import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getAppLanguage } from "../i18n";
import {
  beginHtmlExport,
  cancelHtmlExport,
  completeHtmlExport,
  isNative,
  listenToAgentEvents,
  listenToAgentResourceReloads,
  listenToAgentRestarts,
  listPendingExtensionUiRequests,
  listRunningAgents,
  getSessionHistoryStamp,
  notifyPlanAttention,
  loadSessionHistory,
  reconcilePlanDialogRecovery,
  reloadAgentResources,
  restartAgent,
  sendRpc,
  startAgent,
  writePlanDocument,
  stopAgent,
  type AgentRuntimeMode,
  type StartAgentOptions,
} from "../lib/bridge";
import {
  EMPTY_PLAN_MODE,
  answerPlanQuestion,
  cancelPlanMode,
  classifyPlanUiRequest,
  decodePlanInlineRevisionResponse,
  decodePlanUiRequestTitle,
  decidePlanReview,
  isClaimedPlanUiRequest,
  isTrustedPlanUiRequest,
  normalizePlanDocument,
  openPlanReview,
  planUiToolCallId,
  PLAN_RECOVERY_PROMPT_PREFIX,
  rearmPlanModeAfterLostDialog,
  recoverablePlanDialogKind,
  restorePlanQuestion,
  restorePlanReview,
  resolvePlanState,
  shouldAwaitPlanToolResult,
  startPlanMode,
  isInternalPlanRecoveryPrompt,
  unresolvedPlanDialogSummary,
  type PlanDocument,
  type PlanModeState,
  type PlanReviewDecision,
} from "../lib/plan-mode";
import { redactText, redactValue } from "../lib/redaction";
import { buildRlmDelegationPrompt } from "../lib/rlm-preferences";
import {
  appendUniqueAgentMessage,
  parseAgentMessageNotice,
} from "../lib/agent-message-notices";
import {
  appendUniqueRefinementOutcome,
  parseRefinementOutcomeNotice,
} from "../lib/refinement-outcome-notices";
import {
  goalAcknowledgementDisposition,
  goalForSessionSnapshot,
  goalMutationDescriptor,
  goalMutationEventMatches,
  type GoalMutationDescriptor,
  type GoalMutationRuntimeState,
} from "../lib/goal-control";
import type { RuntimeNotice } from "../lib/runtime-notices";
import { isParentManagedSubagentClosure } from "../lib/session-inspector";
import type {
  ActivityItem,
  AgentRlmChild,
  AgentSessionState,
  AgentSchedule,
  AgentHeartbeatSummary,
  Attachment,
  ChatMessage,
  Conversation,
  ExtensionUiRequest,
  GoalState,
  ModelInfo,
  NativeEventPayload,
  PendingExtensionUiRequest,
  Project,
  RpcEnvelope,
  RuntimeDetection,
  SessionHarnessEntry,
  SessionRefinementRecord,
  SessionStats,
  SlashCommand,
  ThinkingLevel,
  ToolActivity,
} from "../types";

interface ConversationRuntime {
  isCompacting?: boolean;
  isRefining?: boolean;
  state?: AgentSessionState;
  models: ModelInfo[];
  commands: SlashCommand[];
  stats?: SessionStats;
  schedules?: AgentSchedule[];
  heartbeat?: AgentSchedule | null;
  heartbeats?: AgentHeartbeatSummary[];
  subagents?: AgentRlmChild[];
  observedSubagent?: {
    activeSessionId: string;
    messages: ChatMessage[];
    closed?: boolean;
    error?: string;
  };
  goalMutation?: GoalMutationRuntimeState;
  refinements?: SessionRefinementRecord[];
  harnessEntries?: SessionHarnessEntry[];
  /** Corrections applied when an authoritative snapshot contradicted the
   * renderer. Diagnostic evidence for lost-event investigations. */
  divergences?: RuntimeDivergence[];
  logs: Array<{ id: string; stream: "rpc" | "stderr"; text: string; createdAt: string }>;
}

interface RuntimeMap {
  [conversationId: string]: ConversationRuntime | undefined;
}

interface SelectionToken {
  conversationId?: string;
  generation: number;
}

interface PendingSelectionRequest {
  conversationId: string;
  generation: number;
  timeout: number;
  transcriptEpoch?: number;
  statsEpoch?: number;
  stateEpoch?: number;
  goalEpoch?: number;
  resolve?: (message: RpcEnvelope) => void;
  reject?: (error: Error) => void;
}

interface PendingConversationRequest {
  conversationId: string;
  timeout: number;
  purpose?: ConversationResponsePurpose;
  resolve: (message: RpcEnvelope) => void;
  reject: (error: Error) => void;
}

type ConversationResponsePurpose = "goal_mutation" | "prompt_admission" | "plan_recovery";

export function shouldConsumeConversationResponse(
  purpose: ConversationResponsePurpose | undefined,
  isSuppressedLateResponse = false,
): boolean {
  return isSuppressedLateResponse
    || purpose === "goal_mutation"
    || purpose === "prompt_admission"
    || purpose === "plan_recovery";
}

export function applyRuntimeCompactingState(
  runtime: ConversationRuntime | undefined,
  isCompacting: boolean,
  clearContextUsage = false,
): ConversationRuntime {
  const current = runtime ?? { models: [], commands: [], logs: [] };
  const state = current.state && current.state.isCompacting !== isCompacting
    ? { ...current.state, isCompacting }
    : current.state;
  const stats = clearContextUsage && current.stats?.contextUsage
    ? { ...current.stats, contextUsage: undefined }
    : current.stats;
  if (current.isCompacting === isCompacting && state === current.state && stats === current.stats) return current;
  return { ...current, isCompacting, state, stats };
}

interface PendingCompaction {
  conversationId: string;
  previousStatus: Conversation["status"];
  started: boolean;
  timeout: number;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface HistoryLoad {
  promise: Promise<void>;
  transcriptEpoch: number;
}

interface RuntimeBootstrap {
  generation: number;
  promise: Promise<void>;
}

type MaintenanceKind = "restart" | "reload";

const HISTORY_RESPONSE_TIMEOUT_MS = 30_000;
const HISTORY_REQUEST_ATTEMPTS = 1;
const PASSIVE_RESPONSE_TIMEOUT_MS = 30_000;
const SELECTION_ACTIVATION_TIMEOUT_MS = 5_000;
export const PLAN_NATIVE_REPLAY_PROBE_TIMEOUT_MS = 5_000;
export const PLAN_NATIVE_REPLAY_POLL_INTERVAL_MS = 125;
// A client-owned Prime Agent daemon session keeps its lease for up to 30 s
// after an abrupt RPC-client disconnect. Stay in one reconnect transaction
// across that grace period instead of flashing an error and requiring a
// manual state refresh.
const RUNTIME_RECOVERY_TIMEOUT_MS = 60_000;
const RUNTIME_RECOVERY_INITIAL_DELAY_MS = 400;
const RUNTIME_RECOVERY_MAX_DELAY_MS = 4_000;
const HTML_EXPORT_RESPONSE_TIMEOUT_MS = 20 * 60_000;
// Prime Agent gives daemon refinements a ten-minute window. Orbit keeps
// the request conversation-scoped (so navigation cannot cancel it) and adds a
// small transport margin without pretending that a timeout cancelled the work.
const REFINE_RESPONSE_TIMEOUT_MS = 12 * 60_000;
// Compaction can legitimately take far longer than the daemon's legacy 30 s
// acknowledgement window. The lifecycle events remain authoritative and the
// emergency restart is the explicit escape hatch for a truly stuck operation.
const COMPACTION_LIFECYCLE_TIMEOUT_MS = 24 * 60 * 60_000;
// A goal slash command may legitimately wait behind a long-running turn. Keep
// the lifecycle waiter conversation-scoped and avoid presenting a short local
// timeout as proof that Prime Agent rejected the mutation.
const GOAL_MUTATION_LIFECYCLE_TIMEOUT_MS = 24 * 60 * 60_000;
const RECENT_COMPACTION_END_MS = 10_000;
const TERMINAL_STATE_RECONCILIATION_DELAY_MS = 600;
// Event-driven reconciliation only fires on a cue that itself travelled
// through the stream. When that cue is the thing that was lost, nothing
// re-synchronizes. This unconditional poll is the floor under every other
// recovery path: while Prime Agent is believed to be working, Orbit keeps
// asking it what is actually true.
const RUNTIME_RECONCILIATION_INTERVAL_MS = 7_000;
// A renderer activity row is never individually acknowledged by Prime Agent.
// One still marked running long after its last update is either real work or
// a lost terminal event, and only an authoritative snapshot separates the two.
export const ACTIVITY_STALL_TIMEOUT_MS = 45_000;
const MAX_RECORDED_DIVERGENCES = 20;
const SESSION_FILE_POLL_INTERVAL_MS = 400;
const PLAN_RESPONSE_ACK_TIMEOUT_MS = 12_000;
const OPTIONAL_SELECTION_COMMANDS = new Set([
  "get_available_models",
  "get_commands",
  "get_session_stats",
  "list_schedules",
  "get_heartbeat",
  "list_heartbeats",
]);
const SELECTION_SCOPED_COMMANDS = new Set([
  "get_state",
  "get_messages",
  ...OPTIONAL_SELECTION_COMMANDS,
]);
const ACKNOWLEDGED_COMMANDS = new Set([
  "add_schedule",
  "cancel_schedule",
  "set_heartbeat",
  "update_heartbeat",
  "manage_heartbeat",
  "observe",
  "unobserve",
]);

const now = () => new Date().toISOString();
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const maintenanceEventKey = (kind: MaintenanceKind, conversationId: string) => `${kind}:${conversationId}`;
const localHistoryIdentity = (conversation: Pick<Conversation, "id" | "sessionPath" | "sessionId">) => (
  `${conversation.id}\0${conversation.sessionPath ?? ""}\0${conversation.sessionId ?? ""}`
);
const localHistoryConversationPrefix = (conversationId: string) => `${conversationId}\0`;

/** Local history may advertise the initial loading state only while the
 * persisted conversation is still offline. Once an RPC history response has
 * made the conversation ready (including a valid empty history), a later
 * session-path render must not latch it back into `starting`. */
export function shouldEnterLocalHistoryLoading(
  conversation: Pick<Conversation, "messages" | "sessionPath" | "status">,
  rpcHistoryLoaded: boolean,
): boolean {
  return Boolean(conversation.sessionPath)
    && conversation.messages.length === 0
    && conversation.status === "offline"
    && !rpcHistoryLoaded;
}

/** An in-flight local history read is selection-generation scoped. React
 * StrictMode and HMR can remount selection effects while retaining refs; a
 * promise started by the previous generation will deliberately refuse to
 * apply its result, so the new generation must replace it rather than await a
 * read that can only resolve as a no-op. */
export function shouldReuseLocalHistoryLoad(
  inFlightGeneration: number | undefined,
  requestedGeneration: number,
): boolean {
  return inFlightGeneration === requestedGeneration;
}

/** React Fast Refresh and StrictMode are allowed to clean up and recreate
 * effects without destroying the desktop page. Session-scoped requests must
 * survive those development lifecycles and be cancelled only when the WebView
 * itself is actually leaving. */
export function bindRuntimePageHideTeardown(
  target: {
    addEventListener: (type: "pagehide", listener: EventListener) => void;
    removeEventListener: (type: "pagehide", listener: EventListener) => void;
  },
  teardown: () => void,
): () => void {
  const handlePageHide: EventListener = () => teardown();
  target.addEventListener("pagehide", handlePageHide);
  return () => target.removeEventListener("pagehide", handlePageHide);
}

/** A reconnect is transport work, not a new agent turn. If Prime Agent's
 * attested JSONL already records an idle task verdict, keep presenting that
 * native state while Orbit reclaims the RPC lease in the background. */
export function statusDuringRuntimeRecovery(
  currentStatus: Conversation["status"],
  hasDurableIdleVerdict: boolean,
): Conversation["status"] {
  if (hasDurableIdleVerdict) return "idle";
  return currentStatus === "streaming" || currentStatus === "tool" || currentStatus === "queued"
    ? currentStatus
    : "starting";
}

/** Prime Agent's previous durable idle verdict cannot finish a prompt that
 * Orbit has just admitted. A later attested file revision may carry the next
 * authoritative verdict, but an initial read has no baseline proving that the
 * verdict was recorded after the prompt. */
export function shouldApplyDurableIdleTaskState(
  taskState: string | undefined,
  promptIsTracked: boolean,
  previousRevision: string | undefined,
  currentRevision: string,
): boolean {
  const isIdle = taskState === "needs_input" || taskState === "completed";
  if (!isIdle) return false;
  if (!promptIsTracked) return true;
  return previousRevision !== undefined && previousRevision !== currentRevision;
}

/** Mirrors Prime Agent's native admission rule. An idle prompt starts a turn;
 * input submitted during active work steers unless the caller explicitly asks
 * for a follow-up. Compaction only accepts work for the later idle boundary. */
export function resolveNativePromptDelivery(
  status: Conversation["status"],
  requestedDelivery: "steer" | "follow_up" | undefined,
  hasTrackedWork: boolean,
  isCompacting = false,
): "steer" | "follow_up" | undefined {
  if (status === "starting" && !hasTrackedWork) return undefined;
  if (isCompacting) return "follow_up";
  if (requestedDelivery) return requestedDelivery;
  return hasTrackedWork || status === "streaming" || status === "tool" || status === "queued"
    ? "steer"
    : undefined;
}

/** A successful get_state snapshot is the recovery boundary when renderer
 * event delivery was interrupted between message_end and agent_end. */
export function isAuthoritativeIdleSessionSnapshot(
  sessionState: Pick<AgentSessionState, "isCompacting" | "isStreaming" | "sessionActions">,
): boolean {
  const actions = sessionState.sessionActions;
  return !sessionState.isCompacting
    && !sessionState.isStreaming
    && !actions.active;
}

/** Only Prime Agent's active action means that work is executing. Its native
 * queues deliberately survive Ctrl+C/Stop and must not make an idle session
 * look busy or force the next normal prompt into the steering lane. */
export function sessionActionsHaveWork(
  actions: AgentSessionState["sessionActions"] | undefined,
): boolean {
  return Boolean(actions?.active);
}

export function activeStatusForSessionActions(
  actions: AgentSessionState["sessionActions"] | undefined,
): Conversation["status"] | undefined {
  if (actions?.active) {
    return actions.active.kind === "session_command" ? "tool" : "streaming";
  }
  return undefined;
}

export function conversationStatusForSessionSnapshot(
  sessionState: Pick<AgentSessionState, "isCompacting" | "isStreaming" | "sessionActions">,
  currentStatus: Conversation["status"],
  localOperationBlocksIdleRecovery: boolean,
): Conversation["status"] {
  if (sessionState.isCompacting) return "tool";
  if (sessionState.isStreaming) return "streaming";
  const actionStatus = activeStatusForSessionActions(sessionState.sessionActions);
  if (actionStatus) return actionStatus;
  if (localOperationBlocksIdleRecovery) return currentStatus;
  return currentStatus === "starting" ? "starting" : "idle";
}

export function canFinalizePendingPlanDecision(
  hasPendingPlanRequest: boolean,
  hasPersistedDecisionResult: boolean,
): boolean {
  return hasPersistedDecisionResult && !hasPendingPlanRequest;
}

/** Renderer state can say idle while the native Plan process is blocked in a
 * UI call. Replay the native queue whenever either the runtime looks active or
 * the canonical transcript/Plan state says a dialog is recoverable. */
export function shouldReplayNativePlanRequests(
  status: Conversation["status"],
  recoverableKind: "question" | "review" | undefined,
): boolean {
  return Boolean(recoverableKind)
    || status === "starting"
    || status === "streaming"
    || status === "tool"
    || status === "queued";
}

export interface PlanReplayGenerationIdentity {
  pid: number;
  startedAt: number;
  toolCallId: string;
}

export interface PlanReplayAbsenceEvidence extends PlanReplayGenerationIdentity {
  firstObservedAt: number;
  lastObservedAt: number;
  observations: number;
}

/** Native request absence is meaningful only while the exact Plan process and
 * durable tool call remain unchanged. Any transient/ambiguous observation
 * discards the accumulated evidence instead of opening a recovery card. */
export function updatePlanReplayAbsenceEvidence(
  current: PlanReplayAbsenceEvidence | undefined,
  observation: ({ status: "absent" } & PlanReplayGenerationIdentity) | { status: "unknown" },
  observedAt: number,
): PlanReplayAbsenceEvidence | undefined {
  if (observation.status !== "absent") return undefined;
  if (
    current
    && current.pid === observation.pid
    && current.startedAt === observation.startedAt
    && current.toolCallId === observation.toolCallId
  ) {
    return {
      ...current,
      lastObservedAt: observedAt,
      observations: current.observations + 1,
    };
  }
  return {
    pid: observation.pid,
    startedAt: observation.startedAt,
    toolCallId: observation.toolCallId,
    firstObservedAt: observedAt,
    lastObservedAt: observedAt,
    observations: 1,
  };
}

export function hasAttestedPlanReplayAbsence(
  evidence: PlanReplayAbsenceEvidence | undefined,
  timeoutMs = PLAN_NATIVE_REPLAY_PROBE_TIMEOUT_MS,
): boolean {
  return Boolean(
    evidence
    && evidence.observations >= 2
    && evidence.lastObservedAt - evidence.firstObservedAt >= timeoutMs,
  );
}

/** A primitive identity keeps the replay effect stable when workspace updates
 * clone the selected conversation or project object. Selection generation is
 * captured after layout and remains a separate stale-work guard. */
export function planReplayProbeIdentity(
  conversationId: string | undefined,
  projectId: string | undefined,
  expectedToolCallId: string | undefined,
): string | undefined {
  if (!conversationId || !projectId) return undefined;
  return JSON.stringify([conversationId, projectId, expectedToolCallId ?? null]);
}

/** Finds the live native dialog that owns the durable Plan tool call seen in
 * Prime Agent's transcript. A transient request from another Plan round must
 * never make recovery believe that the expected interaction is available. */
export function matchingNativePlanRequest(
  payloads: readonly NativeEventPayload[],
  conversationId: string,
  expectedToolCallId?: string,
  excludedRequestIds: ReadonlySet<string> = new Set<string>(),
): NativeEventPayload | undefined {
  return payloads.find((payload) => {
    if (payload.conversationId !== conversationId || payload.runtimeMode !== "plan") return false;
    try {
      const request = JSON.parse(payload.line) as ExtensionUiRequest;
      if (excludedRequestIds.has(request.id)) return false;
      if (classifyPlanUiRequest(request, payload.runtimeMode) !== "accepted") return false;
      return expectedToolCallId === undefined || planUiToolCallId(request) === expectedToolCallId;
    } catch {
      return false;
    }
  });
}

/** An idle daemon snapshot may repair a missed terminal event, but it must not
 * erase a prompt that the renderer has admitted and is still bootstrapping. */
export function shouldRecoverIdleSessionState(
  snapshotIsIdle: boolean,
  localOperationBlocksRecovery: boolean,
  promptAdmissionPending: boolean,
): boolean {
  return snapshotIsIdle && !localOperationBlocksRecovery && !promptAdmissionPending;
}

/** State snapshots are point-in-time observations. A lifecycle or local prompt
 * admission that starts after the request invalidates an otherwise-idle
 * response so it cannot erase newer work. */
export function shouldApplySessionStateResponse(
  requestedStateEpoch: number | undefined,
  currentStateEpoch: number,
): boolean {
  return requestedStateEpoch === currentStateEpoch;
}

/** message_end is not itself an idle boundary: post-processing, tools, retry,
 * compaction, or a queued follow-up can still run. It is only a cue to request
 * an authoritative state snapshot if the stronger agent_end event is missed. */
export function shouldScheduleTerminalStateReconciliation(event: { type: string; message?: unknown }): boolean {
  if (event.type === "turn_end") return true;
  if (event.type !== "message_end") return false;
  const message = event.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const record = message as Record<string, unknown>;
  return record.role === "assistant" && record.stopReason !== "toolUse";
}

const STALLED_ACTIVITY_NOTE = "Ligne close après relecture de l’état Prime Agent.";
export const STOPPED_ACTIVITY_NOTE = "Ligne close : le processus Prime Agent s’est arrêté.";

/** Activity rows whose last update is older than the stall timeout. */
export function stalledRunningActivities(
  activities: readonly ActivityItem[],
  nowMs: number,
  stallTimeoutMs = ACTIVITY_STALL_TIMEOUT_MS,
): ActivityItem[] {
  return activities.filter((activity) => {
    if (activity.status !== "running") return false;
    const stamp = Date.parse(activity.updatedAt ?? activity.createdAt);
    return Number.isFinite(stamp) && nowMs - stamp >= stallTimeoutMs;
  });
}

/** Decides whether a conversation still owes Prime Agent a state check.
 * Polling covers both directions of drift: a status that stayed active after a
 * lost terminal event, and an idle status still presenting running rows. */
export function shouldReconcileRuntimeState(
  status: Conversation["status"],
  hasStalledActivities: boolean,
): boolean {
  if (status === "streaming" || status === "tool" || status === "queued") return true;
  return hasStalledActivities && status !== "offline";
}

/** Closes renderer-owned rows that Prime Agent's idle state has outlived.
 * `finalizeConversationTools` only understands tool executions; lifecycle rows
 * such as `agent_start` have no terminal event of their own once the stream
 * that would have closed them was lost, so they would otherwise spin forever.
 * The neutral status is deliberate: the snapshot proves the work is over, not
 * that it succeeded. */
export function finalizeStalledActivityRows(
  activities: readonly ActivityItem[],
  eventTime: string,
  outcome: { status: ActivityItem["status"]; note: string } = {
    status: "info",
    note: STALLED_ACTIVITY_NOTE,
  },
): ActivityItem[] {
  let changed = false;
  const next = activities.map((activity) => {
    if (activity.status !== "running") return activity;
    changed = true;
    return {
      ...activity,
      status: outcome.status,
      detail: activity.detail ? `${activity.detail} · ${outcome.note}` : outcome.note,
      updatedAt: eventTime,
      updateCount: (activity.updateCount ?? 1) + 1,
    };
  });
  return changed ? next : (activities as ActivityItem[]);
}

/** Finalize renderer-only tool/activity state after get_state proves that the
 * daemon has no active turn. A preserved native queue remains visible. */
export function finalizeAuthoritativeIdleSnapshot(
  conversation: Conversation,
  eventTime = now(),
): Conversation {
  const finalized = finalizeConversationTools(conversation, "completed", eventTime);
  return {
    ...finalized,
    activities: finalizeStalledActivityRows(finalized.activities, eventTime),
    status: conversation.status === "starting" ? "starting" : "idle",
    lastError: undefined,
  };
}

export interface RuntimeDivergence {
  id: string;
  observedStatus: Conversation["status"];
  stalledActivities: number;
  detectedAt: string;
  source: "reconciliation" | "resync";
}

/** Records only corrections that contradict what the renderer was presenting.
 * A snapshot confirming an already-idle conversation is agreement, not drift,
 * and logging it would bury the real losses in noise. */
export function runtimeDivergenceForSnapshot(
  observedStatus: Conversation["status"],
  stalledActivities: number,
  source: RuntimeDivergence["source"],
  detectedAt = now(),
): Omit<RuntimeDivergence, "id"> | undefined {
  const statusDiverged = observedStatus === "streaming"
    || observedStatus === "tool"
    || observedStatus === "queued";
  if (!statusDiverged && stalledActivities === 0) return undefined;
  return { observedStatus, stalledActivities, detectedAt, source };
}

export function isCompactDaemonAcknowledgementTimeout(message: Pick<RpcEnvelope, "command" | "success" | "error">): boolean {
  if (message.command !== "compact" || message.success !== false || typeof message.error !== "string") return false;
  return /^Timed out after 30000ms waiting for the Prime Agent daemon response to "compact"\.(?:\s|$)/.test(
    message.error.trim(),
  );
}

interface PendingGoalMutation {
  conversationId: string;
  descriptor: GoalMutationDescriptor;
  settled: boolean;
  timeout: number;
  promise: Promise<GoalState>;
  resolve: (goal: GoalState) => void;
  reject: (error: Error) => void;
}

export function isRefineDaemonAcknowledgementTimeout(message: Pick<RpcEnvelope, "command" | "success" | "error">): boolean {
  if (message.command !== "refine" || message.success !== false || typeof message.error !== "string") return false;
  return /^Timed out after \d+ms waiting for the Prime Agent daemon response to "refine"\.(?:\s|$)/.test(
    message.error.trim(),
  );
}

export function refineLifecycleDisposition(hasLocalDirectRequest: boolean): "await_local_response" | "passive_terminal" {
  // Prime Agent does not identify which refine request emitted a terminal
  // lifecycle event. A window that owns a direct request must therefore wait
  // for its correlated RPC response; the event may belong to another window
  // or to an automatic refinement.
  return hasLocalDirectRequest ? "await_local_response" : "passive_terminal";
}

export interface RefinementPresentation {
  activityId?: string;
  title: string;
  detail?: string;
  appliedEdits: number;
}

export function refinementResultPresentation(value: unknown): RefinementPresentation {
  const result = asRecord(value);
  const id = textValue(result?.id);
  const summary = cleanDiagnostic(result?.summary);
  const scope = result?.scope === "global" ? "globale" : result?.scope === "local" ? "locale" : undefined;
  const edits = Array.isArray(result?.appliedEdits) ? result.appliedEdits : [];
  const appliedEdits = edits.filter((edit) => asRecord(edit)?.applied === true).length;
  const count = appliedEdits === 0
    ? "Aucune modification appliquée"
    : `${appliedEdits} modification${appliedEdits === 1 ? "" : "s"} appliquée${appliedEdits === 1 ? "" : "s"}`;
  return {
    activityId: id ? `refinement:${id}` : undefined,
    title: appliedEdits > 0 ? "Raffinement appliqué" : "Raffinement terminé",
    detail: [summary, count, scope ? `Portée ${scope}` : undefined].filter(Boolean).join(" · "),
    appliedEdits,
  };
}

export type CompactResponseDisposition = "not_compact" | "success" | "pending" | "lifecycle_handled" | "failure";

/** Classifies the compact acknowledgement separately from the operation. A
 * daemon acknowledgement timeout never proves that compaction failed: Prime
 * Agent keeps running it and reports completion with compaction_end. */
export function compactResponseDisposition(
  message: Pick<RpcEnvelope, "command" | "success" | "error">,
  hasRecentLifecycleEnd: boolean,
): CompactResponseDisposition {
  if (message.command !== "compact") return "not_compact";
  if (message.success !== false) return "success";
  if (hasRecentLifecycleEnd) return "lifecycle_handled";
  return isCompactDaemonAcknowledgementTimeout(message) ? "pending" : "failure";
}

export interface CompactionEndPresentation {
  title: string;
  detail?: string;
  status: ActivityItem["status"];
  failed: boolean;
}

interface CompactionEndEventLike {
  type?: string;
  aborted?: unknown;
  willRetry?: unknown;
  errorMessage?: unknown;
  errorSeverity?: unknown;
}

export function compactionEndPresentation(
  event: CompactionEndEventLike,
): CompactionEndPresentation {
  const detail = typeof event.errorMessage === "string" && event.errorMessage.trim()
    ? event.errorMessage.trim()
    : undefined;
  if (event.errorSeverity === "error") {
    return { title: "Échec du compactage", detail, status: "error", failed: true };
  }
  if (event.aborted === true) {
    return { title: "Compactage annulé", detail, status: "warning", failed: false };
  }
  if (event.errorSeverity === "warning") {
    return { title: "Compactage non nécessaire", detail, status: "warning", failed: false };
  }
  // Older and automatic Prime Agent compaction paths can report a real
  // failure through errorMessage without adding errorSeverity. A terminal
  // diagnostic must never be presented as a successful compaction.
  if (detail) {
    return { title: "Échec du compactage", detail, status: "error", failed: true };
  }
  if (event.willRetry === true) {
    return { title: "Contexte compacté, reprise en cours", detail, status: "running", failed: false };
  }
  return { title: "Contexte compacté", detail, status: "success", failed: false };
}

const cleanDiagnostic = (value: unknown) => (
  typeof value === "string" && value.trim() ? redactText(value.trim()) : undefined
);

/** Only durable display metadata is allowed into app state. Native attachment
 * handles are short-lived capabilities. The optional preview is a bounded
 * thumbnail generated natively, never the original file bytes. */
export function durableAttachmentMetadata(attachment: Attachment): Attachment {
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    isImage: attachment.isImage,
    ...(attachment.isImage && attachment.previewDataUrl
      ? { previewDataUrl: attachment.previewDataUrl }
      : {}),
  };
}

/** Builds the capability-only attachment fields accepted by the native RPC
 * bridge. Neither the prompt nor renderer state needs a source path. */
export function promptAttachmentPayload(attachments: Attachment[]) {
  const images = attachments
    .filter((item) => item.isImage && item.attachmentHandle)
    .map((item) => ({ type: "image", attachmentHandle: item.attachmentHandle! }));
  const documents = attachments
    .filter((item) => !item.isImage && item.attachmentHandle)
    .map((item) => ({ attachmentHandle: item.attachmentHandle! }));
  return {
    ...(images.length ? { images } : {}),
    ...(documents.length ? { attachments: documents } : {}),
  };
}

/** Removes queue rows written by older Orbit builds. They are renderer-owned
 * artifacts, not Prime Agent transcript entries, and must never participate in
 * queue reconciliation after the native queue becomes authoritative. */
function isLegacyOrbitQueueRow(message: ChatMessage): boolean {
  return Boolean(
    message.role === "user"
    && (
      message.queueDelivery
      || message.queueHistoryPending
      || message.status === "pending"
    )
  );
}

function stripLegacyOrbitQueueMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.some(isLegacyOrbitQueueRow)
    ? messages.filter((message) => !isLegacyOrbitQueueRow(message))
    : messages;
}

export function stripLegacyOrbitQueueRows(conversation: Conversation): Conversation {
  const messages = stripLegacyOrbitQueueMessages(conversation.messages);
  return messages === conversation.messages
    ? conversation
    : { ...conversation, messages };
}

/** Normal bootstrap histories remain applicable without an epoch. A targeted
 * terminal queue reload is accepted only if no newer prompt/run has started. */
export function shouldApplyHistoryResponse(
  expectedTranscriptEpoch: number | undefined,
  currentTranscriptEpoch: number,
  isRunning: boolean,
): boolean {
  return expectedTranscriptEpoch === undefined
    || (!isRunning && expectedTranscriptEpoch === currentTranscriptEpoch);
}

function normalizeQueuedText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

/** Appends only Prime Agent's authoritative user event. Orbit never promotes a
 * local draft or queue row by comparing text, position, or attachments. */
export function applyAuthoritativeUserMessageStart(
  conversation: Conversation,
  text: string,
  createdAt: string,
  structuredAttachments: Attachment[] = [],
  authoritativeMessageId?: string,
): Conversation {
  const parsedContext = parsePrimeOrbitAttachmentContext(text);
  const visibleText = parsedContext.visibleText;
  const eventAttachments = sanitizeAuthoritativeAttachments(structuredAttachments);
  const authoritativeAttachments = eventAttachments.length
    ? eventAttachments
    : parsedContext.attachments;
  const cleaned = stripLegacyOrbitQueueRows(conversation);
  if (authoritativeMessageId && cleaned.messages.some((message) => (
    message.role === "user"
    && (message.id === authoritativeMessageId || message.entryId === authoritativeMessageId)
  ))) return cleaned;
  if (!visibleText.trim() && !authoritativeAttachments.length) return cleaned;

  return {
    ...cleaned,
    hasContent: true,
    messages: [...cleaned.messages, {
      id: authoritativeMessageId || uid("user"),
      ...(authoritativeMessageId ? { entryId: authoritativeMessageId } : {}),
      role: "user",
      content: visibleText || "Fichier joint",
      createdAt,
      status: "complete",
      attachments: authoritativeAttachments.length ? authoritativeAttachments : undefined,
    }],
  };
}

/** Once Prime Agent has published a session file, that append-only file is
 * the sole transcript projection. Runtime events remain lifecycle signals and
 * must not add a second copy of the same durable message. */
export function usesPersistedPrimeAgentTranscript(
  nativeRuntime: boolean,
  sessionPath: string | undefined,
): boolean {
  return nativeRuntime && typeof sessionPath === "string" && sessionPath.trim().length > 0;
}

export function shouldProjectLiveTranscript(
  nativeRuntime: boolean,
  sessionPath: string | undefined,
): boolean {
  return !usesPersistedPrimeAgentTranscript(nativeRuntime, sessionPath);
}

/** Marks only orphaned blocking Plan calls as cancelled before asking Prime
 * Agent to recreate their native extension UI. Other unresolved tools remain
 * untouched because Orbit cannot infer their outcome. */
export function cancelUnresolvedPlanDialogs(
  conversation: Conversation,
  eventTime: string,
): Conversation {
  let changed = false;
  const messages = conversation.messages.map((message) => {
    if (!message.tools?.some((tool) => (
      tool.status === "unresolved"
      && (tool.name === "prime_orbit_plan_question" || tool.name === "prime_orbit_plan_submit")
    ))) return message;
    changed = true;
    return {
      ...message,
      tools: message.tools.map((tool) => (
        tool.status === "unresolved"
        && (tool.name === "prime_orbit_plan_question" || tool.name === "prime_orbit_plan_submit")
          ? { ...tool, status: "cancelled" as const, endedAt: eventTime }
          : tool
      )),
    };
  });
  return changed ? { ...conversation, messages } : conversation;
}

export function extensionRequestKey(conversationId: string, requestId: string) {
  return `${conversationId}\0${requestId}`;
}

export function enqueueExtensionRequest(
  requests: PendingExtensionUiRequest[],
  request: PendingExtensionUiRequest,
): PendingExtensionUiRequest[] {
  const existing = requests.findIndex((item) => item.requestKey === request.requestKey);
  if (existing < 0) return [...requests, request];
  const next = [...requests];
  next[existing] = request;
  return next;
}

function planRuntimeText(french: string, english: string): string {
  return getAppLanguage() === "en" ? english : french;
}

type PendingPlanFinalization = NonNullable<Conversation["pendingPlanAction"]>;

export function conversationPlanState(conversation: Pick<Conversation, "planMode"> | undefined): PlanModeState {
  return resolvePlanState(conversation?.planMode) ?? EMPTY_PLAN_MODE;
}

export function runtimeModeForPlan(state: PlanModeState): AgentRuntimeMode {
  return state.phase === "idle" ? "normal" : "plan";
}

export function runtimeModeForConversationPlan(
  conversation: Pick<Conversation, "planMode" | "pendingPlanAction"> | undefined,
): AgentRuntimeMode {
  const pending = conversation?.pendingPlanAction;
  if (pending?.stage === "decisionRecorded") return "plan";
  if (pending) return "normal";
  return runtimeModeForPlan(conversationPlanState(conversation));
}

export function desiredRuntimeModeForConversation(
  conversation: Pick<Conversation, "planMode" | "pendingPlanAction"> | undefined,
  expectedTransitionMode?: AgentRuntimeMode,
): AgentRuntimeMode {
  return expectedTransitionMode ?? runtimeModeForConversationPlan(conversation);
}

export function isTransientHistoryReadFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message === "Prime Agent n’a pas répondu à get_messages."
    || message === "Prime Agent n’a pas répondu à get_messages dans le délai prévu."
    || message === "Prime Agent did not respond to get_messages."
    || message === "Prime Agent did not respond to get_messages before the timeout."
    || message.startsWith(
      'Cannot send daemon command "get_messages" because the Prime Agent daemon is not connected.',
    );
}

export function isTransientHistoryResponseFailure(message: {
  command?: string;
  success?: boolean;
  error?: unknown;
}): boolean {
  return message.command === "get_messages"
    && message.success === false
    && isTransientHistoryReadFailure(message.error ?? "");
}

export function isOptionalSelectionResponseFailure(message: {
  command?: string;
  success?: boolean;
  error?: unknown;
}): boolean {
  if (message.success !== false
    || typeof message.command !== "string"
    || !OPTIONAL_SELECTION_COMMANDS.has(message.command)) return false;
  const detail = message.error instanceof Error ? message.error.message : String(message.error ?? "");
  const lowerDetail = detail.toLowerCase();
  return detail.startsWith(
    `Cannot send daemon command "${message.command}" because the Prime Agent daemon is not connected.`,
  ) || lowerDetail.includes("unknown command") || lowerDetail.includes("unsupported");
}

export async function commitPlanRuntimeModeTransition(
  mode: AgentRuntimeMode,
  restartNative: (() => Promise<AgentRuntimeMode | undefined>) | undefined,
  persistPlanState: () => void | Promise<void>,
  setExpectedRuntimeMode: (mode: AgentRuntimeMode | undefined) => void = () => undefined,
): Promise<void> {
  // The native restarted event can refresh this conversation before the
  // durable Plan state is committed. Publish the transaction-local intent so
  // that refresh cannot interpret the replacement runtime as a mismatch and
  // immediately restart it back to the old mode.
  setExpectedRuntimeMode(mode);
  try {
    if (restartNative) {
      const activeMode = await restartNative();
      if (activeMode !== mode) {
        throw new Error(planRuntimeText(
          "Prime Agent n’a pas pu changer de mode d’exécution.",
          "Prime Agent could not change runtime mode.",
        ));
      }
    }
    // Persist only after the native process reports the requested mode. This
    // prevents the selection effect from observing the new Plan state early
    // and racing a second restart against the first one.
    await persistPlanState();
  } finally {
    setExpectedRuntimeMode(undefined);
  }
}

export function recordedPlanResponseValue(
  pending: Conversation["pendingPlanAction"] | undefined,
  request: Pick<PendingExtensionUiRequest, "options">,
  decoded: ReturnType<typeof decodePlanUiRequestTitle>,
): string | undefined {
  if (pending?.stage !== "decisionRecorded" || decoded?.payload.kind !== "review") return undefined;
  if (decoded.payload.planId !== pending.handoffId) return undefined;
  return request.options?.[pending.decision === "apply" ? 0 : 1];
}

export function planDocumentForReview(
  conversation: Pick<Conversation, "messages">,
  planId: string,
  title: string,
): Omit<PlanDocument, "round"> | undefined {
  for (let messageIndex = conversation.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const tools = conversation.messages[messageIndex]?.tools ?? [];
    for (let toolIndex = tools.length - 1; toolIndex >= 0; toolIndex -= 1) {
      const tool = tools[toolIndex];
      if (tool?.id !== planId || tool.name !== "prime_orbit_plan_submit") continue;
      const input = tool.input && typeof tool.input === "object" ? tool.input as Record<string, unknown> : undefined;
      return normalizePlanDocument({ name: title, markdown: input?.document });
    }
  }
  return undefined;
}

const PLAN_HANDOFF_MARKER_PREFIX = "prime-orbit-plan-handoff:v1:";

export function planHandoffMarker(handoffId: string): string {
  return `<!-- ${PLAN_HANDOFF_MARKER_PREFIX}${handoffId} -->`;
}

export function conversationHasPlanHandoff(
  conversation: Pick<Conversation, "messages"> | undefined,
  handoffId: string,
): boolean {
  const marker = planHandoffMarker(handoffId);
  return Boolean(conversation?.messages.some(
    (message) => message.role === "user"
      && (message.internal === "plan_handoff" || message.content.includes(marker))
      && message.content.includes(marker),
  ));
}

/** The exact persisted Prime Agent tool result is the acknowledgement boundary
 * for Apply/Keep. It is safe to terminate the isolated Plan runtime only after
 * this canonical result exists; renderer state and `message_end` are not ACKs. */
export function conversationHasPlanDecisionResult(
  conversation: Pick<Conversation, "messages"> | undefined,
  handoffId: string,
): boolean {
  return Boolean(conversation?.messages.some((message) => (
    message.tools ?? []
  ).some((tool) => (
    tool.id === handoffId
      && tool.name === "prime_orbit_plan_submit"
      && tool.status === "completed"
  ))));
}

export function persistedPlanToolResultStatus(
  messages: unknown[],
  requestId: string,
): "completed" | "failed" | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (
      message?.role !== "toolResult"
      || message.toolCallId !== requestId
      || (message.toolName !== "prime_orbit_plan_question" && message.toolName !== "prime_orbit_plan_submit")
    ) continue;
    return message.isError === true ? "failed" : "completed";
  }
  return undefined;
}

export function isInternalPlanHandoffPrompt(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(`<!-- ${PLAN_HANDOFF_MARKER_PREFIX}`);
}

function planImplementationPrompt(document: PlanDocument, relativePath: string, handoffId: string): string {
  return [
    planHandoffMarker(handoffId),
    `[Prime Orbit approved plan: ${relativePath}]`,
    "Implement the approved plan now in this same conversation.",
    "Use the normal runtime tools. Treat the saved Markdown below as the source of truth.",
    "",
    document.markdown,
  ].join("\n");
}

/**
 * Builds the authoritative diagnostic for a process exit. stderr usually
 * contains the actionable Node/Python error, while the bridge error explains
 * the lifecycle failure. Keep both when they differ instead of hiding either
 * behind the generic history-request cancellation.
 */
export function agentExitErrorMessage(input: {
  code?: number;
  success: boolean;
  error?: string;
  stderr?: string;
}): string {
  const bridgeError = cleanDiagnostic(input.error);
  const stderr = cleanDiagnostic(input.stderr);
  if (bridgeError && stderr) {
    if (bridgeError.includes(stderr)) return bridgeError;
    if (stderr.includes(bridgeError)) return stderr;
    return `${bridgeError}\n\n${stderr}`;
  }
  if (stderr) return stderr;
  if (bridgeError) return bridgeError;
  return input.success
    ? "Prime Agent s’est fermé avant la fin du chargement."
    : `Prime Agent s’est arrêté (code ${input.code ?? "inconnu"}).`;
}

/** Prefer an exit diagnostic over the secondary error caused by cancelling a
 * pending get_messages request. This is deliberately pure so the race remains
 * covered without mounting the React hook. */
export function startupErrorMessage(error: unknown, exitDiagnostic?: string): string {
  return cleanDiagnostic(exitDiagnostic)
    ?? (error instanceof Error ? error.message : String(error));
}

export function isRecoverableConversationActivationError(error: unknown): boolean {
  const name = error && typeof error === "object" && "name" in error
    ? String((error as { name?: unknown }).name ?? "")
    : "";
  const message = error instanceof Error ? error.message : String(error);
  return name === "AbortError" && [
    "La conversation n’est plus active.",
    "The conversation is no longer active.",
    "Le chargement a été remplacé par une autre conversation.",
    "The conversation load was replaced by another conversation.",
  ].includes(message);
}

/** Failures that mean Orbit lost its RPC client or encountered Prime Agent's
 * short client-owned-session grace period. These may be retried safely because
 * every attempt resumes the same persisted session and never submits a turn. */
export function isRecoverableRuntimeBootstrapError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("aucun prime agent actif pour conversation-")
    || message.includes("no active prime agent for conversation-")
    || message.includes("session is already active in ")
    || message.includes("registered to a failed worker that could not be safely reclaimed")
    || message.includes("prime agent s’est arrêté pendant le chargement")
    || message.includes("prime agent stopped during loading")
    || (
      message.includes('cannot send daemon command "get_state"')
      && message.includes("daemon is not connected")
    );
}

export function useAgentRuntime(options: {
  active?: boolean;
  detection?: RuntimeDetection;
  selectedProject?: Project;
  selectedConversation?: Conversation;
  getProject: (projectId: string) => Project | undefined;
  getConversation: (conversationId: string) => Conversation | undefined;
  preserveSessionReference: (conversationId: string, title: string) => string | undefined;
  discardSessionReference: (conversationId: string) => void;
  updateConversation: (id: string, updater: Partial<Conversation> | ((current: Conversation) => Conversation)) => void;
  flushWorkspaceState: () => Promise<boolean>;
  onInstallProgress: (phase: string, message: string) => void;
  onInstallComplete: (detection: RuntimeDetection) => void;
  onNotice?: (notice: RuntimeNotice) => void;
}) {
  const {
    active = true,
    detection,
    selectedProject,
    selectedConversation,
    getProject,
    getConversation,
    preserveSessionReference,
    discardSessionReference,
    updateConversation,
    flushWorkspaceState,
    onInstallProgress,
    onInstallComplete,
    onNotice,
  } = options;
  const [runtimes, setRuntimes] = useState<RuntimeMap>({});
  const [extensionRequests, setExtensionRequests] = useState<PendingExtensionUiRequest[]>([]);
  const [planReplayProbeConversationId, setPlanReplayProbeConversationId] = useState<string>();
  const [eventsReady, setEventsReady] = useState(!isNative());
  const started = useRef(new Set<string>());
  const runtimeModes = useRef(new Map<string, AgentRuntimeMode>());
  const expectedRuntimeModeTransitions = useRef(new Map<string, AgentRuntimeMode>());
  const pendingPlanFinalizations = useRef(new Map<string, PendingPlanFinalization>());
  const planFinalizationsInFlight = useRef(new Set<string>());
  const persistedPlanDecisionResults = useRef(new Map<string, string>());
  const planReviewDocumentRefreshes = useRef(new Set<string>());
  const startInFlight = useRef(new Map<string, Promise<void>>());
  const runtimeBootstraps = useRef(new Map<string, RuntimeBootstrap>());
  const historyInFlight = useRef(new Map<string, HistoryLoad>());
  const historyLoaded = useRef(new Set<string>());
  const transcriptEpoch = useRef(new Map<string, number>());
  const statsEpoch = useRef(new Map<string, number>());
  const stateEpoch = useRef(new Map<string, number>());
  const goalEpoch = useRef(new Map<string, number>());
  const latestGoalByConversation = useRef(new Map<string, GoalState>());
  const localHistoryInFlight = useRef(new Map<string, {
    generation: number;
    promise: Promise<string | undefined>;
  }>());
  const localHistoryLoaded = useRef(new Set<string>());
  const localHistoryApplied = useRef(new Map<string, string>());
  const localHistoryRevisions = useRef(new Map<string, string>());
  const sessionActionsByConversation = useRef(new Map<string, AgentSessionState["sessionActions"]>());
  const bootstrapGeneration = useRef(new Map<string, number>());
  const pendingSelectionRequests = useRef(new Map<string, PendingSelectionRequest>());
  const pendingConversationRequests = useRef(new Map<string, PendingConversationRequest>());
  const suppressedConversationResponses = useRef(new Set<string>());
  const pendingGoalMutations = useRef(new Map<string, PendingGoalMutation>());
  const directRefinementActivities = useRef(new Map<string, string>());
  const uncertainRefinementConversations = useRef(new Set<string>());
  // Unlike selection-scoped bootstrap requests, compaction belongs to the
  // conversation process and must survive navigation. Every window receives
  // the same native lifecycle events; only the initiating window owns a
  // waiter/promise for its button.
  const pendingCompactions = useRef(new Map<string, PendingCompaction>());
  const compactingConversations = useRef(new Set<string>());
  const compactionLifecycleStarted = useRef(new Set<string>());
  const activeCompactionActivities = useRef(new Map<string, string>());
  const recentCompactionEnds = useRef(new Map<string, { endedAt: number; activityId: string }>());
  const compactionRefreshPending = useRef(new Set<string>());
  const terminalStateReconciliationTimers = useRef(new Map<string, number>());
  const activeSelection = useRef<SelectionToken>({ generation: 0 });
  const planReplayProbeGeneration = useRef(0);
  const selectedConversationId = useRef(active ? selectedConversation?.id : undefined);
  const runtimeViewActive = useRef(active);
  const runtimeEventsReady = useRef(eventsReady);
  const intentionallyStopped = useRef(new Set<string>());
  const activeBashActivities = useRef(new Map<string, string>());
  const lastStderr = useRef(new Map<string, string>());
  const processExitErrors = useRef(new Map<string, string>());
  // React state can lag by one render between two very fast submissions. This
  // process-local marker closes that gap so the second prompt is represented
  // as queued even when both handlers crossed ensureStarted concurrently.
  const activePromptRuns = useRef(new Set<string>());
  const persistedIdleConversations = useRef(new Set<string>());
  const pendingPromptAdmissions = useRef(new Set<string>());
  // Keep the real agent lifecycle separate from optimistic/queued prompts.
  // Otherwise deleting the last follow-up during Compact can leave a phantom
  // run, while clearing it blindly could hide a genuinely running agent.
  const activeAgentLifecycles = useRef(new Set<string>());
  const extensionResponsesInFlight = useRef(new Set<string>());
  const recordedPlanResponsesInFlight = useRef(new Set<string>());
  const maintenanceEventVersions = useRef(new Map<string, number>());
  const maintenanceRefreshes = useRef(new Map<string, Promise<void>>());
  const getProjectRef = useRef(getProject);
  const getConversationRef = useRef(getConversation);

  // Event callbacks can run between React's render and effect phases. Keeping
  // this ref current prevents a late history response from the previous
  // conversation from ever replacing the newly selected transcript.
  selectedConversationId.current = active ? selectedConversation?.id : undefined;
  runtimeViewActive.current = active;
  runtimeEventsReady.current = eventsReady;
  getProjectRef.current = getProject;
  getConversationRef.current = getConversation;

  const isCurrentSelection = useCallback((conversationId: string, generation: number) => (
    selectedConversationId.current === conversationId
      && activeSelection.current.conversationId === conversationId
      && activeSelection.current.generation === generation
  ), []);

  const clearPendingRequest = useCallback((requestId: string, error?: Error) => {
    const pending = pendingSelectionRequests.current.get(requestId);
    if (!pending) return;
    pendingSelectionRequests.current.delete(requestId);
    window.clearTimeout(pending.timeout);
    if (error) pending.reject?.(error);
  }, []);

  const cancelConversationRequests = useCallback((conversationId: string, reason: string) => {
    for (const [requestId, pending] of pendingSelectionRequests.current) {
      if (pending.conversationId !== conversationId) continue;
      clearPendingRequest(requestId, new Error(reason));
    }
    historyInFlight.current.delete(conversationId);
    historyLoaded.current.delete(conversationId);
    const localPrefix = localHistoryConversationPrefix(conversationId);
    for (const key of localHistoryInFlight.current.keys()) {
      if (key.startsWith(localPrefix)) localHistoryInFlight.current.delete(key);
    }
    bootstrapGeneration.current.delete(conversationId);
  }, [clearPendingRequest]);

  const clearPendingConversationRequest = useCallback((requestId: string, error?: Error) => {
    const pending = pendingConversationRequests.current.get(requestId);
    if (!pending) return;
    pendingConversationRequests.current.delete(requestId);
    window.clearTimeout(pending.timeout);
    // A timed-out/cancelled Goal acknowledgement can still arrive after the
    // lifecycle event. Retain its correlation id so that late response remains
    // owned by the Goal action instead of poisoning the whole conversation.
    if (error && shouldConsumeConversationResponse(pending.purpose)) {
      suppressedConversationResponses.current.add(requestId);
    }
    if (error) pending.reject(error);
  }, []);

  const cancelPersistentConversationRequests = useCallback((conversationId: string, reason: string) => {
    for (const [requestId, pending] of pendingConversationRequests.current) {
      if (pending.conversationId !== conversationId) continue;
      clearPendingConversationRequest(requestId, new Error(reason));
    }
  }, [clearPendingConversationRequest]);

  const sendConversationRequest = useCallback((
    conversationId: string,
    type: string,
    fields: Record<string, unknown> = {},
    timeoutMs = PASSIVE_RESPONSE_TIMEOUT_MS,
    purpose?: ConversationResponsePurpose,
    expectedRuntimeMode?: AgentRuntimeMode,
  ): Promise<RpcEnvelope> => {
    const requestId = uid(type);
    let resolveResponse!: (message: RpcEnvelope) => void;
    let rejectResponse!: (error: Error) => void;
    const response = new Promise<RpcEnvelope>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    const timeout = window.setTimeout(() => {
      clearPendingConversationRequest(
        requestId,
        new Error(`Prime Agent n’a pas répondu à ${type} dans le délai prévu.`),
      );
    }, timeoutMs);
    pendingConversationRequests.current.set(requestId, {
      conversationId,
      timeout,
      purpose,
      resolve: resolveResponse,
      reject: rejectResponse,
    });
    return sendRpc(
      conversationId,
      { id: requestId, type, ...fields },
      { expectedRuntimeMode },
    )
      .then(() => response)
      .catch((error) => {
        clearPendingConversationRequest(requestId);
        throw error;
      });
  }, [clearPendingConversationRequest]);

  const sendSelectionRequest = useCallback((
    conversationId: string,
    generation: number,
    type: string,
    waitForResponse = false,
    fields: Record<string, unknown> = {},
    requestMetadata: { transcriptEpoch?: number } = {},
  ): Promise<RpcEnvelope | void> => {
    if (!isCurrentSelection(conversationId, generation)) return Promise.resolve();
    const requestId = uid(type);
    let resolveResponse: ((message: RpcEnvelope) => void) | undefined;
    let rejectResponse: ((error: Error) => void) | undefined;
    const response = waitForResponse
      ? new Promise<RpcEnvelope>((resolve, reject) => {
          resolveResponse = resolve;
          rejectResponse = reject;
        })
      : Promise.resolve();
    const timeoutMs = waitForResponse ? HISTORY_RESPONSE_TIMEOUT_MS : PASSIVE_RESPONSE_TIMEOUT_MS;
    const timeout = window.setTimeout(() => {
      clearPendingRequest(requestId, waitForResponse
        ? new Error(`Prime Agent n’a pas répondu à ${type}.`)
        : undefined);
    }, timeoutMs);
    pendingSelectionRequests.current.set(requestId, {
      conversationId,
      generation,
      timeout,
      transcriptEpoch: requestMetadata.transcriptEpoch,
      statsEpoch: type === "get_session_stats" ? (statsEpoch.current.get(conversationId) ?? 0) : undefined,
      stateEpoch: type === "get_state" ? (stateEpoch.current.get(conversationId) ?? 0) : undefined,
      goalEpoch: type === "get_state" ? (goalEpoch.current.get(conversationId) ?? 0) : undefined,
      resolve: resolveResponse,
      reject: rejectResponse,
    });
    return sendRpc(conversationId, { id: requestId, type, ...fields })
      .then(() => response as Promise<RpcEnvelope | void>)
      .catch((error) => {
        clearPendingRequest(requestId);
        throw error;
      });
  }, [clearPendingRequest, isCurrentSelection]);

  const cancelTerminalStateReconciliation = useCallback((conversationId: string) => {
    const timeout = terminalStateReconciliationTimers.current.get(conversationId);
    if (timeout === undefined) return;
    terminalStateReconciliationTimers.current.delete(conversationId);
    window.clearTimeout(timeout);
  }, []);

  const scheduleTerminalStateReconciliation = useCallback((conversationId: string) => {
    cancelTerminalStateReconciliation(conversationId);
    const timeout = window.setTimeout(() => {
      terminalStateReconciliationTimers.current.delete(conversationId);
      // Normal delivery of agent_end clears the marker and cancels this probe.
      // A remaining marker means that Orbit may have lost the terminal tail of
      // the event stream, so ask the daemon rather than guessing from
      // message_end or a renderer-only tool card.
      if (!activePromptRuns.current.has(conversationId)) return;
      const token = activeSelection.current;
      if (
        token.conversationId !== conversationId
        || !isCurrentSelection(conversationId, token.generation)
      ) return;
      void sendSelectionRequest(conversationId, token.generation, "get_state").catch(() => undefined);
    }, TERMINAL_STATE_RECONCILIATION_DELAY_MS);
    terminalStateReconciliationTimers.current.set(conversationId, timeout);
  }, [cancelTerminalStateReconciliation, isCurrentSelection, sendSelectionRequest]);

  const loadConversationHistory = useCallback((
    conversationId: string,
    generation: number,
    requestedTranscriptEpoch?: number,
  ) => {
    if (historyLoaded.current.has(conversationId)) return Promise.resolve();
    const requestEpoch = requestedTranscriptEpoch ?? transcriptEpoch.current.get(conversationId) ?? 0;
    const existing = historyInFlight.current.get(conversationId);
    if (existing?.transcriptEpoch === requestEpoch) return existing.promise;

    const load = (async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < HISTORY_REQUEST_ATTEMPTS; attempt += 1) {
        if (!isCurrentSelection(conversationId, generation)) return;
        try {
          const response = await sendSelectionRequest(
            conversationId,
            generation,
            "get_messages",
            true,
            {},
            { transcriptEpoch: requestEpoch },
          );
          if (!response || !isCurrentSelection(conversationId, generation)) return;
          if (response.success === false) throw new Error(response.error ?? "Le chargement de la conversation a échoué.");
          const data = asRecord(response.data);
          if (!Array.isArray(data?.messages)) throw new Error("Prime Agent a renvoyé un historique invalide.");
          return;
        } catch (error) {
          lastError = error;
        }
      }
      if (isCurrentSelection(conversationId, generation)) {
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
      }
    })().finally(() => {
      if (historyInFlight.current.get(conversationId)?.promise === load) {
        historyInFlight.current.delete(conversationId);
      }
    });
    historyInFlight.current.set(conversationId, { promise: load, transcriptEpoch: requestEpoch });
    return load;
  }, [isCurrentSelection, sendSelectionRequest]);

  const loadLocalConversationHistory = useCallback((
    conversation: Conversation,
    project: Project,
    generation: number,
    force = false,
  ) => {
    if (!isNative() || !conversation.sessionPath) return Promise.resolve(undefined);
    const identity = localHistoryIdentity(conversation);
    if (
      !force
      &&
      localHistoryLoaded.current.has(identity)
      && localHistoryApplied.current.get(conversation.id) === identity
      && conversation.messages.length > 0
    ) {
      return Promise.resolve(undefined);
    }
    localHistoryLoaded.current.delete(identity);
    const existing = localHistoryInFlight.current.get(identity);
    if (existing && shouldReuseLocalHistoryLoad(existing.generation, generation)) {
      return existing.promise;
    }

    const load = loadSessionHistory(
      conversation.sessionPath,
      conversation.sessionId,
      project.path,
    )
      .then((history) => {
        if (!isCurrentSelection(conversation.id, generation)) return;
        const currentMetadata = getConversationRef.current(conversation.id);
        if (!currentMetadata || localHistoryIdentity(currentMetadata) !== identity) return;
        localHistoryLoaded.current.add(identity);
        setRuntimes((current) => {
          const runtime = current[conversation.id] ?? { models: [], commands: [], logs: [] };
          return {
            ...current,
            [conversation.id]: {
              ...runtime,
              refinements: history.refinements ?? [],
              harnessEntries: history.harnessEntries ?? [],
            },
          };
        });
        const mapped = mapAgentMessages(history.messages);
        const previousRevision = localHistoryRevisions.current.get(identity);
        localHistoryRevisions.current.set(identity, history.revision);
        const pendingPlan = pendingPlanFinalizations.current.get(conversation.id)
          ?? currentMetadata.pendingPlanAction;
        const persistedIdle = shouldApplyDurableIdleTaskState(
          history.latestAgentTaskState,
          activePromptRuns.current.has(conversation.id),
          previousRevision,
          history.revision,
        );
        // Transcript shape is not a Prime Agent lifecycle verdict. An
        // assistant-looking tail can be followed by more tools or model work,
        // so only the persisted task state (or native terminal events handled
        // by the live runtime path) may transition Orbit to idle here.
        const persistedSettled = persistedIdle;
        if (persistedSettled) {
          persistedIdleConversations.current.add(conversation.id);
          activeAgentLifecycles.current.delete(conversation.id);
          activePromptRuns.current.delete(conversation.id);
          cancelTerminalStateReconciliation(conversation.id);
        } else {
          persistedIdleConversations.current.delete(conversation.id);
        }
        if (
          pendingPlan?.stage === "decisionRecorded"
          && conversationHasPlanDecisionResult({ messages: mapped }, pendingPlan.handoffId)
        ) {
          persistedPlanDecisionResults.current.set(conversation.id, pendingPlan.handoffId);
        } else if (
          persistedPlanDecisionResults.current.get(conversation.id)
          && persistedPlanDecisionResults.current.get(conversation.id) !== pendingPlan?.handoffId
        ) {
          persistedPlanDecisionResults.current.delete(conversation.id);
        }
        const handoffId = pendingPlan?.stage === "applySending"
          ? pendingPlan.handoffId
          : conversationPlanState(currentMetadata).phase === "review"
            ? currentMetadata.planArtifactId
            : undefined;
        const handoffCommitted = Boolean(
          handoffId && conversationHasPlanHandoff({ messages: mapped }, handoffId),
        );
        if (handoffCommitted) pendingPlanFinalizations.current.delete(conversation.id);
        updateConversation(conversation.id, (current) => {
          // The JSONL file remains the durable record, but Orbit must not
          // erase a Prime Agent projection it already received from the same
          // session while the file is still between two writes. Reconcile the
          // two authoritative Prime Agent projections instead of replacing the
          // current transcript wholesale.
          const messages = reconcileLocalTranscriptAfterRpc(current.messages, mapped);
          localHistoryApplied.current.set(conversation.id, identity);
          return {
            ...current,
            messages,
            hasContent: history.messages.length > 0 ? true : current.hasContent,
            status: persistedSettled
              ? compactingConversations.current.has(conversation.id) ? "tool" : "idle"
              : current.status,
            ...(persistedSettled ? { lastError: undefined } : {}),
            ...(handoffCommitted ? {
              planMode: EMPTY_PLAN_MODE,
              planArtifactId: undefined,
              pendingPlanAction: undefined,
              lastError: undefined,
            } : {}),
          };
        });
        if (handoffCommitted) void flushWorkspaceState();
        return history.revision;
      })
      .finally(() => {
        if (localHistoryInFlight.current.get(identity)?.promise === load) {
          localHistoryInFlight.current.delete(identity);
        }
      });
    localHistoryInFlight.current.set(identity, { generation, promise: load });
    return load;
  }, [cancelTerminalStateReconciliation, flushWorkspaceState, isCurrentSelection, sendSelectionRequest, updateConversation]);

  const refreshPersistedTranscript = useCallback((conversationId: string, delayMs = 80) => {
    if (!isNative()) return;
    window.setTimeout(() => {
      const token = activeSelection.current;
      const conversation = getConversationRef.current(conversationId);
      const project = conversation ? getProjectRef.current(conversation.projectId) : undefined;
      if (
        token.conversationId !== conversationId
        || !isCurrentSelection(conversationId, token.generation)
        || !conversation?.sessionPath
        || !project
      ) return;
      const identity = localHistoryIdentity(conversation);
      localHistoryLoaded.current.delete(identity);
      localHistoryApplied.current.delete(conversationId);
      void loadLocalConversationHistory(conversation, project, token.generation, true).catch(() => undefined);
    }, delayMs);
  }, [isCurrentSelection, loadLocalConversationHistory]);

  const refreshLocalRefinements = useCallback(async (conversationId: string, generation: number) => {
    if (!isCurrentSelection(conversationId, generation)) return Promise.resolve();
    const initialConversation = getConversationRef.current(conversationId);
    if (!initialConversation?.sessionPath) return;
    const identity = localHistoryIdentity(initialConversation);

    // A refine_complete event can arrive while the first local-history read is
    // still in flight. Reusing that promise would apply the pre-refinement
    // snapshot and mark it loaded forever. Let it settle, then deliberately
    // perform a second disk read for the post-refinement state.
    const pending = localHistoryInFlight.current.get(identity)?.promise;
    if (pending) {
      try {
        await pending;
      } catch {
        // The forced read below is also the retry for a failed initial load.
      }
    }
    if (!isCurrentSelection(conversationId, generation)) return;
    const conversation = getConversationRef.current(conversationId);
    const project = conversation ? getProjectRef.current(conversation.projectId) : undefined;
    if (!conversation?.sessionPath || !project || localHistoryIdentity(conversation) !== identity) return;
    localHistoryLoaded.current.delete(identity);
    await loadLocalConversationHistory(conversation, project, generation);
  }, [isCurrentSelection, loadLocalConversationHistory]);

  const refreshPlanReviewDocument = useCallback(async (
    conversationId: string,
    generation: number,
    planId: string,
    title: string,
  ) => {
    const initialConversation = getConversationRef.current(conversationId);
    if (!initialConversation?.sessionPath) return;
    const identity = localHistoryIdentity(initialConversation);

    // The extension request can beat the matching JSONL tool-call projection
    // by a few milliseconds. Let any older read settle, then perform bounded
    // forced reads until the exact persisted call is visible. The UUID remains
    // authoritative throughout; no document is inferred from another call.
    for (const delayMs of [0, 40, 120, 240]) {
      const pending = localHistoryInFlight.current.get(identity)?.promise;
      if (pending) {
        try {
          await pending;
        } catch {
          // The forced read below is also the retry for the failed snapshot.
        }
      }
      if (!isCurrentSelection(conversationId, generation)) return;
      const current = getConversationRef.current(conversationId);
      if (current && planDocumentForReview(current, planId, title)) return;
      if (delayMs > 0) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
      }
      if (!isCurrentSelection(conversationId, generation)) return;
      const conversation = getConversationRef.current(conversationId);
      const project = conversation ? getProjectRef.current(conversation.projectId) : undefined;
      if (!conversation?.sessionPath || !project || localHistoryIdentity(conversation) !== identity) return;
      localHistoryLoaded.current.delete(identity);
      localHistoryApplied.current.delete(conversationId);
      await loadLocalConversationHistory(conversation, project, generation, true);
    }
  }, [isCurrentSelection, loadLocalConversationHistory]);

  const waitForPersistedPlanToolResult = useCallback(async (
    conversation: Conversation,
    project: Project,
    requestId: string,
  ): Promise<"completed" | "failed" | undefined> => {
    if (!isNative() || !conversation.sessionPath) return "completed";
    const deadline = Date.now() + PLAN_RESPONSE_ACK_TIMEOUT_MS;
    let delayMs = 40;
    while (Date.now() < deadline) {
      try {
        const history = await loadSessionHistory(
          conversation.sessionPath,
          conversation.sessionId,
          project.path,
        );
        const status = persistedPlanToolResultStatus(history.messages, requestId);
        if (status) return status;
      } catch {
        // A concurrent JSONL append can invalidate one atomic-read attempt.
        // The next bounded pass retries the same attested session file.
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
      delayMs = Math.min(500, delayMs * 2);
    }
    return undefined;
  }, []);

  const ensureRuntime = useCallback((conversationId: string) => {
    setRuntimes((current) => {
      if (current[conversationId]) return current;
      return { ...current, [conversationId]: { models: [], commands: [], logs: [] } };
    });
  }, []);

  const setGoalMutationState = useCallback((
    conversationId: string,
    mutation: ConversationRuntime["goalMutation"],
  ) => {
    setRuntimes((current) => {
      const runtime = current[conversationId] ?? { models: [], commands: [], logs: [] };
      if (runtime.goalMutation === mutation) return current;
      return { ...current, [conversationId]: { ...runtime, goalMutation: mutation } };
    });
  }, []);

  const rejectGoalMutation = useCallback((conversationId: string, reason: string) => {
    const pending = pendingGoalMutations.current.get(conversationId);
    if (!pending) return;
    pendingGoalMutations.current.delete(conversationId);
    window.clearTimeout(pending.timeout);
    const error = new Error(reason);
    setGoalMutationState(conversationId, {
      command: pending.descriptor.command,
      kind: pending.descriptor.kind,
      phase: "error",
      error: reason,
    });
    pending.reject(error);
  }, [setGoalMutationState]);

  const addActivity = useCallback(
    (conversationId: string, activity: Omit<ActivityItem, "id" | "createdAt"> & { id?: string; createdAt?: string }) => {
      updateConversation(conversationId, (conversation) => {
        const id = activity.id ?? uid("activity");
        const index = conversation.activities.findIndex((item) => item.id === id);
        const previous = index >= 0 ? conversation.activities[index] : undefined;
        const eventTime = activity.updatedAt ?? activity.createdAt ?? now();
        const next: ActivityItem = {
          ...previous,
          id,
          createdAt: previous?.createdAt ?? activity.createdAt ?? eventTime,
          updatedAt: eventTime,
          updateCount: previous ? (previous.updateCount ?? 1) + (activity.updateCount ?? 1) : activity.updateCount ?? 1,
          type: activity.type,
          title: redactText(activity.title),
          detail: activity.detail ? redactText(activity.detail) : previous?.detail,
          status: activity.status,
          raw: activity.raw === undefined ? undefined : redactValue(activity.raw),
        };
        const activities = [...conversation.activities];
        if (index >= 0) activities[index] = next;
        else activities.push(next);
        return { ...conversation, activities: activities.slice(-240) };
      });
    },
    [updateConversation],
  );

  const removeActivity = useCallback((conversationId: string, activityId: string) => {
    updateConversation(conversationId, (conversation) => {
      if (!conversation.activities.some((activity) => activity.id === activityId)) return conversation;
      return {
        ...conversation,
        activities: conversation.activities.filter((activity) => activity.id !== activityId),
      };
    });
  }, [updateConversation]);

  /** Keeps the evidence trail for a correction Orbit had to make on its own.
   * Without it every lost event looks identical to a slow agent. */
  const recordRuntimeDivergence = useCallback((
    conversationId: string,
    divergence: Omit<RuntimeDivergence, "id">,
  ) => {
    setRuntimes((current) => {
      const runtime = current[conversationId] ?? { models: [], commands: [], logs: [] };
      return {
        ...current,
        [conversationId]: {
          ...runtime,
          divergences: [...(runtime.divergences ?? []), { ...divergence, id: uid("divergence") }]
            .slice(-MAX_RECORDED_DIVERGENCES),
        },
      };
    });
  }, []);

  const addLog = useCallback((conversationId: string, stream: "rpc" | "stderr", text: string) => {
    setRuntimes((current) => {
      const runtime = current[conversationId] ?? { models: [], commands: [], logs: [] };
      return {
        ...current,
        [conversationId]: {
          ...runtime,
          logs: [...runtime.logs, { id: uid("log"), stream, text: redactText(text), createdAt: now() }].slice(-500),
        },
      };
    });
  }, []);

  const setRuntimeCompacting = useCallback((conversationId: string, isCompacting: boolean, clearContextUsage = false) => {
    setRuntimes((current) => {
      const runtime = current[conversationId];
      const next = applyRuntimeCompactingState(runtime, isCompacting, clearContextUsage);
      if (next === runtime) return current;
      return { ...current, [conversationId]: next };
    });
  }, []);

  const setRuntimeRefining = useCallback((conversationId: string, isRefining: boolean) => {
    setRuntimes((current) => {
      const runtime = current[conversationId] ?? { models: [], commands: [], logs: [] };
      if (runtime.isRefining === isRefining) return current;
      return { ...current, [conversationId]: { ...runtime, isRefining } };
    });
  }, []);

  const settleCompactionWaiter = useCallback((conversationId: string, error?: Error) => {
    const pending = pendingCompactions.current.get(conversationId);
    if (!pending) return;
    pendingCompactions.current.delete(conversationId);
    window.clearTimeout(pending.timeout);
    if (error) pending.reject(error);
    else pending.resolve();
  }, []);

  const recentCompactionEnd = useCallback((conversationId: string) => {
    const recent = recentCompactionEnds.current.get(conversationId);
    if (!recent) return undefined;
    if (Date.now() - recent.endedAt <= RECENT_COMPACTION_END_MS) return recent;
    recentCompactionEnds.current.delete(conversationId);
    return undefined;
  }, []);

  const invalidateCompactionHistory = useCallback((conversationId: string) => {
    transcriptEpoch.current.set(conversationId, (transcriptEpoch.current.get(conversationId) ?? 0) + 1);
    historyLoaded.current.delete(conversationId);
    historyInFlight.current.delete(conversationId);
    localHistoryApplied.current.delete(conversationId);
    const localPrefix = localHistoryConversationPrefix(conversationId);
    for (const identity of localHistoryLoaded.current) {
      if (identity.startsWith(localPrefix)) localHistoryLoaded.current.delete(identity);
    }
  }, []);

  const refreshAfterCompaction = useCallback((conversationId: string) => {
    compactionRefreshPending.current.add(conversationId);
    historyLoaded.current.delete(conversationId);
    const token = activeSelection.current;
    if (
      token.conversationId !== conversationId
      || !isCurrentSelection(conversationId, token.generation)
      || activePromptRuns.current.has(conversationId)
    ) return;
    compactionRefreshPending.current.delete(conversationId);
    const epoch = transcriptEpoch.current.get(conversationId) ?? 0;
    void sendSelectionRequest(conversationId, token.generation, "get_state").catch(() => undefined);
    void sendSelectionRequest(conversationId, token.generation, "get_session_stats").catch(() => undefined);
    const conversation = getConversationRef.current(conversationId);
    const project = conversation ? getProjectRef.current(conversation.projectId) : undefined;
    if (isNative() && conversation?.sessionPath && project) {
      void loadLocalConversationHistory(conversation, project, token.generation, true).catch(() => undefined);
    } else {
      void loadConversationHistory(conversationId, token.generation, epoch).catch(() => undefined);
    }
  }, [isCurrentSelection, loadConversationHistory, loadLocalConversationHistory, sendSelectionRequest]);

  /** Apply a complete state snapshot without coupling it to the current
   * selection. Goal mutations and their final reconciliation belong to the
   * originating conversation and must survive navigation. */
  const applySessionStateSnapshot = useCallback((
    conversationId: string,
    rawSessionState: AgentSessionState,
    requestedGoalEpoch: number,
    divergenceSource: RuntimeDivergence["source"] = "reconciliation",
  ) => {
    const currentGoalEpoch = goalEpoch.current.get(conversationId) ?? 0;
    const goal = goalForSessionSnapshot({
      snapshot: rawSessionState.goal,
      latestEvent: latestGoalByConversation.current.get(conversationId),
      requestedEventEpoch: requestedGoalEpoch,
      currentEventEpoch: currentGoalEpoch,
    });
    if (goal) latestGoalByConversation.current.set(conversationId, goal);
    else latestGoalByConversation.current.delete(conversationId);
    const sessionState: AgentSessionState = {
      ...rawSessionState,
      goal,
      sessionActions: normalizePrimeOrbitSessionActions(rawSessionState.sessionActions),
    };
    const snapshotIsIdle = isAuthoritativeIdleSessionSnapshot(sessionState);
    const localOperationBlocksIdleRecovery = pendingCompactions.current.has(conversationId)
      || activeBashActivities.current.has(conversationId)
      || directRefinementActivities.current.has(conversationId)
      || uncertainRefinementConversations.current.has(conversationId);
    const shouldRecoverIdle = shouldRecoverIdleSessionState(
      snapshotIsIdle,
      localOperationBlocksIdleRecovery,
      pendingPromptAdmissions.current.has(conversationId),
    );
    if (shouldRecoverIdle) {
      // At an authoritative idle boundary every running row is stale whatever
      // its age, so the stall timeout is deliberately zero here.
      const observed = getConversationRef.current(conversationId);
      const divergence = observed
        ? runtimeDivergenceForSnapshot(
            observed.status,
            stalledRunningActivities(observed.activities, Date.now(), 0).length,
            divergenceSource,
          )
        : undefined;
      if (divergence) recordRuntimeDivergence(conversationId, divergence);
      // get_state is the daemon's authoritative answer after a renderer
      // listener gap. Purging both refs is essential: conversation.status alone
      // is not used to close the rapid-submit race, and a stale prompt marker
      // would make the next genuinely idle prompt look like active work.
      activeAgentLifecycles.current.delete(conversationId);
      activePromptRuns.current.delete(conversationId);
      cancelTerminalStateReconciliation(conversationId);
      historyLoaded.current.delete(conversationId);
    }
    if (sessionState.isCompacting) compactingConversations.current.add(conversationId);
    else compactingConversations.current.delete(conversationId);
    sessionActionsByConversation.current.set(conversationId, sessionState.sessionActions);
    setRuntimes((current) => ({
      ...current,
      [conversationId]: {
        ...(current[conversationId] ?? { models: [], commands: [], logs: [] }),
        isCompacting: sessionState.isCompacting,
        state: sessionState,
      },
    }));
    updateConversation(conversationId, (conversation) => {
      const authoritative = stripLegacyOrbitQueueRows({
        ...conversation,
        title: !conversation.sessionNameSyncPending && sessionState.sessionName?.trim()
          ? sessionState.sessionName.trim()
          : conversation.title,
        sessionPath: sessionState.sessionFile ?? conversation.sessionPath,
        sessionId: sessionState.sessionId ?? conversation.sessionId,
        model: sessionState.model ? `${sessionState.model.provider}/${sessionState.model.id}` : conversation.model,
        thinkingLevel: sessionState.thinkingLevel ?? conversation.thinkingLevel,
        // Keep the central loading state visible until get_messages has
        // actually populated the transcript.
        status: conversationStatusForSessionSnapshot(
          sessionState,
          conversation.status,
          localOperationBlocksIdleRecovery,
        ),
        lastError: undefined,
      });
      return shouldRecoverIdle
        ? finalizeAuthoritativeIdleSnapshot(authoritative)
        : authoritative;
    });
    if (shouldRecoverIdle && !historyLoaded.current.has(conversationId)) {
      // A large get_messages response can race ahead of this recovery snapshot
      // and be rejected while the stale prompt marker still exists. Retry on
      // the next task after that request's promise/finalizer settles; otherwise
      // a reconnected conversation can remain in `starting` forever.
      window.setTimeout(() => {
        if (historyLoaded.current.has(conversationId)) return;
        const token = activeSelection.current;
        if (
          token.conversationId !== conversationId
          || !isCurrentSelection(conversationId, token.generation)
        ) return;
        const epoch = transcriptEpoch.current.get(conversationId) ?? 0;
        const conversation = getConversationRef.current(conversationId);
        const project = conversation ? getProjectRef.current(conversation.projectId) : undefined;
        if (isNative() && conversation?.sessionPath && project) {
          void loadLocalConversationHistory(conversation, project, token.generation, true).catch(() => undefined);
        } else {
          void loadConversationHistory(conversationId, token.generation, epoch).catch(() => undefined);
        }
      }, 0);
    }
  }, [cancelTerminalStateReconciliation, isCurrentSelection, loadConversationHistory, loadLocalConversationHistory, recordRuntimeDivergence, updateConversation]);

  const handleResponse = useCallback(
    (conversationId: string, message: RpcEnvelope) => {
      const requestId = textValue(message.id);
      const isSuppressedLateResponse = requestId
        ? suppressedConversationResponses.current.delete(requestId)
        : false;
      if (shouldConsumeConversationResponse(undefined, isSuppressedLateResponse)) return;
      const scopedCommand = SELECTION_SCOPED_COMMANDS.has(message.command ?? "");
      const persistentPending = requestId ? pendingConversationRequests.current.get(requestId) : undefined;
      if (persistentPending) {
        pendingConversationRequests.current.delete(requestId!);
        window.clearTimeout(persistentPending.timeout);
        if (persistentPending.conversationId !== conversationId) {
          persistentPending.reject(new Error("Prime Agent a répondu pour une autre conversation."));
          return;
        }
        persistentPending.resolve(message);
        if (shouldConsumeConversationResponse(persistentPending.purpose)) return;
        // Export is completed by the initiating command after native
        // validation. It must not change the health of the conversation when
        // the file operation itself fails.
        if (message.command === "export_html" || message.command === "refine") return;
      }
      const pending = requestId ? pendingSelectionRequests.current.get(requestId) : undefined;
      if (pending) {
        pendingSelectionRequests.current.delete(requestId!);
        window.clearTimeout(pending.timeout);
        if (
          pending.conversationId !== conversationId
          || !isCurrentSelection(conversationId, pending.generation)
        ) {
          pending.reject?.(new Error("La conversation active a changé avant la réponse de Prime Agent."));
          return;
        }
        pending.resolve?.(message);
      } else if (scopedCommand) {
        // Bootstrap responses are accepted only when issued for the current
        // selection. This also drops late responses after rapid navigation.
        return;
      }

      // Refinement responses are handled by the exact conversation-scoped
      // request that initiated them. Lifecycle events below remain the source
      // for background/other-window feedback, and a failed refinement must not
      // mark the whole conversation runtime as broken.
      if (message.command === "refine") return;

      const compactDisposition = compactResponseDisposition(
        message,
        Boolean(recentCompactionEnd(conversationId)),
      );
      if (compactDisposition === "pending") {
        compactingConversations.current.add(conversationId);
        setRuntimeCompacting(conversationId, true);
        const activityId = activeCompactionActivities.current.get(conversationId) ?? uid("compaction");
        activeCompactionActivities.current.set(conversationId, activityId);
        updateConversation(conversationId, (conversation) => ({
          ...conversation,
          status: "tool",
          lastError: undefined,
        }));
        addActivity(conversationId, {
          id: activityId,
          type: "compaction_start",
          title: "Compactage du contexte en cours",
          detail: "Le délai d’accusé de réception du daemon est dépassé, mais Prime Agent poursuit le compactage en arrière-plan.",
          status: "running",
          raw: message,
        });
        return;
      }
      if (compactDisposition === "success" || compactDisposition === "lifecycle_handled") return;

      if (isTransientHistoryResponseFailure(message)) {
        // The local session reader remains authoritative for visible history.
        // A shared-daemon reconnect must not make the healthy conversation
        // flash through the global runtime-error banner.
        return;
      }

      if (isOptionalSelectionResponseFailure(message)) {
        // Catalog, schedule, and heartbeat reads enrich the inspector but are
        // not runtime health signals. A reconnect or optional-capability miss
        // keeps the last known data; unexpected failures still reach the
        // normal conversation error path below.
        return;
      }

      if (message.success === false) {
        const error = cleanDiagnostic(message.error) ?? `La commande ${message.command ?? "RPC"} a échoué.`;
        updateConversation(conversationId, { status: "error", lastError: error });
        addActivity(conversationId, { type: "error", title: "Prime Agent a signalé une erreur", detail: error, status: "error", raw: message });
        return;
      }

      const data = message.data as Record<string, unknown> | undefined;
      if (message.command === "get_state" && data) {
        // Conversation-scoped callers apply their own snapshot after resolving
        // the request. Selection-scoped bootstrap remains guarded by both the
        // runtime epoch and the goal-event epoch captured at request time.
        if (!pending) return;
        if (!shouldApplySessionStateResponse(
          pending.stateEpoch,
          stateEpoch.current.get(conversationId) ?? 0,
        )) return;
        applySessionStateSnapshot(
          conversationId,
          data as unknown as AgentSessionState,
          pending.goalEpoch ?? (goalEpoch.current.get(conversationId) ?? 0),
        );
        return;
      }

      if (message.command === "get_messages" && data && Array.isArray(data.messages)) {
        const expectedEpoch = pending?.transcriptEpoch;
        const currentEpoch = transcriptEpoch.current.get(conversationId) ?? 0;
        if (!shouldApplyHistoryResponse(
          expectedEpoch,
          currentEpoch,
          activePromptRuns.current.has(conversationId),
        )) {
          return;
        }
        historyLoaded.current.add(conversationId);
        compactionRefreshPending.current.delete(conversationId);
        localHistoryApplied.current.delete(conversationId);
        const mapped = mapAgentMessages(data.messages);
        const sourceMessageCount = data.messages.length;
        const persistedConversation = getConversationRef.current(conversationId);
        const persistedProject = persistedConversation
          ? getProjectRef.current(persistedConversation.projectId)
          : undefined;
        if (isNative() && persistedConversation?.sessionPath && persistedProject) {
          // A published session file makes JSONL the sole transcript
          // projection. Treat get_messages only as a wake-up signal so RPC
          // history cannot erase, duplicate, or reorder durable file history.
          void loadLocalConversationHistory(
            persistedConversation,
            persistedProject,
            activeSelection.current.generation,
            true,
          ).catch(() => undefined);
          return;
        }
        updateConversation(conversationId, (conversation) => ({
          ...conversation,
          messages: reconcileRpcTranscript(conversation.messages, mapped),
          hasContent: sourceMessageCount > 0 ? true : conversation.hasContent,
          // A persisted non-empty session with an empty RPC projection must
          // remain in the loading state until the validated local reader fills
          // it. Showing the welcome screen here makes the conversation appear
          // to have disappeared.
          status: mapped.length === 0 && conversation.messages.length === 0 && conversation.hasContent
            ? "starting"
            : conversation.status === "starting" || conversation.status === "offline" || conversation.status === "error"
              ? "idle"
              : conversation.status,
          lastError: undefined,
        }));
        return;
      }

      if (message.command === "get_available_models" && data && Array.isArray(data.models)) {
        setRuntimes((current) => ({
          ...current,
          [conversationId]: {
            ...(current[conversationId] ?? { models: [], commands: [], logs: [] }),
            models: data.models as ModelInfo[],
          },
        }));
        return;
      }

      if (message.command === "get_commands" && data && Array.isArray(data.commands)) {
        setRuntimes((current) => ({
          ...current,
          [conversationId]: {
            ...(current[conversationId] ?? { models: [], commands: [], logs: [] }),
            commands: data.commands as SlashCommand[],
          },
        }));
        return;
      }

      if (message.command === "get_session_stats" && data) {
        if (pending?.statsEpoch !== (statsEpoch.current.get(conversationId) ?? 0)) return;
        setRuntimes((current) => ({
          ...current,
          [conversationId]: {
            ...(current[conversationId] ?? { models: [], commands: [], logs: [] }),
            stats: data as unknown as SessionStats,
          },
        }));
        return;
      }

      if (message.command === "list_schedules" && data && Array.isArray(data.jobs)) {
        setRuntimes((current) => ({
          ...current,
          [conversationId]: {
            ...(current[conversationId] ?? { models: [], commands: [], logs: [] }),
            schedules: data.jobs as AgentSchedule[],
          },
        }));
        return;
      }

      if (message.command === "list_heartbeats" && data && Array.isArray(data.heartbeats)) {
        setRuntimes((current) => ({
          ...current,
          [conversationId]: {
            ...(current[conversationId] ?? { models: [], commands: [], logs: [] }),
            heartbeats: data.heartbeats as AgentHeartbeatSummary[],
          },
        }));
        return;
      }

      if (message.command === "get_heartbeat" && data && "heartbeat" in data) {
        setRuntimes((current) => ({
          ...current,
          [conversationId]: {
            ...(current[conversationId] ?? { models: [], commands: [], logs: [] }),
            heartbeat: (data.heartbeat ?? null) as AgentSchedule | null,
          },
        }));
        return;
      }

      if (["add_schedule", "cancel_schedule", "set_heartbeat", "update_heartbeat", "manage_heartbeat"].includes(String(message.command))) {
        window.setTimeout(() => {
          const token = activeSelection.current;
          if (token.conversationId !== conversationId) return;
          void sendSelectionRequest(conversationId, token.generation, "list_schedules", true, { includeInactive: false }).catch(() => undefined);
          void sendSelectionRequest(conversationId, token.generation, "get_heartbeat").catch(() => undefined);
          void sendSelectionRequest(conversationId, token.generation, "list_heartbeats").catch(() => undefined);
        }, 100);
        return;
      }

      if (message.command === "set_session_name") {
        const current = getConversationRef.current(conversationId);
        if (current) {
          updateConversation(conversationId, { sessionNameSyncPending: false });
          setRuntimes((runtimes) => {
            const runtime = runtimes[conversationId];
            if (!runtime?.state) return runtimes;
            return {
              ...runtimes,
              [conversationId]: { ...runtime, state: { ...runtime.state, sessionName: current.title } },
            };
          });
        }
        return;
      }

      if (message.command === "export_html") {
        // The renderer only sees Prime Agent's private staging path here. The
        // user-visible destination is published after native validation and
        // atomic completion in `runCommand`.
        return;
      }

      if (["new_session", "fork", "clone", "switch_session"].includes(String(message.command)) && data?.cancelled !== true) {
        updateConversation(conversationId, {
          messages: [],
          activities: [],
          hasContent: message.command === "new_session" ? false : true,
          status: "idle",
          sessionPath: undefined,
          sessionId: undefined,
        });
        setRuntimes((current) => {
          const runtime = current[conversationId];
          if (!runtime) return current;
          return {
            ...current,
            [conversationId]: { ...runtime, refinements: undefined, harnessEntries: undefined },
          };
        });
        historyLoaded.current.delete(conversationId);
        localHistoryApplied.current.delete(conversationId);
        const localPrefix = localHistoryConversationPrefix(conversationId);
        for (const key of localHistoryLoaded.current) {
          if (key.startsWith(localPrefix)) localHistoryLoaded.current.delete(key);
        }
        for (const key of localHistoryInFlight.current.keys()) {
          if (key.startsWith(localPrefix)) localHistoryInFlight.current.delete(key);
        }
        window.setTimeout(() => {
          const token = activeSelection.current;
          if (token.conversationId !== conversationId) return;
          void sendSelectionRequest(conversationId, token.generation, "get_state").catch(() => undefined);
          void loadConversationHistory(conversationId, token.generation).catch(() => undefined);
        }, 120);
        return;
      }

      if (["set_steering_mode", "set_follow_up_mode", "set_auto_compaction", "set_auto_retry"].includes(message.command ?? "")) {
        window.setTimeout(() => {
          const token = activeSelection.current;
          if (token.conversationId !== conversationId) return;
          void sendSelectionRequest(conversationId, token.generation, "get_state").catch(() => undefined);
        }, 80);
        return;
      }

      if (message.command === "set_model" && data) {
        const model = data as unknown as ModelInfo;
        updateConversation(conversationId, { model: `${model.provider}/${model.id}` });
      }
    },
    [addActivity, applySessionStateSnapshot, isCurrentSelection, loadConversationHistory, loadLocalConversationHistory, recentCompactionEnd, sendSelectionRequest, setRuntimeCompacting, updateConversation],
  );

  const finalizePendingPlan = useCallback(async (conversationId: string) => {
    if (planFinalizationsInFlight.current.has(conversationId)) return;
    const initialPending = pendingPlanFinalizations.current.get(conversationId)
      ?? getConversation(conversationId)?.pendingPlanAction;
    if (!initialPending) return;
    let pending: PendingPlanFinalization = initialPending;
    pendingPlanFinalizations.current.set(conversationId, pending);
    planFinalizationsInFlight.current.add(conversationId);

    const persistStage = async (stage: PendingPlanFinalization["stage"]) => {
      pending = { ...pending, stage };
      pendingPlanFinalizations.current.set(conversationId, pending);
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        pendingPlanAction: pending,
        lastError: undefined,
      }));
      if (!await flushWorkspaceState()) {
        throw new Error(planRuntimeText(
          "Le handoff du plan n’a pas pu être enregistré de façon durable.",
          "The plan handoff could not be saved durably.",
        ));
      }
    };

    const clearCompletedHandoff = async () => {
      pendingPlanFinalizations.current.delete(conversationId);
      persistedPlanDecisionResults.current.delete(conversationId);
      updateConversation(conversationId, {
        planMode: EMPTY_PLAN_MODE,
        planArtifactId: undefined,
        pendingPlanAction: undefined,
        lastError: undefined,
      });
      await flushWorkspaceState();
    };

    try {
      if (pending.stage === "applySending") {
        const conversation = getConversation(conversationId);
        if (conversationHasPlanHandoff(conversation, pending.handoffId)) {
          await clearCompletedHandoff();
          return;
        }
        if (conversation?.sessionPath && !historyLoaded.current.has(conversationId)) {
          // The canonical transcript decides whether the stable handoff marker
          // was admitted before a reload. Never retry until a fresh history
          // snapshot has completed after the admission stage.
          const project = getProject(conversation.projectId);
          if (project) {
            await loadLocalConversationHistory(
              conversation,
              project,
              activeSelection.current.generation,
              true,
            );
          } else {
            await loadConversationHistory(
              conversationId,
              activeSelection.current.generation,
            );
          }
          if (historyLoaded.current.has(conversationId)) {
            window.setTimeout(() => void finalizePendingPlan(conversationId), 0);
            return;
          }
          throw new Error(planRuntimeText(
            "L’historique Prime Agent requis pour vérifier le handoff est indisponible.",
            "The Prime Agent history required to verify the handoff is unavailable.",
          ));
        }
      }

      if (pending.stage === "decisionRecorded") {
        await commitPlanRuntimeModeTransition(
          "normal",
          async () => {
            const result = await restartAgent(conversationId, "normal", pending.handoffId);
            if (result) {
              runtimeModes.current.set(conversationId, result.agent.runtimeMode);
              started.current.add(conversationId);
            }
            return result?.agent.runtimeMode;
          },
          () => persistStage("runtimeNormal"),
          (expectedMode) => {
            if (expectedMode) expectedRuntimeModeTransitions.current.set(conversationId, expectedMode);
            else expectedRuntimeModeTransitions.current.delete(conversationId);
          },
        );
      }

      if (pending.decision === "keep") {
        await clearCompletedHandoff();
      } else {
        if (pending.stage !== "applySending") await persistStage("applySending");
        const message = planImplementationPrompt(
          pending.document,
          pending.relativePath,
          pending.handoffId,
        );
        historyLoaded.current.delete(conversationId);
        persistedIdleConversations.current.delete(conversationId);
        activePromptRuns.current.add(conversationId);
        updateConversation(conversationId, { status: "starting", lastError: undefined });
        const admission = await sendConversationRequest(
          conversationId,
          "prompt",
          { message },
          PASSIVE_RESPONSE_TIMEOUT_MS,
          "prompt_admission",
          "normal",
        );
        if (admission.success === false) {
          throw new Error(admission.error ?? planRuntimeText(
            "Prime Agent a refusé le démarrage de l’implémentation du plan.",
            "Prime Agent rejected the start of the plan implementation.",
          ));
        }
        updateConversation(conversationId, {
          hasContent: true,
          updatedAt: now(),
        });
      }

      addActivity(conversationId, {
        type: "plan_runtime_transition",
        title: pending.decision === "apply"
          ? planRuntimeText("Implémentation du plan lancée", "Plan implementation started")
          : planRuntimeText("Plan conservé", "Plan kept"),
        detail: pending.relativePath,
        status: "success",
      });
    } catch (error) {
      activePromptRuns.current.delete(conversationId);
      const detail = error instanceof Error ? error.message : String(error);
      addActivity(conversationId, {
        type: "plan_runtime_transition",
        title: planRuntimeText("Impossible de finaliser le mode Plan", "Could not finalize Plan mode"),
        detail,
        status: "error",
      });
      updateConversation(conversationId, { status: "error", lastError: detail });
    } finally {
      planFinalizationsInFlight.current.delete(conversationId);
    }
  }, [addActivity, flushWorkspaceState, getConversation, getProject, loadConversationHistory, loadLocalConversationHistory, sendConversationRequest, updateConversation]);

  useEffect(() => {
    const conversationId = selectedConversation?.id;
    const pendingPlan = selectedConversation?.pendingPlanAction;
    const hasPendingPlanRequest = conversationId
      ? extensionRequests.some((request) => (
          request.conversationId === conversationId
          && isTrustedPlanUiRequest(request, request.runtimeMode)
        ))
      : false;
    if (
      pendingPlan
      && started.current.has(selectedConversation.id)
      && eventsReady
      && (!isNative() || canFinalizePendingPlanDecision(
        hasPendingPlanRequest,
        persistedPlanDecisionResults.current.get(selectedConversation.id) === pendingPlan.handoffId,
      ))
    ) {
      pendingPlanFinalizations.current.set(selectedConversation.id, pendingPlan);
      void finalizePendingPlan(selectedConversation.id);
    }
  }, [eventsReady, extensionRequests, finalizePendingPlan, selectedConversation]);

  const handleAgentEvent = useCallback(
    (
      conversationId: string,
      event: RpcEnvelope,
      attestedRuntimeMode?: AgentRuntimeMode,
    ) => {
      const eventType = event.type;
      if (eventType === "response") {
        handleResponse(conversationId, event);
        return;
      }
      if (eventType === "extension_ui_request") {
        const request = event as ExtensionUiRequest;
        if (request.method === "notify") {
          addActivity(conversationId, {
            id: `notification:${request.id}`,
            type: "notification",
            title: request.message ?? "Notification Prime Agent",
            status: request.notifyType === "error" ? "error" : request.notifyType === "warning" ? "warning" : "info",
          });
          void sendRpc(conversationId, { type: "extension_ui_response", id: request.id, cancelled: true }).catch(() => undefined);
        } else if (request.method !== "setStatus" && request.method !== "setWidget" && request.method !== "setTitle" && request.method !== "set_editor_text") {
          const observedRuntimeMode = attestedRuntimeMode
            ?? runtimeModes.current.get(conversationId);
          const pendingRequest: PendingExtensionUiRequest = {
            ...request,
            conversationId,
            requestKey: extensionRequestKey(conversationId, request.id),
            runtimeMode: attestedRuntimeMode ?? observedRuntimeMode,
          };
          const planRequestClassification = classifyPlanUiRequest(
            request,
            observedRuntimeMode,
          );
          const claimedPlanRequest = planRequestClassification !== "generic";
          const validPlanRequest = planRequestClassification === "accepted";
          const decoded = validPlanRequest ? decodePlanUiRequestTitle(request.title) : undefined;
          const recordedPending = pendingPlanFinalizations.current.get(conversationId)
            ?? getConversationRef.current(conversationId)?.pendingPlanAction;
          const recordedValue = recordedPlanResponseValue(recordedPending, request, decoded);
          if (recordedPending && recordedValue) {
            pendingPlanFinalizations.current.set(conversationId, recordedPending);
            if (!recordedPlanResponsesInFlight.current.has(pendingRequest.requestKey)) {
              recordedPlanResponsesInFlight.current.add(pendingRequest.requestKey);
              void sendRpc(conversationId, {
                type: "extension_ui_response",
                id: request.id,
                value: recordedValue,
              }).then(() => {
                setExtensionRequests((current) => current.filter(
                  (item) => item.requestKey !== pendingRequest.requestKey,
                ));
              }).catch((error) => {
                setExtensionRequests((current) => enqueueExtensionRequest(current, pendingRequest));
                const detail = error instanceof Error ? error.message : String(error);
                updateConversation(conversationId, (conversation) => {
                  let state = conversationPlanState(conversation);
                  if (state.phase === "idle") {
                    const startedPlan = startPlanMode(state);
                    if (startedPlan.status === "accepted") state = startedPlan.state;
                  }
                  const opened = openPlanReview(state, { document: recordedPending.document });
                  return {
                    ...conversation,
                    ...(opened.status === "accepted" ? { planMode: opened.state } : {}),
                    status: "error",
                    lastError: detail,
                  };
                });
                addActivity(conversationId, {
                  id: `plan-recorded-response-error:${request.id}`,
                  type: "plan_recorded_response_error",
                  title: planRuntimeText(
                    "Décision Plan enregistrée mais non transmise",
                    "Saved Plan decision not sent",
                  ),
                  detail,
                  status: "error",
                });
              }).finally(() => {
                recordedPlanResponsesInFlight.current.delete(pendingRequest.requestKey);
              });
            }
            return;
          }
          if (claimedPlanRequest && !validPlanRequest) {
            addActivity(conversationId, {
              id: `plan-protocol-error:${request.id}`,
              type: "plan_protocol_error",
              title: planRuntimeText("Dialogue Plan en attente d’attestation", "Plan dialog awaiting attestation"),
              detail: planRuntimeText(
                "Prime Orbit conserve la demande bloquée sans répondre à la place de l’utilisateur. Elle sera affichée uniquement après attestation du runtime Plan natif.",
                "Prime Orbit keeps the request blocked without answering for the user. It will be shown only after native Plan runtime attestation.",
              ),
              status: "warning",
              raw: request,
            });
          } else {
            setExtensionRequests((current) => enqueueExtensionRequest(current, pendingRequest));
          }
          if (validPlanRequest) {
            updateConversation(conversationId, (conversation) => {
              let state = conversationPlanState(conversation);
              if (state.phase === "idle") {
                const startedPlan = startPlanMode(state);
                if (startedPlan.status === "accepted") state = startedPlan.state;
              }
              if (decoded?.payload.kind === "review") {
                if (state.phase === "question") {
                  const rearmed = rearmPlanModeAfterLostDialog(state, "question");
                  if (rearmed.status === "accepted") state = rearmed.state;
                }
                const document = planDocumentForReview(
                  conversation,
                  decoded.payload.planId,
                  decoded.payload.title,
                );
                if (!document) return conversation;
                const transition = restorePlanReview(state, { document });
                return transition.status === "accepted"
                  ? {
                      ...conversation,
                      status: "tool",
                      planMode: transition.state,
                      planArtifactId: decoded.payload.planId,
                    }
                  : conversation;
              }
              if (state.phase === "review") {
                const rearmed = rearmPlanModeAfterLostDialog(state, "review");
                if (rearmed.status === "accepted") state = rearmed.state;
              }
              const transition = restorePlanQuestion(state, { request });
              return transition.status === "accepted"
                ? {
                    ...conversation,
                    status: "tool",
                    planMode: transition.state,
                    planArtifactId: conversation.planArtifactId,
                  }
                : conversation;
            });
            void notifyPlanAttention({
              conversationId,
              requestKey: request.id,
              language: getAppLanguage(),
            }).catch((error) => {
              addActivity(conversationId, {
                id: `plan-notification-error:${request.id}`,
                type: "plan_notification_error",
                title: planRuntimeText(
                  "Notification système indisponible",
                  "System notification unavailable",
                ),
                detail: error instanceof Error ? error.message : String(error),
                status: "warning",
              });
            });
            addActivity(conversationId, {
              id: `plan-attention:${request.id}`,
              type: "plan_attention",
              title: decoded?.payload.kind === "review"
                ? planRuntimeText("Plan prêt à valider", "Plan ready to review")
                : planRuntimeText("Question du mode Plan", "Plan mode question"),
              status: "warning",
              raw: request,
            });
          }
        }
        return;
      }
      if (eventType === "agent_start") {
        cancelTerminalStateReconciliation(conversationId);
        stateEpoch.current.set(conversationId, (stateEpoch.current.get(conversationId) ?? 0) + 1);
        transcriptEpoch.current.set(conversationId, (transcriptEpoch.current.get(conversationId) ?? 0) + 1);
        persistedIdleConversations.current.delete(conversationId);
        activeAgentLifecycles.current.add(conversationId);
        activePromptRuns.current.add(conversationId);
        updateConversation(conversationId, { status: "streaming", lastError: undefined });
        addActivity(conversationId, { type: eventType, title: "Prime Agent réfléchit", status: "running", raw: event });
        return;
      }
      if (eventType === "auto_retry_start") {
        // A retry can wait between two agent lifecycles while isStreaming is
        // momentarily false. It is nevertheless real work and must invalidate
        // an idle snapshot requested from the preceding message_end.
        cancelTerminalStateReconciliation(conversationId);
        stateEpoch.current.set(conversationId, (stateEpoch.current.get(conversationId) ?? 0) + 1);
        persistedIdleConversations.current.delete(conversationId);
        activePromptRuns.current.add(conversationId);
        updateConversation(conversationId, { status: "streaming", lastError: undefined });
        addActivity(conversationId, {
          type: eventType,
          title: "Nouvelle tentative Prime Agent",
          status: "running",
          raw: event,
        });
        return;
      }
      if (eventType === "auto_retry_end" && event.success === false) {
        cancelTerminalStateReconciliation(conversationId);
        stateEpoch.current.set(conversationId, (stateEpoch.current.get(conversationId) ?? 0) + 1);
        activeAgentLifecycles.current.delete(conversationId);
        activePromptRuns.current.delete(conversationId);
        const error = cleanDiagnostic(event.finalError) ?? "Prime Agent n’a pas pu terminer la nouvelle tentative.";
        const boundaryTime = now();
        updateConversation(conversationId, (conversation) => ({
          ...(shouldProjectLiveTranscript(isNative(), conversation.sessionPath)
            ? finalizeConversationTools(conversation, "failed", boundaryTime)
            : conversation),
          status: "error",
          lastError: error,
        }));
        refreshPersistedTranscript(conversationId, 0);
        addActivity(conversationId, {
          type: eventType,
          title: "Nouvelle tentative échouée",
          detail: error,
          status: "error",
          raw: event,
        });
        return;
      }
      if (eventType === "compaction_start") {
        const lifecycleWasStarted = compactionLifecycleStarted.current.has(conversationId);
        compactionLifecycleStarted.current.add(conversationId);
        compactingConversations.current.add(conversationId);
        recentCompactionEnds.current.delete(conversationId);
        const pending = pendingCompactions.current.get(conversationId);
        if (pending && event.reason === "manual") pending.started = true;
        const activityId = activeCompactionActivities.current.get(conversationId) ?? uid("compaction");
        activeCompactionActivities.current.set(conversationId, activityId);
        if (!lifecycleWasStarted) {
          stateEpoch.current.set(conversationId, (stateEpoch.current.get(conversationId) ?? 0) + 1);
          invalidateCompactionHistory(conversationId);
        }
        setRuntimeCompacting(conversationId, true);
        updateConversation(conversationId, { status: "tool", lastError: undefined });
        addActivity(conversationId, {
          id: activityId,
          type: eventType,
          title: "Compactage du contexte en cours",
          detail: event.reason === "manual" ? "Compactage demandé manuellement." : `Compactage automatique · ${String(event.reason ?? "contexte")}`,
          status: "running",
          raw: event,
        });
        return;
      }
      if (eventType === "compaction_end") {
        const recent = recentCompactionEnd(conversationId);
        const lifecycleWasStarted = compactionLifecycleStarted.current.delete(conversationId);
        const activityId = activeCompactionActivities.current.get(conversationId)
          ?? recent?.activityId
          ?? uid("compaction");
        // A repeated terminal event must not launch a second refresh or create
        // another timeline row. This also makes a response arriving immediately
        // before/after compaction_end harmless.
        if (!lifecycleWasStarted && recent) {
          compactingConversations.current.delete(conversationId);
          setRuntimeCompacting(conversationId, false);
          return;
        }
        if (!lifecycleWasStarted) invalidateCompactionHistory(conversationId);
        activeCompactionActivities.current.delete(conversationId);
        compactingConversations.current.delete(conversationId);
        recentCompactionEnds.current.set(conversationId, { endedAt: Date.now(), activityId });
        statsEpoch.current.set(conversationId, (statsEpoch.current.get(conversationId) ?? 0) + 1);
        stateEpoch.current.set(conversationId, (stateEpoch.current.get(conversationId) ?? 0) + 1);
        setRuntimeCompacting(conversationId, false, true);
        const presentation = compactionEndPresentation(event);
        const diagnostic = cleanDiagnostic(event.errorMessage);
        const activeWorkRemains = sessionActionsHaveWork(
          sessionActionsByConversation.current.get(conversationId),
        );
        updateConversation(conversationId, (conversation) => ({
          ...conversation,
          status: presentation.failed
            ? "error"
            : event.willRetry === true
              ? "streaming"
              : activeWorkRemains
                ? "streaming"
                : activePromptRuns.current.has(conversationId)
                  ? "streaming"
                  : "idle",
          lastError: presentation.failed ? diagnostic ?? "Le compactage du contexte a échoué." : undefined,
        }));
        addActivity(conversationId, {
          id: activityId,
          type: eventType,
          title: presentation.title,
          detail: presentation.detail,
          status: presentation.status,
          raw: event,
        });
        if (event.reason === "manual") {
          settleCompactionWaiter(
            conversationId,
            presentation.failed ? new Error(diagnostic ?? "Le compactage du contexte a échoué.") : undefined,
          );
        }
        refreshAfterCompaction(conversationId);
        return;
      }
      if (eventType === "refine_complete") {
        const directActivityId = directRefinementActivities.current.get(conversationId);
        if (refineLifecycleDisposition(Boolean(directActivityId)) === "passive_terminal") {
          uncertainRefinementConversations.current.delete(conversationId);
          setRuntimeRefining(conversationId, false);
        }
        const presentation = refinementResultPresentation(event.result);
        addActivity(conversationId, {
          id: presentation.activityId,
          type: eventType,
          title: presentation.title,
          detail: presentation.detail,
          status: "success",
          raw: event,
        });
        const token = activeSelection.current;
        if (token.conversationId === conversationId && isCurrentSelection(conversationId, token.generation)) {
          void sendSelectionRequest(conversationId, token.generation, "get_state").catch(() => undefined);
          void refreshLocalRefinements(conversationId, token.generation).catch(() => undefined);
        }
        return;
      }
      if (eventType === "refine_failed") {
        const directActivityId = directRefinementActivities.current.get(conversationId);
        if (refineLifecycleDisposition(Boolean(directActivityId)) === "passive_terminal") {
          uncertainRefinementConversations.current.delete(conversationId);
          setRuntimeRefining(conversationId, false);
        }
        addActivity(conversationId, {
          type: eventType,
          title: "Échec du raffinement",
          detail: cleanDiagnostic(event.error) ?? "Prime Agent n’a pas pu appliquer le raffinement.",
          status: "error",
          raw: event,
        });
        return;
      }
      if (eventType === "agent_end") {
        cancelTerminalStateReconciliation(conversationId);
        stateEpoch.current.set(conversationId, (stateEpoch.current.get(conversationId) ?? 0) + 1);
        activeAgentLifecycles.current.delete(conversationId);
        activePromptRuns.current.delete(conversationId);
        const boundaryTime = now();
        updateConversation(conversationId, (conversation) => {
          const status = compactingConversations.current.has(conversationId) ? "tool" : "idle";
          if (!shouldProjectLiveTranscript(isNative(), conversation.sessionPath)) {
            return { ...conversation, status, lastError: undefined };
          }
          const finalized = finalizeConversationTools(conversation, "completed", boundaryTime);
          return {
          ...finalized,
          status,
          messages: finalized.messages
            .filter((item) => item.role !== "assistant" || item.content.trim() || (item.tools?.length ?? 0) > 0)
            .map((item) => (item.status === "streaming" ? { ...item, status: "complete" } : item)),
          };
        });
        refreshPersistedTranscript(conversationId, 0);
        addActivity(conversationId, { type: eventType, title: "Exécution terminée", status: "success", raw: event });
        const pendingPlan = pendingPlanFinalizations.current.get(conversationId);
        if (pendingPlan?.stage === "applySending") {
          pendingPlanFinalizations.current.delete(conversationId);
          updateConversation(conversationId, {
            planMode: EMPTY_PLAN_MODE,
            planArtifactId: undefined,
            pendingPlanAction: undefined,
            lastError: undefined,
          });
          void flushWorkspaceState();
        } else if (pendingPlan) {
          const canFinalize = pendingPlan.stage !== "decisionRecorded"
            || !isNative()
            || persistedPlanDecisionResults.current.get(conversationId) === pendingPlan.handoffId;
          if (canFinalize) void finalizePendingPlan(conversationId);
          else refreshPersistedTranscript(conversationId, 0);
        }
        window.setTimeout(() => {
          const token = activeSelection.current;
          if (token.conversationId !== conversationId) return;
          // Re-read Prime Agent's transcript at the terminal boundary. This is
          // the canonical fallback when a live user/assistant event was lost,
          // and it replaces equivalent event projections without inventing a
          // renderer-owned message.
          const conversation = getConversationRef.current(conversationId);
          if (usesPersistedPrimeAgentTranscript(isNative(), conversation?.sessionPath)) {
            refreshPersistedTranscript(conversationId, 0);
          } else {
            void sendSelectionRequest(conversationId, token.generation, "get_messages").catch(() => undefined);
          }
          void sendSelectionRequest(conversationId, token.generation, "get_session_stats").catch(() => undefined);
        }, 150);
        if (compactionRefreshPending.current.has(conversationId)) {
          refreshAfterCompaction(conversationId);
        }
        return;
      }
      if (eventType === "turn_end") {
        const boundaryTime = now();
        updateConversation(conversationId, (conversation) => finalizeTurnTools(conversation, event, boundaryTime));
        addActivity(conversationId, { type: eventType, title: "Tour de l’agent terminé", status: "success", raw: event });
        scheduleTerminalStateReconciliation(conversationId);
        return;
      }
      if (eventType === "message_start" || eventType === "message_update" || eventType === "message_end") {
        if (eventType === "message_start") {
          transcriptEpoch.current.set(conversationId, (transcriptEpoch.current.get(conversationId) ?? 0) + 1);
          const pending = pendingPlanFinalizations.current.get(conversationId);
          const message = asRecord(event.message);
          if (message?.role === "user") {
            // A native user message_start means Prime Agent admitted the turn.
            // This is the authoritative fallback when agent_start is delayed
            // or lost; queued follow-ups emit it only when they begin running.
            cancelTerminalStateReconciliation(conversationId);
            stateEpoch.current.set(conversationId, (stateEpoch.current.get(conversationId) ?? 0) + 1);
            persistedIdleConversations.current.delete(conversationId);
            activePromptRuns.current.add(conversationId);
            updateConversation(conversationId, { status: "streaming", lastError: undefined });
          }
          if (
            pending?.stage === "applySending"
            && message?.role === "user"
            && extractMessageText(message).includes(planHandoffMarker(pending.handoffId))
          ) {
            pendingPlanFinalizations.current.delete(conversationId);
            updateConversation(conversationId, {
              planMode: EMPTY_PLAN_MODE,
              planArtifactId: undefined,
              pendingPlanAction: undefined,
              lastError: undefined,
            });
            void flushWorkspaceState();
          }
        }
        const persistedConversation = getConversationRef.current(conversationId);
        if (shouldProjectLiveTranscript(isNative(), persistedConversation?.sessionPath)) {
          handleMessageEvent(conversationId, event, updateConversation);
        } else {
          refreshPersistedTranscript(conversationId, eventType === "message_end" ? 0 : 80);
        }
        if (shouldScheduleTerminalStateReconciliation(event)) {
          scheduleTerminalStateReconciliation(conversationId);
        }
        return;
      }
      if (eventType === "tool_execution_start" || eventType === "tool_execution_update" || eventType === "tool_execution_end") {
        const persistedConversation = getConversationRef.current(conversationId);
        if (shouldProjectLiveTranscript(isNative(), persistedConversation?.sessionPath)) {
          handleToolEvent(conversationId, event, updateConversation);
        } else {
          refreshPersistedTranscript(conversationId, eventType === "tool_execution_end" ? 0 : 120);
          addActivity(conversationId, {
            id: `tool:${textValue(event.toolCallId) ?? stableToken(`${event.toolName ?? "tool"}:${event.type}`)}`,
            type: eventType,
            title: humanizeEvent(eventType),
            detail: summarizeToolInvocation(textValue(event.toolName) ?? "tool", event.args),
            status: eventType === "tool_execution_end"
              ? event.isError === true ? "error" : "success"
              : "running",
            raw: event,
          });
        }
        return;
      }
      if (eventType === "rlm_child_update") {
        const child = asRecord(event.child);
        const childId = textValue(child?.id) ?? textValue(child?.sessionName) ?? textValue(child?.label) ?? "unknown";
        const childStatus = textValue(child?.status) ?? "running";
        const presentation = rlmChildPresentation(child, childStatus);
        addActivity(conversationId, {
          id: `rlm-child:${childId}`,
          type: eventType,
          title: presentation.title,
          detail: presentation.detail,
          status: presentation.status,
          raw: event,
        });
        if (child && textValue(child.id)) {
          const snapshot = redactValue(child) as unknown as AgentRlmChild;
          const parentManagedClosure = isParentManagedSubagentClosure(snapshot);
          setRuntimes((current) => {
            const runtime = current[conversationId] ?? { models: [], commands: [], logs: [] };
            const children = runtime.subagents ?? [];
            const index = children.findIndex((item) => item.id === snapshot.id);
            const subagents = [...children];
            if (index >= 0) subagents[index] = { ...subagents[index], ...snapshot };
            else subagents.push(snapshot);
            const observedSubagent = parentManagedClosure
              && snapshot.activeSessionId
              && runtime.observedSubagent?.activeSessionId === snapshot.activeSessionId
              ? undefined
              : runtime.observedSubagent;
            return { ...current, [conversationId]: { ...runtime, subagents, observedSubagent } };
          });
        }
        return;
      }
      if (eventType === "session_action_update") {
        const actions = normalizePrimeOrbitSessionActions(
          event.actions as AgentSessionState["sessionActions"],
        );
        sessionActionsByConversation.current.set(conversationId, actions);
        setRuntimes((current) => {
          const runtime = current[conversationId];
          if (!runtime?.state) return current;
          return {
            ...current,
            [conversationId]: {
              ...runtime,
              state: { ...runtime.state, sessionActions: actions },
            },
          };
        });
        updateConversation(conversationId, (conversation) => {
          const authoritative = stripLegacyOrbitQueueRows(conversation);
          const status = activeStatusForSessionActions(actions);
          return status ? { ...authoritative, status } : authoritative;
        });
        addActivity(conversationId, {
          id: "session-actions",
          type: eventType,
          title: "File d’actions mise à jour",
          detail: summarizeSessionActions(event.actions),
          status: "info",
          raw: { ...event, actions },
        });
        return;
      }
      if (eventType === "session_info_changed") {
        const sessionName = textValue(event.name)?.trim();
        if (sessionName) {
          updateConversation(conversationId, { title: sessionName, sessionNameSyncPending: false });
          setRuntimes((current) => {
            const runtime = current[conversationId];
            if (!runtime?.state) return current;
            return {
              ...current,
              [conversationId]: { ...runtime, state: { ...runtime.state, sessionName } },
            };
          });
        }
        addActivity(conversationId, {
          id: "session-info",
          type: eventType,
          title: sessionName ? "Nom de session synchronisé" : "Informations de session mises à jour",
          detail: sessionName,
          status: "info",
          raw: event,
        });
        return;
      }
      if (eventType === "recap_update") {
        addActivity(conversationId, {
          id: "session-recap",
          type: eventType,
          title: event.recap ? "Synthèse de progression mise à jour" : "Synthèse de progression effacée",
          detail: typeof event.recap === "string" ? event.recap.slice(0, 220) : undefined,
          status: "info",
          raw: event,
        });
        return;
      }
      if (eventType === "observed_session_event") {
        const observed = observedSessionActivity(event);
        if (observed) addActivity(conversationId, observed);
        const activeSessionId = textValue(event.activeSessionId);
        const nested = asRecord(event.event);
        if (activeSessionId && nested?.type === "message_end" && nested.message) {
          const mapped = mapAgentMessages([nested.message]);
          if (mapped.length) {
            setRuntimes((current) => {
              const runtime = current[conversationId];
              if (!runtime?.observedSubagent || runtime.observedSubagent.activeSessionId !== activeSessionId) return current;
              return {
                ...current,
                [conversationId]: {
                  ...runtime,
                  observedSubagent: {
                    ...runtime.observedSubagent,
                    messages: [...runtime.observedSubagent.messages, ...mapped].slice(-160),
                  },
                },
              };
            });
          }
        }
        return;
      }
      if (eventType === "observed_session_closed") {
        const activeSessionId = textValue(event.activeSessionId) ?? "unknown";
        setRuntimes((current) => {
          const runtime = current[conversationId];
          if (!runtime?.observedSubagent || runtime.observedSubagent.activeSessionId !== activeSessionId) return current;
          return {
            ...current,
            [conversationId]: {
              ...runtime,
              observedSubagent: {
                ...runtime.observedSubagent,
                closed: true,
                error: cleanDiagnostic(event.error),
              },
            },
          };
        });
        addActivity(conversationId, {
          id: `observed-session:${activeSessionId}:closed`,
          type: eventType,
          title: "Sous-session observée terminée",
          detail: textValue(event.error),
          status: event.error ? "error" : "success",
          raw: event,
        });
        return;
      }
      if (eventType === "bash_start") {
        const explicitRunId = textValue(event.runId);
        const activityId = explicitRunId ? `bash:${explicitRunId}` : uid("bash-activity");
        activeBashActivities.current.set(conversationId, activityId);
        addActivity(conversationId, {
          id: activityId,
          type: eventType,
          title: "Commande système en cours",
          detail: typeof event.command === "string" ? event.command.slice(0, 180) : undefined,
          status: "running",
          raw: event,
        });
        return;
      }
      if (eventType === "bash_output") {
        // Output chunks remain available in the raw event log. Rendering one
        // timeline row per chunk makes the inspector unusable on long commands.
        return;
      }
      if (eventType === "bash_end") {
        const explicitRunId = textValue(event.runId);
        const activityId = explicitRunId
          ? `bash:${explicitRunId}`
          : activeBashActivities.current.get(conversationId) ?? uid("bash-activity");
        activeBashActivities.current.delete(conversationId);
        const cancelled = event.cancelled === true;
        const exitCode = typeof event.exitCode === "number" ? event.exitCode : undefined;
        const failed = Boolean(event.errorMessage) || (!cancelled && exitCode !== undefined && exitCode !== 0);
        addActivity(conversationId, {
          id: activityId,
          type: eventType,
          title: cancelled ? "Commande système annulée" : failed ? "Commande système échouée" : "Commande système terminée",
          detail: textValue(event.errorMessage) ?? (exitCode === undefined ? undefined : `Code de sortie ${exitCode}`),
          status: cancelled ? "warning" : failed ? "error" : "success",
          raw: event,
        });
        refreshPersistedTranscript(conversationId, 0);
        return;
      }
      if (eventType === "goal_update") {
        const goalState = event.goal as GoalState;
        goalEpoch.current.set(conversationId, (goalEpoch.current.get(conversationId) ?? 0) + 1);
        latestGoalByConversation.current.set(conversationId, goalState);
        setRuntimes((current) => {
          const runtime = current[conversationId] ?? { models: [], commands: [], logs: [] };
          return {
            ...current,
            [conversationId]: {
              ...runtime,
              state: runtime.state ? { ...runtime.state, goal: goalState } : runtime.state,
            },
          };
        });
        const pendingGoal = pendingGoalMutations.current.get(conversationId);
        if (
          pendingGoal
          && !pendingGoal.settled
          && goalMutationEventMatches(
            { conversationId: pendingGoal.conversationId, descriptor: pendingGoal.descriptor },
            conversationId,
            goalState,
          )
        ) {
          pendingGoal.settled = true;
          window.clearTimeout(pendingGoal.timeout);
          setGoalMutationState(conversationId, {
            command: pendingGoal.descriptor.command,
            kind: pendingGoal.descriptor.kind,
            phase: "reconciling",
          });
          pendingGoal.resolve(goalState);
        }
        const goal = asRecord(event.goal);
        const goalStatus = textValue(goal?.status) ?? "idle";
        addActivity(conversationId, {
          id: `goal:${textValue(goal?.goalId) ?? stableToken(goal?.objective)}`,
          type: eventType,
          title: goalActivityTitle(goalStatus),
          detail: summarizeGoal(event.goal),
          status: goalStatus === "complete" ? "success" : goalStatus === "error" ? "error" : goalStatus === "paused" || goalStatus === "budget_limited" ? "warning" : goalStatus === "active" ? "running" : "info",
          raw: event,
        });
        return;
      }
      if (eventType.includes("error") || eventType === "turn_error") {
        if (eventType === "turn_error") {
          cancelTerminalStateReconciliation(conversationId);
          stateEpoch.current.set(conversationId, (stateEpoch.current.get(conversationId) ?? 0) + 1);
          activeAgentLifecycles.current.delete(conversationId);
          activePromptRuns.current.delete(conversationId);
        }
        const error = redactText(String(event.error ?? event.message ?? "Erreur inconnue"));
        const boundaryTime = now();
        updateConversation(conversationId, (conversation) => ({
          ...(shouldProjectLiveTranscript(isNative(), conversation.sessionPath)
            ? finalizeConversationTools(conversation, "failed", boundaryTime)
            : conversation),
          status: "error",
          lastError: error,
        }));
        refreshPersistedTranscript(conversationId, 0);
        addActivity(conversationId, { type: eventType, title: "Exécution interrompue", detail: error, status: "error", raw: event });
        return;
      }
      if (eventType !== "response") {
        addActivity(conversationId, { type: eventType, title: humanizeEvent(eventType), status: "info", raw: event });
      }
    },
    [addActivity, cancelTerminalStateReconciliation, finalizePendingPlan, flushWorkspaceState, handleResponse, invalidateCompactionHistory, isCurrentSelection, recentCompactionEnd, refreshAfterCompaction, refreshLocalRefinements, refreshPersistedTranscript, removeActivity, scheduleTerminalStateReconciliation, sendSelectionRequest, setGoalMutationState, setRuntimeCompacting, setRuntimeRefining, settleCompactionWaiter, updateConversation],
  );

  const consumeAgentEventLine = useCallback(({ conversationId, line, runtimeMode }: NativeEventPayload) => {
    try {
      const event = JSON.parse(line) as RpcEnvelope;
      // Blocking extension requests can arrive immediately after a native
      // restart, before React has rebuilt `runtimeModes`. Trust the mode that
      // Rust attached from the exact registered child process rather than
      // cancelling Prime Agent's valid dialog from a stale renderer cache.
      if (runtimeMode) runtimeModes.current.set(conversationId, runtimeMode);
      addLog(conversationId, "rpc", summarizeRpcLog(line, event));
      handleAgentEvent(conversationId, event, runtimeMode);
    } catch {
      addLog(conversationId, "rpc", truncateRuntimeLog(line));
      addActivity(conversationId, {
        type: "protocol",
        title: "Événement RPC illisible",
        detail: line.slice(0, 220),
        status: "warning",
      });
    }
  }, [addActivity, addLog, handleAgentEvent]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listenToAgentEvents({
      onEvent: consumeAgentEventLine,
      onExtensionUiResolved: ({ conversationId, requestId }) => {
        setExtensionRequests((current) => current.filter(
          (request) => request.conversationId !== conversationId || request.id !== requestId,
        ));
      },
      onStderr: ({ conversationId, line }) => {
        const detail = redactText(line.trim());
        if (detail) {
          const previous = lastStderr.current.get(conversationId);
          lastStderr.current.set(conversationId, `${previous ? `${previous}\n` : ""}${detail}`.slice(-1_200));
        }
        addLog(conversationId, "stderr", truncateRuntimeLog(line));
      },
      onExit: ({ conversationId, code, success, error }) => {
        cancelTerminalStateReconciliation(conversationId);
        stateEpoch.current.set(conversationId, (stateEpoch.current.get(conversationId) ?? 0) + 1);
        activeAgentLifecycles.current.delete(conversationId);
        activePromptRuns.current.delete(conversationId);
        compactingConversations.current.delete(conversationId);
        compactionLifecycleStarted.current.delete(conversationId);
        activeCompactionActivities.current.delete(conversationId);
        recentCompactionEnds.current.delete(conversationId);
        compactionRefreshPending.current.delete(conversationId);
        directRefinementActivities.current.delete(conversationId);
        uncertainRefinementConversations.current.delete(conversationId);
        setRuntimeCompacting(conversationId, false, true);
        setRuntimeRefining(conversationId, false);
        setExtensionRequests((current) => current.filter((request) => request.conversationId !== conversationId));
        started.current.delete(conversationId);
        runtimeModes.current.delete(conversationId);
        startInFlight.current.delete(conversationId);
        const expected = intentionallyStopped.current.delete(conversationId);
        sessionActionsByConversation.current.delete(conversationId);
        const stderr = lastStderr.current.get(conversationId);
        lastStderr.current.delete(conversationId);
        const exitDiagnostic = expected
          ? undefined
          : agentExitErrorMessage({ code, success, error, stderr });
        if (exitDiagnostic) processExitErrors.current.set(conversationId, exitDiagnostic);
        else processExitErrors.current.delete(conversationId);
        settleCompactionWaiter(
          conversationId,
          new Error(exitDiagnostic ?? "Prime Agent s’est arrêté pendant le compactage."),
        );
        cancelConversationRequests(
          conversationId,
          exitDiagnostic ?? "Prime Agent s’est arrêté pendant le chargement.",
        );
        cancelPersistentConversationRequests(
          conversationId,
          exitDiagnostic ?? "Prime Agent s’est arrêté pendant l’opération en arrière-plan.",
        );
        rejectGoalMutation(
          conversationId,
          exitDiagnostic ?? "Prime Agent s’est arrêté avant de confirmer la modification de l’objectif.",
        );
        const recovering = runtimeBootstraps.current.has(conversationId);
        const terminalToolStatus: ToolActivity["status"] = expected ? "cancelled" : "failed";
        const boundaryTime = now();
        updateConversation(conversationId, (conversation) => {
          const projected = shouldProjectLiveTranscript(isNative(), conversation.sessionPath)
            ? finalizeConversationTools(conversation, terminalToolStatus, boundaryTime)
            : conversation;
          return {
            ...projected,
            // Process exit is an authoritative terminal boundary for every
            // running row. Activities are renderer-owned and have no durable
            // source that could ever repair them, so they must close even when
            // the persisted transcript stays authoritative for messages —
            // which is the normal native case, and the one that left
            // "Prime Agent réfléchit" spinning after a crash.
            activities: finalizeStalledActivityRows(projected.activities, boundaryTime, {
              status: expected ? "info" : "error",
              note: expected ? STOPPED_ACTIVITY_NOTE : exitDiagnostic ?? STOPPED_ACTIVITY_NOTE,
            }),
            status: expected ? "idle" : recovering ? "starting" : "error",
            lastError: recovering ? undefined : exitDiagnostic,
          };
        });
        refreshPersistedTranscript(conversationId, 0);
      },
      onInstallProgress: ({ phase, message }) => onInstallProgress(phase, redactText(message)),
      onInstallComplete: (result) => onInstallComplete(redactValue(result)),
    }).then((fn) => {
      if (cancelled) fn();
      else {
        unlisten = fn;
        setEventsReady(true);
      }
    });
    return () => {
      cancelled = true;
      if (isNative()) setEventsReady(false);
      unlisten?.();
    };
  }, [addActivity, addLog, cancelConversationRequests, cancelPersistentConversationRequests, cancelTerminalStateReconciliation, consumeAgentEventLine, onInstallComplete, onInstallProgress, refreshPersistedTranscript, rejectGoalMutation, setRuntimeCompacting, setRuntimeRefining, settleCompactionWaiter, updateConversation]);

  const ensureProcessStarted = useCallback(
    async (conversation: Conversation, project: Project) => {
      ensureRuntime(conversation.id);
      if (!isNative()) return;
      const desiredRuntimeMode = desiredRuntimeModeForConversation(
        getConversation(conversation.id) ?? conversation,
        expectedRuntimeModeTransitions.current.get(conversation.id),
      );
      const modelRef = conversation.model ?? project.defaultModel;
      const slash = modelRef?.indexOf("/") ?? -1;
      const startOptions: StartAgentOptions = {
        conversationId: conversation.id,
        cwd: project.path,
        sessionPath: conversation.sessionPath,
        provider: slash > 0 ? modelRef?.slice(0, slash) : undefined,
        model: slash > 0 ? modelRef?.slice(slash + 1) : modelRef,
        thinking: conversation.thinkingLevel,
        appendSystemPrompt: desiredRuntimeMode === "plan"
          ? undefined
          : buildRlmDelegationPrompt({
              preferredModel: conversation.rlmPreferredModel,
              thinkingLevel: conversation.rlmThinkingLevel,
            }),
        runtimeMode: desiredRuntimeMode,
      };
      // Rust's running-agent registry is authoritative even if a concurrent
      // --version health probe temporarily failed. Reclaim an existing runtime
      // first; start_agent is idempotent in this path and does not need to
      // rediscover the executable. For a new runtime, start_agent performs its
      // own fresh native detection instead of trusting a stale UI snapshot.
      const running = (await listRunningAgents()).find(
        (agent) => agent.conversationId === conversation.id,
      );
      if (!running) {
        started.current.delete(conversation.id);
        runtimeModes.current.delete(conversation.id);
      } else {
        started.current.add(conversation.id);
        runtimeModes.current.set(conversation.id, running.runtimeMode);
        if (running.runtimeMode === desiredRuntimeMode) {
          const reacquired = await startAgent(startOptions);
          if (!reacquired || reacquired.runtimeMode !== desiredRuntimeMode) {
            throw new Error(planRuntimeText(
              "Prime Orbit n’a pas pu reprendre les demandes interactives de cette conversation.",
              "Prime Orbit could not reclaim this conversation's interactive requests.",
            ));
          }
          runtimeModes.current.set(conversation.id, reacquired.runtimeMode);
          processExitErrors.current.delete(conversation.id);
          lastStderr.current.delete(conversation.id);
          return;
        }
      }
      if (started.current.has(conversation.id)) {
        const restarted = await restartAgent(conversation.id, desiredRuntimeMode);
        if (!restarted || restarted.agent.runtimeMode !== desiredRuntimeMode) {
          throw new Error(planRuntimeText(
            "Le runtime Prime Agent actif ne correspond pas au mode de la conversation.",
            "The active Prime Agent runtime does not match the conversation mode.",
          ));
        }
        runtimeModes.current.set(conversation.id, restarted.agent.runtimeMode);
        return;
      }
      const existing = startInFlight.current.get(conversation.id);
      if (existing) return existing;

      // A retry starts a new process attempt. Discard the previous terminal
      // diagnostic only here (not in ensureStarted, which can join an existing
      // attempt) so concurrent callers cannot erase a fresh exit error.
      processExitErrors.current.delete(conversation.id);
      lastStderr.current.delete(conversation.id);
      const start = startAgent(startOptions)
        .then(async (agent) => {
          if (!agent) throw new Error("Prime Agent n’a pas renvoyé d’état de lancement.");
          let activeAgent = agent;
          runtimeModes.current.set(conversation.id, agent.runtimeMode);
          if (agent.runtimeMode !== desiredRuntimeMode) {
            const restarted = await restartAgent(conversation.id, desiredRuntimeMode);
            if (!restarted) throw new Error(planRuntimeText(
              "Prime Agent n’a pas pu changer de mode d’exécution.",
              "Prime Agent could not change runtime mode.",
            ));
            activeAgent = restarted.agent;
          }
          runtimeModes.current.set(conversation.id, activeAgent.runtimeMode);
          const earlyExit = processExitErrors.current.get(conversation.id);
          if (earlyExit) throw new Error(earlyExit);
          intentionallyStopped.current.delete(conversation.id);
          started.current.add(conversation.id);
        })
        .finally(() => {
          if (startInFlight.current.get(conversation.id) === start) {
            startInFlight.current.delete(conversation.id);
          }
        });
      startInFlight.current.set(conversation.id, start);
      return start;
    },
    [ensureRuntime, getConversation],
  );

  const waitForConversationActivation = useCallback(async (conversationId: string) => {
    const deadline = Date.now() + SELECTION_ACTIVATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!runtimeViewActive.current || selectedConversationId.current !== conversationId) {
        return false;
      }
      if (
        runtimeEventsReady.current
        && activeSelection.current.conversationId === conversationId
      ) return true;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
    }
    return runtimeViewActive.current
      && runtimeEventsReady.current
      && selectedConversationId.current === conversationId
      && activeSelection.current.conversationId === conversationId;
  }, []);

  const setConversationRuntimeMode = useCallback(async (
    conversationId: string,
    mode: AgentRuntimeMode,
  ) => {
    const conversation = getConversation(conversationId);
    if (!conversation) throw new Error(planRuntimeText("Conversation introuvable.", "Conversation not found."));
    const previous = conversationPlanState(conversation);
    const transition = mode === "plan" ? startPlanMode(previous) : cancelPlanMode(previous);
    if (transition.status === "rejected") throw new Error(planRuntimeText(
      `Transition Plan refusée (${transition.reason}).`,
      `Plan transition rejected (${transition.reason}).`,
    ));

    if (isNative()) {
      await startInFlight.current.get(conversationId);
    }
    const nativeMode = runtimeModes.current.get(conversationId);
    const restartNative = isNative()
      && started.current.has(conversationId)
      && nativeMode !== mode
      ? async () => {
          const result = await restartAgent(conversationId, mode);
          if (result) runtimeModes.current.set(conversationId, result.agent.runtimeMode);
          return result?.agent.runtimeMode;
        }
      : undefined;
    await commitPlanRuntimeModeTransition(
      mode,
      restartNative,
      () => {
        updateConversation(conversationId, {
          planMode: transition.state,
          planArtifactId: mode === "plan" ? conversation.planArtifactId : undefined,
          lastError: undefined,
        });
      },
      (expectedMode) => {
        if (expectedMode) expectedRuntimeModeTransitions.current.set(conversationId, expectedMode);
        else expectedRuntimeModeTransitions.current.delete(conversationId);
      },
    );
  }, [getConversation, updateConversation]);

  const ensureStarted = useCallback(
    async (conversation: Conversation, project: Project) => {
      if (!await waitForConversationActivation(conversation.id)) {
        throw new DOMException(planRuntimeText(
          "La conversation n’est plus active.",
          "The conversation is no longer active.",
        ), "AbortError");
      }
      const token = activeSelection.current;

      const existingBootstrap = runtimeBootstraps.current.get(conversation.id);
      if (existingBootstrap?.generation === token.generation) {
        return existingBootstrap.promise;
      }

      if (!isNative()) {
        ensureRuntime(conversation.id);
        updateConversation(conversation.id, { status: "idle" });
        return;
      }

      const bootstrapTask = (async () => {
        if (!historyLoaded.current.has(conversation.id)) {
          updateConversation(conversation.id, (current) => {
            const status = statusDuringRuntimeRecovery(
              current.status,
              persistedIdleConversations.current.has(conversation.id),
            );
            return current.status === status && current.lastError === undefined
              ? current
              : { ...current, status, lastError: undefined };
          });
        }
        const recoveryDeadline = Date.now() + RUNTIME_RECOVERY_TIMEOUT_MS;
        let retryDelay = RUNTIME_RECOVERY_INITIAL_DELAY_MS;

        for (;;) {
          try {
            if (!isCurrentSelection(conversation.id, token.generation)) {
              throw new DOMException(planRuntimeText(
                "Le chargement a été remplacé par une autre conversation.",
                "The conversation load was replaced by another conversation.",
              ), "AbortError");
            }
            await ensureProcessStarted(conversation, project);
            if (!isCurrentSelection(conversation.id, token.generation)) {
              throw new DOMException(planRuntimeText(
                "Le chargement a été remplacé par une autre conversation.",
                "The conversation load was replaced by another conversation.",
              ), "AbortError");
            }

            // The native process owns unanswered extension dialogs. Rebuild
            // their React presentation on every selection bootstrap, including
            // when the process already existed and only its interactive-owner
            // lease had to be reclaimed.
            const pendingUiRequests = await listPendingExtensionUiRequests(conversation.id);
            if (!isCurrentSelection(conversation.id, token.generation)) {
              throw new DOMException(planRuntimeText(
                "Le chargement a été remplacé par une autre conversation.",
                "The conversation load was replaced by another conversation.",
              ), "AbortError");
            }
            pendingUiRequests.forEach(consumeAgentEventLine);

            // State and history are the only critical-path requests. Await the
            // state acknowledgement: merely writing get_state to a client that
            // exits one tick later is not a successful recovery.
            if (bootstrapGeneration.current.get(conversation.id) !== token.generation) {
              const stateResponse = await sendSelectionRequest(
                conversation.id,
                token.generation,
                "get_state",
                true,
              );
              if (!stateResponse) {
                throw new DOMException(planRuntimeText(
                  "Le chargement a été remplacé par une autre conversation.",
                  "The conversation load was replaced by another conversation.",
                ), "AbortError");
              }
              if (stateResponse.success === false) {
                throw new Error(stateResponse.error ?? planRuntimeText(
                  "Prime Agent n’a pas pu resynchroniser la conversation.",
                  "Prime Agent could not resynchronize the conversation.",
                ));
              }
              bootstrapGeneration.current.set(conversation.id, token.generation);
            }
            try {
              await loadConversationHistory(conversation.id, token.generation);
            } catch (error) {
              // Local canonical history is loaded independently from the
              // session file. A slow read-only RPC refresh must not flash a
              // global runtime failure while Prime Agent is otherwise healthy.
              if (!isTransientHistoryReadFailure(error)) throw error;
            }
            const currentConversation = getConversationRef.current(conversation.id);
            if (currentConversation?.sessionNameSyncPending && currentConversation.title.trim()) {
              try {
                const response = await sendSelectionRequest(
                  conversation.id,
                  token.generation,
                  "set_session_name",
                  true,
                  { name: currentConversation.title.trim() },
                );
                if (response?.success === false) throw new Error(response.error ?? "Le nom de session a été refusé.");
              } catch (error) {
                addActivity(conversation.id, {
                  type: "session_name_sync",
                  title: "Nom local non synchronisé",
                  detail: error instanceof Error ? error.message : String(error),
                  status: "warning",
                });
              }
            }
            if (isCurrentSelection(conversation.id, token.generation)) {
              void sendSelectionRequest(conversation.id, token.generation, "get_available_models").catch(() => undefined);
              void sendSelectionRequest(conversation.id, token.generation, "get_commands").catch(() => undefined);
              void sendSelectionRequest(conversation.id, token.generation, "get_session_stats").catch(() => undefined);
              void sendSelectionRequest(conversation.id, token.generation, "list_schedules", true, { includeInactive: false }).catch(() => undefined);
              void sendSelectionRequest(conversation.id, token.generation, "get_heartbeat").catch(() => undefined);
              void sendSelectionRequest(conversation.id, token.generation, "list_heartbeats").catch(() => undefined);
            }
            return;
          } catch (error) {
            const diagnostic = startupErrorMessage(
              error,
              processExitErrors.current.get(conversation.id),
            );
            const mayRetry = isCurrentSelection(conversation.id, token.generation)
              && isRecoverableRuntimeBootstrapError(diagnostic)
              && Date.now() < recoveryDeadline;
            if (!mayRetry) {
              if (isCurrentSelection(conversation.id, token.generation)) {
                updateConversation(conversation.id, {
                  status: "error",
                  lastError: redactText(diagnostic),
                });
              }
              throw error;
            }

            started.current.delete(conversation.id);
            runtimeModes.current.delete(conversation.id);
            bootstrapGeneration.current.delete(conversation.id);
            updateConversation(conversation.id, (current) => {
              const status = statusDuringRuntimeRecovery(
                current.status,
                persistedIdleConversations.current.has(conversation.id),
              );
              return current.status === status && current.lastError === undefined
                ? current
                : { ...current, status, lastError: undefined };
            });
            await new Promise<void>((resolve) => window.setTimeout(resolve, retryDelay));
            retryDelay = Math.min(retryDelay * 2, RUNTIME_RECOVERY_MAX_DELAY_MS);
          }
        }
      })();
      let trackedBootstrap!: Promise<void>;
      trackedBootstrap = bootstrapTask.finally(() => {
        if (runtimeBootstraps.current.get(conversation.id)?.promise === trackedBootstrap) {
          runtimeBootstraps.current.delete(conversation.id);
        }
      });
      runtimeBootstraps.current.set(conversation.id, {
        generation: token.generation,
        promise: trackedBootstrap,
      });
      return trackedBootstrap;
    },
    [addActivity, consumeAgentEventLine, ensureProcessStarted, ensureRuntime, isCurrentSelection, loadConversationHistory, sendSelectionRequest, updateConversation, waitForConversationActivation],
  );

  const resynchronizeConversationForPrompt = useCallback(async (conversationId: string) => {
    if (!await waitForConversationActivation(conversationId)) return false;
    const conversation = getConversationRef.current(conversationId);
    const project = conversation ? getProjectRef.current(conversation.projectId) : undefined;
    if (!conversation || !project) return false;
    bootstrapGeneration.current.delete(conversationId);
    await ensureStarted(conversation, project);
    const token = activeSelection.current;
    return isCurrentSelection(conversationId, token.generation);
  }, [ensureStarted, isCurrentSelection, waitForConversationActivation]);

  const refreshAfterMaintenance = useCallback(async (
    conversationId: string,
    kind: MaintenanceKind,
  ) => {
    const ownedByThisWindow = started.current.has(conversationId);
    const transcriptWasLoaded = historyLoaded.current.has(conversationId);
    bootstrapGeneration.current.delete(conversationId);
    sessionActionsByConversation.current.delete(conversationId);
    if (kind === "restart") {
      historyLoaded.current.delete(conversationId);
      activeAgentLifecycles.current.delete(conversationId);
      activePromptRuns.current.delete(conversationId);
      processExitErrors.current.delete(conversationId);
      lastStderr.current.delete(conversationId);
      cancelPersistentConversationRequests(
        conversationId,
        "Le redémarrage d’urgence a interrompu l’opération en arrière-plan.",
      );
      rejectGoalMutation(
        conversationId,
        "Le redémarrage d’urgence a interrompu la modification de l’objectif.",
      );
    }
    setRuntimes((current) => {
      const runtime = current[conversationId];
      if (!runtime) return current;
      return {
        ...current,
        [conversationId]: kind === "restart"
          ? { models: [], commands: [], logs: runtime.logs }
          : { ...runtime, state: undefined, models: [], commands: [], stats: undefined },
      };
    });

    const token = activeSelection.current;
    if (!isCurrentSelection(conversationId, token.generation)) {
      // A global event must not make an unrelated window pretend it owns the
      // runtime. Existing native owners are preserved across a restart; other
      // windows will acquire a lease normally when the conversation is opened.
      if (ownedByThisWindow && kind === "restart") {
        updateConversation(conversationId, { status: "idle", lastError: undefined });
      }
      return;
    }

    cancelConversationRequests(
      conversationId,
      kind === "restart"
        ? "La connexion Prime Agent a été remplacée."
        : "Les ressources Prime Agent ont été rechargées.",
    );
    if (kind === "reload" && transcriptWasLoaded) historyLoaded.current.add(conversationId);

    const conversation = getConversationRef.current(conversationId);
    const project = conversation ? getProjectRef.current(conversation.projectId) : undefined;
    if (!conversation || !project) return;
    updateConversation(conversationId, { status: "starting", lastError: undefined });

    try {
      // start_agent is idempotent and also acquires this window's lease. This
      // matters when another window initiated the maintenance operation.
      await ensureProcessStarted(conversation, project);
      if (!isCurrentSelection(conversationId, token.generation)) return;
      const stateResponse = await sendSelectionRequest(conversationId, token.generation, "get_state", true);
      if (stateResponse?.success === false) {
        throw new Error(stateResponse.error ?? "Prime Agent n’a pas renvoyé son état après l’opération de maintenance.");
      }
      if (kind === "restart") {
        try {
          await loadConversationHistory(conversationId, token.generation);
        } catch (error) {
          if (!isTransientHistoryReadFailure(error)) throw error;
        }
      }
      await Promise.all([
        sendSelectionRequest(conversationId, token.generation, "get_available_models", true),
        sendSelectionRequest(conversationId, token.generation, "get_commands", true),
      ]);
      if (!isCurrentSelection(conversationId, token.generation)) return;
      updateConversation(conversationId, { status: "idle", lastError: undefined });
      void sendSelectionRequest(conversationId, token.generation, "get_session_stats").catch(() => undefined);
      void sendSelectionRequest(conversationId, token.generation, "list_schedules", true, { includeInactive: false }).catch(() => undefined);
      void sendSelectionRequest(conversationId, token.generation, "get_heartbeat").catch(() => undefined);
      void sendSelectionRequest(conversationId, token.generation, "list_heartbeats").catch(() => undefined);
    } catch (error) {
      if (isCurrentSelection(conversationId, token.generation)) {
        updateConversation(conversationId, {
          status: "error",
          lastError: redactText(error instanceof Error ? error.message : String(error)),
        });
      }
      throw error;
    }
  }, [cancelConversationRequests, cancelPersistentConversationRequests, ensureProcessStarted, isCurrentSelection, loadConversationHistory, rejectGoalMutation, sendSelectionRequest, updateConversation]);

  const trackMaintenanceRefresh = useCallback((conversationId: string, kind: MaintenanceKind) => {
    const key = maintenanceEventKey(kind, conversationId);
    maintenanceEventVersions.current.set(key, (maintenanceEventVersions.current.get(key) ?? 0) + 1);
    const refresh = refreshAfterMaintenance(conversationId, kind);
    maintenanceRefreshes.current.set(key, refresh);
    // Keep the settled promise until the next event for this key. The native
    // invoke resolves after the global event is emitted, so the initiating
    // window can still observe a refresh failure without issuing duplicate RPC.
    void refresh.catch(() => undefined);
  }, [refreshAfterMaintenance]);

  const awaitMaintenanceRefresh = useCallback(async (
    conversationId: string,
    kind: MaintenanceKind,
    previousEventVersion: number,
  ) => {
    const key = maintenanceEventKey(kind, conversationId);
    if ((maintenanceEventVersions.current.get(key) ?? 0) > previousEventVersion) {
      await maintenanceRefreshes.current.get(key);
      return;
    }
    const refresh = refreshAfterMaintenance(conversationId, kind);
    maintenanceRefreshes.current.set(key, refresh);
    await refresh;
  }, [refreshAfterMaintenance]);

  useEffect(() => {
    let cancelled = false;
    const unlistens: Array<() => void> = [];
    const register = (pending: Promise<() => void>) => {
      void pending.then((unlisten) => {
        if (cancelled) unlisten();
        else unlistens.push(unlisten);
      }).catch(() => undefined);
    };
    register(listenToAgentRestarts((result) => {
      runtimeModes.current.set(result.agent.conversationId, result.agent.runtimeMode);
      // A controlled Plan mode transition owns its own readiness and durable
      // state transaction. Running the generic maintenance refresh here would
      // observe the pre-commit Plan state and can immediately restart the new
      // Normal runtime back into Plan mode.
      if (
        expectedRuntimeModeTransitions.current.get(result.agent.conversationId)
        === result.agent.runtimeMode
      ) return;
      trackMaintenanceRefresh(result.agent.conversationId, "restart");
    }));
    register(listenToAgentResourceReloads(({ conversationId }) => {
      trackMaintenanceRefresh(conversationId, "reload");
    }));
    return () => {
      cancelled = true;
      unlistens.forEach((unlisten) => unlisten());
    };
  }, [trackMaintenanceRefresh]);

  // Selection ownership is intentionally keyed only by IDs. Session metadata
  // is populated by get_state and must never invalidate an in-flight bootstrap.
  useLayoutEffect(() => {
    const nextConversationId = active ? selectedConversation?.id : undefined;
    const previous = activeSelection.current;
    const generation = previous.generation + 1;
    selectedConversationId.current = nextConversationId;
    activeSelection.current = { conversationId: nextConversationId, generation };

    if (previous.conversationId && previous.conversationId !== nextConversationId) {
      // Keep the native lease: Prime Orbit is a multi-session client and an
      // agent must continue working when its transcript is no longer visible.
      // Only selection-scoped bootstrap requests are cancelled here. Native
      // leases are released safely when the window is destroyed, or explicitly
      // by closeRuntime/stop_agent.
      cancelConversationRequests(previous.conversationId, "La conversation active a changé.");
    }
  }, [active, cancelConversationRequests, selectedConversation?.id, selectedProject?.id]);

  // Local history is deliberately independent from runtime health. A
  // broken/missing Prime Agent must not make a valid saved transcript
  // disappear, and changing session metadata must not advance the selection
  // generation above.
  useEffect(() => {
    if (!active || !selectedConversation || !selectedProject) return;
    const token = activeSelection.current;
    if (token.conversationId !== selectedConversation.id) return;
    if (shouldEnterLocalHistoryLoading(
      selectedConversation,
      historyLoaded.current.has(selectedConversation.id),
    )) {
      updateConversation(selectedConversation.id, (conversation) => ({
        ...conversation,
        status: conversation.status === "offline" ? "starting" : conversation.status,
      }));
    }
    void loadLocalConversationHistory(selectedConversation, selectedProject, token.generation).catch(() => undefined);
  }, [active, loadLocalConversationHistory, selectedConversation?.id, selectedConversation?.messages.length, selectedConversation?.sessionId, selectedConversation?.sessionPath, selectedProject?.id, selectedProject?.path, updateConversation]);

  // Prime Agent's append-only JSONL file is the selected conversation's
  // durable transcript and task-state clock. Poll only its cheap native stamp;
  // parse and replace the public projection when that revision changes.
  useEffect(() => {
    if (
      !isNative()
      || !active
      || !selectedConversation?.sessionPath
      || !selectedProject
    ) return;
    const conversationId = selectedConversation.id;
    const identity = localHistoryIdentity(selectedConversation);
    const generation = activeSelection.current.generation;
    let cancelled = false;
    let timeout: number | undefined;
    let appliedRevision: string | undefined;

    const schedule = () => {
      if (cancelled) return;
      timeout = window.setTimeout(() => void poll(), SESSION_FILE_POLL_INTERVAL_MS);
    };
    const poll = async () => {
      try {
        const current = getConversationRef.current(conversationId);
        if (
          cancelled
          || !current?.sessionPath
          || localHistoryIdentity(current) !== identity
          || !isCurrentSelection(conversationId, generation)
        ) return;
        const stamp = await getSessionHistoryStamp(
          current.sessionPath,
          current.sessionId,
          selectedProject.path,
        );
        if (cancelled) return;
        if (stamp.revision !== appliedRevision) {
          const loadedRevision = await loadLocalConversationHistory(
            current,
            selectedProject,
            generation,
            true,
          );
          if (!cancelled) appliedRevision = loadedRevision;
          return;
        }
        if (
          persistedIdleConversations.current.has(conversationId)
          && !pendingPromptAdmissions.current.has(conversationId)
          && !pendingCompactions.current.has(conversationId)
          && !compactingConversations.current.has(conversationId)
          && current.status !== "idle"
        ) {
          activeAgentLifecycles.current.delete(conversationId);
          activePromptRuns.current.delete(conversationId);
          updateConversation(conversationId, { status: "idle", lastError: undefined });
        }
      } catch {
        // Prime Agent may be between two JSONL writes. Keep the last complete
        // projection and retry the same revision instead of surfacing a false
        // conversation failure.
      } finally {
        schedule();
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [active, isCurrentSelection, loadLocalConversationHistory, selectedConversation?.id, selectedConversation?.sessionId, selectedConversation?.sessionPath, selectedProject?.id, selectedProject?.path, updateConversation]);

  useEffect(() => {
    if (!active || !selectedConversation || !selectedProject || !detection) return;
    if (!eventsReady || activeSelection.current.conversationId !== selectedConversation.id) return;
    const token = activeSelection.current;
    void ensureStarted(selectedConversation, selectedProject).catch(async (error) => {
      let localError: string | undefined;
      try {
        await loadLocalConversationHistory(
          selectedConversation,
          selectedProject,
          token.generation,
        );
      } catch (cause) {
        localError = cause instanceof Error ? cause.message : String(cause);
      }
      if (!isCurrentSelection(selectedConversation.id, token.generation)) return;
      const runtimeError = error instanceof Error
        ? error.message
        : detection.error ?? planRuntimeText(
            "Prime Agent est indisponible. L’historique local reste consultable.",
            "Prime Agent is unavailable. Local history remains readable.",
          );
      const diagnostic = redactText(localError
        ? `${runtimeError}\n\n${planRuntimeText("Historique local", "Local history")}: ${localError}`
        : runtimeError);
      updateConversation(selectedConversation.id, (current) => {
        if (current.status === "error" && current.lastError === diagnostic) return current;
        return { ...current, status: "error", lastError: diagnostic };
      });
    });
  }, [active, detection, ensureStarted, eventsReady, isCurrentSelection, loadLocalConversationHistory, selectedConversation?.id, selectedConversation?.sessionId, selectedConversation?.sessionPath, selectedProject?.id, selectedProject?.path, updateConversation]);

  useEffect(() => bindRuntimePageHideTeardown(window, () => {
    const conversationId = activeSelection.current.conversationId;
    selectedConversationId.current = undefined;
    activeSelection.current = { generation: activeSelection.current.generation + 1 };
    if (conversationId) cancelConversationRequests(conversationId, "La fenêtre se ferme.");
    for (const requestId of pendingConversationRequests.current.keys()) {
      clearPendingConversationRequest(requestId, new Error("La fenêtre se ferme."));
    }
    for (const conversationId of pendingCompactions.current.keys()) {
      settleCompactionWaiter(conversationId, new Error("La fenêtre se ferme pendant le compactage."));
    }
    for (const timeout of terminalStateReconciliationTimers.current.values()) {
      window.clearTimeout(timeout);
    }
    terminalStateReconciliationTimers.current.clear();
  }), [cancelConversationRequests, clearPendingConversationRequest, settleCompactionWaiter]);

  // The reconciliation floor under every event-driven recovery path. Those
  // paths all fire on a cue that itself travelled through the stream, so none
  // of them can repair the loss of that very cue. The ticker is unconditional
  // and the decision to send lives in the callback, reading current state:
  // keeping the interval stable avoids tearing it down on every activity
  // update during a stream. applySessionStateSnapshot remains the sole
  // arbiter of what a snapshot is allowed to change.
  useEffect(() => {
    if (!active || !eventsReady || !isNative()) return;
    const conversationId = selectedConversation?.id;
    if (!conversationId) return;
    const interval = window.setInterval(() => {
      const conversation = getConversationRef.current(conversationId);
      if (!conversation) return;
      // A Plan runtime blocked in a question or review dialog is waiting on the
      // user by design, not drifting. It cannot answer until the dialog is
      // resolved, so polling it would only pile up requests that time out.
      const planPhase = conversationPlanState(conversation).phase;
      if (planPhase === "question" || planPhase === "review") return;
      const stalled = stalledRunningActivities(conversation.activities, Date.now());
      if (!shouldReconcileRuntimeState(conversation.status, stalled.length > 0)) return;
      const token = activeSelection.current;
      if (
        token.conversationId !== conversationId
        || !isCurrentSelection(conversationId, token.generation)
      ) return;
      void sendSelectionRequest(conversationId, token.generation, "get_state").catch(() => undefined);
    }, RUNTIME_RECONCILIATION_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [active, eventsReady, isCurrentSelection, selectedConversation?.id, sendSelectionRequest]);

  const sendPrompt = useCallback(
    async (message: string, attachments: Attachment[], requestedDelivery?: "steer" | "follow_up") => {
      if (!selectedConversation || !selectedProject) return;
      const conversationId = selectedConversation.id;
      const trimmed = message.trim();
      if (!trimmed && attachments.length === 0) return;
      if (attachments.some((item) => !item.attachmentHandle)) {
        throw new Error("Attachment handle unavailable; select the file again.");
      }
      const beforeStart = getConversationRef.current(conversationId) ?? selectedConversation;
      const sessionActions = sessionActionsByConversation.current.get(conversationId);
      const hasTrackedWork = activePromptRuns.current.has(conversationId)
        || activeAgentLifecycles.current.has(conversationId)
        || pendingCompactions.current.has(conversationId)
        || compactingConversations.current.has(conversationId)
        || sessionActionsHaveWork(sessionActions);
      const compactionOwnsSession = pendingCompactions.current.has(conversationId)
        || compactingConversations.current.has(conversationId);
      const effectiveDelivery = resolveNativePromptDelivery(
        beforeStart.status,
        requestedDelivery,
        hasTrackedWork,
        compactionOwnsSession,
      );
      const forceQueued = effectiveDelivery !== undefined;
      cancelTerminalStateReconciliation(conversationId);
      // Invalidate any get_state request issued before this local admission.
      // Otherwise an idle bootstrap response could arrive in the narrow gap
      // before agent_start and erase the rapid-submit marker for a real run.
      stateEpoch.current.set(conversationId, (stateEpoch.current.get(conversationId) ?? 0) + 1);
      transcriptEpoch.current.set(conversationId, (transcriptEpoch.current.get(conversationId) ?? 0) + 1);
      persistedIdleConversations.current.delete(conversationId);
      activePromptRuns.current.add(conversationId);
      pendingPromptAdmissions.current.add(conversationId);
      try {
        try {
          await ensureStarted(selectedConversation, selectedProject);
        } catch (error) {
          if (!isRecoverableConversationActivationError(error)
            || !await resynchronizeConversationForPrompt(conversationId)) throw error;
        }
      } catch (error) {
        // Nothing was admitted: whether or not the prompt was queued, there is
        // no run to track. Keeping the marker would force every later prompt
        // into queued delivery until an agent_end that can never arrive.
        activePromptRuns.current.delete(conversationId);
        pendingPromptAdmissions.current.delete(conversationId);
        throw error;
      }
      const content = trimmed;
      if (!isNative()) {
        pendingPromptAdmissions.current.delete(conversationId);
        updateConversation(conversationId, (conversation) => ({
          ...applyAuthoritativeUserMessageStart(
            conversation,
            content,
            now(),
            attachments.map(durableAttachmentMetadata),
          ),
          status: "streaming",
        }));
        window.setTimeout(() => {
          activePromptRuns.current.delete(conversationId);
          updateConversation(conversationId, (conversation) => {
            return {
              ...conversation,
              status: "idle",
              messages: [
                ...conversation.messages,
                {
                  id: uid("assistant"),
                  role: "assistant",
                  content: "Mode aperçu actif. Dans l’application Tauri, ce message est envoyé au processus RPC de Prime Agent et sa réponse apparaît ici en streaming.",
                  createdAt: now(),
                  status: "complete",
                },
              ],
            };
          });
        }, 700);
        return;
      }
      const attachmentPayload = promptAttachmentPayload(attachments);
      const expectedRuntimeMode = runtimeModeForConversationPlan(
        getConversationRef.current(conversationId) ?? beforeStart,
      );
      try {
        const admission = await sendConversationRequest(
          conversationId,
          "prompt",
          {
            message: content,
            ...attachmentPayload,
            ...(forceQueued
              ? { streamingBehavior: effectiveDelivery === "steer" ? "steer" : "followUp" }
              : {}),
          },
          PASSIVE_RESPONSE_TIMEOUT_MS,
          "prompt_admission",
          expectedRuntimeMode,
        );
        if (admission.success === false) {
          throw new Error(admission.error ?? planRuntimeText(
            "Prime Agent a refusé le message.",
            "Prime Agent rejected the message.",
          ));
        }
        // Prime Agent's correlated `response(command=prompt)` is the admission
        // boundary. A native stdin flush alone does not prove that the daemon
        // accepted the turn or its requested queue lane.
        updateConversation(conversationId, {
          status: compactingConversations.current.has(conversationId) ? "tool" : "streaming",
          lastError: undefined,
        });
        if (forceQueued) {
          const token = activeSelection.current;
          window.setTimeout(() => {
            if (!isCurrentSelection(conversationId, token.generation)) return;
            void sendSelectionRequest(conversationId, token.generation, "get_state").catch(() => undefined);
          }, 50);
        }
        if (usesPersistedPrimeAgentTranscript(isNative(), getConversationRef.current(conversationId)?.sessionPath)) {
          refreshPersistedTranscript(conversationId, 40);
        }
      } catch (error) {
        activePromptRuns.current.delete(conversationId);
        throw error;
      } finally {
        pendingPromptAdmissions.current.delete(conversationId);
      }
    },
    [cancelTerminalStateReconciliation, ensureStarted, isCurrentSelection, refreshPersistedTranscript, resynchronizeConversationForPrompt, selectedConversation, selectedProject, sendConversationRequest, sendSelectionRequest, updateConversation],
  );

  const retryMessage = useCallback(async (assistantMessageId: string) => {
    if (!selectedConversation) return;
    const conversation = getConversationRef.current(selectedConversation.id) ?? selectedConversation;
    const assistantIndex = conversation.messages.findIndex((message) => message.id === assistantMessageId);
    if (assistantIndex < 0) return;
    for (let index = assistantIndex - 1; index >= 0; index -= 1) {
      const source = conversation.messages[index];
      if (source?.role !== "user") continue;
      // A sent image handle is deliberately consumed natively after a
      // successful write and cannot be replayed. Reuse only the source text
      // in the composer so the user can review it and explicitly reselect any
      // attachments, rather than pretending to regenerate a historical turn.
      updateConversation(conversation.id, (current) => ({ ...current, draft: source.content }));
      return;
    }
  }, [selectedConversation, updateConversation]);

  const abort = useCallback(async () => {
    if (!selectedConversation) return;
    const conversationId = selectedConversation.id;
    let confirmedIdle = false;
    try {
      await sendRpc(conversationId, { id: uid("abort"), type: "abort" });
      const token = activeSelection.current;
      if (isCurrentSelection(conversationId, token.generation)) {
        for (let attempt = 0; attempt < 6; attempt += 1) {
          let response: RpcEnvelope | void;
          try {
            response = await sendSelectionRequest(conversationId, token.generation, "get_state", true);
          } catch {
            break;
          }
          const state = asRecord(response?.data) as unknown as AgentSessionState | undefined;
          if (response?.success !== false && state && isAuthoritativeIdleSessionSnapshot(state)) {
            confirmedIdle = true;
            break;
          }
          await new Promise<void>((resolve) => window.setTimeout(resolve, 75));
        }
      }
    } finally {
      if (confirmedIdle) {
        activeAgentLifecycles.current.delete(conversationId);
        activePromptRuns.current.delete(conversationId);
        directRefinementActivities.current.delete(conversationId);
        uncertainRefinementConversations.current.delete(conversationId);
        setRuntimeRefining(conversationId, false);
        updateConversation(conversationId, (conversation) => ({
          ...finalizeConversationTools(conversation, "cancelled", now()),
          status: "idle",
        }));
      }
    }
  }, [isCurrentSelection, selectedConversation, sendSelectionRequest, setRuntimeRefining, updateConversation]);

  const recoverPlanDialogs = useCallback(async () => {
    if (!selectedConversation || !selectedProject) return;
    const conversationId = selectedConversation.id;
    const recoveryKind = recoverablePlanDialogKind(selectedConversation);
    if (!recoveryKind) return;
    const expectedToolCallId = unresolvedPlanDialogSummary(selectedConversation).latestToolCallId;
    if (!expectedToolCallId) {
      throw new Error(planRuntimeText(
        "Prime Agent n’a pas publié l’identifiant durable du dialogue Plan.",
        "Prime Agent did not publish the durable Plan dialog identifier.",
      ));
    }
    const token = activeSelection.current;

    const findLivePlanRequest = (payloads: NativeEventPayload[], excluded = new Set<string>()) => (
      matchingNativePlanRequest(payloads, conversationId, undefined, excluded)
    );

    // Reclaim/stabilize the exact native process before interpreting an empty
    // dialog cache. This applies even when JSONL already looks recoverable:
    // the durable tool call can precede native extension request publication.
    await ensureStarted(selectedConversation, selectedProject);
    if (!isCurrentSelection(conversationId, token.generation)) return;
    const runningAgent = (await listRunningAgents()).find(
      (agent) => agent.conversationId === conversationId,
    );
    if (!runningAgent || runningAgent.runtimeMode !== "plan") {
      throw new Error(planRuntimeText(
        "La génération Prime Agent Plan active est introuvable.",
        "The active Prime Agent Plan generation could not be found.",
      ));
    }

    const reconcileExactRequest = (abortRequestId?: string) => reconcilePlanDialogRecovery({
      conversationId,
      expectedPid: runningAgent.pid,
      expectedStartedAt: runningAgent.startedAt,
      expectedToolCallId,
      abortRequestId,
    });

    // A renderer reload can lose only React's transient card while the same
    // native process still owns the real UUID. Replay that request verbatim;
    // do not restart or reconstruct anything when Prime Agent can answer it.
    // The JSONL write can become visible several seconds before Rust caches
    // the blocking request, so probe that exact durable call on the same
    // pid/startedAt generation for a named bounded interval.
    const replayDeadline = Date.now() + PLAN_NATIVE_REPLAY_PROBE_TIMEOUT_MS;
    for (;;) {
      if (!isCurrentSelection(conversationId, token.generation)) return;
      const disposition = await reconcileExactRequest();
      if (disposition.status === "replayed") {
        consumeAgentEventLine(disposition.request);
        return;
      }
      if (disposition.status === "conflict") {
        refreshPersistedTranscript(conversationId, 0);
        throw new Error(planRuntimeText(
          "Une autre demande interactive Prime Agent est déjà active. Son état doit être resynchronisé avant toute récupération.",
          "Another Prime Agent interactive request is already active. Resynchronize its state before recovery.",
        ));
      }
      if (Date.now() >= replayDeadline) break;
      await new Promise<void>((resolve) => window.setTimeout(
        resolve,
        PLAN_NATIVE_REPLAY_POLL_INTERVAL_MS,
      ));
    }

    const retiredRequestIds = new Set(
      extensionRequests
        .filter((request) => request.conversationId === conversationId)
        .map((request) => request.id),
    );
    const abortRequestId = uid("abort");
    let resolveAbort!: (message: RpcEnvelope) => void;
    let rejectAbort!: (error: Error) => void;
    const abortResponsePromise = new Promise<RpcEnvelope>((resolve, reject) => {
      resolveAbort = resolve;
      rejectAbort = reject;
    });
    const abortTimeout = window.setTimeout(() => {
      clearPendingConversationRequest(
        abortRequestId,
        new Error(planRuntimeText(
          "Prime Agent n’a pas répondu à l’abort Plan dans le délai prévu.",
          "Prime Agent did not respond to the Plan abort in time.",
        )),
      );
    }, PASSIVE_RESPONSE_TIMEOUT_MS);
    pendingConversationRequests.current.set(abortRequestId, {
      conversationId,
      timeout: abortTimeout,
      purpose: "plan_recovery",
      resolve: resolveAbort,
      reject: rejectAbort,
    });

    let abortResponse: RpcEnvelope;
    try {
      const atomicDeadline = Date.now() + PLAN_NATIVE_REPLAY_PROBE_TIMEOUT_MS;
      for (;;) {
        if (!isCurrentSelection(conversationId, token.generation)) {
          clearPendingConversationRequest(abortRequestId);
          return;
        }
        const disposition = await reconcileExactRequest(abortRequestId);
        if (disposition.status === "replayed") {
          clearPendingConversationRequest(abortRequestId);
          consumeAgentEventLine(disposition.request);
          return;
        }
        if (disposition.status === "conflict") {
          clearPendingConversationRequest(abortRequestId);
          throw new Error(planRuntimeText(
            "Prime Agent a publié une autre demande interactive avant l’abort. Aucune demande n’a été annulée.",
            "Prime Agent published another interactive request before abort. No request was cancelled.",
          ));
        }
        if (disposition.status === "abortSent") break;
        if (Date.now() >= atomicDeadline) {
          clearPendingConversationRequest(abortRequestId);
          throw new Error(planRuntimeText(
            "Prime Agent écrit déjà sur cette session. Réessayez la récupération dans un instant.",
            "Prime Agent is already writing to this session. Retry recovery in a moment.",
          ));
        }
        await new Promise<void>((resolve) => window.setTimeout(
          resolve,
          PLAN_NATIVE_REPLAY_POLL_INTERVAL_MS,
        ));
      }
      abortResponse = await abortResponsePromise;
    } catch (error) {
      clearPendingConversationRequest(abortRequestId);
      throw error;
    }
    if (abortResponse.success === false) {
      throw new Error(abortResponse.error ?? planRuntimeText(
        "Prime Agent n’a pas confirmé l’arrêt de l’ancien dialogue Plan.",
        "Prime Agent did not confirm cancellation of the old Plan dialog.",
      ));
    }
    // Plan sessions use Orbit's managed-generation daemon rather than Prime
    // Agent's global default daemon. The abort above releases the orphaned
    // interactive call owned by that exact RPC process; the replacement below
    // starts a fresh Plan runtime on the same isolated daemon generation.
    // Queue recovery still belongs to the RPC runtime and must not gate this
    // exact dialog recovery path.

    let confirmedIdle = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!isCurrentSelection(conversationId, token.generation)) {
        throw new DOMException(planRuntimeText(
          "La récupération a été remplacée par une autre conversation.",
          "Recovery was replaced by another conversation.",
        ), "AbortError");
      }
      const response = await sendSelectionRequest(conversationId, token.generation, "get_state", true);
      if (response?.success === false) {
        throw new Error(response.error ?? planRuntimeText(
          "Prime Agent n’a pas pu confirmer l’état de la session.",
          "Prime Agent could not confirm the session state.",
        ));
      }
      const state = asRecord(response?.data) as unknown as AgentSessionState | undefined;
      if (state && isAuthoritativeIdleSessionSnapshot(state)) {
        confirmedIdle = true;
        break;
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
    }
    if (!confirmedIdle) {
      throw new Error(planRuntimeText(
        "Prime Agent n’a pas libéré l’ancien dialogue Plan dans le délai prévu.",
        "Prime Agent did not release the previous Plan dialog in time.",
      ));
    }

    activeAgentLifecycles.current.delete(conversationId);
    activePromptRuns.current.delete(conversationId);
    directRefinementActivities.current.delete(conversationId);
    uncertainRefinementConversations.current.delete(conversationId);
    setRuntimeRefining(conversationId, false);
    setExtensionRequests((current) => current.filter(
      (request) => request.conversationId !== conversationId,
    ));
    const rearmed = rearmPlanModeAfterLostDialog(
      conversationPlanState(selectedConversation),
      recoveryKind,
    );
    if (rearmed.status === "rejected") {
      throw new Error(planRuntimeText(
        `Le dialogue Plan local ne peut pas être réarmé (${rearmed.reason}).`,
        `The local Plan dialog cannot be rearmed (${rearmed.reason}).`,
      ));
    }
    updateConversation(conversationId, (conversation) => ({
      ...conversation,
      planMode: rearmed.state,
      planArtifactId: undefined,
      status: "starting",
      lastError: undefined,
    }));
    refreshPersistedTranscript(conversationId, 0);
    stateEpoch.current.set(conversationId, (stateEpoch.current.get(conversationId) ?? 0) + 1);
    transcriptEpoch.current.set(conversationId, (transcriptEpoch.current.get(conversationId) ?? 0) + 1);

    cancelConversationRequests(conversationId, planRuntimeText(
      "La connexion Plan est recréée.",
      "The Plan connection is being recreated.",
    ));
    const restarted = await restartAgent(conversationId, "plan");
    if (!restarted || restarted.agent.runtimeMode !== "plan") {
      throw new Error(planRuntimeText(
        "Prime Orbit n’a pas pu recréer la connexion interactive Plan.",
        "Prime Orbit could not recreate the interactive Plan connection.",
      ));
    }
    started.current.add(conversationId);
    runtimeModes.current.set(conversationId, restarted.agent.runtimeMode);
    processExitErrors.current.delete(conversationId);
    lastStderr.current.delete(conversationId);
    const ready = await sendSelectionRequest(conversationId, token.generation, "get_state", true);
    if (ready?.success === false) {
      throw new Error(ready.error ?? planRuntimeText(
        "La nouvelle connexion Plan ne répond pas.",
        "The replacement Plan connection is not responding.",
      ));
    }

    persistedIdleConversations.current.delete(conversationId);
    activePromptRuns.current.add(conversationId);
    const recoveryMessage = recoveryKind === "review"
      ? `${PLAN_RECOVERY_PROMPT_PREFIX} The previous Plan review dialog was lost during a client reconnection. `
        + "Submit the same previously written Plan document again with prime_orbit_plan_submit. "
        + "Do not change its decisions and do not reuse the cancelled tool call."
      : `${PLAN_RECOVERY_PROMPT_PREFIX} The previous Plan question dialog was lost during a client reconnection. `
        + "Ask the still unresolved planning question again with prime_orbit_plan_question. "
        + "Do not reuse the cancelled tool call.";
    try {
      const admission = await sendConversationRequest(
        conversationId,
        "prompt",
        { message: recoveryMessage },
        PASSIVE_RESPONSE_TIMEOUT_MS,
        "prompt_admission",
        "plan",
      );
      if (admission.success === false) {
        throw new Error(admission.error ?? planRuntimeText(
          "Prime Agent a refusé la récupération du dialogue Plan.",
          "Prime Agent rejected the Plan dialog recovery prompt.",
        ));
      }

      // The recovery is successful only when Prime Agent creates a fresh,
      // live dialog UUID. A prompt acknowledgement or idle snapshot is not a
      // substitute for the actual blocking request.
      for (let attempt = 0; attempt < 600; attempt += 1) {
        if (!isCurrentSelection(conversationId, token.generation)) {
          throw new DOMException(planRuntimeText(
            "La récupération a été remplacée par une autre conversation.",
            "Recovery was replaced by another conversation.",
          ), "AbortError");
        }
        const pending = await listPendingExtensionUiRequests(conversationId);
        const freshRequest = findLivePlanRequest(pending, retiredRequestIds);
        if (freshRequest) {
          consumeAgentEventLine(freshRequest);
          return;
        }
        if (attempt > 10 && attempt % 10 === 0) {
          const stateResponse = await sendSelectionRequest(
            conversationId,
            token.generation,
            "get_state",
            true,
          );
          const state = asRecord(stateResponse?.data) as unknown as AgentSessionState | undefined;
          if (state && isAuthoritativeIdleSessionSnapshot(state)) {
            throw new Error(planRuntimeText(
              "Prime Agent a terminé sans recréer le dialogue Plan attendu.",
              "Prime Agent finished without recreating the expected Plan dialog.",
            ));
          }
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, 200));
      }
      throw new Error(planRuntimeText(
        "Prime Agent n’a pas recréé le dialogue Plan dans le délai prévu.",
        "Prime Agent did not recreate the Plan dialog in time.",
      ));
    } catch (error) {
      activePromptRuns.current.delete(conversationId);
      updateConversation(conversationId, { status: "idle" });
      throw error;
    }
  }, [cancelConversationRequests, clearPendingConversationRequest, consumeAgentEventLine, ensureStarted, extensionRequests, isCurrentSelection, refreshPersistedTranscript, selectedConversation, selectedProject, sendConversationRequest, sendSelectionRequest, setRuntimeRefining, updateConversation]);

  const closeRuntime = useCallback(async () => {
    if (!selectedConversation) return;
    intentionallyStopped.current.add(selectedConversation.id);
    try {
      await stopAgent(selectedConversation.id);
    } finally {
      activeAgentLifecycles.current.delete(selectedConversation.id);
      activePromptRuns.current.delete(selectedConversation.id);
      directRefinementActivities.current.delete(selectedConversation.id);
      uncertainRefinementConversations.current.delete(selectedConversation.id);
      setRuntimeRefining(selectedConversation.id, false);
      updateConversation(selectedConversation.id, (conversation) => ({
        ...finalizeConversationTools(conversation, "cancelled", now()),
        status: "idle",
      }));
    }
  }, [selectedConversation, setRuntimeRefining, updateConversation]);

  const chooseModel = useCallback(
    async (model: ModelInfo) => {
      if (!selectedConversation || !selectedProject) return;
      await ensureStarted(selectedConversation, selectedProject);
      await sendRpc(selectedConversation.id, { id: uid("model"), type: "set_model", provider: model.provider, modelId: model.id });
      updateConversation(selectedConversation.id, { model: `${model.provider}/${model.id}` });
    },
    [ensureStarted, selectedConversation, selectedProject, updateConversation],
  );

  const setThinking = useCallback(
    async (level: ThinkingLevel) => {
      if (!selectedConversation || !selectedProject) return;
      await ensureStarted(selectedConversation, selectedProject);
      await sendRpc(selectedConversation.id, { id: uid("thinking"), type: "set_thinking_level", level });
      updateConversation(selectedConversation.id, { thinkingLevel: level });
    },
    [ensureStarted, selectedConversation, selectedProject, updateConversation],
  );

  const runGoalMutation = useCallback(async (
    conversationId: string,
    descriptor: GoalMutationDescriptor,
    fields: Record<string, unknown>,
  ) => {
    if (pendingGoalMutations.current.has(conversationId)) {
      throw new Error("Une modification de l’objectif est déjà en attente pour cette conversation.");
    }

    let resolveGoal!: (goal: GoalState) => void;
    let rejectGoal!: (error: Error) => void;
    const promise = new Promise<GoalState>((resolve, reject) => {
      resolveGoal = resolve;
      rejectGoal = reject;
    });
    // The acknowledgement and the goal event may race. Attach a rejection
    // handler before writing to stdin so an immediate failure stays owned by
    // this command instead of becoming an unhandled promise.
    void promise.catch(() => undefined);
    const pending = {} as PendingGoalMutation;
    const timeout = window.setTimeout(() => {
      if (pendingGoalMutations.current.get(conversationId) !== pending) return;
      rejectGoalMutation(
        conversationId,
        "Prime Agent n’a pas confirmé la modification de l’objectif. Son état reste inchangé dans Prime Orbit ; actualisez l’état avant de réessayer.",
      );
    }, GOAL_MUTATION_LIFECYCLE_TIMEOUT_MS);
    Object.assign(pending, {
      conversationId,
      descriptor,
      settled: false,
      timeout,
      promise,
      resolve: resolveGoal,
      reject: rejectGoal,
    } satisfies PendingGoalMutation);
    pendingGoalMutations.current.set(conversationId, pending);
    setGoalMutationState(conversationId, {
      command: descriptor.command,
      kind: descriptor.kind,
      phase: "sending",
    });

    const acknowledgement = sendConversationRequest(
      conversationId,
      "prompt",
      { ...fields, message: descriptor.command },
      PASSIVE_RESPONSE_TIMEOUT_MS,
      "goal_mutation",
    );
    void acknowledgement.then((response) => {
      const disposition = goalAcknowledgementDisposition({
        isCurrent: pendingGoalMutations.current.get(conversationId) === pending,
        settled: pending.settled,
        success: response.success,
      });
      if (disposition === "ignore") return;
      if (disposition === "reject") {
        rejectGoalMutation(
          conversationId,
          response.error ?? "Prime Agent a refusé la modification de l’objectif.",
        );
        return;
      }
      setGoalMutationState(conversationId, {
        command: descriptor.command,
        kind: descriptor.kind,
        phase: "waiting",
      });
    }).catch((error) => {
      if (pendingGoalMutations.current.get(conversationId) !== pending || pending.settled) return;
      rejectGoalMutation(conversationId, error instanceof Error ? error.message : String(error));
    });

    try {
      await promise;
      const requestedGoalEpoch = goalEpoch.current.get(conversationId) ?? 0;
      const requestedStateEpoch = stateEpoch.current.get(conversationId) ?? 0;
      try {
        const stateResponse = await sendConversationRequest(conversationId, "get_state");
        if (stateResponse.success === false) {
          throw new Error(stateResponse.error ?? "Prime Agent n’a pas renvoyé l’état de l’objectif.");
        }
        if (
          stateResponse.data
          && shouldApplySessionStateResponse(
            requestedStateEpoch,
            stateEpoch.current.get(conversationId) ?? 0,
          )
        ) {
          applySessionStateSnapshot(
            conversationId,
            stateResponse.data as unknown as AgentSessionState,
            requestedGoalEpoch,
          );
        }
      } catch (error) {
        // The matching goal_update already proves the mutation succeeded. A
        // failed verification must remain a warning rather than turn that real
        // success into a fake failure.
        addActivity(conversationId, {
          type: "goal_reconciliation",
          title: "Objectif modifié, resynchronisation différée",
          detail: error instanceof Error ? error.message : String(error),
          status: "warning",
        });
      }
    } finally {
      if (pendingGoalMutations.current.get(conversationId) === pending) {
        pendingGoalMutations.current.delete(conversationId);
        window.clearTimeout(timeout);
        setGoalMutationState(conversationId, undefined);
      }
    }
  }, [addActivity, applySessionStateSnapshot, rejectGoalMutation, sendConversationRequest, setGoalMutationState]);

  const runCommand = useCallback(
    async (type: string, fields: Record<string, unknown> = {}) => {
      if (!selectedConversation || !selectedProject) return;
      if (type === "get_refinements") {
        const token = activeSelection.current;
        await refreshLocalRefinements(selectedConversation.id, token.generation);
        return;
      }
      if (type === "restart_agent") {
        if (!isNative()) throw new Error("Le redémarrage d’urgence est uniquement disponible dans l’application desktop.");
        const conversationId = selectedConversation.id;
        const maintenanceKey = maintenanceEventKey("restart", conversationId);
        const previousEventVersion = maintenanceEventVersions.current.get(maintenanceKey) ?? 0;
        cancelConversationRequests(conversationId, "La connexion Prime Agent redémarre.");
        cancelPersistentConversationRequests(conversationId, "Le redémarrage d’urgence a interrompu l’opération en arrière-plan.");
        rejectGoalMutation(conversationId, "Le redémarrage d’urgence a interrompu la modification de l’objectif.");
        settleCompactionWaiter(conversationId, new Error("Le redémarrage d’urgence a interrompu le compactage."));
        compactingConversations.current.delete(conversationId);
        compactionLifecycleStarted.current.delete(conversationId);
        activeCompactionActivities.current.delete(conversationId);
        recentCompactionEnds.current.delete(conversationId);
        compactionRefreshPending.current.delete(conversationId);
        directRefinementActivities.current.delete(conversationId);
        uncertainRefinementConversations.current.delete(conversationId);
        setRuntimeCompacting(conversationId, false, true);
        setRuntimeRefining(conversationId, false);
        processExitErrors.current.delete(conversationId);
        lastStderr.current.delete(conversationId);
        historyLoaded.current.delete(conversationId);
        bootstrapGeneration.current.delete(conversationId);
        activeAgentLifecycles.current.delete(conversationId);
        activePromptRuns.current.delete(conversationId);
        updateConversation(conversationId, (conversation) => ({
          ...finalizeConversationTools(conversation, "cancelled", now()),
          status: "starting",
          lastError: undefined,
        }));
        try {
          const running = (await listRunningAgents()).some((agent) => agent.conversationId === conversationId);
          let title: string;
          let detail: string;
          if (running) {
            const result = await restartAgent(conversationId);
            if (!result) throw new Error("Prime Agent n’a pas pu être redémarré.");
            started.current.add(conversationId);
            await awaitMaintenanceRefresh(conversationId, "restart", previousEventVersion);
            title = "Connexion Prime Agent redémarrée";
            detail = `Processus ${result.previousPid} remplacé par ${result.agent.pid}`;
          } else {
            // The process may already have crashed and therefore cannot be
            // restarted. Reuse the normal validated launch path instead of
            // reporting a misleading "no active agent" error.
            started.current.delete(conversationId);
            await ensureProcessStarted(selectedConversation, selectedProject);
            await awaitMaintenanceRefresh(conversationId, "restart", previousEventVersion);
            title = "Connexion Prime Agent relancée";
            detail = "Aucun processus actif n’existait ; une nouvelle connexion a été ouverte depuis la session persistante.";
          }
          addActivity(conversationId, { type: "agent_restart", title, detail, status: "success" });
        } catch (error) {
          const message = redactText(error instanceof Error ? error.message : String(error));
          updateConversation(conversationId, { status: "error", lastError: message });
          addActivity(conversationId, {
            type: "agent_restart_error",
            title: "Échec du redémarrage Prime Agent",
            detail: message,
            status: "error",
          });
          throw error;
        }
        return;
      }
      if (type === "reload_resources") {
        if (detection?.mode === "system") {
          throw new Error("Le rechargement desktop des ressources nécessite l’installation source ou gérée de Prime Agent.");
        }
        await ensureStarted(selectedConversation, selectedProject);
        const conversationId = selectedConversation.id;
        const maintenanceKey = maintenanceEventKey("reload", conversationId);
        const previousEventVersion = maintenanceEventVersions.current.get(maintenanceKey) ?? 0;
        const result = await reloadAgentResources(conversationId);
        if (result.status === "busy") {
          const reason = result.reason === "compacting"
            ? "un compactage est en cours"
            : result.reason === "bash"
              ? "une commande système est en cours"
              : result.reason === "session_action"
                ? "une action de session est en cours"
                : "Prime Agent traite encore un message";
          throw new Error(`Les ressources ne peuvent pas être rechargées maintenant : ${reason}. Attendez la fin de l’exécution puis réessayez.`);
        }
        if (result.status === "unavailable") {
          throw new Error("La session Prime Agent active est introuvable. Actualisez l’état ou utilisez le redémarrage d’urgence.");
        }
        if (result.status === "pending") {
          throw new Error("Prime Agent n’a pas confirmé le rechargement dans le délai de sécurité. Son état est inconnu : attendez avant de réessayer, puis utilisez « Actualiser l’état ».");
        }
        if (result.status === "unsupported") {
          throw new Error("Cette installation de Prime Agent n’expose pas encore le rechargement des ressources au mode desktop.");
        }
        await awaitMaintenanceRefresh(conversationId, "reload", previousEventVersion);
        addActivity(conversationId, {
          type: "resource_reload",
          title: "Ressources Prime Agent rechargées",
          detail: "Réglages, skills, extensions, prompts et intégrations MCP ont été relus.",
          status: "success",
        });
        return;
      }
      if (type === "resync_runtime") {
        const conversationId = selectedConversation.id;
        const observed = getConversationRef.current(conversationId) ?? selectedConversation;
        const stalled = stalledRunningActivities(observed.activities, Date.now(), 0).length;
        // Only renderer-owned inference markers are cleared here. Operations
        // that have a real awaiting caller — compaction, refinement, a running
        // bash command — keep their state: discarding them would report an
        // outcome Orbit never observed. Emergency restart remains the escape
        // hatch for those.
        activePromptRuns.current.delete(conversationId);
        activeAgentLifecycles.current.delete(conversationId);
        pendingPromptAdmissions.current.delete(conversationId);
        persistedIdleConversations.current.delete(conversationId);
        cancelTerminalStateReconciliation(conversationId);
        historyLoaded.current.delete(conversationId);
        historyInFlight.current.delete(conversationId);
        bootstrapGeneration.current.delete(conversationId);
        stateEpoch.current.set(conversationId, (stateEpoch.current.get(conversationId) ?? 0) + 1);
        transcriptEpoch.current.set(conversationId, (transcriptEpoch.current.get(conversationId) ?? 0) + 1);
        const divergence = runtimeDivergenceForSnapshot(observed.status, stalled, "resync");
        if (divergence) recordRuntimeDivergence(conversationId, divergence);
        await ensureStarted(selectedConversation, selectedProject);
        const token = activeSelection.current;
        const conversation = getConversationRef.current(conversationId);
        const project = conversation ? getProjectRef.current(conversation.projectId) : undefined;
        if (isNative() && conversation?.sessionPath && project) {
          await loadLocalConversationHistory(conversation, project, token.generation, true)
            .catch(() => undefined);
        }
        addActivity(conversationId, {
          type: "runtime_resync",
          title: "État resynchronisé",
          detail: stalled > 0
            ? `${stalled} ligne(s) d’activité en cours ont été confrontées à l’état réel de Prime Agent.`
            : "L’état et l’historique ont été relus depuis Prime Agent.",
          status: "success",
        });
        return;
      }
      if (type === "get_state" && Object.keys(fields).length === 0) {
        // A manual refresh is itself the bootstrap transaction. Invalidating
        // the successful generation makes ensureStarted await one authoritative
        // state response, including automatic native-client recovery, rather
        // than sending an unacknowledged duplicate afterwards.
        bootstrapGeneration.current.delete(selectedConversation.id);
        await ensureStarted(selectedConversation, selectedProject);
        return;
      }
      await ensureStarted(selectedConversation, selectedProject);
      const goalMutation = type === "prompt" ? goalMutationDescriptor(fields.message) : undefined;
      if (goalMutation) {
        await runGoalMutation(selectedConversation.id, goalMutation, fields);
        return;
      }
      const token = activeSelection.current;
      if (type === "refine") {
        const conversationId = selectedConversation.id;
        if (uncertainRefinementConversations.current.has(conversationId)) {
          throw new Error("L’état du dernier raffinement est encore inconnu. Attendez son événement terminal ou utilisez le redémarrage d’urgence avant de relancer.");
        }
        if (directRefinementActivities.current.has(conversationId)) {
          throw new Error("Un raffinement demandé depuis cette fenêtre est déjà en cours pour cette conversation.");
        }
        const activityId = uid("refinement-request");
        directRefinementActivities.current.set(conversationId, activityId);
        setRuntimeRefining(conversationId, true);
        addActivity(conversationId, {
          id: activityId,
          type: "refine_start",
          title: "Raffinement du contexte en cours",
          detail: "Prime Agent analyse puis met à jour sa mémoire de travail. Cette opération continue si vous changez de conversation.",
          status: "running",
        });
        try {
          const response = await sendConversationRequest(
            conversationId,
            type,
            fields,
            REFINE_RESPONSE_TIMEOUT_MS,
          );
          if (response.success === false) {
            if (isRefineDaemonAcknowledgementTimeout(response)) {
              uncertainRefinementConversations.current.add(conversationId);
              addActivity(conversationId, {
                id: activityId,
                type: "refine_start",
                title: "Raffinement toujours en cours",
                detail: "Le daemon n’a pas confirmé la fin dans son délai, mais cela n’annule pas le travail. N’envoyez pas une deuxième demande ; le résultat apparaîtra à l’événement terminal.",
                status: "warning",
                raw: response,
              });
              return;
            }
            throw new Error(response.error ?? "Prime Agent n’a pas pu raffiner le contexte.");
          }
          const presentation = refinementResultPresentation(response.data);
          setRuntimeRefining(conversationId, false);
          removeActivity(conversationId, activityId);
          addActivity(conversationId, {
            id: presentation.activityId ?? activityId,
            type: "refine_complete",
            title: presentation.title,
            detail: presentation.detail,
            status: "success",
            raw: response,
          });
          const current = activeSelection.current;
          if (current.conversationId === conversationId && isCurrentSelection(conversationId, current.generation)) {
            void sendSelectionRequest(conversationId, current.generation, "get_state").catch(() => undefined);
          }
        } catch (error) {
          const detail = cleanDiagnostic(error instanceof Error ? error.message : String(error))
            ?? "Prime Agent n’a pas pu raffiner le contexte.";
          if (detail.includes("n’a pas répondu à refine dans le délai prévu")) {
            uncertainRefinementConversations.current.add(conversationId);
            addActivity(conversationId, {
              id: activityId,
              type: "refine_start",
              title: "État du raffinement inconnu",
              detail: "Prime Orbit a perdu l’accusé terminal. Le travail peut toujours continuer : n’envoyez pas une seconde demande avant un événement terminal ou un redémarrage d’urgence.",
              status: "warning",
            });
            return;
          }
          addActivity(conversationId, {
            id: activityId,
            type: "refine_failed",
            title: "Échec du raffinement",
            detail,
            status: "error",
          });
          setRuntimeRefining(conversationId, false);
          throw error;
        } finally {
          if (directRefinementActivities.current.get(conversationId) === activityId) {
            directRefinementActivities.current.delete(conversationId);
          }
        }
        return;
      }
      if (type === "compact") {
        const conversationId = selectedConversation.id;
        if (
          pendingCompactions.current.has(conversationId)
          || compactingConversations.current.has(conversationId)
        ) {
          throw new Error("Un compactage du contexte est déjà en cours pour cette conversation.");
        }
        const currentConversation = getConversationRef.current(conversationId) ?? selectedConversation;
        let resolveCompaction!: () => void;
        let rejectCompaction!: (error: Error) => void;
        const promise = new Promise<void>((resolve, reject) => {
          resolveCompaction = resolve;
          rejectCompaction = reject;
        });
        // A compaction_end error can arrive immediately before the compact RPC
        // response. Attach a handler now so that ordering cannot create an
        // unhandled rejection before runCommand awaits the lifecycle promise.
        void promise.catch(() => undefined);
        const activityId = uid("compaction");
        const pending = {} as PendingCompaction;
        const timeout = window.setTimeout(() => {
          if (pendingCompactions.current.get(conversationId) !== pending) return;
          pendingCompactions.current.delete(conversationId);
          addActivity(conversationId, {
            id: activityId,
            type: "compaction_start",
            title: "Compactage toujours en cours",
            detail: "Prime Orbit n’a reçu aucun événement terminal. L’état reste conservé ; utilisez le redémarrage d’urgence uniquement si la session est réellement bloquée.",
            status: "warning",
          });
          rejectCompaction(new Error("Prime Agent n’a pas confirmé la fin du compactage dans le délai de sécurité."));
        }, COMPACTION_LIFECYCLE_TIMEOUT_MS);
        Object.assign(pending, {
          conversationId,
          previousStatus: currentConversation.status,
          started: false,
          timeout,
          promise,
          resolve: resolveCompaction,
          reject: rejectCompaction,
        } satisfies PendingCompaction);
        pendingCompactions.current.set(conversationId, pending);
        compactingConversations.current.add(conversationId);
        activeCompactionActivities.current.set(conversationId, activityId);
        stateEpoch.current.set(conversationId, (stateEpoch.current.get(conversationId) ?? 0) + 1);
        setRuntimeCompacting(conversationId, true);
        updateConversation(conversationId, { status: "tool", lastError: undefined });
        addActivity(conversationId, {
          id: activityId,
          type: "compaction_start",
          title: "Compactage du contexte en cours",
          detail: "Demande envoyée à Prime Agent.",
          status: "running",
        });
        try {
          const responsePromise = sendConversationRequest(
            conversationId,
            type,
            fields,
            COMPACTION_LIFECYCLE_TIMEOUT_MS,
          );
          const first = await Promise.race([
            responsePromise.then((response) => ({ kind: "response" as const, response })),
            promise.then(() => ({ kind: "lifecycle" as const })),
          ]);
          if (first.kind === "lifecycle") return;
          const disposition = compactResponseDisposition(
            first.response,
            Boolean(recentCompactionEnd(conversationId)),
          );
          if (disposition === "failure") {
            throw new Error(first.response.error ?? "Prime Agent n’a pas pu démarrer le compactage du contexte.");
          }
          await promise;
        } catch (error) {
          if (pendingCompactions.current.get(conversationId) === pending) {
            pendingCompactions.current.delete(conversationId);
            window.clearTimeout(timeout);
            if (!compactionLifecycleStarted.current.has(conversationId)) {
              compactingConversations.current.delete(conversationId);
              activeCompactionActivities.current.delete(conversationId);
              setRuntimeCompacting(conversationId, false);
              updateConversation(conversationId, (conversation) => conversation.status === "tool"
                ? { ...conversation, status: pending.previousStatus }
                : conversation);
              addActivity(conversationId, {
                id: activityId,
                type: "compaction_end",
                title: "Compactage non démarré",
                detail: error instanceof Error ? error.message : String(error),
                status: "error",
              });
            }
            rejectCompaction(error instanceof Error ? error : new Error(String(error)));
          }
          throw error;
        }
        return;
      }
      if (type === "export_html") {
        const exportConversationId = selectedConversation.id;
        const exportConversationTitle = selectedConversation.title;
        const reservation = await beginHtmlExport(exportConversationId, exportConversationTitle);
        if (!reservation) return;
        let completed = false;
        try {
          const response = await sendConversationRequest(
            exportConversationId,
            type,
            { ...fields, outputPath: reservation.outputPath },
            HTML_EXPORT_RESPONSE_TIMEOUT_MS,
          );
          if (response.success === false) {
            throw new Error(response.error ?? "Prime Agent n’a pas pu générer l’export HTML.");
          }
          const saved = await completeHtmlExport(reservation.token);
          completed = true;
          addActivity(exportConversationId, {
            type: "export",
            title: "Session exportée",
            detail: saved.path,
            status: "success",
          });
          onNotice?.({
            kind: "html_export",
            status: "success",
            conversationId: exportConversationId,
            conversationTitle: exportConversationTitle,
            path: saved.path,
          });
        } catch (error) {
          const message = redactText(error instanceof Error ? error.message : String(error));
          addActivity(exportConversationId, {
            type: "export",
            title: "Échec de l’export HTML",
            detail: message,
            status: "error",
          });
          onNotice?.({
            kind: "html_export",
            status: "error",
            conversationId: exportConversationId,
            conversationTitle: exportConversationTitle,
            error: message,
          });
          throw error;
        } finally {
          if (!completed) {
            await cancelHtmlExport(reservation.token).catch(() => undefined);
          }
        }
        return;
      }
      if (SELECTION_SCOPED_COMMANDS.has(type) && Object.keys(fields).length === 0) {
        if (type === "get_messages") {
          historyLoaded.current.delete(selectedConversation.id);
          await loadConversationHistory(selectedConversation.id, token.generation);
        } else {
          await sendSelectionRequest(selectedConversation.id, token.generation, type);
        }
        return;
      }
      if (ACKNOWLEDGED_COMMANDS.has(type)) {
        const response = await sendSelectionRequest(selectedConversation.id, token.generation, type, true, fields);
        if (response?.success === false) throw new Error(response.error ?? `La commande ${type} a échoué.`);
        return;
      }
      await sendRpc(selectedConversation.id, { id: uid(type), type, ...fields });
    },
    [addActivity, awaitMaintenanceRefresh, cancelConversationRequests, cancelPersistentConversationRequests, cancelTerminalStateReconciliation, detection?.mode, ensureProcessStarted, ensureStarted, isCurrentSelection, loadConversationHistory, loadLocalConversationHistory, onNotice, recentCompactionEnd, recordRuntimeDivergence, refreshLocalRefinements, rejectGoalMutation, removeActivity, runGoalMutation, selectedConversation, selectedProject, sendConversationRequest, sendSelectionRequest, setRuntimeCompacting, setRuntimeRefining, settleCompactionWaiter, updateConversation],
  );

  const observeSubagent = useCallback(async (activeSessionId?: string) => {
    if (!selectedConversation || !selectedProject) return;
    await ensureStarted(selectedConversation, selectedProject);
    const conversationId = selectedConversation.id;
    const currentRuntime = runtimes[conversationId];
    const currentId = currentRuntime?.observedSubagent?.activeSessionId;
    const token = activeSelection.current;
    if (currentId && currentId !== activeSessionId) {
      const response = await sendSelectionRequest(
        conversationId,
        token.generation,
        "unobserve",
        true,
        { activeSessionId: currentId },
      );
      if (response?.success === false) throw new Error(response.error ?? "Impossible d’arrêter l’observation du sous-agent.");
    }
    if (!activeSessionId || activeSessionId === currentId) {
      setRuntimes((current) => {
        const runtime = current[conversationId];
        if (!runtime) return current;
        return { ...current, [conversationId]: { ...runtime, observedSubagent: undefined } };
      });
      return;
    }
    const response = await sendSelectionRequest(
      conversationId,
      token.generation,
      "observe",
      true,
      { activeSessionId },
    );
    if (response?.success === false) throw new Error(response.error ?? "Impossible d’observer ce sous-agent.");
    const messages = asRecord(response?.data)?.messages;
    const mapped = Array.isArray(messages) ? mapAgentMessages(messages) : [];
    setRuntimes((current) => {
      const runtime = current[conversationId] ?? { models: [], commands: [], logs: [] };
      return {
        ...current,
        [conversationId]: {
          ...runtime,
          observedSubagent: { activeSessionId, messages: mapped },
        },
      };
    });
  }, [ensureStarted, runtimes, selectedConversation, selectedProject, sendSelectionRequest]);

  const renameSession = useCallback(async (name: string) => {
    if (!selectedConversation || !selectedProject) return;
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Le nom de session ne peut pas être vide.");
    updateConversation(selectedConversation.id, { title: trimmed, sessionNameSyncPending: true });
    await ensureStarted(selectedConversation, selectedProject);
    const token = activeSelection.current;
    const response = await sendSelectionRequest(
      selectedConversation.id,
      token.generation,
      "set_session_name",
      true,
      { name: trimmed },
    );
    if (response?.success === false) throw new Error(response.error ?? "Prime Agent a refusé le nom de session.");
  }, [ensureStarted, selectedConversation, selectedProject, sendSelectionRequest, updateConversation]);

  const forkFromMessage = useCallback(async (assistantMessageId: string) => {
    if (!selectedConversation || !selectedProject) return;
    await ensureStarted(selectedConversation, selectedProject);
    const conversation = getConversationRef.current(selectedConversation.id) ?? selectedConversation;
    const token = activeSelection.current;
    const response = await sendSelectionRequest(
      conversation.id,
      token.generation,
      "get_fork_messages",
      true,
    );
    if (response?.success === false) throw new Error(response.error ?? "Impossible de lire les points de branchement.");
    const records = asRecord(response?.data)?.messages;
    const candidates = Array.isArray(records)
      ? records.flatMap((value) => {
          const record = asRecord(value);
          const entryId = textValue(record?.entryId);
          const text = textValue(record?.text);
          return entryId && text ? [{ entryId, text }] : [];
        })
      : [];
    const entryId = selectForkEntryId(conversation.messages, assistantMessageId, candidates);
    if (!entryId) throw new Error("Prime Agent n’a pas trouvé le tour correspondant dans l’arbre de session.");
    const preservedId = preserveSessionReference(conversation.id, `${conversation.title} · origine`);
    if (!preservedId) throw new Error("La session source n’est pas encore persistée ; réessayez après son chargement.");
    try {
      const fork = await sendSelectionRequest(
        conversation.id,
        token.generation,
        "fork",
        true,
        { entryId },
      );
      if (fork?.success === false) throw new Error(fork.error ?? "La création de la branche a échoué.");
      if (asRecord(fork?.data)?.cancelled === true) discardSessionReference(preservedId);
    } catch (error) {
      discardSessionReference(preservedId);
      throw error;
    }
  }, [discardSessionReference, ensureStarted, preserveSessionReference, selectedConversation, selectedProject, sendSelectionRequest]);

  const cloneSession = useCallback(async () => {
    if (!selectedConversation || !selectedProject) return;
    await ensureStarted(selectedConversation, selectedProject);
    const conversation = getConversationRef.current(selectedConversation.id) ?? selectedConversation;
    const token = activeSelection.current;
    const preservedId = preserveSessionReference(conversation.id, `${conversation.title} · origine`);
    if (!preservedId) throw new Error("La session source n’est pas encore persistée ; réessayez après son chargement.");
    try {
      const clone = await sendSelectionRequest(conversation.id, token.generation, "clone", true);
      if (clone?.success === false) throw new Error(clone.error ?? "La duplication de la session a échoué.");
      if (asRecord(clone?.data)?.cancelled === true) discardSessionReference(preservedId);
    } catch (error) {
      discardSessionReference(preservedId);
      throw error;
    }
  }, [discardSessionReference, ensureStarted, preserveSessionReference, selectedConversation, selectedProject, sendSelectionRequest]);

  const answerExtensionRequest = useCallback(async (
    request: PendingExtensionUiRequest,
    response: Record<string, unknown>,
  ) => {
    if (extensionResponsesInFlight.current.has(request.requestKey)) return;
    extensionResponsesInFlight.current.add(request.requestKey);
    const isPlanRequest = isTrustedPlanUiRequest(
      request,
      request.runtimeMode,
    );
    let previousPlanState: PlanModeState | undefined;
    let previousPlanArtifactId: string | undefined;
    let pendingFinalizationInstalled = false;
    let planRequestKind: "question" | "custom" | "review" | undefined;
    let planReviewDecision: PlanReviewDecision | undefined;
    let inlinePlanRevision = false;
    try {
      if (isPlanRequest) {
        const conversation = getConversation(request.conversationId);
        const project = conversation ? getProject(conversation.projectId) : undefined;
        const decoded = decodePlanUiRequestTitle(request.title);
        if (!conversation || !project || !decoded) throw new Error(planRuntimeText(
          "Requête Plan invalide ou conversation indisponible.",
          "Invalid Plan request or unavailable conversation.",
        ));
        previousPlanState = conversationPlanState(conversation);
        planRequestKind = decoded.payload.kind;
        previousPlanArtifactId = conversation.planArtifactId;
        const planToolCallId = planUiToolCallId(request);
        if (!planToolCallId) throw new Error(planRuntimeText(
          "L’identifiant durable du dialogue Plan est invalide.",
          "The durable Plan dialog identifier is invalid.",
        ));
        const planArtifactId = decoded.payload.kind === "review"
          ? decoded.payload.planId
          : conversation.planArtifactId;
        let nextPlanState = previousPlanState;

        if (decoded.payload.kind === "review") {
          let document: PlanDocument | undefined = previousPlanState.document;
          if (!document) {
            const recovered = planDocumentForReview(conversation, decoded.payload.planId, decoded.payload.title);
            if (recovered) {
              const opened = openPlanReview(previousPlanState, { document: recovered });
              if (opened.status === "accepted") {
                nextPlanState = opened.state;
                document = opened.state.document;
              }
            }
          }
          if (!document) throw new Error(planRuntimeText(
            "Le document du plan n’est plus disponible.",
            "The plan document is no longer available.",
          ));
          const value = typeof response.value === "string" ? response.value : undefined;
          const index = value === undefined ? -1 : (request.options ?? []).indexOf(value);
          const inlineRevision = decodePlanInlineRevisionResponse(value, decoded.payload.planId);
          const decision = inlineRevision
            ? "revise"
            : (["apply", "keep", "revise"] as const)[index] as PlanReviewDecision | undefined;
          if (!decision) throw new Error(planRuntimeText("Décision de plan non reconnue.", "Unrecognized plan decision."));
          planReviewDecision = decision;
          inlinePlanRevision = Boolean(inlineRevision);
          const written = decision === "apply" || decision === "keep"
              ? await writePlanDocument({
                conversationId: request.conversationId,
                requestId: request.id,
                projectPath: project.path,
                planId: decoded.payload.planId,
                title: document.name,
                markdown: document.markdown,
                recoveredFromTranscript: false,
              })
            : undefined;
          const decided = decidePlanReview(nextPlanState, { decision });
          if (decided.status === "rejected") throw new Error(planRuntimeText(
            `Décision Plan refusée (${decided.reason}).`,
            `Plan decision rejected (${decided.reason}).`,
          ));
          nextPlanState = decided.state;
          if ((decision === "apply" || decision === "keep") && written) {
            pendingPlanFinalizations.current.set(request.conversationId, {
              decision,
              document,
              relativePath: written.relativePath,
              handoffId: decoded.payload.planId,
              stage: "decisionRecorded",
            });
            pendingFinalizationInstalled = true;
          }
        } else {
          let questionState = previousPlanState;
          if (questionState.phase === "review") {
            const rearmed = rearmPlanModeAfterLostDialog(questionState, "review");
            if (rearmed.status === "accepted") questionState = rearmed.state;
          }
          const restored = restorePlanQuestion(questionState, { request });
          if (restored.status === "rejected") throw new Error(planRuntimeText(
            `Question Plan impossible à restaurer (${restored.reason}).`,
            `Plan question could not be restored (${restored.reason}).`,
          ));
          const answered = answerPlanQuestion(restored.state, {
            requestId: request.id,
            cancelled: response.cancelled === true,
            value: response.value,
          });
          if (answered.status === "rejected") throw new Error(planRuntimeText(
            `Réponse Plan refusée (${answered.reason}).`,
            `Plan answer rejected (${answered.reason}).`,
          ));
          nextPlanState = answered.state;
        }

        updateConversation(request.conversationId, {
          planMode: nextPlanState,
          planArtifactId,
          pendingPlanAction: pendingFinalizationInstalled
            ? pendingPlanFinalizations.current.get(request.conversationId)
            : undefined,
          lastError: undefined,
        });
        if (pendingFinalizationInstalled && !await flushWorkspaceState()) {
          throw new Error(planRuntimeText(
            "La décision du plan n’a pas pu être enregistrée avant sa transmission.",
            "The plan decision could not be saved before it was sent.",
          ));
        }
        await sendRpc(request.conversationId, {
          type: "extension_ui_response",
          id: request.id,
          ...response,
        });
        if (
          planRequestKind
          && !shouldAwaitPlanToolResult(planRequestKind, planReviewDecision, inlinePlanRevision)
        ) {
          // Prime Agent's native Revise path continues the same Plan tool call
          // with a second `ctx.ui.input`. Release the answered select now so
          // that exact next request can become the visible, actionable card.
          // Waiting for the final tool result here would deadlock the UI: the
          // result cannot be persisted until the user answers that input.
          setExtensionRequests((current) => current.filter((item) => item.requestKey !== request.requestKey));
          return;
        }
        const acknowledgement = await waitForPersistedPlanToolResult(
          conversation,
          project,
          planToolCallId,
        );
        if (acknowledgement !== "completed") {
          // Rust has already consumed the one-shot native UUID after writing
          // the response. Never leave a deceptively retryable form behind;
          // the canonical unresolved call drives the explicit recovery card.
          setExtensionRequests((current) => current.filter((item) => item.requestKey !== request.requestKey));
          throw new Error(acknowledgement === "failed"
            ? planRuntimeText(
                "Prime Agent a refusé la réponse au dialogue Plan.",
                "Prime Agent rejected the Plan dialog response.",
              )
            : planRuntimeText(
                "Prime Agent n’a pas confirmé la réponse au dialogue Plan.",
                "Prime Agent did not acknowledge the Plan dialog response.",
              ));
        }
        if (pendingFinalizationInstalled) {
          persistedPlanDecisionResults.current.set(request.conversationId, planToolCallId);
        }
        setExtensionRequests((current) => current.filter((item) => item.requestKey !== request.requestKey));
        refreshPersistedTranscript(request.conversationId, 0);
        return;
      }

      // Generic extension dialogs retain their historical cancel-and-dequeue
      // semantics so a stale third-party modal can never block the queue.
      setExtensionRequests((current) => current.filter((item) => item.requestKey !== request.requestKey));
      await sendRpc(request.conversationId, {
        type: "extension_ui_response",
        id: request.id,
        ...response,
      });
    } catch (error) {
      if (isPlanRequest && previousPlanState) {
        if (pendingFinalizationInstalled) {
          // Writing the attested plan is irreversible. Preserve the recorded
          // decision so background reconciliation can resume safely instead
          // of resurrecting the already-answered review form.
          const pending = pendingPlanFinalizations.current.get(request.conversationId);
          updateConversation(request.conversationId, {
            pendingPlanAction: pending,
            status: "error",
            lastError: error instanceof Error ? error.message : String(error),
          });
          await flushWorkspaceState();
        } else {
          updateConversation(request.conversationId, {
            planMode: previousPlanState,
            planArtifactId: previousPlanArtifactId,
            pendingPlanAction: undefined,
          });
        }
      }
      addActivity(request.conversationId, {
        id: `extension-response:${request.id}`,
        type: "extension_ui_response_error",
        title: planRuntimeText(
          "Réponse à l’extension non transmise",
          "Extension response not sent",
        ),
        detail: error instanceof Error ? error.message : String(error),
        status: "warning",
      });
      if (isPlanRequest) throw error;
    } finally {
      extensionResponsesInFlight.current.delete(request.requestKey);
    }
  }, [addActivity, flushWorkspaceState, getConversation, getProject, refreshPersistedTranscript, updateConversation, waitForPersistedPlanToolResult]);

  const extensionRequest = extensionRequests.find((request) => !isClaimedPlanUiRequest(request));
  const nativePlanExtensionRequest = extensionRequests.find((request) => (
    request.conversationId === selectedConversation?.id
      && isTrustedPlanUiRequest(request, request.runtimeMode)
  ));
  // Only a live request still owned by the native Prime Agent process is
  // actionable. Historical tool calls and cached renderer state may explain
  // why a dialog was lost, but they can never recreate its response UUID.
  const planExtensionRequest = nativePlanExtensionRequest;
  const planReplayConversationId = selectedConversation?.id;
  const planReplayProjectId = selectedProject?.id;
  const planReplayConversationStatus = selectedConversation?.status;
  const planReplayRecoverySummary = selectedConversation
    ? unresolvedPlanDialogSummary(selectedConversation)
    : undefined;
  const planReplayRecoverableKind = selectedConversation
    ? recoverablePlanDialogKind(selectedConversation)
    : undefined;
  const planReplayExpectedToolCallId = planReplayRecoverySummary?.latestToolCallId;
  const planReplayShouldRun = planReplayConversationStatus
    ? shouldReplayNativePlanRequests(planReplayConversationStatus, planReplayRecoverableKind)
    : false;
  const planReplayIdentity = planReplayProbeIdentity(
    planReplayConversationId,
    planReplayProjectId,
    planReplayExpectedToolCallId,
  );
  useEffect(() => {
    const conversationId = planReplayConversationId;
    const projectId = planReplayProjectId;
    if (
      !isNative()
      || !conversationId
      || !projectId
      || !planReplayIdentity
    ) {
      return;
    }
    if (planExtensionRequest || !planReplayShouldRun) {
      setPlanReplayProbeConversationId((current) => (
        current === conversationId ? undefined : current
      ));
      return;
    }
    // Event bridge setup and native runtime discovery are unknown states, not
    // proof that Prime Agent lost the request. Suppress the recovery affordance
    // while either one is still settling.
    setPlanReplayProbeConversationId(conversationId);
    if (!eventsReady) return;

    const generation = activeSelection.current.generation;
    if (!isCurrentSelection(conversationId, generation)) return;
    const probeGeneration = planReplayProbeGeneration.current + 1;
    planReplayProbeGeneration.current = probeGeneration;
    let cancelled = false;
    let absenceEvidence: PlanReplayAbsenceEvidence | undefined;
    let observedRuntimeIdentity: string | undefined;
    let ownershipEstablished = false;
    let nextConflictRefreshAt = 0;
    const waitForNextProbe = (delayMs = PLAN_NATIVE_REPLAY_POLL_INTERVAL_MS) => (
      new Promise<void>((resolve) => window.setTimeout(resolve, delayMs))
    );
    const resetAbsenceEvidence = () => {
      absenceEvidence = updatePlanReplayAbsenceEvidence(
        absenceEvidence,
        { status: "unknown" },
        Date.now(),
      );
    };
    const clearCurrentProbe = () => {
      if (
        cancelled
        || !isCurrentSelection(conversationId, generation)
        || planReplayProbeGeneration.current !== probeGeneration
      ) return;
      setPlanReplayProbeConversationId((current) => (
        current === conversationId ? undefined : current
      ));
    };
    // A renderer refresh can lose React's transient dialog queue while the
    // native RPC client still owns the unanswered requests. Re-read that
    // authoritative queue whenever active Plan work has no visible dialog.
    // JSONL publication and native request caching are independent writes, so
    // stabilize the exact runtime first and require repeated absence from that
    // same pid/start/tool-call generation for the entire replay window.
    void (async () => {
      try {
        for (;;) {
          if (cancelled || !isCurrentSelection(conversationId, generation)) return;
          const currentConversation = getConversationRef.current(conversationId);
          const currentProject = getProjectRef.current(projectId);
          if (!currentConversation || currentConversation.projectId !== projectId || !currentProject) {
            return;
          }

          if (!ownershipEstablished) {
            // Use current refs rather than the render snapshot: transcript and
            // session metadata may legitimately advance while the probe runs.
            await ensureStarted(currentConversation, currentProject);
            if (cancelled || !isCurrentSelection(conversationId, generation)) return;
            ownershipEstablished = true;
          }

          try {
            const runningAgent = (await listRunningAgents()).find(
              (agent) => agent.conversationId === conversationId,
            );
            if (!runningAgent || runningAgent.runtimeMode !== "plan") {
              resetAbsenceEvidence();
              observedRuntimeIdentity = undefined;
              ownershipEstablished = false;
              await waitForNextProbe();
              continue;
            }

            const runtimeIdentity = `${runningAgent.pid}:${runningAgent.startedAt}`;
            if (observedRuntimeIdentity && observedRuntimeIdentity !== runtimeIdentity) {
              resetAbsenceEvidence();
              observedRuntimeIdentity = runtimeIdentity;
              ownershipEstablished = false;
              await waitForNextProbe();
              continue;
            }
            observedRuntimeIdentity = runtimeIdentity;

            if (!planReplayExpectedToolCallId) {
              const matchingRequest = matchingNativePlanRequest(
                await listPendingExtensionUiRequests(conversationId),
                conversationId,
              );
              if (matchingRequest) {
                consumeAgentEventLine(matchingRequest);
                clearCurrentProbe();
                return;
              }
              absenceEvidence = updatePlanReplayAbsenceEvidence(
                absenceEvidence,
                {
                  status: "absent",
                  pid: runningAgent.pid,
                  startedAt: runningAgent.startedAt,
                  toolCallId: "<pending-native-plan-request>",
                },
                Date.now(),
              );
            } else {
              const disposition = await reconcilePlanDialogRecovery({
                conversationId,
                expectedPid: runningAgent.pid,
                expectedStartedAt: runningAgent.startedAt,
                expectedToolCallId: planReplayExpectedToolCallId,
              });
              if (
                disposition.pid !== runningAgent.pid
                || disposition.startedAt !== runningAgent.startedAt
              ) {
                resetAbsenceEvidence();
                ownershipEstablished = false;
                await waitForNextProbe();
                continue;
              }
              if (disposition.status === "replayed") {
                consumeAgentEventLine(disposition.request);
                clearCurrentProbe();
                return;
              }
              if (disposition.status === "conflict") {
                resetAbsenceEvidence();
                const now = Date.now();
                if (now >= nextConflictRefreshAt) {
                  refreshPersistedTranscript(conversationId, 0);
                  nextConflictRefreshAt = now + 500;
                }
                await waitForNextProbe();
                continue;
              }
              absenceEvidence = updatePlanReplayAbsenceEvidence(
                absenceEvidence,
                disposition.status === "absent"
                  ? {
                      status: "absent",
                      pid: disposition.pid,
                      startedAt: disposition.startedAt,
                      toolCallId: planReplayExpectedToolCallId,
                    }
                  : { status: "unknown" },
                Date.now(),
              );
            }

            if (hasAttestedPlanReplayAbsence(absenceEvidence)) {
              clearCurrentProbe();
              return;
            }
            await waitForNextProbe();
          } catch {
            // A failed native read or a temporary ownership transition is not
            // absence. Drop any partial proof and reacquire before retrying.
            resetAbsenceEvidence();
            ownershipEstablished = false;
            await waitForNextProbe(Math.max(400, PLAN_NATIVE_REPLAY_POLL_INTERVAL_MS));
          }
        }
      } catch {
        // ensureStarted owns the normal runtime error surface. Keep this probe
        // unknown: an exception never proves that Prime Agent lost a dialog.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    consumeAgentEventLine,
    ensureStarted,
    eventsReady,
    isCurrentSelection,
    planExtensionRequest?.requestKey,
    planReplayConversationId,
    planReplayIdentity,
    planReplayProjectId,
    planReplayShouldRun,
    refreshPersistedTranscript,
  ]);
  useEffect(() => {
    if (!planExtensionRequest || !selectedConversation) return;
    // Answering a Plan question updates the persisted state before the native
    // response write resolves. Do not reopen that same request during this
    // short await; once it is acknowledged and removed, the next cached
    // question becomes the active request naturally.
    if (extensionResponsesInFlight.current.has(planExtensionRequest.requestKey)) return;
    const decoded = decodePlanUiRequestTitle(planExtensionRequest.title);
    const currentState = conversationPlanState(selectedConversation);
    if (!decoded) return;
    if (decoded.payload.kind !== "review") {
      if (currentState.phase === "question" && currentState.question?.requestId === planExtensionRequest.id) return;
      let reconciledState = currentState;
      if (reconciledState.phase === "review") {
        const rearmed = rearmPlanModeAfterLostDialog(reconciledState, "review");
        if (rearmed.status === "accepted") reconciledState = rearmed.state;
      }
      const opened = restorePlanQuestion(reconciledState, { request: planExtensionRequest });
      if (opened.status !== "accepted" || !opened.changed) return;
      updateConversation(selectedConversation.id, {
        status: "tool",
        planMode: opened.state,
        planArtifactId: selectedConversation.planArtifactId,
      });
      return;
    }
    const document = planDocumentForReview(
      selectedConversation,
      decoded.payload.planId,
      decoded.payload.title,
    );
    if (!document) {
      if (!planReviewDocumentRefreshes.current.has(planExtensionRequest.requestKey)) {
        planReviewDocumentRefreshes.current.add(planExtensionRequest.requestKey);
        const generation = activeSelection.current.generation;
        void refreshPlanReviewDocument(
          selectedConversation.id,
          generation,
          decoded.payload.planId,
          decoded.payload.title,
        ).finally(() => {
          planReviewDocumentRefreshes.current.delete(planExtensionRequest.requestKey);
        });
      }
      return;
    }
    let reconciledState = currentState;
    if (reconciledState.phase === "question") {
      const rearmed = rearmPlanModeAfterLostDialog(reconciledState, "question");
      if (rearmed.status === "accepted") reconciledState = rearmed.state;
    }
    const opened = restorePlanReview(reconciledState, { document });
    if (opened.status !== "accepted" || !opened.changed) return;
    updateConversation(selectedConversation.id, {
      planMode: opened.state,
      planArtifactId: decoded.payload.planId,
    });
  }, [planExtensionRequest, refreshPlanReviewDocument, selectedConversation, updateConversation]);
  useEffect(() => {
    if (planExtensionRequest || !selectedConversation || selectedConversation.messages.length === 0) return;
    if (!["idle", "offline", "error"].includes(selectedConversation.status)) return;
    const currentState = conversationPlanState(selectedConversation);
    if (currentState.phase !== "question" && currentState.phase !== "review") return;
    // Prime Agent's persisted transcript is authoritative. Once it contains
    // the terminal result for the old dialog, a renderer snapshot must not
    // keep presenting that UUID as recoverable work.
    if (unresolvedPlanDialogSummary(selectedConversation).total > 0) return;
    const rearmed = rearmPlanModeAfterLostDialog(currentState, currentState.phase);
    if (rearmed.status !== "accepted" || !rearmed.changed) return;
    updateConversation(selectedConversation.id, {
      planMode: rearmed.state,
      planArtifactId: currentState.phase === "review"
        ? undefined
        : selectedConversation.planArtifactId,
    });
  }, [planExtensionRequest, selectedConversation, updateConversation]);

  const runtime = selectedConversation ? runtimes[selectedConversation.id] : undefined;
  const groupedModels = useMemo(() => {
    const groups = new Map<string, ModelInfo[]>();
    for (const model of runtime?.models ?? []) {
      groups.set(model.provider, [...(groups.get(model.provider) ?? []), model]);
    }
    return groups;
  }, [runtime?.models]);

  return {
    runtime,
    runtimes,
    models: runtime?.models ?? [],
    groupedModels,
    commands: runtime?.commands ?? [],
    stats: runtime?.stats,
    sessionState: runtime?.state,
    goalMutation: runtime?.goalMutation,
    refinements: runtime?.refinements,
    harnessEntries: runtime?.harnessEntries,
    divergences: runtime?.divergences ?? [],
    isCompacting: runtime?.isCompacting ?? runtime?.state?.isCompacting ?? false,
    isRefining: runtime?.isRefining ?? false,
    schedules: runtime?.schedules ?? [],
    heartbeat: runtime?.heartbeat,
    heartbeats: runtime?.heartbeats ?? [],
    subagents: runtime?.subagents ?? [],
    observedSubagent: runtime?.observedSubagent,
    logs: runtime?.logs ?? [],
    extensionRequest,
    extensionRequestCount: extensionRequests.filter((request) => !isClaimedPlanUiRequest(request)).length,
    planExtensionRequest,
    isPlanRequestReplayPending: planReplayProbeConversationId === selectedConversation?.id,
    ensureStarted,
    setConversationRuntimeMode,
    retryPlanFinalization: finalizePendingPlan,
    recoverPlanDialogs,
    sendPrompt,
    retryMessage,
    abort,
    closeRuntime,
    chooseModel,
    setThinking,
    runCommand,
    observeSubagent,
    renameSession,
    forkFromMessage,
    cloneSession,
    answerExtensionRequest,
  };
}

export function selectForkEntryId(
  messages: ChatMessage[],
  assistantMessageId: string,
  candidates: Array<{ entryId: string; text: string }>,
): string | undefined {
  const assistantIndex = messages.findIndex((message) => message.id === assistantMessageId);
  if (assistantIndex < 0) return undefined;
  const users = messages.slice(0, assistantIndex).filter((message) => message.role === "user");
  const source = users.at(-1);
  if (!source) return undefined;
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const sourceText = normalize(source.content);
  const occurrence = users.filter((message) => normalize(message.content) === sourceText).length - 1;
  const exact = candidates.filter((candidate) => (
    normalize(stripPrimeOrbitAttachmentWrapper(candidate.text)) === sourceText
  ));
  return exact[occurrence]?.entryId ?? candidates[users.length - 1]?.entryId;
}

export function handleMessageEvent(
  conversationId: string,
  event: RpcEnvelope,
  updateConversation: (id: string, updater: Partial<Conversation> | ((current: Conversation) => Conversation)) => void,
) {
  const rawMessage = event.message as Record<string, unknown> | undefined;
  const role = String(rawMessage?.role ?? "assistant");
  const extracted = extractMessageText(rawMessage);
  const eventId = String(rawMessage?.id ?? event.messageId ?? "");
  if (role === "user") {
    const messageAttachments = sanitizePrimeOrbitDocumentAttachments(rawMessage?.primeOrbitAttachments);
    const eventDocuments = messageAttachments.length
      ? messageAttachments
      : sanitizePrimeOrbitDocumentAttachments(event.primeOrbitAttachments);
    const eventImages = historicalImageAttachments(rawMessage?.content, eventId || "runtime");
    const eventAttachments = [...eventImages, ...eventDocuments];
    if (
      event.type !== "message_start"
      || isInternalPlanRecoveryPrompt(extracted)
      || isInternalPlanHandoffPrompt(extracted)
      || (!extracted && !eventAttachments.length)
    ) return;
    const timestamp = typeof rawMessage?.timestamp === "number" ? rawMessage.timestamp : undefined;
    const createdAt = timestamp && Number.isFinite(timestamp)
      ? new Date(timestamp).toISOString()
      : now();
    updateConversation(conversationId, (conversation) => applyAuthoritativeUserMessageStart(
      conversation,
      extracted,
      createdAt,
      eventAttachments,
      eventId || undefined,
    ));
    return;
  }
  if (role === "custom") {
    // Durable custom records are emitted at both message_start and message_end.
    // Append only the start and deduplicate on their canonical public id.
    if (event.type !== "message_start") return;
    const parsed = parseAgentMessageNotice(rawMessage) ?? parseRefinementOutcomeNotice(rawMessage);
    if (!parsed) return;
    const message: ChatMessage = {
      id: parsed.notice.kind === "agent_message" ? parsed.notice.messageId : parsed.notice.refinementId,
      role: "system",
      content: parsed.content,
      createdAt: historyTimestamp(rawMessage?.timestamp),
      status: "complete",
      notice: parsed.notice,
    };
    updateConversation(conversationId, (conversation) => {
      const messages = parsed.notice.kind === "agent_message"
        ? appendUniqueAgentMessage(conversation.messages, message)
        : appendUniqueRefinementOutcome(conversation.messages, message);
      return messages === conversation.messages
        ? conversation
        : { ...conversation, hasContent: true, messages };
    });
    return;
  }
  if (role !== "assistant") return;
  const assistantEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
  const isTextDelta = assistantEvent?.type === "text_delta";
  const delta = isTextDelta && typeof assistantEvent.delta === "string" ? assistantEvent.delta : "";
  const assistantCreatedAt = historyTimestamp(rawMessage?.timestamp);
  if (event.type === "message_update" && !isTextDelta) return;
  updateConversation(conversationId, (conversation) => {
    const streamingIndex = [...conversation.messages].reverse().findIndex((item) => item.role === "assistant" && item.status === "streaming");
    let actualIndex = streamingIndex < 0 ? -1 : conversation.messages.length - 1 - streamingIndex;
    const lastIndex = conversation.messages.length - 1;
    const last = conversation.messages[lastIndex];
    if (actualIndex < 0 && last?.role === "assistant" && !last.content.trim() && (last.tools?.length ?? 0) > 0) actualIndex = lastIndex;

    if (event.type === "message_end") {
      if (actualIndex < 0) {
        if (!extracted) return conversation;
        return { ...conversation, hasContent: true, messages: [...conversation.messages, { id: eventId || uid("assistant"), role: "assistant", content: extracted, createdAt: assistantCreatedAt, status: "complete" }] };
      }
      const messages = [...conversation.messages];
      const current = messages[actualIndex]!;
      if (!extracted && (current.tools?.length ?? 0) === 0) {
        messages.splice(actualIndex, 1);
        return { ...conversation, messages };
      }
      messages[actualIndex] = {
        ...current,
        id: eventId || current.id,
        content: extracted || current.content,
        status: "complete",
      };
      return { ...conversation, hasContent: true, messages };
    }

    if (event.type === "message_start") {
      if (!extracted) return conversation;
      if (actualIndex >= 0) {
        const messages = [...conversation.messages];
        messages[actualIndex] = { ...messages[actualIndex]!, id: eventId || messages[actualIndex]!.id, content: extracted, status: "streaming" };
        return { ...conversation, hasContent: true, messages };
      }
      const message: ChatMessage = {
        id: eventId || uid("assistant"),
        role: "assistant",
        content: extracted,
        createdAt: assistantCreatedAt,
        status: "streaming",
      };
      return { ...conversation, hasContent: true, messages: [...conversation.messages, message] };
    }

    if (actualIndex < 0 && !extracted && !delta) return conversation;
    if (actualIndex < 0) {
      return { ...conversation, hasContent: true, messages: [...conversation.messages, { id: eventId || uid("assistant"), role: "assistant", content: extracted || delta, createdAt: assistantCreatedAt, status: "streaming" }] };
    }
    const messages = [...conversation.messages];
    const current = messages[actualIndex]!;
    messages[actualIndex] = {
      ...current,
      id: eventId || current.id,
      content: extracted || `${current.content}${delta}`,
      status: "streaming",
    };
    return { ...conversation, hasContent: true, messages };
  });
}

function handleToolEvent(
  conversationId: string,
  event: RpcEnvelope,
  updateConversation: (id: string, updater: Partial<Conversation> | ((current: Conversation) => Conversation)) => void,
) {
  const eventTime = now();
  updateConversation(conversationId, (conversation) => applyToolEventToConversation(conversation, event, eventTime));
}

type TerminalToolStatus = Extract<ToolActivity["status"], "completed" | "failed" | "cancelled">;

interface ToolLocation {
  messageIndex: number;
  toolIndex: number;
  tool: ToolActivity;
}

interface ReconciledToolEvent {
  messages: ChatMessage[];
  tool: ToolActivity;
}

const isPendingTool = (tool: ToolActivity) => tool.status === "queued" || tool.status === "running";
const isTerminalTool = (tool: ToolActivity) => tool.status === "completed"
  || tool.status === "failed"
  || tool.status === "cancelled";
const normalizedToolName = (value: unknown) => textValue(value)?.toLocaleLowerCase();

function comparableToolInput(value: unknown): string {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function allToolLocations(messages: ChatMessage[]): ToolLocation[] {
  const locations: ToolLocation[] = [];
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const tools = messages[messageIndex]?.tools ?? [];
    for (let toolIndex = tools.length - 1; toolIndex >= 0; toolIndex -= 1) {
      const tool = tools[toolIndex];
      if (tool) locations.push({ messageIndex, toolIndex, tool });
    }
  }
  return locations;
}

function findToolForEvent(messages: ChatMessage[], event: RpcEnvelope): ToolLocation | undefined {
  const locations = allToolLocations(messages);
  const incomingId = textValue(event.toolCallId);
  if (incomingId) {
    const exact = locations.find(({ tool }) => tool.id === incomingId);
    if (exact) return exact;
  }

  const pending = locations.filter(({ tool }) => isPendingTool(tool));
  const incomingName = normalizedToolName(event.toolName);
  if (!incomingName) {
    if (event.type === "tool_execution_start" && incomingId) return undefined;
    return pending.length === 1 ? pending[0] : undefined;
  }
  let candidates = pending.filter(({ tool }) => normalizedToolName(tool.name) === incomingName);

  if (event.args !== undefined && candidates.length > 1) {
    const inputKey = comparableToolInput(event.args);
    const sameInput = candidates.filter(({ tool }) => comparableToolInput(tool.input) === inputKey);
    if (sameInput.length > 0) candidates = sameInput;
  }

  if (event.type === "tool_execution_start") {
    // A distinct upstream id means a distinct call, even for parallel calls to
    // the same tool. Id-less duplicate starts can safely reuse one unambiguous
    // pending card and will subsequently be found by name/input.
    if (incomingId) return undefined;
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  // Updates and ends occasionally arrive without an id (or through adapters
  // that rewrite it). The event stream is ordered, so the latest pending call
  // with the same name/input is the safest deterministic fallback.
  return candidates[0];
}

/**
 * Applies one tool lifecycle event to its original assistant message. This is
 * exported so association and terminal-state rules can be unit-tested without
 * mounting the React hook.
 */
export function reconcileToolEventMessages(
  sourceMessages: ChatMessage[],
  event: RpcEnvelope,
  eventTime = now(),
): ReconciledToolEvent {
  const location = findToolForEvent(sourceMessages, event);
  const previous = location?.tool;
  const incomingId = textValue(event.toolCallId);
  const name = textValue(event.toolName) ?? previous?.name ?? "tool";
  const previousIsTerminal = previous ? isTerminalTool(previous) : false;

  let status: ToolActivity["status"] = previous?.status ?? "running";
  let endedAt = previous?.endedAt;
  let output = previous?.output;
  if (event.type === "tool_execution_end") {
    status = previous?.status === "cancelled"
      ? "cancelled"
      : event.isError === true || previous?.status === "failed" ? "failed" : "completed";
    endedAt = eventTime;
    output = event.result ?? event.partialResult ?? previous?.output;
  } else if (!previousIsTerminal) {
    status = "running";
    endedAt = undefined;
    if (event.type === "tool_execution_update") output = event.partialResult ?? previous?.output;
  }

  const tool: ToolActivity = {
    id: previous?.id ?? incomingId ?? uid("tool"),
    name,
    title: humanizeToolName(name),
    status,
    input: event.args ?? previous?.input,
    output,
    startedAt: previous?.startedAt ?? eventTime,
    endedAt,
  };

  const messages = [...sourceMessages];
  let messageIndex = location?.messageIndex ?? -1;
  let toolIndex = location?.toolIndex ?? -1;
  if (messageIndex < 0) {
    const lastIndex = messages.length - 1;
    if (messages[lastIndex]?.role === "assistant") {
      messageIndex = lastIndex;
    } else {
      messages.push({
        id: uid("assistant"),
        role: "assistant",
        content: "",
        createdAt: eventTime,
        status: event.type === "tool_execution_end" ? "complete" : "streaming",
        tools: [],
      });
      messageIndex = messages.length - 1;
    }
  }

  const assistant = messages[messageIndex]!;
  const tools = [...(assistant.tools ?? [])];
  if (toolIndex >= 0) tools[toolIndex] = tool;
  else tools.push(tool);
  messages[messageIndex] = { ...assistant, tools };
  return { messages, tool };
}

function toolActivityStatus(status: ToolActivity["status"]): ActivityItem["status"] {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "cancelled") return "warning";
  return "running";
}

function toolActivityTitle(tool: ToolActivity): string {
  if (tool.status === "completed") return `${tool.title} terminé`;
  if (tool.status === "failed") return `Échec · ${tool.title}`;
  if (tool.status === "cancelled") return `${tool.title} annulé`;
  return `${tool.title} en cours`;
}

function toolActivityDetail(tool: ToolActivity): string | undefined {
  if (isPendingTool(tool)) return summarizeToolInvocation(tool.name, tool.input);
  return summarizeUnknown(tool.output) ?? summarizeToolInvocation(tool.name, tool.input);
}

function applyToolEventToConversation(conversation: Conversation, event: RpcEnvelope, eventTime: string): Conversation {
  const reconciled = reconcileToolEventMessages(conversation.messages, event, eventTime);
  const rawId = textValue(event.toolCallId);
  const activityId = `tool:${reconciled.tool.id}`;
  let activityIndex = conversation.activities.findIndex((item) => item.id === activityId);
  if (activityIndex < 0 && rawId) {
    activityIndex = conversation.activities.findIndex((item) => item.id === rawId || item.id === `tool:${rawId}`);
  }
  if (activityIndex < 0) {
    for (let index = conversation.activities.length - 1; index >= 0; index -= 1) {
      const activity = conversation.activities[index];
      const raw = asRecord(activity?.raw);
      if (
        activity?.status === "running"
        && activity.type.startsWith("tool_execution")
        && normalizedToolName(raw?.toolName) === normalizedToolName(reconciled.tool.name)
      ) {
        activityIndex = index;
        break;
      }
    }
  }

  const previousActivity = activityIndex >= 0 ? conversation.activities[activityIndex] : undefined;
  const activity: ActivityItem = {
    ...previousActivity,
    id: activityId,
    type: event.type,
    title: toolActivityTitle(reconciled.tool),
    detail: (() => {
      const detail = toolActivityDetail(reconciled.tool);
      return detail ? redactText(detail) : previousActivity?.detail;
    })(),
    status: toolActivityStatus(reconciled.tool.status),
    createdAt: previousActivity?.createdAt ?? reconciled.tool.startedAt,
    updatedAt: eventTime,
    updateCount: (previousActivity?.updateCount ?? 0) + 1,
    raw: redactValue(event),
  };
  const activities = [...conversation.activities];
  if (activityIndex >= 0) activities[activityIndex] = activity;
  else activities.push(activity);

  const hasPendingTools = reconciled.messages.some((message) => message.tools?.some(isPendingTool));
  const status = hasPendingTools
    ? "tool"
    : conversation.status === "tool" ? "streaming" : conversation.status;
  return {
    ...conversation,
    hasContent: true,
    status,
    messages: reconciled.messages,
    activities: activities.slice(-240),
  };
}

/** Finalizes only still-pending tool cards at a confirmed lifecycle boundary. */
export function finalizePendingTools(
  messages: ChatMessage[],
  status: TerminalToolStatus,
  eventTime = now(),
): ChatMessage[] {
  let changed = false;
  const finalized = messages.map((message) => {
    if (!message.tools?.some(isPendingTool)) return message;
    changed = true;
    return {
      ...message,
      tools: message.tools.map((tool) => isPendingTool(tool) ? { ...tool, status, endedAt: eventTime } : tool),
    };
  });
  return changed ? finalized : messages;
}

function finalizeConversationTools(
  conversation: Conversation,
  status: TerminalToolStatus,
  eventTime: string,
): Conversation {
  const messages = finalizePendingTools(conversation.messages, status, eventTime);
  const activityStatus = toolActivityStatus(status);
  const activities = conversation.activities.map((activity) => {
    if (activity.status !== "running" || !activity.type.startsWith("tool_execution")) return activity;
    const raw = asRecord(activity.raw);
    const title = humanizeToolName(textValue(raw?.toolName) ?? activity.title.replace(/ en cours$/u, ""));
    return {
      ...activity,
      title: status === "completed" ? `${title} terminé` : status === "failed" ? `Échec · ${title}` : `${title} annulé`,
      status: activityStatus,
      updatedAt: eventTime,
      updateCount: (activity.updateCount ?? 1) + 1,
    };
  });
  if (messages === conversation.messages && activities.every((activity, index) => activity === conversation.activities[index])) {
    return conversation;
  }
  return { ...conversation, messages, activities };
}

function finalizeTurnTools(conversation: Conversation, event: RpcEnvelope, eventTime: string): Conversation {
  let next = conversation;
  if (Array.isArray(event.toolResults)) {
    for (const value of event.toolResults) {
      const result = asRecord(value);
      if (!result) continue;
      next = applyToolEventToConversation(next, {
        type: "tool_execution_end",
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        result: result.result ?? result.content ?? result,
        isError: result.isError === true,
      }, eventTime);
    }
  }
  const finalized = finalizeConversationTools(next, "completed", eventTime);
  return finalized.status === "tool" ? { ...finalized, status: "streaming" } : finalized;
}

const PRIME_ORBIT_MANIFEST_MAX_ENCODED_CHARS = 87_382;
const PRIME_ORBIT_MANIFEST_MAX_JSON_BYTES = 64 * 1024;
const PRIME_ORBIT_MANIFEST_MAX_DOCUMENTS = 20;
const PRIME_ORBIT_MANIFEST_MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
const PRIME_ORBIT_MANIFEST_MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const PRIME_ORBIT_FRAGMENT_MAX_UTF16 = 16 * 1024 * 1024;
const PRIME_ORBIT_CONTEXT_ID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const PRIME_ORBIT_BOUNDARY_RE = new RegExp(
  `<prime_orbit_ui_boundary v="1" id="(${PRIME_ORBIT_CONTEXT_ID})" visible_utf16="(0|[1-9][0-9]{0,9})"\\/>$`,
  "u",
);

export interface ParsedPrimeOrbitAttachmentContext {
  visibleText: string;
  attachments: Attachment[];
  contextId?: string;
}

function decodeBase64UrlUtf8(encoded: string): string | undefined {
  if (!encoded || encoded.length > PRIME_ORBIT_MANIFEST_MAX_ENCODED_CHARS
    || !/^[A-Za-z0-9_-]+$/u.test(encoded)) return undefined;
  try {
    const standard = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const padded = standard.padEnd(standard.length + ((4 - standard.length % 4) % 4), "=");
    const binary = atob(padded);
    const canonical = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
    if (canonical !== encoded) return undefined;
    if (binary.length > PRIME_ORBIT_MANIFEST_MAX_JSON_BYTES) return undefined;
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function decodePrimeOrbitManifest(encoded: string, contextId: string): Attachment[] | undefined {
  const json = decodeBase64UrlUtf8(encoded);
  if (json === undefined) return undefined;
  try {
    const entries = JSON.parse(json) as unknown;
    if (!Array.isArray(entries) || entries.length === 0
      || entries.length > PRIME_ORBIT_MANIFEST_MAX_DOCUMENTS) return undefined;
    let totalBytes = 0;
    const attachments: Attachment[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = asRecord(entries[index]);
      if (!entry) return undefined;
      const keys = Object.keys(entry).sort();
      if (keys.join("\0") !== ["isImage", "mimeType", "name", "size"].sort().join("\0")) return undefined;
      const { name, mimeType, size, isImage } = entry;
      if (typeof name !== "string" || !name || new TextEncoder().encode(name).length > 2_048
        || /[\\/\u0000-\u001f\u007f]/u.test(name)) return undefined;
      if (typeof mimeType !== "string" || !mimeType || new TextEncoder().encode(mimeType).length > 256
        || /[\u0000-\u001f\u007f]/u.test(mimeType)) return undefined;
      if (!Number.isSafeInteger(size) || Number(size) < 0
        || Number(size) > PRIME_ORBIT_MANIFEST_MAX_DOCUMENT_BYTES || isImage !== false) return undefined;
      totalBytes += Number(size);
      if (totalBytes > PRIME_ORBIT_MANIFEST_MAX_TOTAL_BYTES) return undefined;
      attachments.push({
        id: `orbit-attachment:${contextId}:${index}`,
        name,
        mimeType,
        size: Number(size),
        isImage: false,
      });
    }
    return attachments;
  } catch {
    return undefined;
  }
}

function escapePrimeOrbitFileName(name: string) {
  return name
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Validates the native fragments without interpreting their content. The
 * UTF-16 length lets us skip arbitrary inline text (including tag-shaped text)
 * while still requiring an exact one-to-one manifest match. */
function primeOrbitFragmentsMatchManifest(fragments: string, attachments: Attachment[]) {
  let cursor = 0;
  for (let index = 0; index < attachments.length; index += 1) {
    if (index > 0) {
      if (fragments[cursor] !== "\n") return false;
      cursor += 1;
    }
    const opener = `<file name="${escapePrimeOrbitFileName(attachments[index].name)}" content_utf16="`;
    if (!fragments.startsWith(opener, cursor)) return false;
    const encodedLengthStart = cursor + opener.length;
    const encodedLengthEnd = fragments.indexOf('\">\n', encodedLengthStart);
    if (encodedLengthEnd < encodedLengthStart) return false;
    const encodedLength = fragments.slice(encodedLengthStart, encodedLengthEnd);
    if (!/^(0|[1-9][0-9]*)$/u.test(encodedLength)) return false;
    const contentUtf16 = Number(encodedLength);
    if (!Number.isSafeInteger(contentUtf16) || contentUtf16 > PRIME_ORBIT_FRAGMENT_MAX_UTF16) return false;
    const bodyStart = encodedLengthEnd + 3;
    const bodyEnd = bodyStart + contentUtf16;
    if (bodyEnd > fragments.length || fragments.slice(bodyEnd, bodyEnd + 8) !== "\n</file>") return false;
    cursor = bodyEnd + 8;
  }
  return cursor === fragments.length;
}

/** Parses only a complete, native-generated trailing context. The boundary's
 * UTF-16 length selects the visible prefix exactly, so prompt text containing
 * similar tags is never searched, trimmed, or normalized. */
export function parsePrimeOrbitAttachmentContext(content: string): ParsedPrimeOrbitAttachmentContext {
  const fallback = { visibleText: content, attachments: [] };
  const boundary = PRIME_ORBIT_BOUNDARY_RE.exec(content);
  if (!boundary || boundary.index === undefined) return fallback;
  const contextId = boundary[1];
  const visibleUtf16 = Number(boundary[2]);
  if (!contextId || !Number.isSafeInteger(visibleUtf16) || visibleUtf16 < 0 || visibleUtf16 > content.length) return fallback;
  const contextStart = visibleUtf16 === 0 ? 0 : visibleUtf16 + 2;
  if (visibleUtf16 > 0 && content.slice(visibleUtf16, contextStart) !== "\n\n") return fallback;
  const context = content.slice(contextStart, boundary.index);
  const open = `<prime_orbit_attachment_context v="1" id="${contextId}">\n<prime_orbit_manifest encoding="base64url">`;
  const manifestClose = "</prime_orbit_manifest>\n";
  const contextClose = "\n</prime_orbit_attachment_context>\n";
  if (!context.startsWith(open) || !context.endsWith(contextClose)) return fallback;
  const encodedStart = open.length;
  const encodedEnd = context.indexOf(manifestClose, encodedStart);
  if (encodedEnd < encodedStart) return fallback;
  const fragments = context.slice(encodedEnd + manifestClose.length, -contextClose.length);
  const attachments = decodePrimeOrbitManifest(context.slice(encodedStart, encodedEnd), contextId);
  if (!attachments || !primeOrbitFragmentsMatchManifest(fragments, attachments)) return fallback;
  return { visibleText: content.slice(0, visibleUtf16), attachments, contextId };
}

export function stripPrimeOrbitAttachmentWrapper(content: string) {
  return parsePrimeOrbitAttachmentContext(content).visibleText;
}

const PRIME_ORBIT_ATTACHMENT_ID_RE = new RegExp(
  `^orbit-attachment:(${PRIME_ORBIT_CONTEXT_ID}):(0|[1-9][0-9]*)$`,
  "u",
);

/** Accepts only the capability-free document metadata emitted by the native
 * sanitizer. Rebuilding each object ensures unrecognized fields such as a
 * staging path, attachment handle, or inline bytes cannot cross into state. */
export function sanitizePrimeOrbitDocumentAttachments(value: unknown): Attachment[] {
  if (!Array.isArray(value) || value.length > PRIME_ORBIT_MANIFEST_MAX_DOCUMENTS) return [];
  const attachments: Attachment[] = [];
  let totalBytes = 0;
  for (const candidate of value) {
    const record = asRecord(candidate);
    if (!record) return [];
    const keys = Object.keys(record).sort();
    if (keys.join("\0") !== ["id", "isImage", "mimeType", "name", "size"].sort().join("\0")) return [];
    const { id, name, mimeType, size, isImage } = record;
    if (typeof id !== "string" || !PRIME_ORBIT_ATTACHMENT_ID_RE.test(id)
      || typeof name !== "string" || !name || name.length > 2_048
      || /[\u0000-\u001f\u007f]/u.test(name)
      || typeof mimeType !== "string" || mimeType.length > 256
      || /[\u0000-\u001f\u007f]/u.test(mimeType)
      || !Number.isSafeInteger(size) || Number(size) < 0
      || Number(size) > PRIME_ORBIT_MANIFEST_MAX_DOCUMENT_BYTES
      || isImage !== false) return [];
    totalBytes += Number(size);
    if (totalBytes > PRIME_ORBIT_MANIFEST_MAX_TOTAL_BYTES) return [];
    attachments.push({ id, name, mimeType, size: Number(size), isImage: false });
  }
  return attachments;
}

function sanitizeRuntimeImageAttachments(value: unknown): Attachment[] {
  if (!Array.isArray(value) || value.length > PRIME_ORBIT_MANIFEST_MAX_DOCUMENTS) return [];
  const attachments: Attachment[] = [];
  let totalBytes = 0;
  for (const candidate of value) {
    const record = asRecord(candidate);
    if (!record) return [];
    const allowedKeys = ["id", "isImage", "mimeType", "name", "previewDataUrl", "size"];
    if (Object.keys(record).some((key) => !allowedKeys.includes(key))) return [];
    const { id, name, mimeType, size, isImage, previewDataUrl } = record;
    if (typeof id !== "string" || !id || id.length > 256
      || /[\u0000-\u001f\u007f]/u.test(id)
      || typeof name !== "string" || !name || name.length > 2_048
      || /[\u0000-\u001f\u007f]/u.test(name)
      || typeof mimeType !== "string"
      || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mimeType.toLowerCase())
      || !Number.isSafeInteger(size) || Number(size) < 0 || Number(size) > 8 * 1024 * 1024
      || isImage !== true
      || (previewDataUrl !== undefined && (
        typeof previewDataUrl !== "string"
        || previewDataUrl.length > 512 * 1024
        || !/^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/iu.test(previewDataUrl)
      ))) return [];
    totalBytes += Number(size);
    if (totalBytes > 10 * 1024 * 1024) return [];
    attachments.push({
      id,
      name,
      mimeType,
      size: Number(size),
      isImage: true,
      ...(typeof previewDataUrl === "string" ? { previewDataUrl } : {}),
    });
  }
  return attachments;
}

function sanitizeAuthoritativeAttachments(value: unknown): Attachment[] {
  if (!Array.isArray(value) || value.length > PRIME_ORBIT_MANIFEST_MAX_DOCUMENTS) return [];
  const documentsInput = value.filter((candidate) => asRecord(candidate)?.isImage === false);
  const imagesInput = value.filter((candidate) => asRecord(candidate)?.isImage === true);
  const documents = sanitizePrimeOrbitDocumentAttachments(documentsInput);
  const images = sanitizeRuntimeImageAttachments(imagesInput);
  return documents.length + images.length === value.length ? [...images, ...documents] : [];
}

/** Keeps Prime Agent's queue shape while ensuring hydrated attachment
 * contents and native staging paths never enter renderer state or matching. */
export function normalizePrimeOrbitSessionActions(
  actions: AgentSessionState["sessionActions"] | undefined,
): AgentSessionState["sessionActions"] {
  if (!actions) return { queuedCount: 0, steering: [], followUps: [] };
  const steeringContexts = Array.isArray(actions.steering)
    ? actions.steering.map((text) => parsePrimeOrbitAttachmentContext(String(text)))
    : [];
  const followUpContexts = Array.isArray(actions.followUps)
    ? actions.followUps.map((text) => parsePrimeOrbitAttachmentContext(String(text)))
    : [];
  const activeContext = typeof actions.active?.label === "string"
    ? parsePrimeOrbitAttachmentContext(actions.active.label)
    : undefined;
  const nativeSteeringAttachments = Array.isArray(actions.queueAttachments?.steering)
    ? actions.queueAttachments.steering.map(sanitizePrimeOrbitDocumentAttachments)
    : [];
  const nativeFollowUpAttachments = Array.isArray(actions.queueAttachments?.followUps)
    ? actions.queueAttachments.followUps.map(sanitizePrimeOrbitDocumentAttachments)
    : [];
  const nativeActiveAttachments = sanitizePrimeOrbitDocumentAttachments(actions.queueAttachments?.active);
  const steering = steeringContexts.map((context) => context.visibleText);
  const followUps = followUpContexts.map((context) => context.visibleText);
  const active = actions.active
    ? {
      ...actions.active,
      ...(activeContext ? { label: activeContext.visibleText } : {}),
    }
    : undefined;
  return {
    ...actions,
    steering,
    followUps,
    queueAttachments: {
      steering: steeringContexts.map((context, index) => (
        nativeSteeringAttachments[index]?.length
          ? nativeSteeringAttachments[index]!
          : context.attachments
      )),
      followUps: followUpContexts.map((context, index) => (
        nativeFollowUpAttachments[index]?.length
          ? nativeFollowUpAttachments[index]!
          : context.attachments
      )),
      ...(nativeActiveAttachments.length
        ? { active: nativeActiveAttachments }
        : activeContext?.attachments.length
          ? { active: activeContext.attachments }
          : {}),
    },
    ...(active ? { active } : {}),
  };
}

export function mapAgentMessages(messages: unknown[]): ChatMessage[] {
  const mapped: ChatMessage[] = [];
  const toolLocations = new Map<string, { messageIndex: number; toolIndex: number }>();
  const agentMessageIds = new Set<string>();
  const refinementOutcomeIds = new Set<string>();

  for (let index = 0; index < messages.length; index += 1) {
    const message = asRecord(messages[index]);
    if (!message) continue;
    const role = String(message.role ?? "");
    const createdAt = historyTimestamp(message.timestamp);

    if (role === "toolResult") {
      const toolCallId = textValue(message.toolCallId);
      const location = toolCallId ? toolLocations.get(toolCallId) : undefined;
      if (!location) continue;
      const owner = mapped[location.messageIndex];
      const previous = owner?.tools?.[location.toolIndex];
      if (!owner || !previous) continue;
      const tools = [...(owner.tools ?? [])];
      tools[location.toolIndex] = {
        ...previous,
        status: message.isError === true ? "failed" : "completed",
        output: truncateHistoricalPayload(extractMessageText(message) || message.details),
        endedAt: createdAt,
      };
      mapped[location.messageIndex] = { ...owner, tools };
      continue;
    }

    if (role === "assistant") {
      const blocks = Array.isArray(message.content)
        ? message.content.filter((block): block is Record<string, unknown> => Boolean(block && typeof block === "object"))
        : [];
      const tools = blocks.flatMap((block): ToolActivity[] => {
        if (block.type !== "toolCall") return [];
        const id = textValue(block.id) ?? `history-tool-${index}-${crypto.randomUUID()}`;
        const name = textValue(block.name) ?? "tool";
        return [{
          id,
          name,
          title: humanizeToolName(name),
          // A saved toolCall without its matching toolResult proves neither
          // cancellation nor completion. Live lifecycle events may still be
          // pending (notably extension UI questions), so keep it neutral.
          status: "unresolved",
          input: historicalToolInput(name, block.arguments),
          startedAt: createdAt,
        }];
      });
      const content = extractMessageText(message);
      if (!content && tools.length === 0) continue;
      const usage = asRecord(message.usage);
      const chatMessage: ChatMessage = {
        id: String(message.id ?? `history-${index}`),
        role: "assistant",
        content,
        createdAt,
        status: "complete",
        model: textValue(message.model),
        usage: usage ? {
          input: numberValue(usage.input),
          output: numberValue(usage.output),
          cacheRead: numberValue(usage.cacheRead),
          total: numberValue(usage.totalTokens) ?? numberValue(usage.total),
        } : undefined,
        tools: tools.length ? tools : undefined,
      };
      const messageIndex = mapped.push(chatMessage) - 1;
      tools.forEach((tool, toolIndex) => toolLocations.set(tool.id, { messageIndex, toolIndex }));
      continue;
    }

    if (role === "user" || role === "system") {
      const extracted = extractMessageText(message);
      if (role === "user" && isInternalPlanRecoveryPrompt(extracted)) continue;
      const internalPlanHandoff = role === "user" && isInternalPlanHandoffPrompt(extracted);
      const parsedContext = role === "user"
        ? parsePrimeOrbitAttachmentContext(extracted)
        : { visibleText: extracted, attachments: [] };
      const structuredAttachments = role === "user"
        ? sanitizePrimeOrbitDocumentAttachments(message.primeOrbitAttachments)
        : [];
      const attachments = [
        ...historicalImageAttachments(message.content, index),
        ...(structuredAttachments.length ? structuredAttachments : parsedContext.attachments),
      ];
      const content = role === "user"
        ? parsedContext.visibleText
          || (containsImageContent(message.content) ? "Image jointe" : attachments.length ? "Fichier joint" : "")
        : extracted || (containsImageContent(message.content) ? "Image jointe" : "");
      if (!content) continue;
      mapped.push({
        id: String(message.id ?? `history-${index}`),
        role,
        content: internalPlanHandoff
          ? extracted.slice(0, extracted.indexOf("\n") >= 0 ? extracted.indexOf("\n") : undefined)
          : content,
        createdAt,
        status: "complete",
        attachments: attachments.length ? attachments : undefined,
        ...(internalPlanHandoff ? { internal: "plan_handoff" as const } : {}),
      });
      continue;
    }

    // Prime Agent keeps summaries and selected displayable custom messages in
    // the saved session. Keeping them avoids showing an apparently empty
    // transcript after compaction.
    if (role === "compactionSummary" || role === "branchSummary") {
      const content = textValue(message.summary);
      if (content) mapped.push({ id: `history-${index}`, role: "system", content, createdAt, status: "complete" });
      continue;
    }
    if (role === "custom" && message.display === true) {
      const agentMessage = parseAgentMessageNotice(message);
      if (agentMessage) {
        if (agentMessageIds.has(agentMessage.notice.messageId)) continue;
        agentMessageIds.add(agentMessage.notice.messageId);
        mapped.push({
          id: String(message.id ?? agentMessage.notice.messageId),
          role: "system",
          content: agentMessage.content,
          createdAt,
          status: "complete",
          notice: agentMessage.notice,
        });
        continue;
      }
      const refinementOutcome = parseRefinementOutcomeNotice(message);
      if (refinementOutcome) {
        if (refinementOutcomeIds.has(refinementOutcome.notice.refinementId)) continue;
        refinementOutcomeIds.add(refinementOutcome.notice.refinementId);
        mapped.push({
          id: String(message.id ?? refinementOutcome.notice.refinementId),
          role: "system",
          content: refinementOutcome.content,
          createdAt,
          status: "complete",
          notice: refinementOutcome.notice,
        });
        continue;
      }
      // Prime Agent persists injected context such as the IPython restore
      // envelope as a displayable custom message so it can be supplied to the
      // model on the next turn. Its terminal renderer intentionally shows only
      // a compact status label and never the raw XML-like prompt or restored
      // variable names. Orbit has no actionable UI for this internal event, so
      // keep it out of the chat transcript instead of presenting it as an
      // assistant answer. The role/type checks are important: identical text
      // typed by a user or returned by an assistant remains visible.
      if (isInternalCustomMessage(message)) continue;
      const content = extractMessageText(message);
      if (content) mapped.push({ id: `history-${index}`, role: "system", content, createdAt, status: "complete" });
      continue;
    }
    if (role === "bashExecution") {
      const output = textValue(message.output);
      const cancelled = message.cancelled === true;
      const exitCode = numberValue(message.exitCode);
      const failed = !cancelled && exitCode !== undefined && exitCode !== 0;
      mapped.push({
        id: `history-${index}`,
        role: "assistant",
        content: "",
        createdAt,
        status: "complete",
        tools: [{
          id: `history-bash-${index}`,
          name: "bash",
          title: humanizeToolName("bash"),
          status: cancelled ? "cancelled" : failed ? "failed" : "completed",
          input: truncateHistoricalPayload(message.command),
          output: truncateHistoricalPayload(output),
          startedAt: createdAt,
          endedAt: createdAt,
        }],
      });
    }
  }
  return mapped;
}

const HIDDEN_INTERNAL_CUSTOM_TYPES = new Set(["ipython_state_restored"]);

/**
 * Some read-only histories predate preservation of `customType` in the native
 * sanitizer. Recognize the legacy payload only when it is the complete content
 * of a custom message; never scan or strip arbitrary user/assistant text.
 */
export function isInternalCustomMessage(message: Record<string, unknown>): boolean {
  if (String(message.role ?? "") !== "custom") return false;
  const customType = textValue(message.customType);
  if (customType && HIDDEN_INTERNAL_CUSTOM_TYPES.has(customType)) return true;
  const content = extractMessageText(message).trim();
  return /^<ipython_state_restored>\s*[\s\S]*?\s*<\/ipython_state_restored>$/u.test(content);
}

function historicalImageAttachments(value: unknown, messageIndex: number | string): Attachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((block, blockIndex): Attachment[] => {
    const record = asRecord(block);
    if (!record || !["image", "image_url"].includes(String(record.type))) return [];
    const mimeType = textValue(record.mimeType) ?? "image/png";
    const previewDataUrl = textValue(record.previewDataUrl);
    const size = numberValue(record.size) ?? 0;
    return [{
      id: `history-image-${messageIndex}-${blockIndex}`,
      name: `image-${blockIndex + 1}.${mimeType.split("/")[1] ?? "png"}`,
      mimeType,
      size,
      isImage: true,
      ...(previewDataUrl ? { previewDataUrl } : {}),
    }];
  });
}

export function mergeHistoricalAttachmentPreviews(next: ChatMessage[], previous: ChatMessage[]): ChatMessage[] {
  const previousUsers = previous.filter((message) => message.role === "user" && message.attachments?.length);
  const usedPrevious = new Set<number>();
  return next.map((message) => {
    if (message.role !== "user" || !message.attachments?.length) return message;
    const normalizedContent = normalizeQueuedText(message.content);
    let previousIndex = previousUsers.findIndex((candidate, index) => (
      !usedPrevious.has(index) && candidate.id === message.id
    ));
    if (previousIndex < 0 && normalizedContent) {
      const messageTime = Date.parse(message.createdAt);
      const candidates = previousUsers
        .map((candidate, index) => ({
          candidate,
          index,
          distance: Number.isFinite(messageTime) && Number.isFinite(Date.parse(candidate.createdAt))
            ? Math.abs(messageTime - Date.parse(candidate.createdAt))
            : Number.POSITIVE_INFINITY,
        }))
        .filter(({ candidate, index }) => !usedPrevious.has(index)
          && normalizeQueuedText(candidate.content) === normalizedContent)
        .sort((left, right) => left.distance - right.distance);
      // History and the optimistic turn normally share a timestamp within a
      // few seconds. A bound prevents compaction/reordering from transferring
      // a thumbnail between old duplicate prompts.
      if ((candidates[0]?.distance ?? Number.POSITIVE_INFINITY) <= 5 * 60_000) {
        previousIndex = candidates[0]!.index;
      }
    }
    const old = previousIndex >= 0 ? previousUsers[previousIndex] : undefined;
    if (!old?.attachments?.length) {
      return { ...message, attachments: message.attachments.map(durableAttachmentMetadata) };
    }
    usedPrevious.add(previousIndex);
    const oldAttachments = old.attachments.map(durableAttachmentMetadata);
    const used = new Set<number>();
    const attachments = message.attachments.map((attachment) => {
      const durable = durableAttachmentMetadata(attachment);
      let matchIndex = oldAttachments.findIndex((candidate, index) => !used.has(index)
        && candidate.isImage === durable.isImage
        && candidate.name === durable.name
        && candidate.mimeType === durable.mimeType);
      if (matchIndex < 0 && durable.isImage) {
        matchIndex = oldAttachments.findIndex((candidate, index) => !used.has(index)
          && candidate.isImage === durable.isImage);
      }
      if (matchIndex < 0) return durable;
      used.add(matchIndex);
      const prior = oldAttachments[matchIndex]!;
      return {
        ...durable,
        // Prime Agent's historical image blocks use generated names and do
        // not retain byte size. Prefer the local bounded display metadata.
        ...(durable.isImage && prior.name ? { name: prior.name } : {}),
        ...(durable.isImage && prior.size ? { size: prior.size } : {}),
        ...(prior.previewDataUrl ? { previewDataUrl: prior.previewDataUrl } : {}),
      };
    });
    return { ...message, attachments };
  });
}

const PRIME_AGENT_PROJECTION_MATCH_WINDOW_MS = 15_000;

function projectionTimestamp(message: ChatMessage): number {
  const timestamp = Date.parse(message.createdAt);
  return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
}

function primeAgentProjectionShape(message: ChatMessage): string | undefined {
  if (message.role === "system") return undefined;
  const tools = (message.tools ?? []).map((tool) => tool.id).sort();
  const attachments = (message.attachments ?? []).map((attachment) => (
    `${attachment.isImage ? "image" : "document"}:${attachment.mimeType}`
  ));
  return JSON.stringify([message.role, message.content.trim(), tools, attachments]);
}

/** Live events and get_messages are two Prime Agent projections of the same
 * durable record, but get_messages does not always retain the session-tree id.
 * Match only exact Prime Agent fields, within a tight timestamp window. */
function equivalentPrimeAgentProjection(left: ChatMessage, right: ChatMessage): boolean {
  const leftShape = primeAgentProjectionShape(left);
  if (!leftShape || leftShape !== primeAgentProjectionShape(right)) return false;
  const leftTime = projectionTimestamp(left);
  const rightTime = projectionTimestamp(right);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return false;
  return Math.abs(leftTime - rightTime) <= PRIME_AGENT_PROJECTION_MATCH_WINDOW_MS;
}

/** An empty daemon projection is not evidence that a persisted transcript was
 * deleted. Preserve already rendered Prime Agent messages until a non-empty
 * authoritative projection arrives. */
export function reconcileRpcTranscript(
  current: ChatMessage[],
  rpc: ChatMessage[],
): ChatMessage[] {
  const durableCurrent = stripLegacyOrbitQueueMessages(current);
  if (rpc.length === 0) return durableCurrent;
  const incoming = mergeHistoricalAttachmentPreviews(rpc, durableCurrent);
  if (durableCurrent.length === 0) return incoming;

  const messageKeys = (message: ChatMessage) => [message.entryId, message.id]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  const incomingByKey = new Map<string, number>();
  incoming.forEach((message, index) => {
    for (const key of messageKeys(message)) incomingByKey.set(key, index);
  });
  const matched = new Map<number, number>();
  const currentExactMatches = durableCurrent.map((message) => messageKeys(message)
    .map((key) => incomingByKey.get(key))
    .find((index): index is number => index !== undefined));

  // Pair remaining event/history projections globally by closest authoritative
  // timestamp. This preserves legitimate repeated messages while collapsing
  // the same Prime Agent record when the RPC projection has no tree id.
  const projectionCandidates: Array<{ currentIndex: number; incomingIndex: number; distance: number }> = [];
  const incomingProjectionBuckets = new Map<string, number[]>();
  incoming.forEach((message, incomingIndex) => {
    const shape = primeAgentProjectionShape(message);
    if (!shape) return;
    const bucket = incomingProjectionBuckets.get(shape) ?? [];
    bucket.push(incomingIndex);
    incomingProjectionBuckets.set(shape, bucket);
  });
  durableCurrent.forEach((message, currentIndex) => {
    if (currentExactMatches[currentIndex] !== undefined) return;
    const shape = primeAgentProjectionShape(message);
    if (!shape) return;
    (incomingProjectionBuckets.get(shape) ?? []).forEach((incomingIndex) => {
      const candidate = incoming[incomingIndex]!;
      if (!equivalentPrimeAgentProjection(message, candidate)) return;
      projectionCandidates.push({
        currentIndex,
        incomingIndex,
        distance: Math.abs(projectionTimestamp(message) - projectionTimestamp(candidate)),
      });
    });
  });
  projectionCandidates
    .sort((left, right) => left.distance - right.distance
      || left.currentIndex - right.currentIndex
      || left.incomingIndex - right.incomingIndex);
  const semanticallyMatchedIncoming = new Set<number>();
  projectionCandidates
    .forEach(({ currentIndex, incomingIndex }) => {
      if (matched.has(currentIndex) || semanticallyMatchedIncoming.has(incomingIndex)) return;
      matched.set(currentIndex, incomingIndex);
      semanticallyMatchedIncoming.add(incomingIndex);
    });
  // A previously merged history copy can share an incoming id with the native
  // event projection paired above. Map both to the same authoritative record;
  // the emission pass below renders that record exactly once.
  currentExactMatches.forEach((incomingIndex, currentIndex) => {
    if (incomingIndex !== undefined) matched.set(currentIndex, incomingIndex);
  });

  const emittedIncoming = new Set<number>();
  const merged = durableCurrent.flatMap((message, index) => {
    const match = matched.get(index);
    if (match === undefined) return [message];
    if (emittedIncoming.has(match)) return [];
    emittedIncoming.add(match);
    return [incoming[match]!];
  });
  incoming.forEach((message, index) => {
    if (!emittedIncoming.has(index)) merged.push(message);
  });

  // Both projections are chronological. A stable timestamp sort inserts
  // newly discovered history without reordering equal-time live events.
  return merged
    .map((message, index) => ({ message, index, time: Date.parse(message.createdAt) }))
    .sort((left, right) => {
      const leftTime = Number.isFinite(left.time) ? left.time : Number.MAX_SAFE_INTEGER;
      const rightTime = Number.isFinite(right.time) ? right.time : Number.MAX_SAFE_INTEGER;
      return leftTime - rightTime || left.index - right.index;
    })
    .map(({ message }) => message);
}

/** If an empty RPC response won the initial race, let the validated session
 * file reconcile onto the same Prime Agent transcript without erasing newer
 * authoritative turns that have not been flushed yet. */
export function reconcileLocalTranscriptAfterRpc(
  current: ChatMessage[],
  local: ChatMessage[],
): ChatMessage[] {
  const durableCurrent = stripLegacyOrbitQueueMessages(current);
  const durableLocal = stripLegacyOrbitQueueMessages(local);
  if (durableLocal.length === 0) return durableCurrent;
  return reconcileRpcTranscript(durableCurrent, durableLocal);
}

function historyTimestamp(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return now();
}

function containsImageContent(value: unknown) {
  return Array.isArray(value) && value.some((block) => asRecord(block)?.type === "image");
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const MAX_HISTORICAL_PAYLOAD_CHARS = 16_000;

export function historicalToolInput(toolName: string, value: unknown): unknown {
  if (toolName === "prime_orbit_plan_submit") {
    const input = asRecord(value);
    const document = normalizePlanDocument({
      name: textValue(input?.title) ?? "Plan",
      markdown: input?.document,
    });
    if (document) return { title: document.name, document: document.markdown };
  }
  return truncateHistoricalPayload(value);
}

function truncateHistoricalPayload(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    return value.length <= MAX_HISTORICAL_PAYLOAD_CHARS
      ? value
      : `${value.slice(0, MAX_HISTORICAL_PAYLOAD_CHARS)}\n… [historique tronqué]`;
  }
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || serialized.length <= MAX_HISTORICAL_PAYLOAD_CHARS) return value;
    return `${serialized.slice(0, MAX_HISTORICAL_PAYLOAD_CHARS)}\n… [historique tronqué]`;
  } catch {
    const text = String(value);
    return text.length <= MAX_HISTORICAL_PAYLOAD_CHARS
      ? text
      : `${text.slice(0, MAX_HISTORICAL_PAYLOAD_CHARS)}\n… [historique tronqué]`;
  }
}

function extractMessageText(message?: Record<string, unknown>): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block): block is Record<string, unknown> => Boolean(block && typeof block === "object"))
    .filter((block) => block.type === "text" || block.type === "output_text")
    .map((block) => String(block.text ?? block.content ?? ""))
    .join("");
}

type ActivityDraft = Omit<ActivityItem, "id" | "createdAt"> & { id?: string; createdAt?: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stableToken(value: unknown): string {
  const text = typeof value === "string" ? value : value === undefined ? "current" : JSON.stringify(value);
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

export function rlmChildPresentation(child: Record<string, unknown> | undefined, status: string): {
  title: string;
  detail?: string;
  status: ActivityItem["status"];
} {
  const label = (textValue(child?.label) ?? textValue(child?.sessionName) ?? "sans nom").slice(0, 64);
  const activity = asRecord(child?.activity);
  const activityKind = textValue(activity?.kind);
  const toolName = textValue(activity?.toolName);
  const activityDetail = activityKind === "executing"
    ? `Exécute ${toolName ? humanizeToolName(toolName) : "un outil"}`
    : activityKind === "writing"
      ? "Rédige sa réponse"
      : activityKind === "waiting"
        ? "Attend une nouvelle étape"
        : undefined;
  const parentManagedClosure = isParentManagedSubagentClosure({
    status: status === "cancelled" ? "cancelled" : "running",
    error: textValue(child?.error),
  });
  const primaryDetail = (parentManagedClosure ? undefined : textValue(child?.error))
    ?? textValue(child?.recap)
    ?? activityDetail
    ?? textValue(child?.answerPreview);
  const metrics: string[] = [];
  if (typeof child?.toolUseCount === "number" && child.toolUseCount > 0) {
    metrics.push(`${child.toolUseCount} outil${child.toolUseCount === 1 ? "" : "s"}`);
  }
  if (typeof child?.tokenCount === "number" && child.tokenCount > 0) {
    metrics.push(`${Math.round(child.tokenCount).toLocaleString("fr-FR")} tokens`);
  }
  if (typeof child?.durationMs === "number" && child.durationMs >= 1_000 && status !== "running") {
    metrics.push(`${Math.round(child.durationMs / 1_000)} s`);
  }
  const detail = [primaryDetail?.slice(0, 190), metrics.join(" · ")].filter(Boolean).join(" — ") || undefined;

  if (status === "done") return { title: `Sous-agent « ${label} » terminé`, detail, status: "success" };
  if (status === "error") return { title: `Échec du sous-agent « ${label} »`, detail, status: "error" };
  if (parentManagedClosure) return { title: `Sous-agent « ${label} » fermé par l’agent principal`, detail, status: "info" };
  if (status === "cancelled") return { title: `Sous-agent « ${label} » annulé`, detail, status: "warning" };
  if (status === "queued") return { title: `Sous-agent « ${label} » en attente`, detail, status: "info" };
  return { title: `Sous-agent « ${label} » travaille`, detail, status: "running" };
}

function summarizeSessionActions(value: unknown): string | undefined {
  const actions = asRecord(value);
  if (!actions) return undefined;
  const detail: string[] = [];
  const active = asRecord(actions.active);
  const activeLabel = textValue(active?.label);
  const activePhase = textValue(active?.phase);
  if (activeLabel) detail.push(activeLabel.slice(0, 120));
  else if (activePhase === "preparing") detail.push("Préparation de l’action active");
  else if (activePhase === "committing") detail.push("Enregistrement de l’action active");
  else if (activePhase === "running") detail.push("Action en cours");
  const queuedCount = typeof actions.queuedCount === "number" ? actions.queuedCount : 0;
  if (queuedCount > 0) detail.push(`${queuedCount} instruction${queuedCount === 1 ? "" : "s"} en attente`);
  if (detail.length === 0) detail.push("Aucune instruction en attente");
  return detail.join(" · ");
}

function observedSessionActivity(event: RpcEnvelope): ActivityDraft | undefined {
  const activeSessionId = textValue(event.activeSessionId) ?? "unknown";
  const nested = asRecord(event.event);
  const nestedType = textValue(nested?.type);
  if (!nestedType || ["message_start", "message_update", "message_end", "turn_start", "turn_end", "tool_execution_update"].includes(nestedType)) {
    return undefined;
  }

  if (nestedType === "agent_start" || nestedType === "agent_end") {
    return {
      id: `observed-session:${activeSessionId}:agent`,
      type: event.type,
      title: nestedType === "agent_start" ? "Sous-session observée en cours" : "Sous-session observée terminée",
      status: nestedType === "agent_start" ? "running" : "success",
      raw: event,
    };
  }

  if (nestedType === "tool_execution_start" || nestedType === "tool_execution_end") {
    const toolCallId = textValue(nested?.toolCallId) ?? stableToken(nested?.toolName);
    const toolName = humanizeToolName(textValue(nested?.toolName) ?? "Outil");
    const failed = nestedType === "tool_execution_end" && nested?.isError === true;
    return {
      id: `observed-session:${activeSessionId}:tool:${toolCallId}`,
      type: event.type,
      title: nestedType === "tool_execution_start" ? `Sous-agent · ${toolName}` : failed ? `Sous-agent · ${toolName} échoué` : `Sous-agent · ${toolName} terminé`,
      detail: nestedType === "tool_execution_start" ? summarizeToolInvocation(textValue(nested?.toolName) ?? "Outil", nested?.args) : undefined,
      status: nestedType === "tool_execution_start" ? "running" : failed ? "error" : "success",
      raw: event,
    };
  }

  return {
    id: `observed-session:${activeSessionId}:${nestedType}`,
    type: event.type,
    title: `Sous-session · ${humanizeEvent(nestedType)}`,
    status: nestedType.includes("error") ? "error" : "info",
    raw: event,
  };
}

function goalActivityTitle(status: string) {
  if (status === "active") return "Objectif en cours";
  if (status === "complete") return "Objectif terminé";
  if (status === "paused") return "Objectif en pause";
  if (status === "budget_limited") return "Budget de l’objectif atteint";
  if (status === "error") return "Objectif interrompu";
  return "Objectif mis à jour";
}

function humanizeToolName(name: string) {
  if (name === "ipython") return "Exécution Python";
  if (name === "bash") return "Commande système";
  return name.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function humanizeEvent(type: string) {
  const labels: Record<string, string> = {
    agent_start: "Prime Agent a démarré",
    agent_end: "Exécution terminée",
    turn_start: "Nouveau tour de l’agent",
    turn_end: "Tour de l’agent terminé",
    compaction_start: "Compactage du contexte",
    compaction_end: "Contexte compacté",
    retry_start: "Nouvelle tentative",
    retry_end: "Nouvelle tentative terminée",
    session_action_update: "File d’attente mise à jour",
    observed_session_event: "Activité d’un sous-agent",
    observed_session_closed: "Sous-session observée terminée",
    ipython_sent_agent_message: "Message envoyé à un sous-agent",
    session_info_changed: "Informations de session mises à jour",
    thinking_level_changed: "Niveau de raisonnement modifié",
    service_tier_changed: "Priorité du service modifiée",
    auth_stale: "Authentification à renouveler",
    refine_complete: "Raffinement terminé",
    refine_failed: "Échec du raffinement",
  };
  return labels[type] ?? type.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function summarizeUnknown(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value.slice(0, 180);
  try {
    return JSON.stringify(value).slice(0, 180);
  } catch {
    return String(value).slice(0, 180);
  }
}

const MAX_RUNTIME_LOG_CHARS = 12_000;

function truncateRuntimeLog(line: string): string {
  if (line.length <= MAX_RUNTIME_LOG_CHARS) return line;
  return `${line.slice(0, MAX_RUNTIME_LOG_CHARS)}\n… [${Math.ceil(line.length / 1_024).toLocaleString("fr-FR")} Ko tronqués]`;
}

function summarizeRpcLog(line: string, event: RpcEnvelope): string {
  if (event.type === "response" && event.command === "get_messages") {
    const data = asRecord(event.data);
    const count = Array.isArray(data?.messages) ? data.messages.length : 0;
    return `Réponse get_messages · ${count.toLocaleString("fr-FR")} message${count === 1 ? "" : "s"} · ${Math.ceil(line.length / 1_024).toLocaleString("fr-FR")} Ko`;
  }
  if (line.includes("<prime_orbit_attachment_context")) {
    return `${humanizeEvent(String(event.type ?? "rpc"))} · contenu des pièces jointes masqué`;
  }
  return truncateRuntimeLog(line);
}

function summarizeToolInvocation(name: string, value: unknown): string | undefined {
  if (value && typeof value === "object") {
    const fields = value as Record<string, unknown>;
    const candidate = name === "ipython" ? fields.code : fields.command ?? fields.path ?? fields.query;
    if (typeof candidate === "string") return candidate.replace(/\s+/g, " ").trim().slice(0, 110);
  }
  return summarizeUnknown(value)?.replace(/\s+/g, " ").slice(0, 110);
}

function summarizeGoal(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const goal = value as Record<string, unknown>;
  return [goal.objective, goal.status].filter(Boolean).join(" · ").slice(0, 220);
}
