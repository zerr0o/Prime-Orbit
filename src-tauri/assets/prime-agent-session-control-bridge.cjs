"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const MAX_REQUEST_BYTES = 64 * 1024;
const SUPPORTED_PROTOCOL_VERSION = 7;
const RELOAD_REQUEST_TIMEOUT_MS = 120_000;
const HARD_TIMEOUT_MS = RELOAD_REQUEST_TIMEOUT_MS + 15_000;
const MAX_WINDOWS_DAEMON_SOCKET_BYTES = 240;
const MAX_UNIX_DAEMON_SOCKET_BYTES = 100;
const WINDOWS_GENERATION_SOCKET = /^\\\\\.\\pipe\\prime-orbit-daemon-prime-agent-v\d{1,10}\.\d{1,10}\.\d{1,10}-[0-9a-f]{32}$/u;
const UNIX_GENERATION_SOCKET = /^\/tmp\/prime-orbit-daemon-prime-agent-v\d{1,10}\.\d{1,10}\.\d{1,10}-[0-9a-f]{32}\.sock$/u;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function normalizedFile(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function findDaemonModules(cliPath) {
  let cursor = path.dirname(cliPath);
  for (let depth = 0; depth < 6; depth += 1) {
    const daemonClient = path.join(cursor, "modes", "daemon", "daemon-client.js");
    const daemonSocket = path.join(cursor, "modes", "daemon", "daemon-socket.js");
    if (fs.existsSync(daemonClient) && fs.existsSync(daemonSocket)) {
      return { daemonClient, daemonSocket };
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error("Les modules daemon de Prime Agent sont introuvables dans ce runtime.");
}

function resolveDaemonSocketPath(explicitSocketPath, defaultDaemonSocketPath, platform = process.platform) {
  if (explicitSocketPath === undefined) return defaultDaemonSocketPath();
  if (typeof explicitSocketPath !== "string" || explicitSocketPath.length === 0) {
    throw new Error("Socket de daemon Prime Agent invalide.");
  }
  const isWindows = platform === "win32";
  const maxBytes = isWindows ? MAX_WINDOWS_DAEMON_SOCKET_BYTES : MAX_UNIX_DAEMON_SOCKET_BYTES;
  const pattern = isWindows ? WINDOWS_GENERATION_SOCKET : UNIX_GENERATION_SOCKET;
  if (Buffer.byteLength(explicitSocketPath, "utf8") > maxBytes || !pattern.test(explicitSocketPath)) {
    throw new Error("Socket de daemon Prime Agent géré invalide ou trop long.");
  }
  return explicitSocketPath;
}

function validRequest(request) {
  return request
    && typeof request === "object"
    && !Array.isArray(request)
    && request.action === "reload"
    && typeof request.sessionFile === "string"
    && request.sessionFile.length > 0
    && request.sessionFile.length <= 32_768
    && (request.sessionId === undefined
      || (typeof request.sessionId === "string" && request.sessionId.length > 0 && request.sessionId.length <= 512));
}

function selectSession(sessions, request) {
  const expectedFile = normalizedFile(request.sessionFile);
  if (typeof request.sessionId === "string" && request.sessionId) {
    const exact = sessions.find((item) => item?.sessionId === request.sessionId && item?.activeSessionId);
    if (exact) return exact;
  }
  if (!expectedFile) return undefined;
  return sessions.find((item) => normalizedFile(item?.sessionFile) === expectedFile && item?.activeSessionId);
}

function busyReason(state) {
  if (state?.isCompacting) return "compacting";
  if (state?.isBashRunning) return "bash";
  if (state?.isStreaming) return "streaming";
  if (state?.sessionActions?.active
    || Number(state?.sessionActions?.queuedCount ?? 0) > 0
    || state?.sessionActions?.steering?.length > 0
    || state?.sessionActions?.followUps?.length > 0) return "session_action";
  return undefined;
}

function unsupported(reason) {
  return { status: "unsupported", supported: false, reason };
}

function isReloadResponseTimeout(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("Timed out after ")
    && message.includes('waiting for the Prime Agent daemon response to "reload"');
}

async function reloadAgentResources(client, request, hello) {
  if (!validRequest(request)) throw new Error("Requête de rechargement Prime Agent invalide.");
  if (!Number.isInteger(hello?.protocol?.version) || hello.protocol.version < SUPPORTED_PROTOCOL_VERSION) {
    return unsupported("daemon_protocol");
  }

  const list = await client.request({ type: "list", all: true, includeClientOwned: true }, 5_000);
  if (!list.success) throw new Error(list.error || "Prime Agent a refusé de lister les sessions.");
  const sessions = Array.isArray(list.data?.sessions) ? list.data.sessions : [];
  const session = selectSession(sessions, request);
  if (!session?.activeSessionId) {
    return { status: "unavailable", supported: true, reason: "inactive_session" };
  }

  const state = await client.request({
    type: "get_state",
    activeSessionId: session.activeSessionId,
  }, 5_000);
  if (!state.success) throw new Error(state.error || "Prime Agent n’a pas pu relire l’état de la session.");
  const reason = busyReason(state.data);
  if (reason) return { status: "busy", supported: true, reason };

  let response;
  try {
    response = await client.request({
      type: "reload",
      activeSessionId: session.activeSessionId,
    }, RELOAD_REQUEST_TIMEOUT_MS);
  } catch (error) {
    if (error?.name === "DaemonCapabilityUnavailableError") {
      return unsupported("daemon_command");
    }
    if (isReloadResponseTimeout(error)) {
      return { status: "pending", supported: true, reason: "timeout" };
    }
    throw error;
  }
  if (!response.success) {
    const detail = typeof response.error === "string" ? response.error.toLowerCase() : "";
    if (detail.includes("unknown command") || detail.includes("unsupported")) {
      return unsupported("daemon_command");
    }
    throw new Error(response.error || "Prime Agent a refusé de recharger les ressources.");
  }

  return { status: "reloaded", supported: true };
}

async function readRequest() {
  const chunks = [];
  let requestBytes = 0;
  for await (const chunk of process.stdin) {
    requestBytes += chunk.length;
    if (requestBytes > MAX_REQUEST_BYTES) {
      throw new Error("La requête de contrôle Prime Agent est trop volumineuse.");
    }
    chunks.push(chunk);
  }
  const requestText = Buffer.concat(chunks).toString("utf8");
  if (!requestText) throw new Error("Requête de contrôle Prime Agent incomplète.");
  return JSON.parse(requestText);
}

async function main() {
  const cliPath = process.env.PRIME_ORBIT_CLI_PATH;
  if (!cliPath) throw new Error("Runtime Prime Agent incomplet.");
  const request = await readRequest();
  const modules = findDaemonModules(cliPath);
  const [{ DaemonClient }, { defaultDaemonSocketPath }] = await Promise.all([
    import(pathToFileURL(modules.daemonClient).href),
    import(pathToFileURL(modules.daemonSocket).href),
  ]);

  const socketPath = resolveDaemonSocketPath(
    process.env.PRIME_ORBIT_DAEMON_SOCKET,
    defaultDaemonSocketPath,
  );
  const client = new DaemonClient(socketPath);
  try {
    await client.connect(3_000);
    const hello = await client.waitForHello(3_000);
    const result = await reloadAgentResources(client, request, hello);
    process.stdout.write(JSON.stringify(result));
  } finally {
    client.close();
  }
}

module.exports = {
  RELOAD_REQUEST_TIMEOUT_MS,
  SUPPORTED_PROTOCOL_VERSION,
  busyReason,
  isReloadResponseTimeout,
  reloadAgentResources,
  resolveDaemonSocketPath,
  selectSession,
  validRequest,
};

if (process.env.PRIME_ORBIT_BRIDGE_TEST !== "1") {
  const hardTimeout = setTimeout(() => {
    fail(`Le daemon Prime Agent n’a pas répondu au rechargement après ${Math.round(HARD_TIMEOUT_MS / 1_000)} secondes.`);
    process.exit(1);
  }, HARD_TIMEOUT_MS);

  main()
    .then(() => clearTimeout(hardTimeout))
    .catch((error) => {
      clearTimeout(hardTimeout);
      fail(error instanceof Error ? error.message : String(error));
    });
}
