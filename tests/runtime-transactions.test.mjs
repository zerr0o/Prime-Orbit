import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

const buildResult = await build({
  entryPoints: ["src/hooks/useAgentRuntime.ts"],
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
  beginPromptTransaction,
  commitPromptTransaction,
  durableAttachmentMetadata,
  enqueueExtensionRequest,
  extensionRequestKey,
  rollbackPromptTransaction,
} = compiledModule.exports;

test("persists attachment metadata without native handles or legacy image payloads", () => {
  const legacy = {
    id: "image-1",
    name: "image.png",
    mimeType: "image/png",
    size: 12,
    isImage: true,
    attachmentHandle: "ephemeral-handle",
    dataBase64: "SECRET_BYTES",
    previewUrl: "data:image/png;base64,SECRET_BYTES",
  };
  const durable = durableAttachmentMetadata(legacy);
  assert.deepEqual(durable, {
    id: "image-1",
    name: "image.png",
    mimeType: "image/png",
    size: 12,
    isImage: true,
  });
});

function conversation(overrides = {}) {
  return {
    id: "conversation-a",
    projectId: "project-a",
    title: "Nouvelle conversation",
    createdAt: "2026-08-19T10:00:00.000Z",
    updatedAt: "2026-08-19T10:00:00.000Z",
    pinned: false,
    archived: false,
    status: "idle",
    thinkingLevel: "medium",
    hasContent: false,
    draft: "hello",
    messages: [],
    activities: [],
    ...overrides,
  };
}

test("a failed prompt rolls back its exact optimistic message and conversation metadata", () => {
  const original = conversation();
  const prepared = beginPromptTransaction(original, {
    message: "Inspect the project",
    attachments: [],
    messageId: "user-local-1",
    createdAt: "2026-08-19T10:01:00.000Z",
  });

  assert.equal(prepared.conversation.messages.length, 1);
  assert.equal(prepared.conversation.messages[0].status, "pending");
  assert.equal(prepared.conversation.status, "streaming");
  assert.equal(prepared.conversation.draft, original.draft, "a newer composer draft must never be cleared by the IPC transaction");
  assert.notEqual(prepared.conversation.title, original.title);

  assert.deepEqual(
    rollbackPromptTransaction(prepared.conversation, prepared.transaction),
    original,
  );
});

test("a successful prompt confirms only its pending local message", () => {
  const prepared = beginPromptTransaction(conversation(), {
    message: "Inspect the project",
    attachments: [],
    messageId: "user-local-1",
    createdAt: "2026-08-19T10:01:00.000Z",
  });
  const withConcurrentAssistant = {
    ...prepared.conversation,
    messages: [
      ...prepared.conversation.messages,
      { id: "assistant-1", role: "assistant", content: "Working", createdAt: "2026-08-19T10:01:01.000Z", status: "streaming" },
    ],
  };

  const committed = commitPromptTransaction(withConcurrentAssistant, prepared.transaction);
  assert.equal(committed.messages[0].status, "complete");
  assert.equal(committed.messages[1].status, "streaming");
});

test("rollback removes the ghost without overwriting newer runtime or draft state", () => {
  const prepared = beginPromptTransaction(conversation(), {
    message: "Inspect the project",
    attachments: [],
    messageId: "user-local-1",
    createdAt: "2026-08-19T10:01:00.000Z",
  });
  const concurrent = {
    ...prepared.conversation,
    status: "tool",
    draft: "a newer draft",
    title: "Renamed elsewhere",
    updatedAt: "2026-08-19T10:02:00.000Z",
  };

  const rolledBack = rollbackPromptTransaction(concurrent, prepared.transaction);
  assert.equal(rolledBack.messages.length, 0);
  assert.equal(rolledBack.status, "tool");
  assert.equal(rolledBack.draft, "a newer draft");
  assert.equal(rolledBack.title, "Renamed elsewhere");
  assert.equal(rolledBack.updatedAt, "2026-08-19T10:02:00.000Z");
});

test("successive follow-ups remain queued while earlier work is still pending", () => {
  const first = beginPromptTransaction(conversation({ status: "streaming" }), {
    message: "First follow-up",
    attachments: [],
    messageId: "user-follow-up-1",
    createdAt: "2026-08-19T10:03:00.000Z",
  });
  assert.equal(first.conversation.status, "queued");

  const second = beginPromptTransaction(first.conversation, {
    message: "Second follow-up",
    attachments: [],
    messageId: "user-follow-up-2",
    createdAt: "2026-08-19T10:04:00.000Z",
  });
  assert.equal(second.transaction.previous.status, "queued");
  assert.equal(second.conversation.status, "queued");
});

test("extension requests with the same id remain distinct across conversations and duplicate events update in place", () => {
  const first = {
    id: "request-1",
    type: "extension_ui_request",
    method: "confirm",
    conversationId: "conversation-a",
    requestKey: extensionRequestKey("conversation-a", "request-1"),
    message: "A",
  };
  const second = {
    ...first,
    conversationId: "conversation-b",
    requestKey: extensionRequestKey("conversation-b", "request-1"),
    message: "B",
  };
  let queue = enqueueExtensionRequest([], first);
  queue = enqueueExtensionRequest(queue, second);
  queue = enqueueExtensionRequest(queue, { ...first, message: "A updated" });

  assert.equal(queue.length, 2);
  assert.equal(queue[0].message, "A updated");
  assert.equal(queue[1].message, "B");
});
