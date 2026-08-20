import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
process.env.PRIME_ORBIT_BRIDGE_TEST = "1";
const {
  RELOAD_REQUEST_TIMEOUT_MS,
  SUPPORTED_PROTOCOL_VERSION,
  busyReason,
  reloadAgentResources,
  resolveDaemonSocketPath,
  selectSession,
  validRequest,
} = require("../src-tauri/assets/prime-agent-session-control-bridge.cjs");
delete process.env.PRIME_ORBIT_BRIDGE_TEST;

const request = {
  action: "reload",
  sessionFile: "C:\\sessions\\active.jsonl",
  sessionId: "session-active",
};
const hello = { protocol: { version: SUPPORTED_PROTOCOL_VERSION } };

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

test("accepts only the bounded native reload action", () => {
  assert.equal(validRequest(request), true);
  assert.equal(validRequest({ ...request, action: "prompt" }), false);
  assert.equal(validRequest({ ...request, sessionFile: "" }), false);
  assert.equal(validRequest({ ...request, sessionId: "x".repeat(513) }), false);
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
