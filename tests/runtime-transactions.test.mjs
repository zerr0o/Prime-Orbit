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
  canFinalizePendingPlanDecision,
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
  matchingNativePlanRequest,
  mergeHistoricalAttachmentPreviews,
  hasAttestedPlanReplayAbsence,
  planReplayProbeIdentity,
  resolveNativePromptDelivery,
  promptAttachmentPayload,
  reconcileLocalTranscriptAfterRpc,
  reconcileRpcTranscript,
  cancelUnresolvedPlanDialogs,
  recordedPlanResponseValue,
  selectForkEntryId,
  shouldApplyHistoryResponse,
  usesPersistedPrimeAgentTranscript,
  shouldEnterLocalHistoryLoading,
  shouldReuseLocalHistoryLoad,
  bindRuntimePageHideTeardown,
  shouldApplyDurableIdleTaskState,
  statusDuringRuntimeRecovery,
  shouldConsumeConversationResponse,
  stripLegacyOrbitQueueRows,
  shouldRecoverIdleSessionState,
  conversationHasPlanDecisionResult,
  persistedPlanToolResultStatus,
  shouldReplayNativePlanRequests,
  updatePlanReplayAbsenceEvidence,
  shouldApplySessionStateResponse,
  shouldScheduleTerminalStateReconciliation,
  isCompactDaemonAcknowledgementTimeout,
  isRefineDaemonAcknowledgementTimeout,
  refineLifecycleDisposition,
  refinementResultPresentation,
  rlmChildPresentation,
  finalizeStalledActivityRows,
  STOPPED_ACTIVITY_NOTE,
  runtimeDivergenceForSnapshot,
  shouldReconcileRuntimeState,
  statusAfterCompletedBootstrap,
  shouldRestartStalledBootstrap,
  planHandoffTranscriptRefreshed,
  PLAN_REPLAY_IDLE_POLL_INTERVAL_MS,
  stalledRunningActivities,
  ACTIVITY_STALL_TIMEOUT_MS,
  PLAN_NATIVE_REPLAY_POLL_INTERVAL_MS,
  PLAN_NATIVE_REPLAY_PROBE_TIMEOUT_MS,
} = compiledModule.exports;

test("Plan replay waits on a named multi-second native stabilization window", () => {
  assert.ok(PLAN_NATIVE_REPLAY_PROBE_TIMEOUT_MS >= 5_000);
  assert.ok(PLAN_NATIVE_REPLAY_POLL_INTERVAL_MS >= 50);
  assert.ok(PLAN_NATIVE_REPLAY_POLL_INTERVAL_MS <= 500);
});

test("Plan replay identity ignores cloned workspace objects but changes with the durable call", () => {
  assert.equal(
    planReplayProbeIdentity("conversation", "project", "call-1"),
    planReplayProbeIdentity(`${"conversation"}`, `${"project"}`, `${"call-1"}`),
  );
  assert.notEqual(
    planReplayProbeIdentity("conversation", "project", "call-1"),
    planReplayProbeIdentity("conversation", "project", "call-2"),
  );
  assert.equal(planReplayProbeIdentity(undefined, "project", "call-1"), undefined);
});

test("Plan replay attests absence only after repeated observations of one exact generation", () => {
  const generation = { pid: 41, startedAt: 1_000, toolCallId: "call-current" };
  let evidence = updatePlanReplayAbsenceEvidence(
    undefined,
    { status: "absent", ...generation },
    10_000,
  );
  assert.equal(hasAttestedPlanReplayAbsence(evidence), false);

  evidence = updatePlanReplayAbsenceEvidence(
    evidence,
    { status: "absent", ...generation },
    10_000 + PLAN_NATIVE_REPLAY_PROBE_TIMEOUT_MS,
  );
  assert.equal(hasAttestedPlanReplayAbsence(evidence), true);

  const restarted = updatePlanReplayAbsenceEvidence(
    evidence,
    { status: "absent", ...generation, pid: 42 },
    20_000,
  );
  assert.equal(restarted?.observations, 1);
  assert.equal(hasAttestedPlanReplayAbsence(restarted), false);
  assert.equal(
    updatePlanReplayAbsenceEvidence(restarted, { status: "unknown" }, 20_100),
    undefined,
  );
});

test("a published Prime Agent session file is the sole transcript projection", () => {
  assert.equal(usesPersistedPrimeAgentTranscript(true, "C:/Users/test/.prime/agent/sessions/a.jsonl"), true);
  assert.equal(usesPersistedPrimeAgentTranscript(true, ""), false);
  assert.equal(usesPersistedPrimeAgentTranscript(false, "preview.jsonl"), false);
});

test("runtime reconnect preserves Prime Agent's durable idle verdict", () => {
  assert.equal(statusDuringRuntimeRecovery("starting", true), "idle");
  assert.equal(statusDuringRuntimeRecovery("error", true), "idle");
  assert.equal(statusDuringRuntimeRecovery("idle", false), "starting");
  assert.equal(statusDuringRuntimeRecovery("streaming", false), "streaming");
  assert.equal(statusDuringRuntimeRecovery("tool", false), "tool");
  assert.equal(statusDuringRuntimeRecovery("queued", false), "queued");
});

test("an admitted prompt requires a later revision carrying Prime Agent's durable idle verdict", () => {
  assert.equal(shouldApplyDurableIdleTaskState("needs_input", false, "10:1", "10:1"), true);
  assert.equal(shouldApplyDurableIdleTaskState("needs_input", true, "10:1", "10:1"), false);
  assert.equal(shouldApplyDurableIdleTaskState("completed", true, "10:1", "20:2"), true);
  assert.equal(
    shouldApplyDurableIdleTaskState("needs_input", true, undefined, "20:2"),
    false,
    "an initial history read has no pre-prompt revision baseline",
  );
  assert.equal(shouldApplyDurableIdleTaskState(undefined, true, "10:1", "20:2"), false);
});

test("transcript shape cannot substitute for a durable Prime Agent idle verdict", () => {
  assert.equal(
    shouldApplyDurableIdleTaskState(undefined, false, "10:1", "20:2"),
    false,
    "even an advanced transcript remains active without a persisted task verdict",
  );
});

test("keeps internal Plan recovery prompts out of live and restored transcripts", () => {
  const internal = "[Prime Orbit internal Plan recovery v1] resubmit the same plan";
  const current = conversation();
  handleMessageEvent("conversation", {
    type: "message_start",
    message: { id: "internal-live", role: "user", content: [{ type: "text", text: internal }] },
  }, (_id, updater) => {
    const next = typeof updater === "function" ? updater(current) : { ...current, ...updater };
    assert.equal(next.messages.length, 0);
  });
  assert.deepEqual(mapAgentMessages([
    { id: "internal-history", role: "user", content: [{ type: "text", text: internal }] },
    { id: "visible", role: "user", content: [{ type: "text", text: "Apply the plan" }] },
  ]).map((message) => message.content), ["Apply the plan"]);
});

test("cancels orphaned Plan dialogs without rewriting unrelated unresolved tools", () => {
  const recovered = cancelUnresolvedPlanDialogs(conversation({
    messages: [{
      id: "assistant",
      role: "assistant",
      content: "",
      tools: [
        { id: "question", name: "prime_orbit_plan_question", status: "unresolved" },
        { id: "review", name: "prime_orbit_plan_submit", status: "unresolved" },
        { id: "inspect", name: "prime_orbit_plan_inspect", status: "unresolved" },
      ],
    }],
  }), "2026-08-25T00:00:01.000Z");
  assert.deepEqual(recovered.messages[0].tools.map((tool) => tool.status), [
    "cancelled",
    "cancelled",
    "unresolved",
  ]);
});

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
    { payload: { kind: "review", planId: "handoff" } },
  ), "apply-wire");
  assert.equal(recordedPlanResponseValue(
    { ...pendingPlanAction, stage: "decisionRecorded" },
    { options: ["apply-wire", "keep-wire", "revise-wire"] },
    { payload: { kind: "review", planId: "different-call" } },
  ), undefined, "a durable decision must never answer a different Prime Agent call");

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

test("a Plan mode switch keeps its published intent through asynchronous persistence", async () => {
  const observations = [];
  let expectedMode;
  await commitPlanRuntimeModeTransition(
    "normal",
    async () => "normal",
    async () => {
      observations.push(expectedMode);
      await Promise.resolve();
      observations.push(expectedMode);
    },
    (mode) => { expectedMode = mode; },
  );
  assert.deepEqual(observations, ["normal", "normal"]);
  assert.equal(expectedMode, undefined);
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

test("an internal Plan handoff remains available for reconciliation without exposing its document", () => {
  const [message] = mapAgentMessages([{
    id: "handoff-message",
    role: "user",
    timestamp: Date.now(),
    content: [{
      type: "text",
      text: "<!-- prime-orbit-plan-handoff:v1:artifact-123 -->\n[Prime Orbit approved plan]\n# Private plan body",
    }],
  }]);
  assert.equal(message.internal, "plan_handoff");
  assert.equal(message.content, "<!-- prime-orbit-plan-handoff:v1:artifact-123 -->");
  assert.equal(message.content.includes("Private plan body"), false);
  assert.equal(conversationHasPlanHandoff({ messages: [message] }, "artifact-123"), true);
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

test("a remounted selection never reuses a stale local-history read", () => {
  assert.equal(shouldReuseLocalHistoryLoad(7, 7), true, "the same selection generation shares one disk read");
  assert.equal(
    shouldReuseLocalHistoryLoad(7, 8),
    false,
    "HMR or StrictMode must replace a read whose stale guard can no longer apply it",
  );
  assert.equal(shouldReuseLocalHistoryLoad(undefined, 8), false);
});

test("React effect cleanup does not masquerade as a real WebView teardown", () => {
  let listener;
  let teardownCount = 0;
  const target = {
    addEventListener(type, next) {
      assert.equal(type, "pagehide");
      listener = next;
    },
    removeEventListener(type, previous) {
      assert.equal(type, "pagehide");
      if (listener === previous) listener = undefined;
    },
  };

  const cleanup = bindRuntimePageHideTeardown(target, () => { teardownCount += 1; });
  cleanup();
  assert.equal(teardownCount, 0, "Fast Refresh only detaches the old listener");

  const cleanupAfterRemount = bindRuntimePageHideTeardown(target, () => { teardownCount += 1; });
  listener(new Event("pagehide"));
  assert.equal(teardownCount, 1, "the real page lifecycle still tears down runtime requests");
  cleanupAfterRemount();
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

test("only an exact persisted Plan result unlocks the runtime handoff", () => {
  const conversation = {
    messages: [{
      tools: [{ id: "plan-call", name: "prime_orbit_plan_submit", status: "completed" }],
    }],
  };
  assert.equal(conversationHasPlanDecisionResult(conversation, "plan-call"), true);
  assert.equal(conversationHasPlanDecisionResult(conversation, "other-call"), false);
  assert.equal(conversationHasPlanDecisionResult({
    messages: [{ tools: [{ id: "plan-call", name: "prime_orbit_plan_submit", status: "unresolved" }] }],
  }, "plan-call"), false);
  assert.equal(canFinalizePendingPlanDecision(false, true), true);
  assert.equal(canFinalizePendingPlanDecision(true, true), false);
  assert.equal(canFinalizePendingPlanDecision(false, false), false);
});

test("Plan responses wait for Prime Agent's exact persisted tool result", () => {
  const messages = [{
    role: "toolResult",
    toolCallId: "question-call",
    toolName: "prime_orbit_plan_question",
    isError: false,
  }, {
    role: "toolResult",
    toolCallId: "review-call",
    toolName: "prime_orbit_plan_submit",
    isError: true,
  }];
  assert.equal(persistedPlanToolResultStatus(messages, "question-call"), "completed");
  assert.equal(persistedPlanToolResultStatus(messages, "review-call"), "failed");
  assert.equal(persistedPlanToolResultStatus(messages, "other-call"), undefined);
  assert.equal(persistedPlanToolResultStatus([{
    role: "toolResult",
    toolCallId: "question-call",
    toolName: "untrusted_tool",
    isError: false,
  }], "question-call"), undefined);
});

test("replays native Plan requests while Prime Agent waits in an idle projection", () => {
  assert.equal(shouldReplayNativePlanRequests("idle", "question"), true);
  assert.equal(shouldReplayNativePlanRequests("error", "review"), true);
  assert.equal(shouldReplayNativePlanRequests("tool", undefined), true);
  assert.equal(shouldReplayNativePlanRequests("idle", undefined), false);
});

test("native Plan replay correlates the transient request to the durable transcript call", () => {
  const titleFor = (planId) => {
    const encoded = Buffer.from(JSON.stringify({
      kind: "review",
      planId,
      title: "Implementation plan",
      v: 1,
    }), "utf8").toString("base64url");
    return `prime-orbit-plan-ui:v1:${encoded}\nPlan ready`;
  };
  const payloadFor = (conversationId, requestId, planId, runtimeMode = "plan") => ({
    conversationId,
    runtimeMode,
    line: JSON.stringify({
      type: "extension_ui_request",
      id: requestId,
      method: "select",
      title: titleFor(planId),
      options: ["Apply", "Keep", "Revise"],
    }),
  });
  const stale = payloadFor("conversation", "request-old", "call-old");
  const expected = payloadFor("conversation", "request-current", "call-current");
  const wrongRuntime = payloadFor("conversation", "request-normal", "call-current", "normal");

  assert.equal(
    matchingNativePlanRequest([stale, wrongRuntime, expected], "conversation", "call-current"),
    expected,
  );
  assert.equal(
    matchingNativePlanRequest([stale], "conversation", "call-current"),
    undefined,
  );
  assert.equal(
    matchingNativePlanRequest([expected], "other-conversation", "call-current"),
    undefined,
  );
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

test("owned command responses stay scoped to their initiating transaction", () => {
  assert.equal(shouldConsumeConversationResponse(undefined), false);
  assert.equal(shouldConsumeConversationResponse("goal_mutation"), true);
  assert.equal(shouldConsumeConversationResponse("prompt_admission"), true);
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

test("a stale validated session file does not erase newer Prime Agent turns already rendered", () => {
  const current = [
    { id: "history-user-1", entryId: "history-user-1", role: "user", content: "First", createdAt: "2026-08-25T00:00:00.000Z", status: "complete" },
    { id: "history-assistant-1", entryId: "history-assistant-1", role: "assistant", content: "Answer", createdAt: "2026-08-25T00:00:01.000Z", status: "complete" },
    { id: "rpc-user-2", role: "user", content: "Second", createdAt: "2026-08-25T00:00:02.000Z", status: "complete" },
  ];
  const local = [
    { id: "history-user-1", entryId: "history-user-1", role: "user", content: "First", createdAt: "2026-08-25T00:00:00.000Z", status: "complete" },
    { id: "history-assistant-1", entryId: "history-assistant-1", role: "assistant", content: "Answer", createdAt: "2026-08-25T00:00:01.000Z", status: "complete" },
  ];

  const reconciled = reconcileLocalTranscriptAfterRpc(current, local);
  assert.deepEqual(reconciled.map((message) => message.id), ["history-user-1", "history-assistant-1", "rpc-user-2"]);
});

test("a partial RPC transcript cannot erase already rendered durable turns", () => {
  const current = [
    { id: "user-1", entryId: "user-1", role: "user", content: "First", createdAt: "2026-08-25T00:00:00.000Z", status: "complete" },
    { id: "assistant-1", entryId: "assistant-1", role: "assistant", content: "Answer", createdAt: "2026-08-25T00:00:01.000Z", status: "complete" },
    { id: "user-2", entryId: "user-2", role: "user", content: "Second", createdAt: "2026-08-25T00:00:02.000Z", status: "complete" },
  ];
  const rpc = [
    { ...current[1], content: "Authoritative answer" },
    { id: "assistant-2", entryId: "assistant-2", role: "assistant", content: "Latest", createdAt: "2026-08-25T00:00:03.000Z", status: "complete" },
  ];

  const reconciled = reconcileRpcTranscript(current, rpc);
  assert.deepEqual(reconciled.map((message) => message.id), ["user-1", "assistant-1", "user-2", "assistant-2"]);
  assert.equal(reconciled[1].content, "Authoritative answer");
});

test("RPC history replaces id-less projections of the same Prime Agent records", () => {
  const live = [
    { id: "event-user", role: "user", content: "My prompt", createdAt: "2026-08-25T00:00:01.000Z", status: "complete" },
    { id: "event-assistant", role: "assistant", content: "Answer", createdAt: "2026-08-25T00:00:02.000Z", status: "complete" },
  ];
  const rpc = [
    { id: "history-0", role: "user", content: "My prompt", createdAt: "2026-08-25T00:00:01.000Z", status: "complete" },
    { id: "history-1", role: "assistant", content: "Answer", createdAt: "2026-08-25T00:00:02.000Z", status: "complete" },
  ];

  const reconciled = reconcileRpcTranscript(live, rpc);
  assert.deepEqual(reconciled.map((message) => message.id), ["history-0", "history-1"]);
});

test("a later Prime Agent snapshot collapses duplicates left by two native projections", () => {
  const current = [
    { id: "event-user", role: "user", content: "My prompt", createdAt: "2026-08-25T00:00:01.000Z", status: "complete" },
    { id: "history-0", role: "user", content: "My prompt", createdAt: "2026-08-25T00:00:01.000Z", status: "complete" },
    { id: "event-assistant", role: "assistant", content: "Answer", createdAt: "2026-08-25T00:00:02.000Z", status: "complete" },
    { id: "history-1", role: "assistant", content: "Answer", createdAt: "2026-08-25T00:00:02.000Z", status: "complete" },
  ];
  const rpc = [
    { id: "history-0", role: "user", content: "My prompt", createdAt: "2026-08-25T00:00:01.000Z", status: "complete" },
    { id: "history-1", role: "assistant", content: "Answer", createdAt: "2026-08-25T00:00:02.000Z", status: "complete" },
  ];

  const reconciled = reconcileRpcTranscript(current, rpc);
  assert.deepEqual(reconciled.map((message) => message.id), ["history-0", "history-1"]);
});

test("projection reconciliation preserves repeated Prime Agent messages by occurrence", () => {
  const current = [
    { id: "old-user", role: "user", content: "same", createdAt: "2026-08-25T00:00:00.000Z", status: "complete" },
    { id: "new-user", role: "user", content: "same", createdAt: "2026-08-25T00:00:10.000Z", status: "complete" },
  ];
  const partialRpc = [
    { id: "history-new-user", role: "user", content: "same", createdAt: "2026-08-25T00:00:10.000Z", status: "complete" },
  ];

  const reconciled = reconcileRpcTranscript(current, partialRpc);
  assert.deepEqual(reconciled.map((message) => message.id), ["old-user", "history-new-user"]);
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

test("an authoritative idle snapshot closes lifecycle rows that lost their terminal event", () => {
  // agent_start is not a tool execution, so finalizeConversationTools alone
  // leaves it spinning forever once agent_end is lost. This is the exact
  // "Prime Agent is working" symptom the reconciliation pass has to end.
  const recovered = finalizeAuthoritativeIdleSnapshot(conversation({
    status: "streaming",
    activities: [
      {
        id: "activity-agent-start",
        type: "agent_start",
        title: "Prime Agent réfléchit",
        status: "running",
        createdAt: "2026-08-21T11:28:16.000Z",
      },
      {
        id: "activity-done",
        type: "agent_end",
        title: "Exécution terminée",
        status: "success",
        createdAt: "2026-08-21T11:29:00.000Z",
      },
    ],
  }), "2026-08-21T11:29:17.000Z");

  assert.equal(recovered.status, "idle");
  const lifecycle = recovered.activities.find((item) => item.id === "activity-agent-start");
  assert.equal(lifecycle.status, "info");
  assert.equal(lifecycle.updatedAt, "2026-08-21T11:29:17.000Z");
  assert.match(lifecycle.detail, /Prime Agent/u);
  // Rows that already reached a terminal status are untouched.
  const settled = recovered.activities.find((item) => item.id === "activity-done");
  assert.equal(settled.status, "success");
  assert.equal(settled.updatedAt, undefined);
});

test("finalizing stalled rows preserves identity and returns the original array when nothing runs", () => {
  const settled = [{
    id: "activity-done",
    type: "agent_end",
    title: "Exécution terminée",
    status: "success",
    createdAt: "2026-08-21T11:29:00.000Z",
  }];
  assert.equal(finalizeStalledActivityRows(settled, "2026-08-21T11:30:00.000Z"), settled);

  const withDetail = finalizeStalledActivityRows([{
    id: "activity-bash",
    type: "tool_execution_start",
    title: "Commande en cours",
    detail: "npm test",
    status: "running",
    createdAt: "2026-08-21T11:29:00.000Z",
    updateCount: 3,
  }], "2026-08-21T11:30:00.000Z");
  assert.match(withDetail[0].detail, /^npm test · /u);
  assert.equal(withDetail[0].updateCount, 4);
});

test("stalled activity detection uses the latest update, not creation time", () => {
  const nowMs = Date.parse("2026-08-21T11:30:00.000Z");
  const activities = [
    {
      id: "fresh",
      type: "tool_execution_start",
      title: "Fraîche",
      status: "running",
      createdAt: "2026-08-21T10:00:00.000Z",
      updatedAt: "2026-08-21T11:29:59.000Z",
    },
    {
      id: "stalled",
      type: "tool_execution_start",
      title: "Bloquée",
      status: "running",
      createdAt: "2026-08-21T11:00:00.000Z",
    },
    {
      id: "settled",
      type: "tool_execution_end",
      title: "Terminée",
      status: "success",
      createdAt: "2026-08-21T11:00:00.000Z",
    },
    {
      id: "unparseable",
      type: "tool_execution_start",
      title: "Horodatage illisible",
      status: "running",
      createdAt: "not-a-date",
    },
  ];

  const stalled = stalledRunningActivities(activities, nowMs);
  assert.deepEqual(stalled.map((item) => item.id), ["stalled"]);
  // A zero timeout is how the authoritative idle boundary counts every row.
  assert.deepEqual(
    stalledRunningActivities(activities, nowMs, 0).map((item) => item.id),
    ["fresh", "stalled"],
  );
  assert.ok(ACTIVITY_STALL_TIMEOUT_MS >= 30_000);
});

test("reconciliation polls active work and any status still showing stalled rows", () => {
  for (const status of ["streaming", "tool", "queued"]) {
    assert.equal(shouldReconcileRuntimeState(status, false), true);
  }
  // An idle conversation is only worth polling when it contradicts itself.
  assert.equal(shouldReconcileRuntimeState("idle", false), false);
  assert.equal(shouldReconcileRuntimeState("idle", true), true);
  // The bootstrap owns `starting`; it is polled only to break a visible stall.
  assert.equal(shouldReconcileRuntimeState("starting", false), false);
  assert.equal(shouldReconcileRuntimeState("starting", true), true);
  // A closed runtime has nothing to answer.
  assert.equal(shouldReconcileRuntimeState("offline", true), false);
});

test("divergences record corrections only, never agreement", () => {
  assert.equal(runtimeDivergenceForSnapshot("idle", 0, "reconciliation"), undefined);
  assert.equal(runtimeDivergenceForSnapshot("offline", 0, "resync"), undefined);

  const corrected = runtimeDivergenceForSnapshot(
    "streaming",
    2,
    "reconciliation",
    "2026-08-21T11:30:00.000Z",
  );
  assert.deepEqual(corrected, {
    observedStatus: "streaming",
    stalledActivities: 2,
    detectedAt: "2026-08-21T11:30:00.000Z",
    source: "reconciliation",
  });

  // An idle status that still carried running rows is drift worth recording.
  assert.equal(runtimeDivergenceForSnapshot("idle", 1, "resync").stalledActivities, 1);
});

test("a caller-supplied outcome closes running rows with the right verdict", () => {
  const running = [{
    id: "activity-agent-start",
    type: "agent_start",
    title: "Prime Agent réfléchit",
    status: "running",
    createdAt: "2026-08-21T11:28:16.000Z",
  }];

  // Process exit is terminal for every row, but a crash must not be dressed
  // up as the calm outcome used when a snapshot proves the work simply ended.
  const crashed = finalizeStalledActivityRows(running, "2026-08-21T11:29:00.000Z", {
    status: "error",
    note: "Prime Agent s’est arrêté (code 1).",
  });
  assert.equal(crashed[0].status, "error");
  assert.equal(crashed[0].detail, "Prime Agent s’est arrêté (code 1).");

  const stopped = finalizeStalledActivityRows(running, "2026-08-21T11:29:00.000Z", {
    status: "info",
    note: STOPPED_ACTIVITY_NOTE,
  });
  assert.equal(stopped[0].status, "info");
  assert.match(stopped[0].detail, /processus Prime Agent/u);
});

test("a completed bootstrap closes starting instead of waiting on get_messages", () => {
  // loadConversationHistory skips get_messages when history is already loaded,
  // which is exactly what a bootstrap retry, a runtime-mode switch, or a
  // reattach produces. Depending on that response to leave `starting` is what
  // stranded conversations under "Connecting to Prime Agent" forever.
  assert.equal(statusAfterCompletedBootstrap("starting", true), "idle");
  // Nothing to show yet: the loading screen is still the honest state.
  assert.equal(statusAfterCompletedBootstrap("starting", false), "starting");
  // A bootstrap completing behind real work must never contradict it.
  assert.equal(statusAfterCompletedBootstrap("streaming", true), "streaming");
  assert.equal(statusAfterCompletedBootstrap("tool", true), "tool");
  assert.equal(statusAfterCompletedBootstrap("idle", true), "idle");
});

test("an idle snapshot releases starting once the transcript is on screen", () => {
  const idleSnapshot = { isCompacting: false, isStreaming: false, sessionActions: {} };

  // A rendered transcript under a "Connecting" banner is a contradiction.
  assert.equal(
    conversationStatusForSessionSnapshot(idleSnapshot, "starting", false, true),
    "idle",
  );
  // With nothing rendered yet, the loading screen must survive the snapshot.
  assert.equal(
    conversationStatusForSessionSnapshot(idleSnapshot, "starting", false, false),
    "starting",
  );
  // Real work still wins over both.
  assert.equal(
    conversationStatusForSessionSnapshot({ ...idleSnapshot, isStreaming: true }, "starting", false, true),
    "streaming",
  );
  // A local operation that owns the session keeps the current status.
  assert.equal(
    conversationStatusForSessionSnapshot(idleSnapshot, "starting", true, true),
    "starting",
  );
});

test("reconciliation rescues a starting conversation that already shows a transcript", () => {
  // The new-conversation case: nothing rendered, bootstrap owns the state.
  assert.equal(shouldReconcileRuntimeState("starting", false, false), false);
  // The stuck case from the field: messages visible, banner still "Connecting".
  assert.equal(shouldReconcileRuntimeState("starting", false, true), true);
  assert.equal(shouldReconcileRuntimeState("starting", true, false), true);
  assert.equal(shouldReconcileRuntimeState("offline", true, true), false);
});

test("a starting conversation with nothing connecting it is re-bootstrapped", () => {
  // The stranded new-conversation case: the banner claims to be connecting
  // but no transaction owns that state, so no response can ever clear it.
  assert.equal(shouldRestartStalledBootstrap("starting", false, false), true);
  // A bootstrap or a process start already in flight owns the state.
  assert.equal(shouldRestartStalledBootstrap("starting", true, false), false);
  assert.equal(shouldRestartStalledBootstrap("starting", false, true), false);
  // Any other status is not a connection claim and must be left alone.
  for (const status of ["idle", "streaming", "tool", "queued", "error", "offline"]) {
    assert.equal(shouldRestartStalledBootstrap(status, false, false), false);
  }
});

test("handoff verification reads the flag its own transcript source writes", () => {
  // A published session is projected from the local JSONL. Testing the RPC
  // get_messages flag after a local read can never succeed, which turned every
  // verification into a visible "history unavailable" error while the plan was
  // in fact running.
  assert.equal(planHandoffTranscriptRefreshed(true, true, false), true);
  assert.equal(planHandoffTranscriptRefreshed(true, false, true), false);
  // Without a published session the RPC projection stays authoritative.
  assert.equal(planHandoffTranscriptRefreshed(false, false, true), true);
  assert.equal(planHandoffTranscriptRefreshed(false, true, false), false);
});

test("plan replay backs off while the runtime is not in Plan mode", () => {
  // The tight interval exists to catch a lost dialog fast. There is no dialog
  // to catch once the runtime left Plan mode, and probing at that cadence
  // re-ran a bootstrap — and its dialog-queue replay — eight times a second.
  assert.ok(PLAN_REPLAY_IDLE_POLL_INTERVAL_MS >= 8 * PLAN_NATIVE_REPLAY_POLL_INTERVAL_MS);
});

test("a timed-out enrichment read never raises a runtime failure", () => {
  // Observed against a contended daemon: the model picker read timed out and
  // flipped the whole conversation into "Prime Agent needs attention" over a
  // purely cosmetic fetch.
  assert.equal(isOptionalSelectionResponseFailure({
    command: "get_available_models",
    success: false,
    error: 'Timed out after 30000ms waiting for the Prime Agent daemon response to "get_available_models". Socket: \\.\pipe\prime-orbit-daemon-prime-agent-v0.8.0-3a60f74.',
  }), true);
  assert.equal(isOptionalSelectionResponseFailure({
    command: "list_schedules",
    success: false,
    error: 'Timed out after 5000ms waiting for the Prime Agent daemon response to "list_schedules".',
  }), true);

  // A timeout naming a different command is not this command's excuse.
  assert.equal(isOptionalSelectionResponseFailure({
    command: "get_available_models",
    success: false,
    error: 'Timed out after 30000ms waiting for the Prime Agent daemon response to "get_state".',
  }), false);
  // Critical-path reads keep surfacing their failures.
  assert.equal(isOptionalSelectionResponseFailure({
    command: "get_state",
    success: false,
    error: 'Timed out after 30000ms waiting for the Prime Agent daemon response to "get_state".',
  }), false);
  // A genuine refusal from an optional command still reads as a real answer.
  assert.equal(isOptionalSelectionResponseFailure({
    command: "get_available_models",
    success: false,
    error: "The provider rejected the catalog request.",
  }), false);
});
