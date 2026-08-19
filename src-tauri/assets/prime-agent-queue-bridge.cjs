"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

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

async function main() {
  const cliPath = process.env.PRIME_ORBIT_CLI_PATH;
  const requestText = process.env.PRIME_ORBIT_QUEUE_REQUEST;
  if (!cliPath || !requestText) throw new Error("Requête de mutation de file incomplète.");
  const request = JSON.parse(requestText);
  const modules = findDaemonModules(cliPath);
  const [{ DaemonClient }, { defaultDaemonSocketPath }] = await Promise.all([
    import(pathToFileURL(modules.daemonClient).href),
    import(pathToFileURL(modules.daemonSocket).href),
  ]);

  const client = new DaemonClient(defaultDaemonSocketPath());
  try {
    await client.connect(3_000);
    await client.waitForHello(3_000);
    if (!client.supportsServerCapability("queue_message_mutation")) {
      process.stdout.write(JSON.stringify({ status: "unsupported" }));
      return;
    }

    const list = await client.request({ type: "list", all: true, includeClientOwned: true }, 5_000);
    if (!list.success) throw new Error(list.error || "Prime Agent a refusé de lister les sessions.");
    const sessions = Array.isArray(list.data?.sessions) ? list.data.sessions : [];
    const expectedFile = normalizedFile(request.sessionFile);
    let session;
    if (typeof request.sessionId === "string" && request.sessionId) {
      session = sessions.find((item) => item?.sessionId === request.sessionId && item?.activeSessionId);
    }
    if (!session && expectedFile) {
      session = sessions.find((item) => normalizedFile(item?.sessionFile) === expectedFile && item?.activeSessionId);
    }
    if (!session?.activeSessionId) {
      throw new Error("La session Prime Agent n’est pas active dans le daemon.");
    }

    const mutation = await client.request({
      type: "mutate_queued_message",
      activeSessionId: session.activeSessionId,
      lane: request.lane,
      index: request.index,
      expectedText: request.expectedText,
      mutation: request.mutation,
    }, 5_000);
    if (!mutation.success) throw new Error(mutation.error || "Prime Agent a refusé la mutation de file.");
    const status = mutation.data?.status;
    if (!["applied", "rejected", "invalid"].includes(status)) {
      throw new Error("Réponse de mutation de file invalide.");
    }

    process.stdout.write(JSON.stringify({ status }));
  } finally {
    client.close();
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
