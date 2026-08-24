"use strict";

const fs = require("node:fs");
const { createHash, randomBytes } = require("node:crypto");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const WINDOWS_GENERATION_SOCKET = /^\\\\\.\\pipe\\prime-orbit-daemon-prime-agent-v\d{1,10}\.\d{1,10}\.\d{1,10}-[0-9a-f]{32}$/u;
const UNIX_GENERATION_SOCKET = /^\/tmp\/prime-orbit-daemon-prime-agent-v\d{1,10}\.\d{1,10}\.\d{1,10}-[0-9a-f]{32}\.sock$/u;
const OWNED_CLIENT_ID = /^daemon-client:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const OWNED_REQUEST_ID_HIGH_BIT = 1n << 127n;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function normalizedFile(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function findRuntimeModules(cliPath) {
  let cursor = path.dirname(cliPath);
  for (let depth = 0; depth < 6; depth += 1) {
    const modules = {
      config: path.join(cursor, "config.js"),
      daemonAgentConnection: path.join(cursor, "modes", "agent-connection", "daemon-agent-connection.js"),
      daemonClient: path.join(cursor, "modes", "daemon", "daemon-client.js"),
      daemonSocket: path.join(cursor, "modes", "daemon", "daemon-socket.js"),
      rpcMode: path.join(cursor, "modes", "rpc", "rpc-mode.js"),
    };
    if (Object.values(modules).every((candidate) => fs.existsSync(candidate))) return modules;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error("Les modules RPC de Prime Agent sont introuvables dans ce runtime.");
}

function daemonDescriptorKey(socketPath) {
  return createHash("sha256").update(socketPath).digest("hex").slice(0, 12);
}

function resolveDaemonSocketPath(explicitSocketPath, defaultDaemonSocketPath) {
  if (explicitSocketPath === undefined) return defaultDaemonSocketPath();
  const pattern = process.platform === "win32" ? WINDOWS_GENERATION_SOCKET : UNIX_GENERATION_SOCKET;
  const maxBytes = process.platform === "win32" ? 240 : 100;
  if (typeof explicitSocketPath !== "string"
    || Buffer.byteLength(explicitSocketPath, "utf8") > maxBytes
    || !pattern.test(explicitSocketPath)) {
    throw new Error("Socket de daemon Prime Agent géré invalide ou trop long.");
  }
  return explicitSocketPath;
}

function readOwnedDescriptor(agentDir, socketPath, sessionFile) {
  const descriptorDir = path.join(agentDir, "daemon-workers", daemonDescriptorKey(socketPath));
  const expectedFile = normalizedFile(sessionFile);
  if (!expectedFile) throw new Error("Fichier de session Prime Agent invalide.");
  let entries;
  try {
    entries = fs.readdirSync(descriptorDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("La session Prime Agent active est introuvable.");
    throw error;
  }
  const matches = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const raw = fs.readFileSync(path.join(descriptorDir, entry.name), "utf8");
      if (Buffer.byteLength(raw, "utf8") > MAX_DESCRIPTOR_BYTES) continue;
      const descriptor = JSON.parse(raw);
      if ((descriptor?.version !== 1 && descriptor?.version !== 2)
        || descriptor.supervisorSocketPath !== socketPath
        || descriptor.lifecycle !== "ready"
        || !Number.isInteger(descriptor.pid)
        || descriptor.pid <= 0
        || !OWNED_CLIENT_ID.test(descriptor.ownerClientId ?? "")
        || normalizedFile(descriptor.sessionFile) !== expectedFile) continue;
      matches.push(descriptor);
    } catch {
      // Descriptor replacement is atomic; ignore an incomplete stale entry.
    }
  }
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? "La session Prime Agent active est introuvable."
      : "Plusieurs sessions Prime Agent propriétaires correspondent à ce fichier.");
  }
  return matches[0];
}

function bindOwnedClientIdentity(client, descriptor) {
  if (typeof client?.protocolClientId !== "string"
    || !OWNED_CLIENT_ID.test(client.protocolClientId)
    || !Number.isSafeInteger(client.requestId)
    || client.requestId < 0) {
    throw new Error("Ce runtime Prime Agent ne permet pas de réassocier le contrôle à la session RPC propriétaire.");
  }
  client.protocolClientId = descriptor.ownerClientId;
  client.requestId = BigInt(`0x${randomBytes(16).toString("hex")}`) | OWNED_REQUEST_ID_HIGH_BIT;
}

function selectSession(sessions, sessionFile, sessionId) {
  const expectedFile = normalizedFile(sessionFile);
  if (sessionId) {
    const exact = sessions.find((item) => item?.sessionId === sessionId && item?.activeSessionId);
    if (exact) return exact;
  }
  return sessions.find((item) => normalizedFile(item?.sessionFile) === expectedFile && item?.activeSessionId);
}

async function main() {
  const cliPath = process.env.PRIME_ORBIT_CLI_PATH;
  const sessionFile = process.env.PRIME_ORBIT_SESSION_FILE;
  const sessionId = process.env.PRIME_ORBIT_SESSION_ID || undefined;
  if (!cliPath || !sessionFile) throw new Error("Runtime de réattachement Prime Agent incomplet.");

  const modules = findRuntimeModules(cliPath);
  const [
    { getAgentDir },
    { DaemonAgentConnection },
    { DaemonClient },
    { defaultDaemonSocketPath },
    { runRpcModeWithConnection },
  ] = await Promise.all([
    import(pathToFileURL(modules.config).href),
    import(pathToFileURL(modules.daemonAgentConnection).href),
    import(pathToFileURL(modules.daemonClient).href),
    import(pathToFileURL(modules.daemonSocket).href),
    import(pathToFileURL(modules.rpcMode).href),
  ]);

  const socketPath = resolveDaemonSocketPath(process.env.PRIME_ORBIT_DAEMON_SOCKET, defaultDaemonSocketPath);
  const descriptor = readOwnedDescriptor(getAgentDir(), socketPath, sessionFile);
  const client = new DaemonClient(socketPath);
  bindOwnedClientIdentity(client, descriptor);
  try {
    await client.connect(3_000);
    await client.waitForHello(3_000);
    const list = await client.request({ type: "list", all: true, includeClientOwned: true }, 5_000);
    if (!list.success) throw new Error(list.error || "Prime Agent a refusé de lister les sessions.");
    const sessions = Array.isArray(list.data?.sessions) ? list.data.sessions : [];
    const session = selectSession(sessions, sessionFile, sessionId);
    if (!session?.activeSessionId) throw new Error("La session Prime Agent active est introuvable.");

    const connection = new DaemonAgentConnection(client, session.activeSessionId, {
      closeClientOnDispose: true,
      ownedSession: true,
      sendClientEnv: true,
      supportsExtensionUi: true,
    });
    // Prime Agent replays blocking extension UI while attach is completing.
    // RPC mode normally subscribes just after static attach returns, leaving a
    // narrow window where a restored dialog can be lost. Buffer connection
    // events before attach, then replay them into RPC's first subscription.
    const bufferedEvents = [];
    const stopBuffering = connection.subscribe((event) => bufferedEvents.push(event));
    try {
      await connection.attach();
    } catch (error) {
      stopBuffering();
      await connection.dispose().catch(() => undefined);
      throw error;
    }
    const subscribe = connection.subscribe.bind(connection);
    let replayBufferedEvents = true;
    connection.subscribe = (listener) => {
      const unsubscribe = subscribe(listener);
      if (replayBufferedEvents) {
        replayBufferedEvents = false;
        stopBuffering();
        for (const event of bufferedEvents.splice(0)) listener(event);
      }
      return unsubscribe;
    };
    await runRpcModeWithConnection(connection);
  } catch (error) {
    client.close();
    throw error;
  }
}

if (process.env.PRIME_ORBIT_BRIDGE_TEST === "1") {
  module.exports = {
    bindOwnedClientIdentity,
    daemonDescriptorKey,
    findRuntimeModules,
    normalizedFile,
    readOwnedDescriptor,
    resolveDaemonSocketPath,
    selectSession,
  };
} else {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
