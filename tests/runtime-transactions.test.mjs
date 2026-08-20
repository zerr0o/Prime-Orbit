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
  applyAuthoritativeUserMessageStart,
  applyQueueMutationSnapshot,
  beginPromptTransaction,
  commitPromptTransaction,
  durableAttachmentMetadata,
  enqueueExtensionRequest,
  extensionRequestKey,
  handleMessageEvent,
  mergeHistoricalAttachmentPreviews,
  promptAttachmentPayload,
  reconcileQueuedMessages,
  rollbackPromptTransaction,
  selectForkEntryId,
  shouldApplyHistoryResponse,
  shouldReloadQueuedTranscript,
} = compiledModule.exports;

test("persists a bounded thumbnail without native handles or legacy full image payloads", () => {
  const legacy = {
    id: "image-1",
    name: "image.png",
    mimeType: "image/png",
    size: 12,
    isImage: true,
    path: "D:\\Shared\\image.png",
    attachmentHandle: "ephemeral-handle",
    dataBase64: "SECRET_BYTES",
    previewUrl: "data:image/png;base64,SECRET_BYTES",
    previewDataUrl: "data:image/png;base64,BOUNDED_THUMBNAIL",
  };
  const durable = durableAttachmentMetadata(legacy);
  assert.deepEqual(durable, {
    id: "image-1",
    name: "image.png",
    mimeType: "image/png",
    size: 12,
    isImage: true,
    previewDataUrl: "data:image/png;base64,BOUNDED_THUMBNAIL",
  });
});

test("builds capability-only RPC fields for images and documents", () => {
  assert.deepEqual(promptAttachmentPayload([
    { id: "image", name: "capture.png", mimeType: "image/png", size: 12, isImage: true, attachmentHandle: "image-handle" },
    { id: "document", name: "notes.txt", mimeType: "text/plain", size: 24, isImage: false, attachmentHandle: "document-handle" },
  ]), {
    images: [{ type: "image", attachmentHandle: "image-handle" }],
    attachments: [{ attachmentHandle: "document-handle" }],
  });
});

test("merges a locally generated historical thumbnail after RPC history wins the race", () => {
  const rpcHistory = [{
    id: "user-rpc",
    role: "user",
    content: "Analyse cette image",
    createdAt: "2026-08-19T10:00:00.000Z",
    attachments: [
      { id: "rpc-image", name: "image-1.png", mimeType: "image/png", size: 0, isImage: true },
      { id: "rpc-document", name: "notes.txt", mimeType: "text/plain", size: 240, isImage: false },
    ],
  }];
  const localHistory = [{
    ...rpcHistory[0],
    id: "user-local",
    attachments: [
      {
        id: "local-image",
        name: "capture.png",
        mimeType: "image/png",
        size: 4096,
        isImage: true,
        previewDataUrl: "data:image/png;base64,BOUNDED_THUMBNAIL",
      },
      {
        id: "local-document",
        name: "notes.txt",
        mimeType: "text/plain",
        size: 240,
        isImage: false,
        path: "D:\\Private\\notes.txt",
        attachmentHandle: "must-not-survive",
      },
    ],
  }];

  const [merged] = mergeHistoricalAttachmentPreviews(rpcHistory, localHistory);
  assert.equal(merged.id, "user-rpc", "RPC message identity remains authoritative");
  assert.equal(merged.attachments[0].name, "capture.png");
  assert.equal(merged.attachments[0].size, 4096);
  assert.equal(merged.attachments[0].previewDataUrl, "data:image/png;base64,BOUNDED_THUMBNAIL");
  assert.equal(merged.attachments[1].name, "notes.txt");
  assert.equal("path" in merged.attachments[1], false);
  assert.equal("attachmentHandle" in merged.attachments[1], false);
});

test("never resurrects attachments onto a different or attachment-free historical turn", () => {
  const previous = [{
    id: "local-old",
    role: "user",
    content: "Old request",
    createdAt: "2026-08-19T10:00:00.000Z",
    attachments: [{
      id: "old-document",
      name: "private.txt",
      mimeType: "text/plain",
      size: 12,
      isImage: false,
      attachmentHandle: "old-capability",
    }],
  }];
  const history = [{
    id: "history-new",
    role: "user",
    content: "Different request",
    createdAt: "2026-08-19T11:00:00.000Z",
  }];

  const [merged] = mergeHistoricalAttachmentPreviews(history, previous);
  assert.equal(merged.attachments, undefined);
});

test("recreates a document-only user turn from native message metadata without an optimistic row", () => {
  const document = {
    id: "orbit-attachment:9b8ad0e7-8796-4a7b-9d47-82fd342d9ae8:0",
    name: "requirements.pdf",
    mimeType: "application/pdf",
    size: 4096,
    isImage: false,
  };
  const delivered = applyAuthoritativeUserMessageStart(
    conversation(),
    "",
    "2026-08-19T10:01:00.000Z",
    [document],
    "entry-document-only",
  );

  assert.equal(delivered.messages.length, 1);
  assert.equal(delivered.messages[0].content, "Fichier joint");
  assert.deepEqual(delivered.messages[0].attachments, [document]);
  assert.equal("path" in delivered.messages[0].attachments[0], false);
  const duplicateEvent = applyAuthoritativeUserMessageStart(
    delivered,
    "",
    "2026-08-19T10:01:00.000Z",
    [document],
    "entry-document-only",
  );
  assert.equal(duplicateEvent.messages.length, 1);
});

test("does not drop a sanitized live message_start whose visible text is empty", () => {
  const document = {
    id: "orbit-attachment:9b8ad0e7-8796-4a7b-9d47-82fd342d9ae8:0",
    name: "live.pdf",
    mimeType: "application/pdf",
    size: 512,
    isImage: false,
  };
  let current = conversation();
  handleMessageEvent("conversation-a", {
    type: "message_start",
    message: {
      id: "live-document-message",
      role: "user",
      content: "",
      primeOrbitAttachments: [document],
      timestamp: 1_724_064_060_000,
    },
  }, (_conversationId, updater) => {
    current = typeof updater === "function" ? updater(current) : { ...current, ...updater };
  });

  assert.equal(current.messages.length, 1);
  assert.equal(current.messages[0].id, "live-document-message");
  assert.equal(current.messages[0].content, "Fichier joint");
  assert.deepEqual(current.messages[0].attachments, [document]);
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
  assert.equal(first.conversation.messages[0].queueDelivery, "follow_up");

  const second = beginPromptTransaction(first.conversation, {
    message: "Second follow-up",
    attachments: [],
    messageId: "user-follow-up-2",
    createdAt: "2026-08-19T10:04:00.000Z",
  });
  assert.equal(second.transaction.previous.status, "queued");
  assert.equal(second.conversation.status, "queued");
});

test("a rapid second submission is queued even before the running status rerenders", () => {
  const prepared = beginPromptTransaction(conversation({ status: "idle" }), {
    message: "Rapid follow-up",
    attachments: [],
    messageId: "user-rapid-follow-up",
    createdAt: "2026-08-19T10:04:30.000Z",
    forceQueued: true,
  });

  assert.equal(prepared.conversation.status, "queued");
  assert.equal(prepared.conversation.messages[0].queueDelivery, "follow_up");
  assert.equal(prepared.conversation.messages[0].queueObserved, false);
});

test("an explicit steer submission stays in the immediate lane", () => {
  const prepared = beginPromptTransaction(conversation({ status: "streaming" }), {
    message: "Use this constraint now",
    attachments: [],
    messageId: "user-steer",
    createdAt: "2026-08-19T10:04:45.000Z",
    queuedDelivery: "steer",
  });

  assert.equal(prepared.conversation.messages[0].queueDelivery, "steer");
  assert.equal(prepared.conversation.messages[0].queueText, "Use this constraint now");
});

test("queued messages stay separate until Prime Agent emits the authoritative user event", () => {
  const prepared = beginPromptTransaction(conversation({ status: "streaming" }), {
    message: "Wait for the current run",
    queuedPayload: "Wait for the current run",
    attachments: [],
    messageId: "queued-1",
    createdAt: "2026-08-19T10:03:00.000Z",
  });
  const accepted = commitPromptTransaction(prepared.conversation, prepared.transaction);
  assert.equal(accepted.messages[0].queueAccepted, true);
  const observed = reconcileQueuedMessages(accepted, {
    queuedCount: 1,
    steering: [],
    followUps: ["Wait for the current run"],
  });
  assert.equal(observed.messages[0].queueObserved, true);
  assert.equal(observed.messages[0].queueDelivery, "follow_up");

  const terminalSnapshot = reconcileQueuedMessages(observed, {
    queuedCount: 0,
    steering: [],
    followUps: [],
  });
  assert.equal(terminalSnapshot.messages[0].queueDelivery, "follow_up");
  assert.equal(terminalSnapshot.messages[0].queueObserved, true);

  const activeSnapshot = reconcileQueuedMessages(terminalSnapshot, {
    queuedCount: 0,
    steering: [],
    followUps: [],
    active: {
      kind: "turn",
      phase: "preparing",
      label: "Wait for the current run",
    },
  });
  assert.equal(activeSnapshot.messages[0].queueDelivery, "follow_up");
  assert.equal(activeSnapshot.messages[0].queueObserved, true);

  const delivered = applyAuthoritativeUserMessageStart(
    activeSnapshot,
    "Wait for the current run",
    "2026-08-19T10:03:01.000Z",
  );
  assert.equal(delivered.messages[0].queueDelivery, undefined);
  assert.equal(delivered.messages[0].queueObserved, undefined);
  assert.equal(delivered.messages[0].queueAccepted, undefined);
  const confirmedByUserEvent = applyAuthoritativeUserMessageStart(
    delivered,
    "Wait for the current run",
    "2026-08-19T10:03:01.000Z",
  );
  assert.equal(confirmedByUserEvent.messages.length, 1, "the authoritative event does not duplicate an already promoted row");
});

test("a late empty queue snapshot never moves a queued user turn behind its assistant reply", () => {
  const initial = conversation({
    status: "streaming",
    messages: [{
      id: "assistant-previous",
      role: "assistant",
      content: "Previous answer",
      createdAt: "2026-08-19T10:02:00.000Z",
      status: "complete",
    }],
  });
  const prepared = beginPromptTransaction(initial, {
    message: "ca va ?",
    queuedPayload: "ca va ?",
    attachments: [],
    messageId: "queued-late-snapshot",
    createdAt: "2026-08-19T10:03:00.000Z",
  });
  const accepted = commitPromptTransaction(prepared.conversation, prepared.transaction);
  const observed = reconcileQueuedMessages(accepted, {
    queuedCount: 1,
    steering: [],
    followUps: ["ca va ?"],
  });
  const withReply = {
    ...observed,
    messages: [...observed.messages, {
      id: "assistant-current",
      role: "assistant",
      content: "Ca va très bien.",
      createdAt: "2026-08-19T10:03:01.000Z",
      status: "complete",
    }],
  };

  const lateActiveSnapshot = reconcileQueuedMessages(withReply, {
    queuedCount: 0,
    steering: [],
    followUps: [],
    active: {
      kind: "turn",
      phase: "running",
      label: "ca va ?",
    },
  });
  assert.deepEqual(lateActiveSnapshot.messages.map((message) => message.id), [
    "assistant-previous",
    "queued-late-snapshot",
    "assistant-current",
  ]);
  assert.equal(lateActiveSnapshot.messages[1].queueDelivery, "follow_up");

  const reconciled = reconcileQueuedMessages(lateActiveSnapshot, {
    queuedCount: 0,
    steering: [],
    followUps: [],
  });

  assert.deepEqual(reconciled.messages.map((message) => message.id), [
    "assistant-previous",
    "queued-late-snapshot",
    "assistant-current",
  ]);
  assert.equal(reconciled.messages[1].queueDelivery, "follow_up");
  assert.equal(reconciled.messages[1].queueObserved, true);
  assert.equal(shouldReloadQueuedTranscript(reconciled, {
    queuedCount: 0,
    steering: [],
    followUps: [],
  }), true, "the persisted session must resolve the missing delivery boundary");
  assert.equal(shouldReloadQueuedTranscript(reconciled, {
    queuedCount: 1,
    steering: [],
    followUps: ["ca va ?"],
  }), false, "an item that is still queued must not be removed by a history refresh");
});

test("a terminal queue history response cannot overwrite a newer prompt or run", () => {
  assert.equal(shouldApplyHistoryResponse(undefined, 4, true), true, "normal bootstrap history is not queue-guarded");
  assert.equal(shouldApplyHistoryResponse(4, 4, false), true, "an unchanged idle transcript accepts its repair");
  assert.equal(shouldApplyHistoryResponse(4, 5, false), false, "a newer prompt invalidates the old snapshot");
  assert.equal(shouldApplyHistoryResponse(4, 4, true), false, "a newly active run invalidates the old snapshot");
});

test("an accepted follow-up waits for Prime Agent's user event when the first queue snapshot lags", () => {
  const prepared = beginPromptTransaction(conversation({ status: "streaming" }), {
    message: "Fast follow-up",
    queuedPayload: "Fast follow-up",
    attachments: [],
    messageId: "queued-fast",
    createdAt: "2026-08-19T10:03:00.000Z",
  });
  const accepted = commitPromptTransaction(prepared.conversation, prepared.transaction);
  const laggingSnapshot = reconcileQueuedMessages(accepted, {
    queuedCount: 0,
    steering: [],
    followUps: [],
  });
  assert.equal(laggingSnapshot.messages[0].queueDelivery, "follow_up");

  const delivered = applyAuthoritativeUserMessageStart(
    laggingSnapshot,
    "Fast follow-up",
    "2026-08-19T10:03:01.000Z",
  );
  assert.equal(delivered.messages[0].queueDelivery, undefined);
  assert.equal(delivered.messages[0].queueAccepted, undefined);
});

test("queued follow-ups move beside their own assistant turn instead of grouping above all replies", () => {
  const initial = conversation({
    status: "streaming",
    messages: [{
      id: "assistant-initial",
      role: "assistant",
      content: "Initial answer",
      createdAt: "2026-08-19T10:02:00.000Z",
      status: "complete",
    }],
  });
  const first = beginPromptTransaction(initial, {
    message: "First queued turn",
    queuedPayload: "First queued turn",
    attachments: [],
    messageId: "queued-first",
    createdAt: "2026-08-19T10:03:00.000Z",
  });
  const firstAccepted = commitPromptTransaction(first.conversation, first.transaction);
  const second = beginPromptTransaction(firstAccepted, {
    message: "Second queued turn",
    queuedPayload: "Second queued turn",
    attachments: [],
    messageId: "queued-second",
    createdAt: "2026-08-19T10:04:00.000Z",
  });
  const bothAccepted = commitPromptTransaction(second.conversation, second.transaction);

  const firstDelivered = applyAuthoritativeUserMessageStart(
    bothAccepted,
    "First queued turn",
    "2026-08-19T10:05:00.000Z",
  );
  const afterFirstReply = {
    ...firstDelivered,
    messages: [...firstDelivered.messages, {
      id: "assistant-first",
      role: "assistant",
      content: "First queued answer",
      createdAt: "2026-08-19T10:05:01.000Z",
      status: "complete",
    }],
  };
  const secondDelivered = applyAuthoritativeUserMessageStart(
    afterFirstReply,
    "Second queued turn",
    "2026-08-19T10:06:00.000Z",
  );
  const final = {
    ...secondDelivered,
    messages: [...secondDelivered.messages, {
      id: "assistant-second",
      role: "assistant",
      content: "Second queued answer",
      createdAt: "2026-08-19T10:06:01.000Z",
      status: "complete",
    }],
  };

  assert.deepEqual(final.messages.map((message) => [message.role, message.content]), [
    ["assistant", "Initial answer"],
    ["user", "First queued turn"],
    ["assistant", "First queued answer"],
    ["user", "Second queued turn"],
    ["assistant", "Second queued answer"],
  ]);
});

test("queue mutations preserve duplicate indexes and update the authoritative snapshot", () => {
  const attachment = {
    id: "orbit-attachment:9b8ad0e7-8796-4a7b-9d47-82fd342d9ae8:0",
    name: "queued.txt",
    mimeType: "text/plain",
    size: 12,
    isImage: false,
  };
  const actions = {
    queuedCount: 3,
    steering: ["same"],
    followUps: ["same", "later"],
    queueAttachments: {
      steering: [[]],
      followUps: [[attachment], []],
    },
  };
  const edited = applyQueueMutationSnapshot(actions, "followUp", 0, "same", {
    type: "replace",
    text: "edited",
    lane: "followUp",
  });
  assert.deepEqual(edited.followUps, ["edited", "later"]);
  assert.deepEqual(edited.steering, ["same"]);
  assert.deepEqual(edited.queueAttachments.followUps, [[attachment], []]);

  const deleted = applyQueueMutationSnapshot(edited, "steering", 0, "same", { type: "delete" });
  assert.deepEqual(deleted.steering, []);
  assert.equal(deleted.queuedCount, 2);

  const movedLane = applyQueueMutationSnapshot(deleted, "followUp", 0, "edited", {
    type: "replace",
    text: "steered edit",
    lane: "steering",
  });
  assert.deepEqual(movedLane.steering, ["steered edit"]);
  assert.deepEqual(movedLane.queueAttachments.steering, [[attachment]]);
  assert.deepEqual(movedLane.queueAttachments.followUps, [[]]);
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

test("maps a visible assistant turn to Prime Agent's real fork entry", () => {
  const messages = [
    { id: "user-1", role: "user", content: "Inspect the project", createdAt: "2026-08-19T10:00:00.000Z", status: "complete" },
    { id: "assistant-1", role: "assistant", content: "First answer", createdAt: "2026-08-19T10:00:01.000Z", status: "complete" },
    { id: "user-2", role: "user", content: "Inspect   the project", createdAt: "2026-08-19T10:01:00.000Z", status: "complete" },
    { id: "assistant-2", role: "assistant", content: "Second answer", createdAt: "2026-08-19T10:01:01.000Z", status: "complete" },
  ];
  const candidates = [
    { entryId: "entry-first", text: "Inspect the project" },
    { entryId: "entry-second", text: "Inspect the project" },
  ];

  assert.equal(selectForkEntryId(messages, "assistant-1", candidates), "entry-first");
  assert.equal(selectForkEntryId(messages, "assistant-2", candidates), "entry-second");
});

test("falls back to the same user-message ordinal when display text was normalized upstream", () => {
  const messages = [
    { id: "user-1", role: "user", content: "Local attachment prompt", createdAt: "2026-08-19T10:00:00.000Z", status: "complete" },
    { id: "assistant-1", role: "assistant", content: "Done", createdAt: "2026-08-19T10:00:01.000Z", status: "complete" },
  ];

  assert.equal(
    selectForkEntryId(messages, "assistant-1", [{ entryId: "entry-1", text: "[attachment] Local attachment prompt" }]),
    "entry-1",
  );
});
