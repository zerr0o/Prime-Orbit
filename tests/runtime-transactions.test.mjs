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
  activeStatusForSessionActions,
  applyAuthoritativeUserMessageStart,
  applyRuntimeCompactingState,
  compactResponseDisposition,
  compactionEndPresentation,
  commitPlanRuntimeModeTransition,
  canResumePendingPlanFinalization,
  conversationStatusForSessionSnapshot,
  conversationHasPlanHandoff,
  conversationPlanState,
  planDocumentForReview,
  runtimeModeForConversationPlan,
  runtimeModeForPlan,
  sessionActionsHaveWork,
  desiredRuntimeModeForConversation,
  durableAttachmentMetadata,
  enqueueExtensionRequest,
  extensionRequestKey,
  finalizeAuthoritativeIdleSnapshot,
  handleMessageEvent,
  historicalToolInput,
  isAuthoritativeIdleSessionSnapshot,
  isTransientHistoryReadFailure,
  isTransientHistoryResponseFailure,
  isOptionalSelectionResponseFailure,
  isRecoverableConversationActivationError,
  isRecoverableRuntimeBootstrapError,
  mapAgentMessages,
  mergeHistoricalAttachmentPreviews,
  resolveNativePromptDelivery,
  promptAttachmentPayload,
  reconcileLocalTranscriptAfterRpc,
  reconcileRpcTranscript,
  recordedPlanResponseValue,
  selectForkEntryId,
  shouldApplyHistoryResponse,
  shouldEnterLocalHistoryLoading,
  shouldConsumeConversationResponse,
  stripLegacyOrbitQueueRows,
  shouldRecoverIdleSessionState,
  shouldApplySessionStateResponse,
  shouldScheduleTerminalStateReconciliation,
  isCompactDaemonAcknowledgementTimeout,
  isRefineDaemonAcknowledgementTimeout,
  refineLifecycleDisposition,
  refinementResultPresentation,
  rlmChildPresentation,
} = compiledModule.exports;

test("conversation Plan state selects the isolated runtime and recovers submitted Markdown", () => {
  const normal = conversationPlanState({});
  assert.deepEqual(normal, { phase: "idle", revision: 0 });
  assert.equal(runtimeModeForPlan(normal), "normal");
  assert.equal(
    desiredRuntimeModeForConversation({ planMode: normal }, "plan"),
    "plan",
    "an in-flight native transition overrides the still-stale persisted mode",
  );
  const planning = conversationPlanState({ planMode: { phase: "planning", revision: 1 } });
  assert.equal(runtimeModeForPlan(planning), "plan");
  assert.equal(runtimeModeForConversationPlan({ planMode: planning }), "plan");
  const pendingPlanAction = {
    decision: "apply",
    document: { name: "plan", markdown: "# Plan", round: 1 },
    relativePath: ".prime/plans/plan.md",
    handoffId: "handoff",
    stage: "applySending",
  };
  assert.equal(runtimeModeForConversationPlan({ planMode: planning, pendingPlanAction }), "normal");
  assert.equal(runtimeModeForConversationPlan({
    planMode: { phase: "idle", revision: 2, outcome: "applied" },
    pendingPlanAction: { ...pendingPlanAction, stage: "decisionRecorded" },
  }), "plan");
  assert.equal(recordedPlanResponseValue(
    { ...pendingPlanAction, stage: "decisionRecorded" },
    { options: ["apply-wire", "keep-wire", "revise-wire"] },
    { payload: { kind: "review" } },
  ), "apply-wire");

  const document = planDocumentForReview({
    messages: [{
      id: "assistant-1",
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
      status: "complete",
      tools: [{
        id: "tool-plan",
        name: "prime_orbit_plan_submit",
        title: "Plan",
        status: "running",
        input: { title: "Plan sûr", document: "# Plan\r\n\r\nÉtape" },
        startedAt: new Date().toISOString(),
      }],
    }],
  }, "tool-plan", "Plan sûr");
  assert.deepEqual(document, { name: "plan-sur", markdown: "# Plan\n\nÉtape" });
  assert.equal(planDocumentForReview({ messages: [] }, "missing", "Plan"), undefined);
});

test("a Plan mode switch publishes intent, restarts, then commits UI state", async () => {
  const events = [];
  let expectedMode;
  await commitPlanRuntimeModeTransition(
    "plan",
    async () => {
      events.push(`restart:sees:${expectedMode}`);
      await Promise.resolve();
      events.push("restart:complete");
      return "plan";
    },
    () => events.push(`persist:sees:${expectedMode}`),
    (mode) => {
      expectedMode = mode;
      events.push(`expected:${mode ?? "clear"}`);
    },
  );
  assert.deepEqual(events, [
    "expected:plan",
    "restart:sees:plan",
    "restart:complete",
    "persist:sees:plan",
    "expected:clear",
  ]);
});

test("a failed Plan mode restart leaves persisted mode untouched and clears intent", async () => {
  let persisted = false;
  let expectedMode;
  await assert.rejects(
    commitPlanRuntimeModeTransition(
      "plan",
      async () => "normal",
      () => { persisted = true; },
      (mode) => { expectedMode = mode; },
    ),
    /changer de mode|change runtime mode/,
  );
  assert.equal(persisted, false);
  assert.equal(expectedMode, undefined);
});

test("a conversation without a running native process persists its next startup mode", async () => {
  let persisted = false;
  await commitPlanRuntimeModeTransition("plan", undefined, () => { persisted = true; });
  assert.equal(persisted, true);
});

test("a stable Plan handoff marker reconciles an admitted Apply prompt after reload", () => {
  const handoffId = "artifact-123";
  assert.equal(conversationHasPlanHandoff({ messages: [{
    role: "user",
    content: `<!-- prime-orbit-plan-handoff:v1:${handoffId} -->\nImplement`,
  }] }, handoffId), true);
  assert.equal(conversationHasPlanHandoff({ messages: [] }, handoffId), false);
});

test("historical Plan submit keeps its typed Markdown projection above the generic history limit", () => {
  const markdown = `# Large plan\n\n${"step\n".repeat(4_000)}`;
  const input = historicalToolInput("prime_orbit_plan_submit", { title: "Large", document: markdown });
  assert.equal(typeof input, "object");
  assert.equal(input.title, "large");
  assert.equal(input.document, markdown);
  assert.ok(input.document.length > 16_000);
});

test("a transient get_messages timeout never masquerades as a runtime failure", () => {
  assert.equal(isTransientHistoryReadFailure(
    new Error("Prime Agent n’a pas répondu à get_messages."),
  ), true);
  assert.equal(isTransientHistoryReadFailure(
    new Error("Prime Agent n’a pas répondu à get_messages dans le délai prévu."),
  ), true);
  assert.equal(isTransientHistoryReadFailure(
    new Error('Cannot send daemon command "get_messages" because the Prime Agent daemon is not connected. Socket: \\.\pipe\prime-orbit-daemon. Daemon log: C:\safe\daemon.log.'),
  ), true);
  assert.equal(isTransientHistoryReadFailure(
    new Error('Cannot send daemon command "get_state" because the Prime Agent daemon is not connected.'),
  ), false);
  assert.equal(isTransientHistoryReadFailure(
    new Error("Prime Agent n’a pas répondu à get_state."),
  ), false);
  assert.equal(isTransientHistoryReadFailure(
    new Error("Prime Agent process exited unexpectedly"),
  ), false);
  assert.equal(isTransientHistoryResponseFailure({
    command: "get_messages",
    success: false,
    error: 'Cannot send daemon command "get_messages" because the Prime Agent daemon is not connected.',
  }), true);
  assert.equal(isTransientHistoryResponseFailure({
    command: "prompt",
    success: false,
    error: 'Cannot send daemon command "get_messages" because the Prime Agent daemon is not connected.',
  }), false);
});

test("optional bootstrap probes never masquerade as a conversation failure", () => {
  for (const command of [
    "get_available_models",
    "get_commands",
    "get_session_stats",
    "list_schedules",
    "get_heartbeat",
    "list_heartbeats",
  ]) {
    assert.equal(isOptionalSelectionResponseFailure({
      command,
      success: false,
      error: `Cannot send daemon command "${command}" because the Prime Agent daemon is not connected.`,
    }), true, command);
  }
  assert.equal(isOptionalSelectionResponseFailure({
    command: "list_heartbeats",
    success: false,
    error: "Unknown command: list_heartbeats",
  }), true);
  assert.equal(isOptionalSelectionResponseFailure({
    command: "list_heartbeats",
    success: false,
    error: "Session permission denied",
  }), false, "unexpected passive-read failures remain visible");
  assert.equal(isOptionalSelectionResponseFailure({
    command: "get_state",
    success: false,
    error: 'Cannot send daemon command "get_state" because the Prime Agent daemon is not connected.',
  }), false);
  assert.equal(isOptionalSelectionResponseFailure({ command: "prompt", success: false }), false);
  assert.equal(isOptionalSelectionResponseFailure({ command: "manage_heartbeat", success: false }), false);
  assert.equal(isOptionalSelectionResponseFailure({ command: "list_heartbeats", success: true }), false);
});

test("only transient selection races qualify for automatic prompt recovery", () => {
  assert.equal(isRecoverableConversationActivationError(
    new DOMException("La conversation n’est plus active.", "AbortError"),
  ), true);
  assert.equal(isRecoverableConversationActivationError(
    new DOMException("The conversation load was replaced by another conversation.", "AbortError"),
  ), true);
  assert.equal(isRecoverableConversationActivationError(
    new Error("La conversation n’est plus active."),
  ), false, "an unrelated error with the same text is not retried");
  assert.equal(isRecoverableConversationActivationError(
    new DOMException("La fenêtre se ferme.", "AbortError"),
  ), false);
});

test("only lost native clients and daemon lease races qualify for runtime bootstrap recovery", () => {
  assert.equal(isRecoverableRuntimeBootstrapError(
    new Error("Aucun Prime Agent actif pour conversation-123"),
  ), true);
  assert.equal(isRecoverableRuntimeBootstrapError(
    new Error("SessionAlreadyActiveError: Session is already active in 17e1c622ab16"),
  ), true);
  assert.equal(isRecoverableRuntimeBootstrapError(
    new Error("Session is registered to a failed worker that could not be safely reclaimed"),
  ), true);
  assert.equal(isRecoverableRuntimeBootstrapError(
    new Error('Cannot send daemon command "get_state" because the Prime Agent daemon is not connected.'),
  ), true);
  assert.equal(isRecoverableRuntimeBootstrapError(
    new Error('Cannot send daemon command "prompt" because the Prime Agent daemon is not connected.'),
  ), false, "a prompt transport failure must never be replayed automatically");
  assert.equal(isRecoverableRuntimeBootstrapError(
    new Error("Cannot find package 'zeromq'"),
  ), false, "installation failures remain actionable instead of looping");
});

test("an empty RPC history cannot be relatched into local-history loading", () => {
  const hydratedEmptyConversation = conversation({
    status: "idle",
    sessionPath: "C:/safe/session.jsonl",
    messages: [],
  });
  assert.equal(shouldEnterLocalHistoryLoading(hydratedEmptyConversation, true), false);
  assert.equal(
    shouldEnterLocalHistoryLoading({ ...hydratedEmptyConversation, status: "offline" }, true),
    false,
    "the synchronous RPC marker wins even if React still exposes the previous offline render",
  );
  assert.equal(
    shouldEnterLocalHistoryLoading({ ...hydratedEmptyConversation, status: "offline" }, false),
    true,
    "a persisted saved conversation may show loading before either history source finishes",
  );
  assert.equal(
    shouldEnterLocalHistoryLoading({ ...hydratedEmptyConversation, status: "streaming" }, false),
    false,
    "local history never overwrites a live runtime state",
  );
});

test("an idle bootstrap snapshot cannot erase a prompt admission still in progress", () => {
  assert.equal(shouldRecoverIdleSessionState(true, false, true), false);
  assert.equal(shouldRecoverIdleSessionState(true, false, false), true);
  assert.equal(shouldRecoverIdleSessionState(true, true, false), false);
});

test("a prompt submitted while only connecting starts normally instead of entering follow-up", () => {
  assert.equal(resolveNativePromptDelivery("starting", "follow_up", false), undefined);
  assert.equal(resolveNativePromptDelivery("starting", "steer", false), undefined);
  assert.equal(resolveNativePromptDelivery("starting", "follow_up", true), "follow_up");
  assert.equal(resolveNativePromptDelivery("streaming", undefined, true), "steer");
  assert.equal(resolveNativePromptDelivery("tool", undefined, true, true), "follow_up");
  assert.equal(resolveNativePromptDelivery("tool", "steer", true, true), "follow_up");
});

const idleSessionSnapshot = (overrides = {}) => ({
  isStreaming: false,
  isCompacting: false,
  sessionActions: {
    queuedCount: 0,
    steering: [],
    followUps: [],
  },
  ...overrides,
});

test("uses only a quiescent daemon state snapshot as an idle recovery boundary", () => {
  assert.equal(isAuthoritativeIdleSessionSnapshot(idleSessionSnapshot()), true);
  assert.equal(isAuthoritativeIdleSessionSnapshot(idleSessionSnapshot({ isStreaming: true })), false);
  assert.equal(isAuthoritativeIdleSessionSnapshot(idleSessionSnapshot({ isCompacting: true })), false);
  assert.equal(isAuthoritativeIdleSessionSnapshot(idleSessionSnapshot({
    sessionActions: { queuedCount: 1, steering: [], followUps: ["next"] },
  })), true, "a preserved native queue is idle until Prime Agent activates an action");
  assert.equal(isAuthoritativeIdleSessionSnapshot(idleSessionSnapshot({
    sessionActions: {
      queuedCount: 0,
      steering: [],
      followUps: [],
      active: { kind: "turn", phase: "running" },
    },
  })), false);
});

test("an active daemon session action remains visible and forces queued prompt delivery", () => {
  const activePlanTool = idleSessionSnapshot({
    sessionActions: {
      queuedCount: 0,
      steering: [],
      followUps: [],
      active: { kind: "turn", phase: "running", label: "prime_orbit_plan_submit" },
    },
  });
  assert.equal(sessionActionsHaveWork(activePlanTool.sessionActions), true);
  assert.equal(activeStatusForSessionActions(activePlanTool.sessionActions), "streaming");
  assert.equal(conversationStatusForSessionSnapshot(activePlanTool, "idle", false), "streaming");
  assert.equal(canResumePendingPlanFinalization(activePlanTool, false), false);
  assert.equal(canResumePendingPlanFinalization(idleSessionSnapshot(), true), false);
  assert.equal(canResumePendingPlanFinalization(idleSessionSnapshot(), false), true);
  assert.equal(conversationStatusForSessionSnapshot(idleSessionSnapshot({
    sessionActions: {
      queuedCount: 0,
      steering: [],
      followUps: [],
      active: { kind: "session_command", phase: "committing" },
    },
  }), "idle", false), "tool");
  assert.equal(activeStatusForSessionActions(idleSessionSnapshot().sessionActions), undefined);
  const preservedQueue = idleSessionSnapshot({
    sessionActions: { queuedCount: 1, steering: ["resume me"], followUps: [] },
  });
  assert.equal(sessionActionsHaveWork(preservedQueue.sessionActions), false);
  assert.equal(activeStatusForSessionActions(preservedQueue.sessionActions), undefined);
  assert.equal(conversationStatusForSessionSnapshot(preservedQueue, "streaming", false), "idle");
  assert.equal(resolveNativePromptDelivery("idle", undefined, sessionActionsHaveWork(preservedQueue.sessionActions)), undefined);
});

test("rejects an idle snapshot requested before a newer prompt or lifecycle epoch", () => {
  assert.equal(shouldApplySessionStateResponse(12, 12), true);
  assert.equal(shouldApplySessionStateResponse(12, 13), false);
  assert.equal(shouldApplySessionStateResponse(undefined, 0), false);
});

test("terminal-looking events request state reconciliation without treating message_end as idle", () => {
  assert.equal(shouldScheduleTerminalStateReconciliation({ type: "turn_end" }), true);
  assert.equal(shouldScheduleTerminalStateReconciliation({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop" },
  }), true);
  assert.equal(shouldScheduleTerminalStateReconciliation({
    type: "message_end",
    message: { role: "assistant", stopReason: "toolUse" },
  }), false);
  assert.equal(shouldScheduleTerminalStateReconciliation({
    type: "message_end",
    message: { role: "user" },
  }), false);
  assert.equal(shouldScheduleTerminalStateReconciliation({ type: "agent_end" }), false);
});

test("an authoritative idle snapshot closes orphaned Python tools and their running activity", () => {
  const recovered = finalizeAuthoritativeIdleSnapshot(conversation({
    status: "tool",
    messages: [{
      id: "assistant-python",
      role: "assistant",
      content: "Finished",
      createdAt: "2026-08-21T11:29:16.000Z",
      status: "complete",
      tools: [{
        id: "call-python",
        name: "ipython",
        title: "Python",
        status: "running",
        startedAt: "2026-08-21T11:28:16.000Z",
      }],
    }],
    activities: [{
      id: "tool:call-python",
      type: "tool_execution_start",
      title: "Python en cours",
      status: "running",
      createdAt: "2026-08-21T11:28:16.000Z",
      raw: { toolName: "ipython" },
    }],
  }), "2026-08-21T11:29:17.000Z");

  assert.equal(recovered.status, "idle");
  assert.equal(recovered.messages[0].tools[0].status, "completed");
  assert.equal(recovered.messages[0].tools[0].endedAt, "2026-08-21T11:29:17.000Z");
  assert.equal(recovered.activities[0].status, "success");
  assert.equal(recovered.lastError, undefined);

  assert.equal(
    resolveNativePromptDelivery(recovered.status, undefined, false),
    undefined,
    "the next prompt starts a normal native turn after authoritative recovery",
  );
});

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

test("removes renderer-owned queue artifacts without touching native transcript rows", () => {
  const cleaned = stripLegacyOrbitQueueRows(conversation({
    messages: [
      { id: "legacy-queue", role: "user", content: "Queued", status: "complete", queueDelivery: "steer" },
      { id: "legacy-pending", role: "user", content: "Pending", status: "pending" },
      { id: "native-user", role: "user", content: "Native", status: "complete", entryId: "entry-native" },
      { id: "assistant", role: "assistant", content: "Done", status: "complete" },
    ],
  }));

  assert.deepEqual(cleaned.messages.map((message) => message.id), ["native-user", "assistant"]);
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

test("an empty RPC transcript never erases a validated persisted conversation", () => {
  const localMessage = {
    id: "persisted-user",
    role: "user",
    content: "Existing session content",
    createdAt: "2026-08-24T18:30:27.390Z",
    status: "complete",
  };
  const current = [localMessage];
  assert.equal(
    reconcileRpcTranscript(current, []),
    current,
    "an empty daemon response preserves the already rendered transcript by identity",
  );
  assert.deepEqual(
    reconcileLocalTranscriptAfterRpc([], current),
    current,
    "local history fills the transcript when an empty RPC response won the race",
  );
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

test("distinguishes a parent-managed subagent closure from a real cancellation", () => {
  assert.deepEqual(rlmChildPresentation({
    label: "reviewer",
    status: "cancelled",
    error: "Deleted by parent orchestrator",
    recap: "Review delivered",
  }, "cancelled"), {
    title: "Sous-agent « reviewer » fermé par l’agent principal",
    detail: "Review delivered",
    status: "info",
  });
  assert.deepEqual(rlmChildPresentation({
    label: "reviewer",
    status: "cancelled",
    error: "Cancelled by user",
  }, "cancelled"), {
    title: "Sous-agent « reviewer » annulé",
    detail: "Cancelled by user",
    status: "warning",
  });
  assert.equal(rlmChildPresentation({ label: "reviewer", error: "Provider unavailable" }, "error").status, "error");
});

test("renders a live agent message once with only its useful structured body", () => {
  const agentMessage = {
    role: "custom",
    customType: "agent_message",
    display: true,
    content: "[from child:reviewer]\nAgent-to-agent message received.\nSource: agent_message\nMessage id: agentmsg_live\n\nDo not render this envelope.",
    details: {
      id: "agentmsg_live",
      message: "Audit complete. No files edited.",
      from: { sessionName: "reviewer", activeSessionId: "child-active" },
      fromRelationship: "child",
    },
    timestamp: "2026-08-20T22:42:16.353Z",
  };
  let current = conversation();
  const update = (_conversationId, updater) => {
    current = typeof updater === "function" ? updater(current) : { ...current, ...updater };
  };

  handleMessageEvent("conversation-a", { type: "message_start", message: agentMessage }, update);
  handleMessageEvent("conversation-a", { type: "message_end", message: agentMessage }, update);
  handleMessageEvent("conversation-a", { type: "message_start", message: agentMessage }, update);

  assert.equal(current.messages.length, 1);
  assert.equal(current.messages[0].content, "Audit complete. No files edited.");
  assert.deepEqual(current.messages[0].notice, {
    kind: "agent_message",
    messageId: "agentmsg_live",
    participant: "reviewer",
    relationship: "child",
  });
  assert.doesNotMatch(current.messages[0].content, /Source:|Message id:/u);
});

test("renders Prime Agent 0.8 refinement outcomes once without private edit snapshots", () => {
  const refinement = {
    role: "custom",
    customType: "refinement_outcome",
    display: true,
    content: "Refinement complete: wire fallback",
    details: {
      refinementId: "refine_live",
      summary: "Keep the validated migration fact.",
      scope: "global",
      edits: [{ action: "create", kind: "memory", id: "runtime-v080", title: "Prime Agent 0.8", applied: true }],
    },
    timestamp: "2026-08-22T12:00:00.000Z",
  };
  let current = conversation();
  const update = (_conversationId, updater) => {
    current = typeof updater === "function" ? updater(current) : { ...current, ...updater };
  };

  handleMessageEvent("conversation-a", { type: "message_start", message: refinement }, update);
  handleMessageEvent("conversation-a", { type: "message_end", message: refinement }, update);
  handleMessageEvent("conversation-a", { type: "message_start", message: refinement }, update);

  assert.equal(current.messages.length, 1);
  assert.equal(current.messages[0].content, "Keep the validated migration fact.");
  assert.equal(current.messages[0].notice.kind, "refinement_outcome");
  assert.equal(current.messages[0].notice.refinementId, "refine_live");
});

test("restores a durable Prime Agent 0.8 refinement outcome as a typed notice", () => {
  const mapped = mapAgentMessages([{
    id: "entry-refine-history",
    role: "custom",
    customType: "refinement_outcome",
    display: true,
    content: "Persist the durable migration outcome.",
    details: {
      refinementId: "refine_history",
      summary: "Persist the durable migration outcome.",
      scope: "local",
      edits: [{ action: "update", kind: "memory", id: "runtime-v080", applied: true }],
    },
  }]);

  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].id, "entry-refine-history");
  assert.equal(mapped[0].role, "system");
  assert.equal(mapped[0].notice.kind, "refinement_outcome");
  assert.equal(mapped[0].notice.refinementId, "refine_history");
});

test("does not invent cancellation for a persisted tool call without a result", () => {
  const [message] = mapAgentMessages([{
    id: "assistant-plan-questions",
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "question-live",
      name: "prime_orbit_plan_question",
      arguments: { prompt: "Choose a stack", options: [{ label: "Vite", value: "vite" }] },
    }],
    timestamp: 1_787_610_374_546,
  }]);

  assert.equal(message.tools[0].status, "unresolved");
  assert.equal(message.tools[0].endedAt, undefined);
});

test("deduplicates structured and canonical legacy agent messages in restored history", () => {
  const canonical = [
    "[from child:reviewer]",
    "Agent-to-agent message received.",
    "Source: agent_message",
    "From: reviewer, active child-active, session child-session",
    "To: active parent-active, session parent-session",
    "Message id: agentmsg_history",
    "",
    "History audit complete.",
  ].join("\n");
  const mapped = mapAgentMessages([
    {
      role: "custom",
      customType: "agent_message",
      display: true,
      content: canonical,
      details: {
        id: "agentmsg_history",
        message: "History audit complete.",
        from: { sessionName: "reviewer" },
        fromRelationship: "child",
      },
    },
    { role: "custom", display: true, content: canonical },
  ]);

  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].content, "History audit complete.");
  assert.equal(mapped[0].notice.messageId, "agentmsg_history");
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

test("authoritative user events remain distinct by Prime Agent identity", () => {
  const first = applyAuthoritativeUserMessageStart(
    conversation(),
    "same text",
    "2026-08-19T10:01:00.000Z",
    [],
    "entry-first",
  );
  const second = applyAuthoritativeUserMessageStart(
    first,
    "same text",
    "2026-08-19T10:02:00.000Z",
    [],
    "entry-second",
  );
  const duplicate = applyAuthoritativeUserMessageStart(
    second,
    "same text",
    "2026-08-19T10:02:00.000Z",
    [],
    "entry-second",
  );

  assert.deepEqual(second.messages.map((message) => message.entryId), ["entry-first", "entry-second"]);
  assert.equal(duplicate.messages.length, 2);
});

test("RPC history removes legacy local queue rows instead of reconciling them", () => {
  const current = [
    { id: "legacy", role: "user", content: "queued", status: "complete", queueDelivery: "follow_up" },
  ];
  const rpc = [
    { id: "entry-native", entryId: "entry-native", role: "user", content: "queued", status: "complete" },
  ];

  assert.deepEqual(reconcileRpcTranscript(current, rpc), rpc);
  assert.deepEqual(reconcileRpcTranscript(current, []), []);
});

test("a terminal history response cannot overwrite a newer prompt or run", () => {
  assert.equal(shouldApplyHistoryResponse(4, 4, false), true);
  assert.equal(shouldApplyHistoryResponse(4, 5, false), false);
  assert.equal(shouldApplyHistoryResponse(4, 4, true), false);
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
