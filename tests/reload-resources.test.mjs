import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
process.env.PRIME_ORBIT_BRIDGE_TEST = "1";
const {
  RELOAD_REQUEST_TIMEOUT_MS,
  SUPPORTED_PROTOCOL_VERSION,
  bindOwnedClientIdentity,
  busyReason,
  createOwnedRequestIdSeed,
  daemonDescriptorKey,
  inspectOwnedSession,
  reloadAgentResources,
  resumeQueuedWork,
  resolveDaemonSocketPath,
  selectSession,
  selectOwnedClientDescriptor,
  shutdownPrimeAgentDaemon,
  validOwnedClientDescriptor,
  validOwnedRequestIdSeed,
  validRequest,
} = require("../src-tauri/assets/prime-agent-session-control-bridge.cjs");
delete process.env.PRIME_ORBIT_BRIDGE_TEST;

const request = {
  action: "reload",
  sessionFile: "C:\\sessions\\active.jsonl",
  sessionId: "session-active",
};
const hello = { protocol: { version: SUPPORTED_PROTOCOL_VERSION } };
const generationSocket = "\\\\.\\pipe\\prime-orbit-daemon-prime-agent-v0.7.4-4a6f213a1ed44889a0f0b40ea4774f3d";
const ownerClientId = "daemon-client:11111111-2222-4333-8444-555555555555";

const ownedDescriptor = {
  version: 1,
  pid: 4242,
  lifecycle: "ready",
  supervisorSocketPath: generationSocket,
  sessionFile: request.sessionFile,
  rootSessionId: request.sessionId,
  ownerClientId,
};

test("uses only a strictly bounded generation socket and otherwise keeps the upstream default", () => {
  const fallback = () => "/upstream/default.sock";
  const windows = "\\\\.\\pipe\\prime-orbit-daemon-prime-agent-v0.7.4-4a6f213a1ed44889a0f0b40ea4774f3d";
  const unix = "/tmp/prime-orbit-daemon-prime-agent-v0.7.4-4a6f213a1ed44889a0f0b40ea4774f3d.sock";

  assert.equal(resolveDaemonSocketPath(undefined, fallback, "win32"), fallback());
  assert.equal(resolveDaemonSocketPath(windows, fallback, "win32"), windows);
  assert.equal(resolveDaemonSocketPath(unix, fallback, "linux"), unix);
  assert.throws(
    () => resolveDaemonSocketPath("\\\\.\\pipe\\prime-agent-daemon", fallback, "win32"),
    /invalide ou trop long/u,
  );
  assert.throws(
    () => resolveDaemonSocketPath("/tmp/prime-orbit-daemon-prime-agent-v0.7.4-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.sock", fallback, "linux"),
    /invalide ou trop long/u,
  );
  assert.throws(
    () => resolveDaemonSocketPath(`${unix}${"x".repeat(101)}`, fallback, "linux"),
    /invalide ou trop long/u,
  );
});

test("derives the same bounded descriptor namespace as the Prime Agent supervisor", () => {
  assert.equal(daemonDescriptorKey(generationSocket), "283616240b01");
});

test("selects only the ready client-owned worker for the exact daemon and session", () => {
  assert.equal(validOwnedClientDescriptor(ownedDescriptor, generationSocket), true);
  assert.equal(
    selectOwnedClientDescriptor([
      { ...ownedDescriptor, supervisorSocketPath: "\\\\.\\pipe\\other" },
      { ...ownedDescriptor, lifecycle: "recovering" },
      { ...ownedDescriptor, ownerClientId: undefined },
      ownedDescriptor,
    ], request, generationSocket),
    ownedDescriptor,
  );
  assert.equal(
    selectOwnedClientDescriptor([{ ...ownedDescriptor, rootSessionId: "new-session-id" }], request, generationSocket)?.ownerClientId,
    ownerClientId,
    "the exact session file remains authoritative after a runtime session id replacement",
  );
  assert.equal(
    selectOwnedClientDescriptor([{ ...ownedDescriptor, version: 2 }], request, generationSocket)?.ownerClientId,
    ownerClientId,
    "Prime Agent v0.8 worker descriptors remain eligible for exact owner reattachment",
  );
  assert.throws(
    () => selectOwnedClientDescriptor([ownedDescriptor, { ...ownedDescriptor, pid: 4243 }], request, generationSocket),
    /Plusieurs sessions Prime Agent propriétaires/u,
  );
});

test("reuses the RPC owner's protocol identity instead of listing its worker as inactive", async () => {
  const requestIdSeed = createOwnedRequestIdSeed(Buffer.alloc(16, 0x11));
  const client = {
    protocolClientId: "daemon-client:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    requestId: 0,
    async request(command) {
      if (command.type === "list") {
        return this.protocolClientId === ownerClientId
          ? { success: true, data: { sessions: [{ ...request, activeSessionId: "owned-active" }] } }
          : { success: true, data: { sessions: [{ ...request, isSessionActive: false }] } };
      }
      if (command.type === "get_state") return { success: true, data: {} };
      if (command.type === "reload") return { success: true };
      throw new Error(`unexpected command ${command.type}`);
    },
  };

  assert.equal(bindOwnedClientIdentity(client, ownedDescriptor, requestIdSeed), true);
  assert.equal(client.protocolClientId, ownerClientId);
  assert.equal(client.requestId, requestIdSeed);
  assert.deepEqual(await reloadAgentResources(client, request, hello), {
    status: "reloaded",
    supported: true,
  });
});

test("allocates a disjoint command namespace before impersonating an RPC owner", () => {
  const staleCommandId = "daemon_3";
  const staleJournal = new Map([
    [JSON.stringify([ownerClientId, staleCommandId]), { status: "complete", response: "stale reload" }],
  ]);
  const client = {
    protocolClientId: "daemon-client:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    requestId: 0,
  };
  const requestIdSeed = createOwnedRequestIdSeed(Buffer.from("0123456789abcdeffedcba9876543210", "hex"));

  assert.equal(validOwnedRequestIdSeed(requestIdSeed), true);
  assert.equal(bindOwnedClientIdentity(client, ownedDescriptor, requestIdSeed), true);
  const reloadCommandId = `daemon_${++client.requestId}`;
  const journalKey = JSON.stringify([client.protocolClientId, reloadCommandId]);

  assert.notEqual(reloadCommandId, staleCommandId);
  assert.equal(staleJournal.has(journalKey), false, "a stale owner command result must not be replayed");
  assert.match(reloadCommandId, /^daemon_\d{39}$/u);
  assert.equal(validOwnedRequestIdSeed(1n), false);
  assert.throws(() => createOwnedRequestIdSeed(Buffer.alloc(8)), /Entropie d’identifiant/u);
});

test("accepts only the bounded native reload action", () => {
  assert.equal(validRequest(request), true);
  assert.equal(validRequest({ action: "shutdown" }), true);
  assert.equal(validRequest({ action: "shutdown", sessionFile: request.sessionFile }), false);
  assert.equal(validRequest({ ...request, action: "inspect_owned_session" }), true);
  assert.equal(validRequest({ ...request, action: "prompt" }), false);
  assert.equal(validRequest({ ...request, sessionFile: "" }), false);
  assert.equal(validRequest({ ...request, sessionId: "x".repeat(513) }), false);
});

test("detects an exact active owned session without mutating it", async () => {
  const commands = [];
  const client = {
    async request(command) {
      commands.push(command);
      return {
        success: true,
        data: { sessions: [{ ...request, activeSessionId: "owned-active" }] },
      };
    },
  };

  assert.deepEqual(
    await inspectOwnedSession(client, { ...request, action: "inspect_owned_session" }, hello, ownedDescriptor),
    { status: "active", supported: true, activeSessionId: "owned-active" },
  );
  assert.deepEqual(commands, [{ type: "list", all: true, includeClientOwned: true }]);
  assert.deepEqual(
    await inspectOwnedSession(client, { ...request, action: "inspect_owned_session" }, hello, undefined),
    { status: "inactive", supported: true },
  );
});

test("stops the exact managed daemon and waits until its socket disappears", async () => {
  const commands = [];
  let attempts = 0;
  const createClient = (socketPath) => {
    attempts += 1;
    const reachable = attempts === 1;
    return {
      async connect() {
        assert.equal(socketPath, generationSocket);
        if (!reachable) throw new Error("socket gone");
      },
      async waitForHello() { return hello; },
      async request(command, timeoutMs) {
        commands.push({ command, timeoutMs });
        return { success: true };
      },
      close() {},
    };
  };

  assert.deepEqual(
    await shutdownPrimeAgentDaemon(createClient, generationSocket, 500, Date.now, async () => undefined),
    { status: "stopped" },
  );
  assert.deepEqual(commands, [{ command: { type: "shutdown", force: true }, timeoutMs: 1_500 }]);
  assert.equal(attempts, 2, "the shutdown acknowledgement is followed by a socket probe");
});

test("fails closed when a managed daemon keeps accepting connections", async () => {
  let clock = 0;
  const createClient = () => ({
    async connect() {},
    async waitForHello() { return hello; },
    async request() { return { success: true }; },
    close() {},
  });

  await assert.rejects(
    shutdownPrimeAgentDaemon(
      createClient,
      generationSocket,
      100,
      () => clock,
      async (milliseconds) => { clock += milliseconds; },
    ),
    /resté actif/u,
  );
});

test("resolves the daemon session by canonical id before the file fallback", () => {
  const sessions = [
    { sessionId: "session-active", sessionFile: "C:\\sessions\\other.jsonl", activeSessionId: "active-by-id" },
    { sessionId: "other", sessionFile: request.sessionFile, activeSessionId: "active-by-file" },
  ];
  assert.equal(selectSession(sessions, request).activeSessionId, "active-by-id");
  assert.equal(
    selectSession(sessions, { action: "reload", sessionFile: request.sessionFile }).activeSessionId,
    "active-by-file",
  );
});

test("recognizes every state that makes resource reload unsafe", () => {
  assert.equal(busyReason({ isStreaming: true }), "streaming");
  assert.equal(busyReason({ isCompacting: true, isStreaming: true }), "compacting");
  assert.equal(busyReason({ isBashRunning: true }), "bash");
  assert.equal(busyReason({ sessionActions: { active: { kind: "session_command" } } }), "session_action");
  assert.equal(busyReason({ sessionActions: { queuedCount: 1 } }), "session_action");
  assert.equal(busyReason({ sessionActions: { steering: ["queued"] } }), "session_action");
  assert.equal(busyReason({ isStreaming: false, isCompacting: false, isBashRunning: false }), undefined);
});

test("reloads the exact active session without submitting a prompt", async () => {
  const calls = [];
  const client = {
    async request(command, timeoutMs) {
      calls.push({ command, timeoutMs });
      if (command.type === "list") {
        return { success: true, data: { sessions: [{ ...request, activeSessionId: "daemon-session" }] } };
      }
      if (command.type === "get_state") {
        return { success: true, data: { isStreaming: false, isCompacting: false, isBashRunning: false } };
      }
      if (command.type === "reload") return { success: true };
      throw new Error(`unexpected command ${command.type}`);
    },
  };

  assert.deepEqual(await reloadAgentResources(client, request, hello), {
    status: "reloaded",
    supported: true,
  });
  const commands = calls.map(({ command }) => command);
  assert.deepEqual(commands.map(({ type }) => type), ["list", "get_state", "reload"]);
  assert.deepEqual(commands[2], { type: "reload", activeSessionId: "daemon-session" });
  assert.equal(calls[2].timeoutMs, RELOAD_REQUEST_TIMEOUT_MS);
  assert.equal(commands.some(({ type }) => type === "prompt"), false);
});

test("resumes the exact native queue without admitting another session action", async () => {
  const calls = [];
  const client = {
    async request(command, timeoutMs) {
      calls.push({ command, timeoutMs });
      if (command.type === "list") {
        return { success: true, data: { sessions: [{ ...request, activeSessionId: "daemon-session" }] } };
      }
      if (command.type === "resume_queue") return { success: true };
      throw new Error(`unexpected command ${command.type}`);
    },
  };

  assert.deepEqual(
    await resumeQueuedWork(client, { ...request, action: "resume_queue" }, hello),
    { status: "resumed", supported: true },
  );
  assert.deepEqual(calls.map(({ command }) => command), [
    { type: "list", all: true, includeClientOwned: true },
    { type: "resume_queue", activeSessionId: "daemon-session" },
  ]);
  assert.equal(calls[1].timeoutMs, 5_000);
});

test("treats an empty native queue as resumed because suspension is still cleared", async () => {
  const client = {
    async request(command) {
      if (command.type === "list") {
        return { success: true, data: { sessions: [{ ...request, activeSessionId: "daemon-session" }] } };
      }
      return { success: false, error: "No queued work to resume" };
    },
  };

  assert.deepEqual(
    await resumeQueuedWork(client, { ...request, action: "resume_queue" }, hello),
    { status: "resumed", supported: true },
  );
});

test("keeps a slow reload request pending until the daemon actually answers", async () => {
  let resolveReload;
  let announceReload;
  const reloadStarted = new Promise((resolve) => { announceReload = resolve; });
  const slowResponse = new Promise((resolve) => { resolveReload = resolve; });
  const client = {
    async request(command, timeoutMs) {
      if (command.type === "list") {
        return { success: true, data: { sessions: [{ ...request, activeSessionId: "daemon-session" }] } };
      }
      if (command.type === "get_state") return { success: true, data: {} };
      assert.equal(command.type, "reload");
      assert.equal(timeoutMs, RELOAD_REQUEST_TIMEOUT_MS);
      announceReload();
      return slowResponse;
    },
  };

  let settled = false;
  const resultPromise = reloadAgentResources(client, request, hello).finally(() => { settled = true; });
  await reloadStarted;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "a slow daemon response must keep the native operation reserved");
  resolveReload({ success: true });
  assert.deepEqual(await resultPromise, { status: "reloaded", supported: true });
});

test("refuses a busy session before sending reload", async () => {
  const commands = [];
  const client = {
    async request(command) {
      commands.push(command);
      if (command.type === "list") {
        return { success: true, data: { sessions: [{ ...request, activeSessionId: "daemon-session" }] } };
      }
      return { success: true, data: { isStreaming: true } };
    },
  };

  assert.deepEqual(await reloadAgentResources(client, request, hello), {
    status: "busy",
    supported: true,
    reason: "streaming",
  });
  assert.deepEqual(commands.map(({ type }) => type), ["list", "get_state"]);
});

test("reports an inactive daemon session without attempting reload", async () => {
  const commands = [];
  const client = {
    async request(command) {
      commands.push(command);
      return { success: true, data: { sessions: [] } };
    },
  };

  assert.deepEqual(await reloadAgentResources(client, request, hello), {
    status: "unavailable",
    supported: true,
    reason: "inactive_session",
  });
  assert.deepEqual(commands.map(({ type }) => type), ["list"]);
});

test("capability-gates incompatible daemon protocols", async () => {
  const client = { request: () => assert.fail("an incompatible daemon must not receive commands") };
  assert.deepEqual(
    await reloadAgentResources(client, request, { protocol: { version: SUPPORTED_PROTOCOL_VERSION - 1 } }),
    { status: "unsupported", supported: false, reason: "daemon_protocol" },
  );
});

test("reports a daemon without reload support instead of turning slash text into a prompt", async () => {
  const client = {
    async request(command) {
      if (command.type === "list") {
        return { success: true, data: { sessions: [{ ...request, activeSessionId: "daemon-session" }] } };
      }
      if (command.type === "get_state") return { success: true, data: {} };
      const error = new Error("reload is unavailable");
      error.name = "DaemonCapabilityUnavailableError";
      throw error;
    },
  };

  assert.deepEqual(await reloadAgentResources(client, request, hello), {
    status: "unsupported",
    supported: false,
    reason: "daemon_command",
  });
});

test("reports an unanswered reload as pending instead of pretending it failed", async () => {
  const client = {
    async request(command, timeoutMs) {
      if (command.type === "list") {
        return { success: true, data: { sessions: [{ ...request, activeSessionId: "daemon-session" }] } };
      }
      if (command.type === "get_state") return { success: true, data: {} };
      throw new Error(`Timed out after ${timeoutMs}ms waiting for the Prime Agent daemon response to "reload". fixture`);
    },
  };

  assert.deepEqual(await reloadAgentResources(client, request, hello), {
    status: "pending",
    supported: true,
    reason: "timeout",
  });
});
