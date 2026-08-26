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

const {
  buildToolSequenceSegments,
  buildContextUsageSnapshot,
  buildSessionPanelSummary,
  activityOverviewDetail,
  clampRefinementContextMenuPosition,
  continueComposerMarkdownList,
  agentMessageRelationshipLabel,
  initialAgentMessageNoticeExpanded,
  initialPythonExecutionGroupExpanded,
  initialToolCardExpanded,
  harnessConfirmationPhrase,
  isConversationMaintenanceBlocked,
  isConversationTurnActive,
  shouldShowLivePlanRequest,
  shouldShowMissingPlanDialog,
  unresolvedPlanQuestionCount,
  planModeTransitionError,
  planReviewDisplayDocument,
  isGoalPanelBusy,
  isRefineControlBusy,
  normalizeLegacyActivity,
  refinementReaderAdjacentIndex,
  refinementReaderCopyText,
} = compiledModule.exports;

test("describes authoritative active states even when the activity timeline is empty", () => {
  assert.equal(activityOverviewDetail("streaming", "en"), "Prime Agent is processing the active instruction");
  assert.equal(activityOverviewDetail("tool", "en"), "A tool or interactive request is active");
  assert.equal(activityOverviewDetail("idle", "en"), "Ready for a new instruction");
});

test("clamps memory and refinement menus inside the visible desktop viewport", () => {
  assert.deepEqual(clampRefinementContextMenuPosition(980, 740, 240, 160, 1024, 768), { x: 776, y: 600 });
  assert.deepEqual(clampRefinementContextMenuPosition(-20, -10, 240, 160, 1024, 768), { x: 8, y: 8 });
});

test("requires an explicit stable phrase only for destructive global harness changes", () => {
  assert.equal(harnessConfirmationPhrase({ id: "local-note", title: "Local note", scope: "local" }), "");
  assert.equal(harnessConfirmationPhrase({ id: "global-note", title: "Shared decision", scope: "global" }), "Shared decision");
  assert.equal(harnessConfirmationPhrase({ id: "global-note", title: "x".repeat(81), scope: "global" }), "global-note");
  assert.equal(harnessConfirmationPhrase({ id: "unknown-note", title: "Unknown", scope: "unknown" }), "");
});

test("navigates the memory reader without wrapping past the available inventory", () => {
  assert.equal(refinementReaderAdjacentIndex(2, -1, 5), 1);
  assert.equal(refinementReaderAdjacentIndex(2, 1, 5), 3);
  assert.equal(refinementReaderAdjacentIndex(0, -1, 5), 0);
  assert.equal(refinementReaderAdjacentIndex(4, 1, 5), 4);
  assert.equal(refinementReaderAdjacentIndex(-1, 1, 5), -1);
  assert.equal(refinementReaderAdjacentIndex(0, 1, 0), -1);
});

test("copies only the public memory and refinement fields shown in the reader", () => {
  const memory = refinementReaderCopyText({
    type: "entry",
    entry: {
      key: "private-storage-key",
      id: "memory-1",
      kind: "memory",
      scope: "local",
      title: "Project conventions",
      content: "Use the shared release pipeline.",
      refinementId: "private-refinement-id",
      updatedAt: "2026-08-21T12:00:00.000Z",
    },
  }, "en");
  assert.equal(memory, "Project conventions\n\nUse the shared release pipeline.");
  assert.doesNotMatch(memory, /private-storage-key|private-refinement-id/);

  const refinement = refinementReaderCopyText({
    type: "refinement",
    record: {
      id: "private-journal-id",
      timestamp: "2026-08-21T12:00:00.000Z",
      summary: "Keep releases reproducible",
      rationale: "The installer must be verifiable.",
      expectedOutcome: "Every artifact has a checksum.",
      scope: "local",
      appliedEdits: [{ action: "update", kind: "memory", id: "release-pipeline", title: "Release pipeline", content: "Record SHA-256.", applied: true }],
    },
  }, "en");
  assert.match(refinement, /Rationale\nThe installer must be verifiable\./);
  assert.match(refinement, /Expected outcome\nEvery artifact has a checksum\./);
  assert.match(refinement, /Updated · Memory · Release pipeline/);
  assert.doesNotMatch(refinement, /private-journal-id/);
});

test("connection startup is not presented to the composer as an active turn", () => {
  assert.equal(isConversationTurnActive("starting"), false);
  assert.equal(isConversationTurnActive("idle"), false);
  assert.equal(isConversationTurnActive("streaming"), true);
  assert.equal(isConversationTurnActive("tool"), true);
  assert.equal(isConversationTurnActive("queued"), true);
});

test("does not mislabel an answered Plan question as needing reconnection", () => {
  assert.equal(shouldShowMissingPlanDialog({
    hasLiveRequest: false,
    hasUnresolvedTranscript: true,
    status: "tool",
    recoverableKind: "review",
    phase: "planning",
    nativeProbePending: true,
  }), false, "the native replay grace period owns the question-to-review transition");
  assert.equal(shouldShowMissingPlanDialog({
    hasLiveRequest: false,
    hasUnresolvedTranscript: true,
    status: "tool",
    recoverableKind: "review",
    phase: "planning",
    nativeProbePending: false,
  }), true, "an exact canonical review remains recoverable after the native probe is exhausted");
  assert.equal(shouldShowMissingPlanDialog({
    hasLiveRequest: false,
    hasUnresolvedTranscript: false,
    status: "tool",
    recoverableKind: "question",
    phase: "question",
  }), true, "a genuinely lost blocking form remains recoverable");
  assert.equal(shouldShowMissingPlanDialog({
    hasLiveRequest: true,
    hasUnresolvedTranscript: true,
    status: "tool",
    recoverableKind: "question",
    phase: "question",
  }), false, "the live native form takes precedence over recovery");
  assert.equal(shouldShowMissingPlanDialog({
    hasLiveRequest: false,
    hasUnresolvedTranscript: true,
    status: "tool",
    recoverableKind: "review",
    phase: "review",
    nativeProbePending: true,
  }), false, "a bounded native replay probe must finish before recovery is offered");
});

test("a live native Plan request is never hidden by stale finalization metadata", () => {
  const request = {
    id: "native-question",
    requestKey: "conversation:native-question",
    conversationId: "conversation",
    type: "extension_ui_request",
    method: "select",
  };
  assert.equal(shouldShowLivePlanRequest(request, undefined), true);
  assert.equal(shouldShowLivePlanRequest(request, {
    decision: "apply",
    document: { name: "old-plan", markdown: "# Old", round: 1 },
    relativePath: ".prime/plans/old-plan.md",
    handoffId: "old-plan-id",
    stage: "decisionRecorded",
  }), true);
  assert.equal(shouldShowLivePlanRequest(undefined, undefined), false);
});

test("keeps the reviewed Plan document visible while its native decision is being acknowledged", () => {
  const reviewed = {
    name: "reviewed-plan",
    markdown: "# Reviewed plan",
    round: 2,
  };
  const newer = {
    name: "revised-plan",
    markdown: "# Revised plan",
    round: 3,
  };

  assert.equal(
    planReviewDisplayDocument(undefined, reviewed),
    reviewed,
    "the review-to-planning transition must not replace the document with a false syncing error",
  );
  assert.equal(
    planReviewDisplayDocument(newer, reviewed),
    newer,
    "a newly synchronized document remains authoritative",
  );
});

test("maintenance stays unavailable while connecting or while a real turn is active", () => {
  assert.equal(isConversationMaintenanceBlocked("starting"), true);
  assert.equal(isConversationMaintenanceBlocked("streaming"), true);
  assert.equal(isConversationMaintenanceBlocked("tool"), true);
  assert.equal(isConversationMaintenanceBlocked("queued"), true);
  assert.equal(isConversationMaintenanceBlocked("idle"), false);
});

test("keeps the legacy Plan question count scoped to unresolved question tools", () => {
  assert.equal(unresolvedPlanQuestionCount({
    messages: [{
      tools: [
        { name: "prime_orbit_plan_question", status: "unresolved" },
        { name: "prime_orbit_plan_question", status: "cancelled" },
        { name: "prime_orbit_plan_inspect", status: "unresolved" },
        { name: "prime_orbit_plan_submit", status: "unresolved" },
      ],
    }, {
      tools: [{ name: "prime_orbit_plan_question", status: "unresolved" }],
    }],
  }), 2);
});

test("localizes the native Plan busy rejection with the application language", () => {
  const nativeError = new Error("Le mode de cette conversation ne peut changer que lorsque Prime Agent est au repos.");
  assert.equal(
    planModeTransitionError(nativeError, "en"),
    "The conversation mode can only be changed while Prime Agent is idle.",
  );
  assert.equal(
    planModeTransitionError(nativeError, "fr"),
    "Le mode de cette conversation ne peut changer que lorsque Prime Agent est au repos.",
  );
});

test("legacy child activities preserve a parent-managed closure as neutral", () => {
  const normalized = normalizeLegacyActivity({
    id: "rlm-child:reviewer",
    type: "rlm_child_update",
    title: "legacy",
    createdAt: "2026-08-21T12:00:00.000Z",
    status: "warning",
    raw: {
      child: {
        id: "reviewer",
        label: "reviewer",
        status: "cancelled",
        error: "Deleted by parent orchestrator",
        recap: "Review delivered",
      },
    },
  }, "fr");
  assert.equal(normalized.status, "info");
  assert.equal(normalized.title, "Sous-agent « reviewer » fermé par l’agent principal");
  assert.equal(normalized.detail, "Review delivered");
});

test("continues and exits Markdown lists without replacing the textarea", () => {
  assert.deepEqual(continueComposerMarkdownList("- premier", 9, 9), {
    value: "- premier\n- ",
    selectionStart: 12,
    selectionEnd: 12,
    action: "continue",
  });
  assert.deepEqual(continueComposerMarkdownList("1. un", 5, 5), {
    value: "1. un\n2. ",
    selectionStart: 9,
    selectionEnd: 9,
    action: "continue",
  });
  assert.deepEqual(continueComposerMarkdownList("- premier\n- ", 12, 12), {
    value: "- premier\n",
    selectionStart: 10,
    selectionEnd: 10,
    action: "exit",
  });
  assert.equal(continueComposerMarkdownList("texte normal", 12, 12), undefined);
  assert.equal(continueComposerMarkdownList("- sélection", 2, 5), undefined);
});

test("keeps agent-to-agent notices compact and labels their relationship", () => {
  assert.equal(initialAgentMessageNoticeExpanded(), false);
  assert.equal(agentMessageRelationshipLabel("fr", "child"), "Message du sous-agent");
  assert.equal(agentMessageRelationshipLabel("en", "parent"), "Parent agent message");
  assert.equal(agentMessageRelationshipLabel("fr", "sibling"), "Message d’un agent pair");
  assert.equal(agentMessageRelationshipLabel("en"), "Agent message");
});

test("keeps Python tool details collapsed while a live execution is running", () => {
  assert.equal(initialPythonExecutionGroupExpanded(), false);
  assert.equal(initialToolCardExpanded({ status: "running" }, true), false);
  assert.equal(initialToolCardExpanded({ status: "completed" }, true), false);
  assert.equal(initialToolCardExpanded({ status: "running" }, false), true, "non-Python live tools preserve their current behavior");
});

test("routes even one Python execution through the collapsed Python group", () => {
  const python = { id: "python-1", name: "ipython", title: "Python", status: "running", input: "print(1)" };
  const shell = { id: "shell-1", name: "bash", title: "Shell", status: "running", input: "echo 1" };
  assert.deepEqual(buildToolSequenceSegments([python]), [{ kind: "python", tools: [python] }]);
  assert.deepEqual(buildToolSequenceSegments([shell]), [{ kind: "tool", tool: shell }]);
});

test("builds context details only from real counters and clamps the visual meter", () => {
  assert.deepEqual(buildContextUsageSnapshot({
    contextUsage: { tokens: 75_000, contextWindow: 100_000, percent: 75 },
  }, { autoCompactionEnabled: true }), {
    usedTokens: 75_000,
    contextWindow: 100_000,
    availableTokens: 25_000,
    percent: 75,
    ringPercent: 75,
    status: "warning",
    autoCompactionEnabled: true,
  });

  const overflow = buildContextUsageSnapshot({
    contextUsage: { tokens: 104_000, contextWindow: 100_000, percent: 104 },
  });
  assert.equal(overflow.availableTokens, 0);
  assert.equal(overflow.percent, 104, "the reported percentage stays visible instead of being falsified");
  assert.equal(overflow.ringPercent, 100, "only the circular visualization is clamped");
  assert.equal(overflow.status, "critical");
});

test("derives a percentage from reported token counters but preserves unavailable metrics", () => {
  const derived = buildContextUsageSnapshot({
    contextUsage: { tokens: 32_000, contextWindow: 128_000, percent: null },
  });
  assert.equal(derived.percent, 25);
  assert.equal(derived.availableTokens, 96_000);

  assert.deepEqual(buildContextUsageSnapshot(), {
    usedTokens: null,
    contextWindow: null,
    availableTokens: null,
    percent: null,
    ringPercent: 0,
    status: "unavailable",
    autoCompactionEnabled: undefined,
  });
});

test("compaction is surfaced as the authoritative context state", () => {
  const snapshot = buildContextUsageSnapshot({
    contextUsage: { tokens: 20_000, contextWindow: 100_000, percent: 20 },
  }, undefined, true);
  assert.equal(snapshot.status, "compacting");
});

test("runtime refinement keeps a second Refine action disabled after local acknowledgement", () => {
  assert.equal(isRefineControlBusy(false), false);
  assert.equal(isRefineControlBusy(false, "refine"), true);
  assert.equal(isRefineControlBusy(true), true);
  assert.equal(isRefineControlBusy(true, "export_html"), true);
});

test("goal actions remain disabled after navigation while their runtime mutation is pending", () => {
  assert.equal(isGoalPanelBusy(false), false);
  assert.equal(isGoalPanelBusy(false, { command: "/goal Ship", kind: "start", phase: "sending" }), true);
  assert.equal(isGoalPanelBusy(false, { command: "/goal Ship", kind: "start", phase: "waiting" }), true);
  assert.equal(isGoalPanelBusy(false, { command: "/goal Ship", kind: "start", phase: "reconciling" }), true);
  assert.equal(isGoalPanelBusy(false, { command: "/goal Ship", kind: "start", phase: "error", error: "Failed" }), false);
  assert.equal(isGoalPanelBusy(true), true);
});

test("session navigation counts each real capability without mixing completed supervision jobs", () => {
  const summary = buildSessionPanelSummary({
    messages: [
      { attachments: [{ id: "image" }, { id: "document" }] },
      { attachments: [{ id: "archive" }] },
    ],
  }, {
    goal: { objective: "Ship the release" },
    sessionActions: {
      steering: ["check tests"],
      followUps: ["publish", "verify"],
      active: { kind: "turn", phase: "running" },
    },
  }, [
    { id: "schedule-active", status: "active", source: "cron" },
    { id: "schedule-complete", status: "completed", source: "cron" },
    { id: "schedule-heartbeat", status: "active", source: "heartbeat" },
  ], { id: "heartbeat-current" }, [
    { job: { id: "heartbeat-current", status: "active" } },
    { job: { id: "heartbeat-remote", status: "paused" } },
    { job: { id: "heartbeat-complete", status: "completed" } },
  ], [{ id: "child-a" }, { id: "child-b" }]);

  assert.deepEqual(summary, {
    attachments: 3,
    queued: 3,
    hasActiveAction: true,
    goals: 1,
    agents: 2,
    supervision: 3,
  });
});

test("session navigation does not present Prime Agent's retained completion record as active work", () => {
  const base = {
    sessionActions: { steering: [], followUps: [] },
  };
  const summary = (goal) => buildSessionPanelSummary(
    { messages: [] },
    { ...base, goal },
    [],
    undefined,
    [],
    [],
  );

  assert.equal(summary({ status: "active", objective: "Ship" }).goals, 1);
  assert.equal(summary({ status: "complete", objective: "Ship" }).goals, 0);
  assert.equal(summary({ status: "idle" }).goals, 0);
});
