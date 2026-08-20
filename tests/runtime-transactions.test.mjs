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
  applyRuntimeCompactingState,
  beginPromptTransaction,
  compactResponseDisposition,
  compactionEndPresentation,
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
  shouldClearPromptRunAfterQueueDeletion,
  shouldConsumeConversationResponse,
  shouldReloadQueuedTranscript,
  isCompactDaemonAcknowledgementTimeout,
  isRefineDaemonAcknowledgementTimeout,
  refineLifecycleDisposition,
  refinementResultPresentation,
} = compiledModule.exports;

test("goal prompt responses stay scoped to their mutation, including late failures", () => {
  assert.equal(shouldConsumeConversationResponse(undefined), false);
  assert.equal(shouldConsumeConversationResponse("goal_mutation"), true);
  assert.equal(shouldConsumeConversationResponse(undefined, true), true);
});

const COMPACT_ACK_TIMEOUT = 'Timed out after 30000ms waiting for the Prime Agent daemon response to "compact". Endpoint: \\\\.\\pipe\\prime-agent';

test("treats only the exact 30 second compact daemon acknowledgement timeout as pending", () => {
  const timeout = { command: "compact", success: false, error: COMPACT_ACK_TIMEOUT };
  assert.equal(isCompactDaemonAcknowledgementTimeout(timeout), true);
  assert.equal(compactResponseDisposition(timeout, false), "pending");
  assert.equal(compactResponseDisposition(timeout, true), "lifecycle_handled", "a terminal event always wins the response race");
  assert.equal(isCompactDaemonAcknowledgementTimeout({ ...timeout, command: "refine" }), false);
  assert.equal(isCompactDaemonAcknowledgementTimeout({ ...timeout, error: timeout.error.replace("30000ms", "60000ms") }), false);
  assert.equal(isCompactDaemonAcknowledgementTimeout({ ...timeout, error: "Cannot compact: no model selected" }), false);
  assert.equal(compactResponseDisposition({ command: "compact", success: false, error: "Cannot compact: no model selected" }, false), "failure");
});

test("keeps daemon refine acknowledgement timeouts distinct from real failures", () => {
  const timeout = {
    command: "refine",
    success: false,
    error: 'Timed out after 600000ms waiting for the Prime Agent daemon response to "refine". Socket: \\\\.\\pipe\\prime-agent-daemon.',
  };
  assert.equal(isRefineDaemonAcknowledgementTimeout(timeout), true);
  assert.equal(isRefineDaemonAcknowledgementTimeout({ ...timeout, command: "compact" }), false);
  assert.equal(isRefineDaemonAcknowledgementTimeout({ ...timeout, error: "Refinement requires a persisted session" }), false);
});

test("an uncorrelated refine terminal never closes a direct request owned by this window", () => {
  assert.equal(refineLifecycleDisposition(true), "await_local_response");
  assert.equal(refineLifecycleDisposition(false), "passive_terminal");
});

test("summarizes exact refinement results without exposing harness paths", () => {
  const result = refinementResultPresentation({
    id: "refine-42",
    summary: "Updated delegation guidance",
    scope: "local",
    harnessStatePath: "C:\\private\\harness_state.json",
    appliedEdits: [{ applied: true }, { applied: false }, { applied: true }],
  });
  assert.deepEqual(result, {
    activityId: "refinement:refine-42",
    title: "Raffinement appliqué",
    detail: "Updated delegation guidance · 2 modifications appliquées · Portée locale",
    appliedEdits: 2,
  });
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.deepEqual(refinementResultPresentation({ id: "refine-empty", appliedEdits: [] }), {
    activityId: "refinement:refine-empty",
    title: "Raffinement terminé",
    detail: "Aucune modification appliquée",
    appliedEdits: 0,
  });
});

test("uses compaction_end as the authoritative terminal outcome", () => {
  assert.deepEqual(compactionEndPresentation({ aborted: false, willRetry: false }), {
    title: "Contexte compacté",
    detail: undefined,
    status: "success",
    failed: false,
  });
  assert.equal(compactionEndPresentation({ aborted: false, willRetry: true }).status, "running");
  assert.equal(compactionEndPresentation({ aborted: true, willRetry: false }).status, "warning");
  assert.deepEqual(compactionEndPresentation({
    aborted: false,
    willRetry: false,
    errorMessage: "Nothing to compact",
    errorSeverity: "warning",
  }), {
    title: "Compactage non nécessaire",
    detail: "Nothing to compact",
    status: "warning",
    failed: false,
  });
  assert.equal(compactionEndPresentation({
    aborted: false,
    willRetry: false,
    errorMessage: "Provider failed",
    errorSeverity: "error",
  }).failed, true);
  assert.deepEqual(compactionEndPresentation({
    aborted: false,
    willRetry: false,
    errorMessage: "Automatic compaction failed: provider unavailable",
  }), {
    title: "Échec du compactage",
    detail: "Automatic compaction failed: provider unavailable",
    status: "error",
    failed: true,
  });
});

test("keeps compaction visible when start races the first get_state response", () => {
  const startedBeforeState = applyRuntimeCompactingState(undefined, true);
  assert.equal(startedBeforeState.isCompacting, true);
  assert.equal(startedBeforeState.state, undefined, "no incomplete AgentSessionState is invented");

  const endedBeforeState = applyRuntimeCompactingState(startedBeforeState, false, true);
  assert.equal(endedBeforeState.isCompacting, false);
  assert.equal(endedBeforeState.state, undefined);
});

test("clears a phantom prompt run only after the last compact-time queue row is deleted", () => {
  const queued = {
    id: "queued-1",
    role: "user",
    content: "Continue after compact",
    createdAt: "2026-08-20T14:23:50.000Z",
    status: "complete",
    queueDelivery: "follow_up",
  };
  const deleted = { type: "delete" };
  const emptyActions = { queuedCount: 0, steering: [], followUps: [] };

  assert.equal(shouldClearPromptRunAfterQueueDeletion(deleted, [], emptyActions, false), true);
  assert.equal(
    shouldClearPromptRunAfterQueueDeletion(deleted, [queued], emptyActions, false),
    false,
    "another local queue row still owns the optimistic run marker",
  );
  assert.equal(
    shouldClearPromptRunAfterQueueDeletion(deleted, [], { ...emptyActions, followUps: ["later"] }, false),
    false,
    "Prime Agent still has queued work even if the local row disappeared",
  );
  assert.equal(
    shouldClearPromptRunAfterQueueDeletion(deleted, [], emptyActions, true),
    false,
    "a real agent_start/agent_end lifecycle must not be cleared by queue editing",
  );
  assert.equal(
    shouldClearPromptRunAfterQueueDeletion({ type: "move", direction: 1 }, [], emptyActions, false),
    false,
  );
});

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

test("a message submitted while compaction owns the session is a follow-up, not a concurrent prompt", () => {
  const prepared = beginPromptTransaction(conversation({ status: "tool" }), {
    message: "Continue after compaction",
    attachments: [],
    messageId: "user-during-compaction",
    createdAt: "2026-08-19T10:04:15.000Z",
  });

  assert.equal(prepared.conversation.status, "queued");
  assert.equal(prepared.conversation.messages[0].queueDelivery, "follow_up");
  assert.equal(prepared.conversation.messages[0].queueObserved, false);
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

test("an accepted steer consumed before its first snapshot requests terminal history repair", () => {
  const prepared = beginPromptTransaction(conversation({ status: "streaming" }), {
    message: "Use this constraint now",
    queuedPayload: "Use this constraint now",
    attachments: [],
    messageId: "steer-consumed-fast",
    createdAt: "2026-08-19T10:04:50.000Z",
    queuedDelivery: "steer",
  });
  const terminalActions = {
    queuedCount: 0,
    steering: [],
    followUps: [],
  };

  assert.equal(
    shouldReloadQueuedTranscript(prepared.conversation, terminalActions),
    false,
    "a local row is not durable until Prime Agent accepts the prompt",
  );
  const accepted = commitPromptTransaction(prepared.conversation, prepared.transaction);
  const neverObserved = reconcileQueuedMessages(accepted, terminalActions);
  assert.equal(neverObserved.messages[0].queueAccepted, true);
  assert.equal(neverObserved.messages[0].queueObserved, false);
  assert.equal(
    shouldReloadQueuedTranscript(neverObserved, terminalActions),
    true,
    "RPC acceptance plus an empty terminal snapshot must repair a missed queue-to-active transition",
  );
  assert.equal(shouldReloadQueuedTranscript(neverObserved, {
    ...terminalActions,
    active: { kind: "turn", phase: "running", label: "Use this constraint now" },
  }), false, "persisted history is not applied over an active run");
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

test("authoritative attachments select the matching duplicate queue row", () => {
  const followUpAttachment = {
    id: "orbit-attachment:9b8ad0e7-8796-4a7b-9d47-82fd342d9ae8:0",
    name: "follow-up.pdf",
    mimeType: "application/pdf",
    size: 101,
    isImage: false,
    attachmentHandle: "follow-up-capability",
  };
  const steerAttachment = {
    id: "orbit-attachment:7dc622c6-e8be-4104-8f78-528d28f5ec04:0",
    name: "steer.pdf",
    mimeType: "application/pdf",
    size: 202,
    isImage: false,
    attachmentHandle: "steer-capability",
  };
  const followUp = beginPromptTransaction(conversation({ status: "streaming" }), {
    message: "same constraint",
    queuedPayload: "same constraint",
    attachments: [followUpAttachment],
    messageId: "duplicate-follow-up",
    createdAt: "2026-08-19T10:05:00.000Z",
    queuedDelivery: "follow_up",
  });
  const steer = beginPromptTransaction(
    commitPromptTransaction(followUp.conversation, followUp.transaction),
    {
      message: "same constraint",
      queuedPayload: "same constraint",
      attachments: [steerAttachment],
      messageId: "duplicate-steer",
      createdAt: "2026-08-19T10:06:00.000Z",
      queuedDelivery: "steer",
    },
  );
  const accepted = commitPromptTransaction(steer.conversation, steer.transaction);
  const delivered = applyAuthoritativeUserMessageStart(
    accepted,
    "same constraint",
    "2026-08-19T10:07:00.000Z",
    [durableAttachmentMetadata(steerAttachment)],
    "entry-steer",
  );

  assert.equal(delivered.messages.find((message) => message.id === "duplicate-follow-up").queueDelivery, "follow_up");
  const deliveredSteer = delivered.messages.find((message) => message.id === "duplicate-steer");
  assert.equal(deliveredSteer.queueDelivery, undefined);
  assert.equal(deliveredSteer.entryId, "entry-steer");
  assert.equal(deliveredSteer.attachments[0].name, "steer.pdf");
  assert.equal("attachmentHandle" in deliveredSteer.attachments[0], false);
});

test("authoritative attachments never consume a different same-text local row", () => {
  const localAttachment = {
    id: "orbit-attachment:9b8ad0e7-8796-4a7b-9d47-82fd342d9ae8:0",
    name: "local.pdf",
    mimeType: "application/pdf",
    size: 101,
    isImage: false,
    attachmentHandle: "local-capability",
  };
  const otherWindowAttachment = {
    id: "orbit-attachment:7dc622c6-e8be-4104-8f78-528d28f5ec04:0",
    name: "other-window.pdf",
    mimeType: "application/pdf",
    size: 202,
    isImage: false,
  };
  const local = beginPromptTransaction(conversation({ status: "streaming" }), {
    message: "same cross-window text",
    queuedPayload: "same cross-window text",
    attachments: [localAttachment],
    messageId: "local-queued-row",
    createdAt: "2026-08-19T10:05:00.000Z",
    queuedDelivery: "steer",
  });
  const delivered = applyAuthoritativeUserMessageStart(
    commitPromptTransaction(local.conversation, local.transaction),
    "same cross-window text",
    "2026-08-19T10:06:00.000Z",
    [otherWindowAttachment],
    "entry-other-window",
  );

  assert.equal(delivered.messages.find((message) => message.id === "local-queued-row").queueDelivery, "steer");
  const authoritative = delivered.messages.find((message) => message.id === "entry-other-window");
  assert.equal(authoritative.queueDelivery, undefined);
  assert.equal(authoritative.attachments[0].name, "other-window.pdf");
});

test("a text-only event never consumes a same-text queued attachment", () => {
  const attachment = {
    id: "orbit-attachment:9b8ad0e7-8796-4a7b-9d47-82fd342d9ae8:0",
    name: "queued.pdf",
    mimeType: "application/pdf",
    size: 101,
    isImage: false,
    attachmentHandle: "queued-capability",
  };
  const queued = beginPromptTransaction(conversation({ status: "streaming" }), {
    message: "same text-only content",
    queuedPayload: "same text-only content",
    attachments: [attachment],
    messageId: "queued-with-attachment",
    createdAt: "2026-08-19T10:05:00.000Z",
    queuedDelivery: "steer",
  });
  const delivered = applyAuthoritativeUserMessageStart(
    commitPromptTransaction(queued.conversation, queued.transaction),
    "same text-only content",
    "2026-08-19T10:06:00.000Z",
    [],
    "entry-text-only",
  );

  assert.equal(delivered.messages.find((message) => message.id === "queued-with-attachment").queueDelivery, "steer");
  assert.equal(delivered.messages.find((message) => message.id === "entry-text-only").attachments, undefined);
});

test("non-queued fallbacks never merge a same-text event with different attachments", () => {
  const localAttachment = {
    id: "orbit-attachment:9b8ad0e7-8796-4a7b-9d47-82fd342d9ae8:0",
    name: "a.pdf",
    mimeType: "application/pdf",
    size: 101,
    isImage: false,
  };
  const authoritativeAttachment = {
    id: "orbit-attachment:7dc622c6-e8be-4104-8f78-528d28f5ec04:0",
    name: "b.pdf",
    mimeType: "application/pdf",
    size: 202,
    isImage: false,
  };
  const localMessage = {
    id: "local-non-queued",
    role: "user",
    content: "same prompt",
    createdAt: "2026-08-19T10:05:00.000Z",
    status: "complete",
    attachments: [localAttachment],
  };
  const delivered = applyAuthoritativeUserMessageStart(
    conversation({ messages: [localMessage] }),
    "same prompt",
    "2026-08-19T10:06:00.000Z",
    [authoritativeAttachment],
    "entry-other-window",
  );

  assert.deepEqual(delivered.messages.map((message) => message.id), ["local-non-queued", "entry-other-window"]);
  assert.equal(delivered.messages[0].attachments[0].name, "a.pdf");
  assert.equal(delivered.messages[1].attachments[0].name, "b.pdf");

  const pending = applyAuthoritativeUserMessageStart(
    conversation({ messages: [{ ...localMessage, status: "pending" }] }),
    "same prompt",
    "2026-08-19T10:06:00.000Z",
    [authoritativeAttachment],
    "entry-other-window-pending",
  );
  assert.deepEqual(pending.messages.map((message) => message.id), ["local-non-queued", "entry-other-window-pending"]);
  assert.equal(pending.messages[0].status, "pending");
});

test("ambiguous identical non-queued echoes append instead of stealing another window's row", () => {
  const localRows = ["window-a", "window-b"].map((id, index) => ({
    id,
    role: "user",
    content: "identical cross-window prompt",
    createdAt: `2026-08-19T10:0${index + 5}:00.000Z`,
    status: "pending",
  }));
  const delivered = applyAuthoritativeUserMessageStart(
    conversation({ messages: localRows }),
    "identical cross-window prompt",
    "2026-08-19T10:07:00.000Z",
    [],
    "entry-authoritative",
  );

  assert.deepEqual(delivered.messages.map((message) => message.id), [
    "window-a",
    "window-b",
    "entry-authoritative",
  ]);
  assert.deepEqual(delivered.messages.slice(0, 2).map((message) => message.status), ["pending", "pending"]);

  const persistedCollision = applyAuthoritativeUserMessageStart(
    conversation({ messages: [{ ...localRows[0], status: "complete", entryId: "entry-window-a" }] }),
    "identical cross-window prompt",
    "2026-08-19T10:08:00.000Z",
    [],
    "entry-window-b",
  );
  assert.deepEqual(persistedCollision.messages.map((message) => message.entryId), [
    "entry-window-a",
    "entry-window-b",
  ]);
});

test("steer priority resolves one duplicate across lanes without swapping the follow-up", () => {
  const followUp = beginPromptTransaction(conversation({ status: "streaming" }), {
    message: "same text",
    queuedPayload: "same text",
    attachments: [],
    messageId: "same-follow-up",
    createdAt: "2026-08-19T10:05:00.000Z",
    queuedDelivery: "follow_up",
  });
  const steer = beginPromptTransaction(
    commitPromptTransaction(followUp.conversation, followUp.transaction),
    {
      message: "same text",
      queuedPayload: "same text",
      attachments: [],
      messageId: "same-steer",
      createdAt: "2026-08-19T10:06:00.000Z",
      queuedDelivery: "steer",
    },
  );
  const delivered = applyAuthoritativeUserMessageStart(
    commitPromptTransaction(steer.conversation, steer.transaction),
    "same text",
    "2026-08-19T10:07:00.000Z",
    [],
    "entry-steer-no-attachment",
  );

  assert.equal(delivered.messages.find((message) => message.id === "same-follow-up").queueDelivery, "follow_up");
  assert.equal(delivered.messages.find((message) => message.id === "same-steer").queueDelivery, undefined);
});

test("ambiguous duplicates in one lane wait for persisted history", () => {
  const first = beginPromptTransaction(conversation({ status: "streaming" }), {
    message: "identical steer",
    queuedPayload: "identical steer",
    attachments: [],
    messageId: "ambiguous-first",
    createdAt: "2026-08-19T10:05:00.000Z",
    queuedDelivery: "steer",
  });
  const second = beginPromptTransaction(
    commitPromptTransaction(first.conversation, first.transaction),
    {
      message: "identical steer",
      queuedPayload: "identical steer",
      attachments: [],
      messageId: "ambiguous-second",
      createdAt: "2026-08-19T10:06:00.000Z",
      queuedDelivery: "steer",
    },
  );
  const delivered = applyAuthoritativeUserMessageStart(
    commitPromptTransaction(second.conversation, second.transaction),
    "identical steer",
    "2026-08-19T10:07:00.000Z",
    [],
    "entry-ambiguous",
  );

  assert.deepEqual(
    delivered.messages.filter((message) => message.queueDelivery).map((message) => message.id),
    ["ambiguous-first", "ambiguous-second"],
  );
  assert.deepEqual(
    delivered.messages.filter((message) => !message.queueDelivery).map((message) => message.id),
    ["entry-ambiguous"],
  );
  assert.equal(shouldReloadQueuedTranscript(delivered, {
    queuedCount: 0,
    steering: [],
    followUps: [],
  }), true);
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
  assert.deepEqual(
    lateActiveSnapshot.messages.filter((message) => !message.queueDelivery).map((message) => message.id),
    ["assistant-previous", "assistant-current"],
    "Prime Agent's late running snapshot cannot append the user row after its reply",
  );

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
    queuedCount: 0,
    steering: [],
    followUps: [],
  }, true), false, "a queue repair must never rehydrate a pre-compaction transcript");
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
