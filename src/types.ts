import type { PlanModeState } from "./lib/plan-mode";

export type AppView = "home" | "projects" | "runs" | "connections" | "settings" | "chat";
export type SettingsSectionId = "general" | "appearance" | "agent" | "models" | "security" | "about";
export type ThemeMode = "dark" | "light" | "system";
export type PermissionPreset = "guarded" | "standard" | "autonomous";
export type ConversationStatus = "idle" | "starting" | "streaming" | "tool" | "queued" | "error" | "offline";
export type ToolStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "unresolved";

export interface Project {
  id: string;
  /** Explicit user-controlled position in the project sidebar (lower is first). */
  manualOrder?: number;
  name: string;
  path: string;
  color: string;
  createdAt: string;
  lastOpenedAt: string;
  pinned: boolean;
  permissionPreset: PermissionPreset;
  defaultModel?: string;
}

export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  /** Ephemeral, owner-scoped native cache key. Required before submit and never persisted. */
  attachmentHandle?: string;
  /** Bounded native-generated thumbnail. Never contains the original image. */
  previewDataUrl?: string;
  isImage: boolean;
}

export interface ToolActivity {
  id: string;
  name: string;
  status: ToolStatus;
  title: string;
  input?: unknown;
  output?: unknown;
  startedAt: string;
  endedAt?: string;
}

export type AgentMessageRelationship = "parent" | "sibling" | "child";

/** Structured presentation metadata for Prime Agent's agent-to-agent channel.
 * The useful message body stays in ChatMessage.content; transport headers and
 * runtime identifiers never need to be rendered as conversation text. */
export interface AgentMessageNotice {
  kind: "agent_message";
  messageId: string;
  participant?: string;
  relationship?: AgentMessageRelationship;
}

export type RefinementOutcomeScope = "local" | "global";
export type RefinementOutcomeAction = "create" | "update" | "delete";
export type RefinementOutcomeKind = "prompt" | "memory" | "skill" | "subagent";

export interface RefinementOutcomeEditNotice {
  action: RefinementOutcomeAction;
  kind: RefinementOutcomeKind;
  id: string;
  title?: string;
  applied: boolean;
  error?: string;
}

/** Safe, bounded presentation data for Prime Agent 0.8's durable refinement
 * outcome. Private before/after contents and harness paths never cross into it. */
export interface RefinementOutcomeNotice {
  kind: "refinement_outcome";
  refinementId: string;
  summary: string;
  scope: RefinementOutcomeScope;
  rollbackOf?: string;
  edits: RefinementOutcomeEditNotice[];
}

export type ConversationNotice = AgentMessageNotice | RefinementOutcomeNotice;

export interface ChatMessage {
  id: string;
  /** Prime Agent session-tree entry used for real forks when available. */
  entryId?: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  status?: "pending" | "streaming" | "complete" | "error";
  attachments?: Attachment[];
  tools?: ToolActivity[];
  model?: string;
  durationMs?: number;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    total?: number;
  };
  /** Typed Prime Agent notice with a dedicated, progressively disclosed UI. */
  notice?: ConversationNotice;
  /** Durable Prime Agent protocol turn retained for reconciliation but hidden from the public transcript. */
  internal?: "plan_handoff";
  /** A user turn accepted by Prime Agent but not delivered to the model yet. */
  queueDelivery?: "steer" | "follow_up";
  /** Set after the turn has appeared in Prime Agent's authoritative queue snapshot. */
  queueObserved?: boolean;
  /** Set once Prime Agent has accepted the queued prompt over RPC. */
  queueAccepted?: boolean;
  /** Exact payload used to reconcile the optimistic row with Prime Agent's queue. */
  queueText?: string;
  /** Prime Agent has durably started this queued turn, but canonical history has not been reloaded yet. */
  queueHistoryPending?: boolean;
}

export interface ActivityItem {
  id: string;
  type: string;
  title: string;
  detail?: string;
  status: "info" | "running" | "success" | "warning" | "error";
  createdAt: string;
  /** Timestamp of the latest event folded into this activity. */
  updatedAt?: string;
  /** Number of raw events represented by this activity. */
  updateCount?: number;
  raw?: unknown;
}

export interface Conversation {
  id: string;
  projectId: string;
  /** Explicit user-controlled position inside its project (lower is first). */
  manualOrder?: number;
  title: string;
  createdAt: string;
  updatedAt: string;
  pinned: boolean;
  archived: boolean;
  status: ConversationStatus;
  sessionPath?: string;
  sessionId?: string;
  /** A local rename that still needs to be mirrored to Prime Agent. */
  sessionNameSyncPending?: boolean;
  model?: string;
  thinkingLevel: ThinkingLevel;
  /** Immutable best-effort RLM model preference captured when this conversation is created. */
  rlmPreferredModel?: string;
  /** Immutable rlm.run thinking preference captured only when the runtime supports it. */
  rlmThinkingLevel?: ThinkingLevel;
  /** Durable marker used to distinguish a never-submitted draft from a real session. */
  hasContent?: boolean;
  draft: string;
  messages: ChatMessage[];
  activities: ActivityItem[];
  /** Conversation-local Plan workflow; absent is the Normal-mode default. */
  planMode?: PlanModeState;
  /** Stable native document owner across multiple submit/revise tool calls. */
  planArtifactId?: string;
  /** Durable handoff used if the WebView reloads between approval and restart. */
  pendingPlanAction?: {
    decision: "apply" | "keep";
    document: import("./lib/plan-mode").PlanDocument;
    relativePath: string;
    handoffId: string;
    stage: "decisionRecorded" | "runtimeNormal" | "applySending";
  };
  lastError?: string;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelInfo {
  id: string;
  name?: string;
  provider: string;
  api?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: {
    input?: number;
    output?: number;
  };
}

export interface AgentSessionState {
  model?: ModelInfo;
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  sessionActions: SessionActionSnapshot;
  goal?: GoalState;
}

export interface SessionActionSnapshot {
  queuedCount: number;
  steering: string[];
  followUps: string[];
  /** Sanitized metadata decoded from Orbit manifests; never contains capabilities or paths. */
  queueAttachments?: {
    steering: Attachment[][];
    followUps: Attachment[][];
    active?: Attachment[];
  };
  active?: {
    kind: "turn" | "session_command";
    phase: "preparing" | "committing" | "running";
    label?: string;
  };
}

export interface GoalState {
  active?: boolean;
  goalId?: string;
  status: "idle" | "active" | "paused" | "budget_limited" | "complete" | "error";
  objective?: string;
  tokensUsed?: number;
  tokenBudget?: number;
  continuationsUsed?: number;
  timeUsedSeconds?: number;
  lastReason?: string;
  lastError?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface AgentRlmChild {
  id: string;
  parentId?: string;
  activeSessionId?: string;
  sessionName?: string;
  model?: string;
  label: string;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  durationMs?: number;
  answerPreview?: string;
  repliedSinceTask?: boolean;
  toolUseCount?: number;
  tokenCount?: number;
  recap?: string;
  sessionDir?: string;
  activity?: { kind: "waiting" | "writing" | "executing"; toolName?: string };
  error?: string;
}

export interface AgentSchedule {
  id: string;
  status: "active" | "paused" | "completed" | "cancelled";
  source?: "cron" | "heartbeat" | "rlm_heartbeat";
  deliveryMode?: "steer" | "follow_up";
  activeSessionId: string;
  sessionId: string;
  sessionFile: string;
  cwd: string;
  label?: string;
  prompt: string;
  schedule: { kind: "once" | "cron" | "interval"; expression: string; intervalMs?: number };
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
  lastRunAt?: string;
  lastError?: string;
  runCount: number;
}

export interface AgentHeartbeatSummary {
  job: AgentSchedule;
  sessionName?: string;
  firstMessage?: string;
}

export interface SessionStats {
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
  totalMessages?: number;
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  cost?: number;
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
}

export interface SlashCommand {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
}

export interface Preferences {
  theme: ThemeMode;
  language: "fr" | "en";
  restoreLastWorkspace: boolean;
  askBeforeClose: boolean;
  closeAction: "minimize" | "quit";
  automaticUpdateChecks: boolean;
  compactSidebar: boolean;
  inspectorOpen: boolean;
  bottomDockOpen: boolean;
  telemetry: boolean;
  /** Fully-qualified Prime Agent model references pinned by the user. */
  favoriteModels: string[];
  defaultThinking: ThinkingLevel;
  defaultPermissionPreset: PermissionPreset;
  reduceMotion: boolean;
}

export interface AppUpdateRelease {
  version: string;
  notes?: string;
  publishedAt?: string;
}

export type AppUpdatePhase =
  | "idle"
  | "checking"
  | "upToDate"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "error";

/** Process-wide updater snapshot broadcast to every Prime Orbit window. */
export interface AppUpdateState {
  /** Monotone process-wide sequence used to discard stale IPC snapshots. */
  revision: number;
  phase: AppUpdatePhase;
  currentVersion: string;
  update?: AppUpdateRelease;
  downloadedBytes?: number;
  totalBytes?: number;
  lastCheckedAt?: string;
  error?: string;
  operation?: "check" | "download" | "install";
  trigger?: "automatic" | "manual";
}

export type AppUpdateInstallResult =
  | { status: "installing" }
  | { status: "busy"; activeAgents: number };

export interface PersistedAppState {
  version: number;
  projects: Project[];
  conversations: Conversation[];
  selectedProjectId?: string;
  selectedConversationId?: string;
  preferences: Preferences;
}

export interface RuntimeDetection {
  installed: boolean;
  version?: string;
  executable?: string;
  mode?: "system" | "managed" | "source";
  configDir?: string;
  sourceDir?: string;
  error?: string;
  prerequisites: Array<{
    name: string;
    found: boolean;
    version?: string;
    path?: string;
  }>;
}

export type McpScope = "global" | "project";
export type McpAuthKind = "oauth" | "bearer-env" | "none";

export interface McpServerSummary {
  name: string;
  url: string | null;
  enabled: boolean;
  scope: McpScope;
  authKind: McpAuthKind;
  /** True when opaque HTTP headers exist in settings.json; their names and values never leave Rust. */
  hasCustomHeaders: boolean;
  builtin: boolean;
}

export interface PrimeAgentConnections {
  providerIds: string[];
  mcpServers: McpServerSummary[];
}

/** Official global defaults read from ~/.prime/agent/settings.json. */
export interface PrimeAgentDefaults {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
}

/** Null removes the corresponding official Prime Agent setting. */
export interface SavePrimeAgentDefaultsInput {
  defaultProvider: string | null;
  defaultModel: string | null;
  defaultThinkingLevel: ThinkingLevel | null;
}

export interface SavePrimeAgentDefaultsResult {
  path: string;
  backupPath: string | null;
  defaults: PrimeAgentDefaults;
}

export interface OllamaHealth {
  reachable: boolean;
  /** True only when the response is positively identified as Ollama. */
  verified: boolean;
  /** Sanitized endpoint: native code removes credentials, query and fragment. */
  endpoint: string;
  latencyMs: number;
  error?: string;
}

export interface McpServerInput {
  name: string;
  url: string;
  enabled?: boolean;
  authKind?: McpAuthKind;
  bearerTokenEnvVar?: string;
}

export interface RpcEnvelope {
  id?: string;
  type: string;
  command?: string;
  success?: boolean;
  error?: string;
  data?: unknown;
  [key: string]: unknown;
}

export interface ExtensionUiRequest extends RpcEnvelope {
  type: "extension_ui_request";
  id: string;
  method: "select" | "confirm" | "input" | "editor" | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text";
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  notifyType?: "info" | "warning" | "error";
}

export interface PendingExtensionUiRequest extends ExtensionUiRequest {
  conversationId: string;
  /** Stable identity across conversations, used to queue and key the modal. */
  requestKey: string;
  /** Runtime provenance attached by Rust from the exact owning process. */
  runtimeMode?: "normal" | "plan";
}

export interface NativeEventPayload {
  conversationId: string;
  line: string;
  /** Runtime mode attested by the native process registry for interactive
   * requests. This avoids rejecting a valid Plan dialog while the renderer is
   * still rebuilding its transient runtime cache after a reconnect. */
  runtimeMode?: "normal" | "plan";
}

export interface AgentExitPayload {
  conversationId: string;
  code?: number;
  success: boolean;
  error?: string;
}

/** Sanitized, read-only transcript reconstructed from a Prime Agent JSONL session. */
export type SessionRefinementKind = "prompt" | "memory" | "skill" | "subagent";
export type SessionRefinementAction = "create" | "update" | "delete";

/** Bounded public projection of one applied edit. Native history loading never
 * exposes harness paths, references, arguments, metadata, or raw snapshots. */
export interface SessionRefinementEdit {
  action: SessionRefinementAction;
  kind: SessionRefinementKind;
  id: string;
  title?: string;
  content?: string;
  applied: boolean;
  error?: string;
}

export interface SessionRefinementRecord {
  id: string;
  timestamp: string;
  summary?: string;
  rationale?: string;
  expectedOutcome?: string;
  scope?: "local" | "global";
  rollbackOf?: string;
  appliedEdits: SessionRefinementEdit[];
}

/** Latest state proven by folding every sanitized refinement edit in the
 * validated session file, then bounding the returned snapshot. It is not a
 * complete filesystem-level harness inventory. */
export interface SessionHarnessEntry {
  key: string;
  id: string;
  kind: SessionRefinementKind;
  scope: "local" | "global" | "unknown";
  title?: string;
  content?: string;
  refinementId: string;
  updatedAt: string;
}

export interface SessionHistoryResult {
  revision: string;
  messages: unknown[];
  refinements: SessionRefinementRecord[];
  harnessEntries: SessionHarnessEntry[];
  readOnly: true;
  truncated: boolean;
  latestAgentTaskState?: string;
  warning?: string;
}

export interface SessionHistoryStamp {
  revision: string;
}

export interface InstallProgressPayload {
  phase: string;
  message: string;
  percent?: number;
  stream?: "stdout" | "stderr";
}

export interface AttachmentReadResult {
  name: string;
  mimeType: string;
  attachmentHandle: string;
  previewDataUrl?: string;
  size: number;
  isImage: boolean;
}

export interface PrimeAgentSessionSummary {
  /** Opaque native attestation used to open this exact catalog entry. */
  catalogKey: string;
  sessionPath: string;
  sessionId: string;
  cwd: string;
  sessionName?: string;
  firstMessage?: string;
  messageCount: number;
  rlmDepth: number;
  parentSessionPath?: string;
  createdAt?: string;
  updatedAtMs: number;
  sessionState?: "active" | "archived" | "crash";
  agentSummary?: string;
  agentTaskState?: "needs_input" | "completed";
  catalogStatus: "saved" | "needs_input" | "completed" | "archived" | "crash" | "draft";
  folderAvailable: boolean;
}

export interface GitChange {
  path: string;
  status: string;
  originalPath?: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface GitFileDiff {
  path: string;
  originalPath?: string;
  patch: string;
  binary: boolean;
  truncated: boolean;
}
