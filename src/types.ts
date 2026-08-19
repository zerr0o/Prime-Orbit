export type AppView = "home" | "projects" | "runs" | "connections" | "settings" | "chat";
export type ThemeMode = "dark" | "light" | "system";
export type PermissionPreset = "guarded" | "standard" | "autonomous";
export type ConversationStatus = "idle" | "starting" | "streaming" | "tool" | "queued" | "error" | "offline";
export type ToolStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

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
  path?: string;
  mimeType: string;
  size: number;
  /** Ephemeral, owner-scoped native cache key. Never persisted after submit. */
  attachmentHandle?: string;
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

export interface ChatMessage {
  id: string;
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
  model?: string;
  thinkingLevel: ThinkingLevel;
  /** Durable marker used to distinguish a never-submitted draft from a real session. */
  hasContent?: boolean;
  draft: string;
  messages: ChatMessage[];
  activities: ActivityItem[];
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
  sessionActions?: unknown;
  goal?: GoalState;
}

export interface GoalState {
  status: "idle" | "active" | "paused" | "budget_limited" | "complete" | "error";
  objective?: string;
  tokensUsed?: number;
  tokenBudget?: number;
  continuationsUsed?: number;
  timeUsedSeconds?: number;
  lastReason?: string;
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
  compactSidebar: boolean;
  inspectorOpen: boolean;
  bottomDockOpen: boolean;
  telemetry: boolean;
  defaultThinking: ThinkingLevel;
  defaultPermissionPreset: PermissionPreset;
  reduceMotion: boolean;
}

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
}

export interface NativeEventPayload {
  conversationId: string;
  line: string;
}

export interface AgentExitPayload {
  conversationId: string;
  code?: number;
  success: boolean;
  error?: string;
}

/** Sanitized, read-only transcript reconstructed from a Prime Agent JSONL session. */
export interface SessionHistoryResult {
  messages: unknown[];
  readOnly: true;
  truncated: boolean;
  warning?: string;
}

export interface InstallProgressPayload {
  phase: string;
  message: string;
  percent?: number;
  stream?: "stdout" | "stderr";
}

export interface AttachmentReadResult {
  path?: string;
  name: string;
  mimeType: string;
  attachmentHandle?: string;
  size: number;
  isImage: boolean;
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
