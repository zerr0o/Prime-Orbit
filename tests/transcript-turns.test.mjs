import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

const buildResult = await build({
  entryPoints: ["src/components/ConversationView.tsx"],
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

const { buildAssistantTurnSegments, buildTranscriptEntries } = compiledModule.exports;

function message(id, role, content, overrides = {}) {
  return {
    id,
    role,
    content,
    createdAt: `2026-08-20T12:00:${String(overrides.second ?? 0).padStart(2, "0")}.000Z`,
    status: overrides.status ?? "complete",
    ...(overrides.tools ? { tools: overrides.tools } : {}),
  };
}

function tool(id, name = "python", overrides = {}) {
  return {
    id,
    name,
    title: overrides.title ?? name,
    status: overrides.status ?? "completed",
    startedAt: overrides.startedAt ?? "2026-08-20T12:00:00.000Z",
    ...(overrides.output === undefined ? {} : { output: overrides.output }),
  };
}

function entrySummary(entries) {
  return entries.map((entry) => entry.kind === "message"
    ? { kind: entry.kind, id: entry.message.id, role: entry.message.role }
    : { kind: entry.kind, id: entry.id, messages: entry.messages.map((item) => item.id) });
}

test("groups assistant text, Python execution, and final text into one ordered turn", () => {
  const messages = [
    message("user-1", "user", "Can the kernel be restarted?"),
    message("assistant-1", "assistant", "I will inspect the implementation.", { second: 1 }),
    message("assistant-2", "assistant", "", {
      second: 2,
      tools: [tool("python-1"), tool("python-2")],
    }),
    message("assistant-3", "assistant", "Here is the result.", { second: 3 }),
  ];

  const entries = buildTranscriptEntries(messages);

  assert.deepEqual(entrySummary(entries), [
    { kind: "message", id: "user-1", role: "user" },
    {
      kind: "assistant-turn",
      id: "assistant-turn:assistant-1",
      messages: ["assistant-1", "assistant-2", "assistant-3"],
    },
  ]);
  assert.deepEqual(entries[1].messages, messages.slice(1), "grouping must preserve the authoritative message objects and order");
});

test("keeps multiple heterogeneous tool groups inside the same assistant turn", () => {
  const messages = [
    message("assistant-1", "assistant", "First check"),
    message("assistant-tools-1", "assistant", "", {
      second: 1,
      tools: [tool("read-1", "read"), tool("python-1")],
    }),
    message("assistant-2", "assistant", "Second check", { second: 2 }),
    message("assistant-tools-2", "assistant", "", {
      second: 3,
      tools: [tool("git-1", "git"), tool("python-2")],
    }),
    message("assistant-final", "assistant", "Done", { second: 4 }),
  ];

  assert.deepEqual(entrySummary(buildTranscriptEntries(messages)), [{
    kind: "assistant-turn",
    id: "assistant-turn:assistant-1",
    messages: ["assistant-1", "assistant-tools-1", "assistant-2", "assistant-tools-2", "assistant-final"],
  }]);
});

test("preserves content and tool chronology while merging only contiguous Python-only segments", () => {
  const messages = [
    message("assistant-text-a", "assistant", "Text A"),
    message("assistant-python-a", "assistant", "", {
      second: 1,
      tools: [tool("python-a")],
    }),
    message("assistant-python-b", "assistant", "", {
      second: 2,
      tools: [tool("python-b")],
    }),
    message("assistant-text-b", "assistant", "Text B", { second: 3 }),
    message("assistant-git", "assistant", "", {
      second: 4,
      tools: [tool("git-a", "git")],
    }),
    message("assistant-text-c", "assistant", "Text C", { second: 5 }),
  ];
  const sourceSnapshot = structuredClone(messages);

  const segments = buildAssistantTurnSegments(messages);

  assert.deepEqual(segments.map((segment) => segment.kind === "content"
    ? { kind: segment.kind, id: segment.message.id, content: segment.message.content }
    : { kind: segment.kind, tools: segment.tools.map((item) => item.id) }), [
    { kind: "content", id: "assistant-text-a", content: "Text A" },
    { kind: "tools", tools: ["python-a", "python-b"] },
    { kind: "content", id: "assistant-text-b", content: "Text B" },
    { kind: "tools", tools: ["git-a"] },
    { kind: "content", id: "assistant-text-c", content: "Text C" },
  ]);
  assert.deepEqual(messages, sourceSnapshot, "segment construction must never mutate or reorder source history");
  assert.equal(segments[0].message, messages[0], "visible content retains the authoritative message object");
  assert.equal(segments[2].message, messages[3]);
  assert.equal(segments[4].message, messages[5]);
});

test("user and system messages are strict turn boundaries", () => {
  const messages = [
    message("assistant-before", "assistant", "Before"),
    message("system-1", "system", "Resources restored", { second: 1 }),
    message("assistant-after-system", "assistant", "After system", { second: 2 }),
    message("user-1", "user", "Continue", { second: 3 }),
    message("assistant-after-user", "assistant", "After user", { second: 4 }),
  ];

  assert.deepEqual(entrySummary(buildTranscriptEntries(messages)), [
    { kind: "assistant-turn", id: "assistant-turn:assistant-before", messages: ["assistant-before"] },
    { kind: "message", id: "system-1", role: "system" },
    { kind: "assistant-turn", id: "assistant-turn:assistant-after-system", messages: ["assistant-after-system"] },
    { kind: "message", id: "user-1", role: "user" },
    { kind: "assistant-turn", id: "assistant-turn:assistant-after-user", messages: ["assistant-after-user"] },
  ]);
});

test("streaming appends extend the active turn without changing its stable id", () => {
  const firstChunk = [
    message("user-1", "user", "Run the checks"),
    message("assistant-1", "assistant", "Starting", { second: 1, status: "complete" }),
  ];
  const initial = buildTranscriptEntries(firstChunk);
  const withToolAppend = buildTranscriptEntries([
    ...firstChunk,
    message("assistant-tools", "assistant", "", {
      second: 2,
      status: "streaming",
      tools: [tool("python-running", "python", { status: "running" })],
    }),
  ]);
  const withTextAppend = buildTranscriptEntries([
    ...firstChunk,
    message("assistant-tools", "assistant", "", {
      second: 2,
      status: "complete",
      tools: [tool("python-running")],
    }),
    message("assistant-stream", "assistant", "Still working", { second: 3, status: "streaming" }),
  ]);

  assert.equal(initial[1].id, "assistant-turn:assistant-1");
  assert.equal(withToolAppend[1].id, initial[1].id);
  assert.equal(withTextAppend[1].id, initial[1].id);
  assert.deepEqual(withToolAppend[1].messages.map((item) => item.id), ["assistant-1", "assistant-tools"]);
  assert.deepEqual(withTextAppend[1].messages.map((item) => item.id), ["assistant-1", "assistant-tools", "assistant-stream"]);
});

test("historical transcripts retain source chronology without timestamp-based reordering", () => {
  const messages = [
    message("user-history", "user", "Historical prompt", { second: 9 }),
    message("assistant-history-1", "assistant", "First persisted segment", { second: 8 }),
    message("assistant-history-tools", "assistant", "", {
      second: 7,
      tools: [tool("historical-python")],
    }),
    message("assistant-history-2", "assistant", "Final persisted segment", { second: 6 }),
  ];

  const entries = buildTranscriptEntries(messages);

  assert.deepEqual(entries[1].messages.map((item) => item.id), [
    "assistant-history-1",
    "assistant-history-tools",
    "assistant-history-2",
  ]);
  assert.equal(entries[1].id, "assistant-turn:assistant-history-1");
});
