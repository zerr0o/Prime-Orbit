import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
process.env.PRIME_ORBIT_BRIDGE_TEST = "1";
const {
  bindOwnedClientIdentity,
  daemonDescriptorKey,
  resolveDaemonSocketPath,
  selectSession,
} = require("../src-tauri/assets/prime-agent-rpc-reattach-bridge.cjs");
delete process.env.PRIME_ORBIT_BRIDGE_TEST;

const socket = "\\\\.\\pipe\\prime-orbit-daemon-prime-agent-v0.8.0-3a60f741b3b74f16855a08735893f80d";
const sessionFile = "C:\\Users\\example\\.prime\\agent\\sessions\\session.jsonl";

test("reattach bridge accepts only the bounded managed daemon socket", () => {
  assert.equal(resolveDaemonSocketPath(socket, () => "fallback"), socket);
  assert.throws(
    () => resolveDaemonSocketPath("\\\\.\\pipe\\prime-agent-daemon", () => "fallback"),
    /invalide ou trop long/u,
  );
  assert.equal(daemonDescriptorKey(socket).length, 12);
});

test("reattach bridge binds the attested owner with a fresh command namespace", () => {
  const client = {
    protocolClientId: "daemon-client:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    requestId: 0,
  };
  bindOwnedClientIdentity(client, {
    ownerClientId: "daemon-client:11111111-2222-4333-8444-555555555555",
  });
  assert.equal(client.protocolClientId, "daemon-client:11111111-2222-4333-8444-555555555555");
  assert.equal(typeof client.requestId, "bigint");
  assert.equal(client.requestId >= (1n << 127n), true);
});

test("reattach bridge resolves the exact session before attaching", () => {
  const sessions = [
    { sessionId: "target", sessionFile: "C:\\other.jsonl", activeSessionId: "by-id" },
    { sessionId: "other", sessionFile, activeSessionId: "by-file" },
  ];
  assert.equal(selectSession(sessions, sessionFile, "target").activeSessionId, "by-id");
  assert.equal(selectSession(sessions, sessionFile).activeSessionId, "by-file");
});
