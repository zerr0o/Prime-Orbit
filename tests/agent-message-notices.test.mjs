import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

const buildResult = await build({
  entryPoints: ["src/lib/agent-message-notices.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  logLevel: "silent",
});
const compiledModule = { exports: {} };
const require = createRequire(import.meta.url);
new Function("module", "exports", "require", buildResult.outputFiles[0].text)(
  compiledModule,
  compiledModule.exports,
  require,
);
const {
  AGENT_MESSAGE_BODY_MAX_CHARS,
  agentMessagePreview,
  appendUniqueAgentMessage,
  parseAgentMessageNotice,
} = compiledModule.exports;

function structured(overrides = {}) {
  return {
    role: "custom",
    customType: "agent_message",
    display: true,
    content: "transport header that must never become visible",
    details: {
      id: "agentmsg_57b4946b-3bd4-4bcd-9bc0-d119c199ca1a",
      message: "Audit complete.\nNo files edited.",
      from: {
        sessionName: " fix-architecture-review ",
        activeSessionId: "active-fallback",
        sessionId: "session-fallback",
        clientId: "client-fallback",
      },
      fromRelationship: "child",
      target: { activeSessionId: "parent", sessionId: "session-parent" },
    },
    ...overrides,
  };
}

function legacy(body = "Review complete.") {
  return [
    "[from child:fix-test-planner]",
    "Agent-to-agent message received.",
    "Source: agent_message",
    "From: fix-test-planner, active child-active, session child-session, client agent",
    "To: active parent-active, session parent-session",
    "Message id: agentmsg_062781bc-d342-4870-a000-19ecdaa010e7",
    "",
    body,
  ].join("\n");
}

test("uses structured agent-message details and never exposes transport headers", () => {
  const parsed = parseAgentMessageNotice(structured());
  assert.deepEqual(parsed, {
    content: "Audit complete.\nNo files edited.",
    notice: {
      kind: "agent_message",
      messageId: "agentmsg_57b4946b-3bd4-4bcd-9bc0-d119c199ca1a",
      participant: "fix-architecture-review",
      relationship: "child",
    },
  });
  assert.doesNotMatch(parsed.content, /Source:|Message id:|parent-active/u);
});

test("never promotes technical sender identifiers into presentation metadata", () => {
  const active = parseAgentMessageNotice(structured({
    details: {
      id: "agentmsg_active",
      message: "Active fallback",
      from: { activeSessionId: "worker-active", clientId: "client", sessionId: "session" },
      fromRelationship: "future-relationship",
    },
  }));
  assert.equal(active.notice.participant, undefined);
  assert.equal(active.notice.relationship, undefined);

  const client = parseAgentMessageNotice(structured({
    details: {
      id: "agentmsg_client",
      message: "Client fallback",
      from: { clientId: "client-agent", sessionId: "session" },
    },
  }));
  assert.equal(client.notice.participant, undefined);
});

test("parses only the canonical legacy envelope and returns its useful body", () => {
  const parsed = parseAgentMessageNotice({ role: "custom", display: true, content: legacy("Line one.\n\nLine two.") });
  assert.deepEqual(parsed, {
    content: "Line one.\n\nLine two.",
    notice: {
      kind: "agent_message",
      messageId: "agentmsg_062781bc-d342-4870-a000-19ecdaa010e7",
      participant: "fix-test-planner",
      relationship: "child",
    },
  });
});

test("rejects spoofed channels and malformed legacy header order", () => {
  const canonical = legacy();
  const rejected = [
    { role: "user", display: true, content: canonical },
    { role: "assistant", display: true, content: canonical },
    { role: "system", display: true, content: canonical },
    { role: "custom", display: false, content: canonical },
    { role: "custom", customType: "extension_notice", display: true, content: canonical },
    { role: "custom", customType: "", display: true, content: canonical },
    { role: "custom", display: true, content: canonical.replace("Source: agent_message", "Source: user") },
    { role: "custom", display: true, content: canonical.replace("To: active parent-active, session parent-session\nMessage id:", "Message id:\nTo: active parent-active, session parent-session") },
    { role: "custom", display: true, content: canonical.replace("\n\nReview complete.", "\nReview complete.") },
    { role: "custom", display: true, content: canonical.replace("agentmsg_062781bc", "message_062781bc") },
    { role: "custom", display: true, content: canonical.replace("To: active parent-active, session parent-session", "To: ") },
  ];
  rejected.forEach((value) => assert.equal(parseAgentMessageNotice(value), undefined));
});

test("bounds bodies, previews, participants, and duplicate live notices", () => {
  const parsed = parseAgentMessageNotice(structured({
    details: {
      id: "agentmsg_bounded",
      message: "x".repeat(AGENT_MESSAGE_BODY_MAX_CHARS + 50),
      from: { sessionName: `Agent ${"z".repeat(300)}` },
    },
  }));
  assert.equal(parsed.content.length, AGENT_MESSAGE_BODY_MAX_CHARS);
  assert.equal(parsed.content.endsWith("…"), true);
  assert.equal(parsed.notice.participant.length, 160);
  assert.equal(agentMessagePreview("one\n\n two   three", 12), "one two thr…");
  assert.equal(agentMessagePreview("one two three", Number.NaN), "one two three");

  const message = {
    id: "agentmsg_bounded",
    role: "system",
    content: parsed.content,
    createdAt: "2026-08-20T22:42:16.353Z",
    notice: parsed.notice,
  };
  const once = appendUniqueAgentMessage([], message);
  const twice = appendUniqueAgentMessage(once, { ...message, id: "different-event-id" });
  assert.equal(once.length, 1);
  assert.equal(twice, once, "duplicate events preserve the existing array reference");
});
