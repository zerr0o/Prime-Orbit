import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

const buildResult = await build({
  entryPoints: ["src/lib/conversation-context.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  logLevel: "silent",
});
const compiledModule = { exports: {} };
const require = createRequire(import.meta.url);
new Function("module", "exports", "require", buildResult.outputFiles[0].text)(compiledModule, compiledModule.exports, require);
const { conversationMoveTarget, orderedConversationSiblings } = compiledModule.exports;

function conversation(id, manualOrder, overrides = {}) {
  return {
    id,
    projectId: "project-a",
    manualOrder,
    title: id,
    createdAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
    pinned: false,
    archived: false,
    status: "offline",
    thinkingLevel: "high",
    hasContent: true,
    draft: "",
    messages: [],
    activities: [],
    ...overrides,
  };
}

test("conversation context moves follow the exact visible manual order", () => {
  const first = conversation("first", 10);
  const middle = conversation("middle", 20);
  const last = conversation("last", 30);
  const hidden = conversation("hidden", 15, { archived: true });
  const empty = conversation("empty", 25, { hasContent: false });
  const other = conversation("other", 5, { projectId: "project-b" });
  const all = [last, hidden, other, middle, empty, first];

  assert.deepEqual(orderedConversationSiblings(all, middle).map((item) => item.id), ["first", "middle", "last"]);
  assert.equal(conversationMoveTarget(all, middle, -1)?.id, "first");
  assert.equal(conversationMoveTarget(all, middle, 1)?.id, "last");
});

test("conversation context disables movement at list boundaries", () => {
  const first = conversation("first", 10);
  const last = conversation("last", 20);
  assert.equal(conversationMoveTarget([first, last], first, -1), undefined);
  assert.equal(conversationMoveTarget([first, last], last, 1), undefined);
});
