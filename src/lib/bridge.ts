import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  AgentExitPayload,
  AppUpdateInstallResult,
  AppUpdateState,
  AttachmentReadResult,
  PrimeAgentSessionSummary,
  GitChange,
  GitFileDiff,
  InstallProgressPayload,
  NativeEventPayload,
  McpScope,
  McpServerInput,
  McpServerSummary,
  OllamaHealth,
  PersistedAppState,
  PrimeAgentConnections,
  PrimeAgentDefaults,
  RuntimeDetection,
  SavePrimeAgentDefaultsInput,
  SavePrimeAgentDefaultsResult,
  SessionHistoryResult,
  ThinkingLevel,
} from "../types";
import { defaultAppState, demoAppState, demoDetection } from "./demo";
import packageMetadata from "../../package.json";

export const isNative = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

interface NativeDetection {
  found: boolean;
  runtimeKind?: "executable" | "source";
  executablePath?: string;
  sourceDir?: string;
  nodePath?: string;
  cliPath?: string;
  version?: string;
  managed: boolean;
  warnings: string[];
}

interface NativePrerequisite {
  id: string;
  label: string;
  requiredForInstall: boolean;
  found: boolean;
  path?: string;
  version?: string;
  message: string;
}

interface NativeDiagnostics {
  ready: boolean;
  canQuickInstall: boolean;
  primeAgent: NativeDetection;
  items: NativePrerequisite[];
}

export interface AppStateSnapshot {
  state: PersistedAppState;
  revision: number;
}

export interface SaveAppStateResult {
  saved: boolean;
  snapshot: AppStateSnapshot;
}

interface NativeModelsDocument {
  path: string;
  exists: boolean;
  models: unknown;
}

interface NativeGitChanges {
  cwd: string;
  isRepository: boolean;
  branch?: string;
  files: Array<{ path: string; status: string; originalPath?: string; additions: number; deletions: number; binary: boolean }>;
  diffStat: string;
  error?: string;
}

interface NativeInstallComplete {
  success: boolean;
  sourceDir: string;
  cliPath?: string;
  error?: string;
}

export interface RunningAgentInfo {
  conversationId: string;
  pid: number;
  cwd: string;
  sessionPath?: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  startedAt: number;
}

export interface RestartAgentResult {
  previousPid: number;
  agent: RunningAgentInfo;
}

export type ReloadAgentResourcesResult =
  | { status: "reloaded"; supported: true }
  | { status: "busy"; supported: true; reason: "streaming" | "compacting" | "bash" | "session_action" }
  | { status: "unavailable"; supported: true; reason: "inactive_session" }
  | { status: "pending"; supported: true; reason: "timeout" }
  | { status: "unsupported"; supported: false; reason: "runtime_kind" | "daemon_protocol" | "daemon_command" };

export interface AgentResourcesReloadedEvent {
  conversationId: string;
}

let detectionInFlight: Promise<RuntimeDetection> | undefined;
let ollamaHealthInFlight: Promise<OllamaHealth> | undefined;
let contextMenuInstallInFlight: Promise<void> | undefined;

function mapDetection(raw: NativeDetection, items: NativePrerequisite[] = []): RuntimeDetection {
  return {
    installed: raw.found,
    version: raw.version,
    executable: raw.executablePath ?? raw.cliPath,
    mode: raw.managed ? "managed" : raw.runtimeKind === "source" ? "source" : raw.found ? "system" : undefined,
    sourceDir: raw.sourceDir,
    error: !raw.found && raw.warnings.length ? raw.warnings.join("\n") : undefined,
    prerequisites: items.map((item) => ({
      name: item.label,
      found: item.found,
      version: item.version,
      path: item.path,
    })),
  };
}

export async function detectPrimeAgent(): Promise<RuntimeDetection> {
  if (!isNative()) return demoDetection;
  if (detectionInFlight) return detectionInFlight;
  detectionInFlight = (async () => {
    try {
      const diagnostics = await invoke<NativeDiagnostics>("diagnose_prerequisites");
      return mapDetection(diagnostics.primeAgent, diagnostics.items);
    } catch {
      const detection = await invoke<NativeDetection>("detect_prime_agent");
      return mapDetection(detection);
    }
  })();
  try {
    return await detectionInFlight;
  } finally {
    detectionInFlight = undefined;
  }
}

function normalizeAppStateSnapshot(snapshot: { state: PersistedAppState | null; revision: number }): AppStateSnapshot {
  return {
    state: snapshot.state ? { ...defaultAppState, ...snapshot.state } : defaultAppState,
    revision: snapshot.revision,
  };
}

export async function loadAppState(): Promise<AppStateSnapshot> {
  if (!isNative()) {
    const cached = localStorage.getItem("prime-orbit-state");
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as PersistedAppState;
        return { state: { ...defaultAppState, ...parsed }, revision: 0 };
      } catch {
        localStorage.removeItem("prime-orbit-state");
      }
    }
    return { state: demoAppState, revision: 0 };
  }
  const snapshot = await invoke<{ state: PersistedAppState | null; revision: number }>("load_app_state");
  return normalizeAppStateSnapshot(snapshot);
}

export function durableState(state: PersistedAppState): PersistedAppState {
  return {
    ...state,
    conversations: state.conversations.map((conversation) => ({
      ...conversation,
      status: "offline",
      messages: [],
      activities: [],
      lastError: undefined,
    })),
  };
}

export async function saveAppState(state: PersistedAppState, expectedRevision: number): Promise<SaveAppStateResult> {
  if (!isNative()) {
    const durable = durableState(state);
    localStorage.setItem("prime-orbit-state", JSON.stringify(durable));
    return { saved: true, snapshot: { state: durable, revision: expectedRevision + 1 } };
  }
  const result = await invoke<{ saved: boolean; snapshot: { state: PersistedAppState | null; revision: number } }>("save_app_state", {
    state: durableState(state),
    expectedRevision,
  });
  return { saved: result.saved, snapshot: normalizeAppStateSnapshot(result.snapshot) };
}

export async function listenToStateChanges(handler: (snapshot: AppStateSnapshot) => void): Promise<UnlistenFn> {
  if (!isNative()) return () => undefined;
  return listen<AppStateSnapshot>("prime-orbit://state-changed", (event) => {
    if (!event.payload.state) return;
    handler(normalizeAppStateSnapshot(event.payload));
  });
}

export async function getAppUpdateState(): Promise<AppUpdateState> {
  if (!isNative()) return { revision: 0, phase: "idle", currentVersion: packageMetadata.version };
  return invoke<AppUpdateState>("get_app_update_state");
}

export async function checkForAppUpdates(trigger: "automatic" | "manual"): Promise<AppUpdateState> {
  if (!isNative()) return { revision: 1, phase: "upToDate", currentVersion: packageMetadata.version, lastCheckedAt: new Date().toISOString(), trigger };
  return invoke<AppUpdateState>("check_for_app_updates", { trigger });
}

export async function downloadAppUpdate(): Promise<AppUpdateState> {
  if (!isNative()) return { revision: 0, phase: "idle", currentVersion: packageMetadata.version };
  return invoke<AppUpdateState>("download_app_update");
}

export async function installAppUpdate(force: boolean): Promise<AppUpdateInstallResult> {
  if (!isNative()) return { status: "installing" };
  return invoke<AppUpdateInstallResult>("install_app_update", { force });
}

export async function listenToAppUpdateState(handler: (snapshot: AppUpdateState) => void): Promise<UnlistenFn> {
  if (!isNative()) return () => undefined;
  return listen<AppUpdateState>("prime-orbit://update-state", (event) => handler(event.payload));
}

export interface StartAgentOptions {
  conversationId: string;
  cwd: string;
  sessionPath?: string;
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
  /** Bounded advisory captured with the conversation for future RLM delegations. */
  appendSystemPrompt?: string;
}

export async function startAgent(options: StartAgentOptions): Promise<RunningAgentInfo | undefined> {
  if (!isNative()) return undefined;
  return invoke<RunningAgentInfo>("start_agent", { ...options });
}

/**
 * Releases this window's lease on a conversation runtime. The native layer
 * stops an idle unobserved client immediately and defers a working one until
 * Prime Agent reaches its normal completion boundary.
 */
export async function releaseAgent(conversationId: string): Promise<boolean> {
  if (!isNative()) return false;
  return invoke<boolean>("release_agent", { conversationId });
}

export async function sendRpc(conversationId: string, payload: Record<string, unknown>): Promise<void> {
  if (!isNative()) return;
  await invoke("send_rpc", { conversationId, payload });
}

export type QueueMutationStatus = "applied" | "rejected" | "invalid" | "unsupported";
export type QueueMutation =
  | { type: "delete" }
  | { type: "move"; direction: -1 | 1 }
  | { type: "replace"; text: string; lane: "steering" | "followUp" };

export async function mutateAgentQueue(input: {
  conversationId: string;
  lane: "steering" | "followUp";
  index: number;
  expectedText: string;
  mutation: QueueMutation;
}): Promise<QueueMutationStatus> {
  if (!isNative()) return "applied";
  const result = await invoke<{ status: QueueMutationStatus }>("mutate_agent_queue", input);
  return result.status;
}

export async function stopAgent(conversationId: string): Promise<void> {
  if (!isNative()) return;
  await invoke("stop_agent", { conversationId });
}

/**
 * Emergency-restarts the native Prime Agent RPC client for one conversation
 * while retaining its cwd, resume session, model options, and all window
 * leases. Unlike a get_state resynchronization, this closes the RPC client
 * gracefully, attests daemon lease release, then relaunches it. Forced
 * termination is used only after the bounded graceful timeout.
 */
export async function restartAgent(conversationId: string): Promise<RestartAgentResult | undefined> {
  if (!isNative()) return undefined;
  return invoke<RestartAgentResult>("restart_agent", { conversationId });
}

/**
 * Rebuilds Prime Agent's resources for the active daemon session without
 * creating a model turn or restarting the process. This is the native `/reload`
 * capability: callers must handle busy, unavailable, and unsupported states.
 */
export async function reloadAgentResources(conversationId: string): Promise<ReloadAgentResourcesResult> {
  if (!isNative()) return { status: "unsupported", supported: false, reason: "runtime_kind" };
  return invoke<ReloadAgentResourcesResult>("reload_agent_resources", { conversationId });
}

export async function listenToAgentRestarts(
  handler: Handler<RestartAgentResult>,
): Promise<UnlistenFn> {
  if (!isNative()) return () => undefined;
  return listen<RestartAgentResult>("prime-agent://restarted", (event) => handler(event.payload));
}

/** Broadcast after Prime Agent has acknowledged a completed resource reload. */
export async function listenToAgentResourceReloads(
  handler: Handler<AgentResourcesReloadedEvent>,
): Promise<UnlistenFn> {
  if (!isNative()) return () => undefined;
  return listen<AgentResourcesReloadedEvent>("prime-agent://resources-reloaded", (event) => handler(event.payload));
}

export async function listRunningAgents(): Promise<RunningAgentInfo[]> {
  if (!isNative()) return [];
  return invoke<RunningAgentInfo[]>("list_running_agents");
}

export async function loadSessionHistory(
  sessionPath: string,
  expectedSessionId: string | undefined,
  projectPath: string,
): Promise<SessionHistoryResult> {
  if (!isNative()) return { messages: [], refinements: [], harnessEntries: [], readOnly: true, truncated: false };
  return invoke<SessionHistoryResult>("load_session_history", {
    sessionPath,
    expectedSessionId: expectedSessionId ?? null,
    projectPath,
  });
}

export type HarnessScope = "local" | "global";
export type HarnessKind = "prompt" | "memory" | "skill" | "subagent";
export type HarnessOpenTarget = "file" | "folder";

export interface HarnessTargetInput {
  sessionPath: string;
  expectedSessionId?: string;
  projectPath: string;
  scope: HarnessScope;
  target: HarnessOpenTarget;
}

export interface DeleteHarnessEntryInput {
  sessionPath: string;
  expectedSessionId?: string;
  projectPath: string;
  scope: HarnessScope;
  kind: HarnessKind;
  id: string;
}

export interface DeleteHarnessEntryResult {
  deleted: boolean;
  backupCreated: boolean;
}

/** Opens only the harness state path derived and attested by the native layer. */
export async function openHarnessState(input: HarnessTargetInput): Promise<void> {
  if (!isNative()) return;
  if (!input.expectedSessionId) throw new Error("La session Prime Agent sélectionnée n’a pas d’identifiant vérifiable.");
  await invoke("open_harness_state", { input });
}

/** Opens the session JSONL for local refinements or Prime Agent's global journal. */
export async function openRefinementJournal(input: HarnessTargetInput): Promise<void> {
  if (!isNative()) return;
  if (!input.expectedSessionId) throw new Error("La session Prime Agent sélectionnée n’a pas d’identifiant vérifiable.");
  await invoke("open_refinement_journal", { input });
}

/** Deletes one exact state-map entry. Native code derives all filesystem paths,
 * creates an exact .bak, and performs a compare-before-atomic-replace write. */
export async function deleteHarnessEntry(
  input: DeleteHarnessEntryInput,
): Promise<DeleteHarnessEntryResult> {
  if (!isNative()) return { deleted: true, backupCreated: false };
  if (!input.expectedSessionId) throw new Error("La session Prime Agent sélectionnée n’a pas d’identifiant vérifiable.");
  return invoke<DeleteHarnessEntryResult>("delete_harness_entry", { input });
}

export async function listPrimeAgentSessions(projectPaths: string[]): Promise<PrimeAgentSessionSummary[]> {
  if (!isNative()) return [];
  return invoke<PrimeAgentSessionSummary[]>("list_prime_agent_sessions", { projectPaths });
}

export async function quickInstallPrimeAgent(): Promise<void> {
  if (!isNative()) return;
  await invoke("quick_install_prime_agent");
}

export async function readModelsJson(): Promise<{ path: string; content: string }> {
  if (!isNative()) return { path: "~/.prime/agent/models.json", content: "{\n  \"providers\": {}\n}" };
  const result = await invoke<NativeModelsDocument>("read_models_json", { path: null });
  return { path: result.path, content: JSON.stringify(result.models, null, 2) };
}

export async function saveModelsJson(content: string, path?: string): Promise<{ path: string; backupPath?: string }> {
  if (!isNative()) return { path: path ?? "~/.prime/agent/models.json" };
  let models: unknown;
  try {
    models = JSON.parse(content);
  } catch (error) {
    throw new Error(`Le JSON des modèles est invalide : ${String(error)}`);
  }
  return invoke("save_models_json", { models, path: path ?? null });
}

export async function pickProjectFolder(): Promise<string | null> {
  if (!isNative()) return "C:\\Projects\\sample-project";
  const result = await open({ directory: true, multiple: false, title: "Ouvrir un projet" });
  return typeof result === "string" ? result : null;
}

export async function pickAttachments(
  remainingCount: number,
  remainingAttachmentBytes: number,
  remainingImageBytes: number,
): Promise<AttachmentReadResult[]> {
  if (!isNative()) return [];
  return invoke<AttachmentReadResult[]>("pick_attachments", { remainingCount, remainingAttachmentBytes, remainingImageBytes });
}

/**
 * Transfers a file explicitly dropped or pasted by the user as raw IPC bytes.
 * This avoids a base64/JSON copy and never grants the renderer a filesystem path.
 */
export async function admitDroppedAttachment(
  file: File,
  remainingAttachmentBytes: number,
  remainingImageBytes: number,
): Promise<AttachmentReadResult> {
  if (!isNative()) throw new Error("Native attachment admission is unavailable");
  const bytes = new Uint8Array(await file.arrayBuffer());
  return invoke<AttachmentReadResult>("admit_dropped_attachment", bytes, {
    headers: {
      "x-prime-orbit-file-name": encodeURIComponent(file.name),
      "x-prime-orbit-mime-type": file.type,
      "x-prime-orbit-remaining-attachment-bytes": String(remainingAttachmentBytes),
      "x-prime-orbit-remaining-image-bytes": String(remainingImageBytes),
    },
  });
}

export async function releaseAttachmentHandles(handles: string[]): Promise<void> {
  if (!isNative() || handles.length === 0) return;
  await invoke("release_attachment_handles", { handles });
}

export interface HtmlExportReservation {
  token: string;
  outputPath: string;
}

export async function beginHtmlExport(
  conversationId: string,
  suggestedName: string,
): Promise<HtmlExportReservation | null> {
  if (!isNative()) return null;
  return invoke<HtmlExportReservation | null>("begin_html_export", { conversationId, suggestedName });
}

export async function completeHtmlExport(token: string): Promise<{ path: string }> {
  if (!isNative()) throw new Error("L’export HTML natif n’est pas disponible dans ce mode.");
  return invoke<{ path: string }>("complete_html_export", { token });
}

export async function cancelHtmlExport(token: string): Promise<void> {
  if (!isNative()) return;
  await invoke("cancel_html_export", { token });
}

export async function listGitChanges(cwd: string): Promise<GitChange[]> {
  if (!isNative()) {
    return [
      { path: "src/App.tsx", status: "M", additions: 182, deletions: 12, binary: false },
      { path: "src/styles.css", status: "M", additions: 346, deletions: 0, binary: false },
      { path: "src-tauri/src/lib.rs", status: "A", additions: 418, deletions: 0, binary: false },
    ];
  }
  const result = await invoke<NativeGitChanges>("list_git_changes", { cwd });
  return result.files.map((file) => ({
    path: file.path,
    status: file.status.trim() || "M",
    originalPath: file.originalPath,
    additions: file.additions,
    deletions: file.deletions,
    binary: file.binary,
  }));
}

export async function getGitFileDiff(cwd: string, change: GitChange): Promise<GitFileDiff> {
  if (!isNative()) {
    return {
      path: change.path,
      originalPath: change.originalPath,
      patch: `diff --git a/${change.path} b/${change.path}\n--- a/${change.path}\n+++ b/${change.path}\n@@ -1,2 +1,2 @@\n-old value\n+new value`,
      binary: change.binary,
      truncated: false,
    };
  }
  return invoke<GitFileDiff>("get_git_file_diff", {
    cwd,
    path: change.path,
    originalPath: change.originalPath,
  });
}

export async function openPrimeAgentTerminal(cwd: string): Promise<void> {
  if (!isNative()) return;
  await invoke("open_prime_agent_terminal", { cwd });
}

export async function openProjectFolder(path: string): Promise<void> {
  if (!isNative()) return;
  await invoke("open_project_folder", { path });
}

export async function openGitFileFolder(cwd: string, path: string): Promise<void> {
  if (!isNative()) return;
  await invoke("open_git_file_folder", { cwd, path });
}

export async function openConversationPath(
  cwd: string,
  path: string,
): Promise<void> {
  if (!isNative()) return;
  await invoke("open_conversation_path", {
    cwd,
    path,
  });
}

export async function inspectPrimeAgentConnections(cwd?: string): Promise<PrimeAgentConnections> {
  if (!isNative()) {
    return {
      providerIds: ["anthropic:oauth", "openai-codex:oauth"],
      mcpServers: [
        { name: "linear", url: null, enabled: false, scope: "global", authKind: "oauth", hasCustomHeaders: false, builtin: true },
        { name: "notion", url: null, enabled: false, scope: "global", authKind: "oauth", hasCustomHeaders: false, builtin: true },
      ],
    };
  }
  return invoke<PrimeAgentConnections>("inspect_prime_agent_connections", { cwd: cwd ?? null });
}

export async function inspectPrimeAgentDefaults(): Promise<PrimeAgentDefaults> {
  if (!isNative()) {
    return {};
  }
  return invoke<PrimeAgentDefaults>("inspect_prime_agent_defaults");
}

export async function listenToPrimeAgentDefaults(
  handler: (defaults: PrimeAgentDefaults) => void,
): Promise<UnlistenFn> {
  if (!isNative()) return () => undefined;
  return listen<PrimeAgentDefaults>("prime-orbit://prime-agent-defaults", (event) => handler(event.payload));
}

export async function savePrimeAgentDefaults(
  input: SavePrimeAgentDefaultsInput,
): Promise<SavePrimeAgentDefaultsResult> {
  if (!isNative()) {
    if ((input.defaultProvider === null) !== (input.defaultModel === null)) {
      throw new Error("defaultProvider and defaultModel must be set or removed together");
    }
    const defaults: PrimeAgentDefaults = {};
    if (input.defaultProvider !== null && input.defaultModel !== null) {
      defaults.defaultProvider = input.defaultProvider;
      defaults.defaultModel = input.defaultModel;
    }
    if (input.defaultThinkingLevel !== null) {
      defaults.defaultThinkingLevel = input.defaultThinkingLevel;
    }
    return { path: "~/.prime/agent/settings.json", backupPath: null, defaults };
  }
  return invoke<SavePrimeAgentDefaultsResult>("save_prime_agent_defaults", { input });
}

/**
 * Checks the endpoint configured for Prime Agent's Ollama provider. The native
 * command runs the bounded network probe away from the WebView event loop.
 */
export async function checkOllamaHealth(): Promise<OllamaHealth> {
  if (!isNative()) {
    return { reachable: true, verified: true, endpoint: "http://127.0.0.1:11434/v1", latencyMs: 0 };
  }
  if (!ollamaHealthInFlight) {
    ollamaHealthInFlight = invoke<OllamaHealth>("check_ollama_health");
  }
  const request = ollamaHealthInFlight;
  try {
    return await request;
  } finally {
    if (ollamaHealthInFlight === request) ollamaHealthInFlight = undefined;
  }
}

export interface WebviewContextMenuItem {
  commandId: number;
  name: string;
  label: string;
  shortcut: string;
  enabled: boolean;
  group: "spelling" | "edit";
}

export interface WebviewContextMenuRequest {
  requestId: string;
  x: number;
  y: number;
  items: WebviewContextMenuItem[];
}

/** Returns bounded operating-system spelling suggestions for one captured word.
 * The native command owns dictionary access; browser previews simply keep the
 * regular editing menu without offering synthetic corrections. */
export async function getSpellingSuggestions(word: string, language: string): Promise<string[]> {
  if (!isNative()) return [];
  const result = await invoke<{ suggestions: string[] }>("get_spelling_suggestions", {
    input: { word, language },
  });
  return result.suggestions;
}

/** Installs the WebView2 spellcheck bridge for this renderer's own WebView.
 * Each workspace window has an independent WebView2 instance. */
export async function installWebviewContextMenu(): Promise<void> {
  if (!isNative()) return;
  if (!contextMenuInstallInFlight) {
    contextMenuInstallInFlight = invoke<void>("install_webview_context_menu");
  }
  const request = contextMenuInstallInFlight;
  try {
    await request;
  } catch (error) {
    if (contextMenuInstallInFlight === request) contextMenuInstallInFlight = undefined;
    throw error;
  }
}

export async function listenToWebviewContextMenus(
  handler: (request: WebviewContextMenuRequest) => void,
): Promise<UnlistenFn> {
  if (!isNative()) return () => undefined;
  return listen<WebviewContextMenuRequest>("prime-orbit://webview-context-menu", (event) => {
    handler(event.payload);
  });
}

/** Completes WebView2's pending context-menu deferral. Passing no command id
 * dismisses the menu; passing one executes the exact native spell/edit action. */
export async function resolveWebviewContextMenu(
  requestId: string,
  commandId?: number,
): Promise<void> {
  if (!isNative()) return;
  await invoke<void>("resolve_webview_context_menu", {
    requestId,
    commandId: commandId ?? null,
  });
}

export async function saveMcpServer(cwd: string | undefined, scope: McpScope, server: McpServerInput): Promise<{ path: string; backupPath: string | null; server: McpServerSummary }> {
  if (!isNative()) return { path: scope === "project" ? `${cwd}/.prime/agent/settings.json` : "~/.prime/agent/settings.json", backupPath: null, server: { name: server.name, url: server.url, enabled: server.enabled ?? true, scope, authKind: server.authKind ?? "none", hasCustomHeaders: false, builtin: false } };
  return invoke("save_mcp_server", { cwd: cwd ?? null, scope, server });
}

export async function deleteMcpServer(cwd: string | undefined, scope: McpScope, name: string): Promise<{ path: string; backupPath: string | null; deleted: boolean }> {
  if (!isNative()) return { path: scope === "project" ? `${cwd}/.prime/agent/settings.json` : "~/.prime/agent/settings.json", backupPath: null, deleted: true };
  return invoke("delete_mcp_server", { cwd: cwd ?? null, scope, name });
}

export async function createWorkspaceWindow(projectId?: string, conversationId?: string): Promise<void> {
  if (!isNative()) return;
  const label = `workspace-${crypto.randomUUID()}`;
  const params = new URLSearchParams();
  if (projectId) params.set("project", projectId);
  if (conversationId) params.set("conversation", conversationId);
  const workspaceWindow = new WebviewWindow(label, {
    url: `/?${params.toString()}`,
    title: "Prime Orbit",
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    decorations: true,
    dragDropEnabled: false,
    center: true,
  });
  await new Promise<void>((resolve, reject) => {
    workspaceWindow.once("tauri://created", () => resolve());
    workspaceWindow.once("tauri://error", (event) => reject(event.payload));
  });
}

type Handler<T> = (payload: T) => void;

export async function listenToAgentEvents(handlers: {
  onEvent: Handler<NativeEventPayload>;
  onStderr: Handler<NativeEventPayload>;
  onExit: Handler<AgentExitPayload>;
  onInstallProgress: Handler<InstallProgressPayload>;
  onInstallComplete: Handler<RuntimeDetection>;
}): Promise<UnlistenFn> {
  if (!isNative()) return () => undefined;
  const unlisteners = await Promise.all([
    listen<NativeEventPayload>("prime-agent://event", (event) => handlers.onEvent(event.payload)),
    listen<NativeEventPayload>("prime-agent://stderr", (event) => handlers.onStderr(event.payload)),
    listen<AgentExitPayload>("prime-agent://exit", (event) => handlers.onExit(event.payload)),
    listen<{ stage: string; message: string; percent?: number; stream?: "stdout" | "stderr" }>(
      "prime-agent://install-progress",
      (event) => handlers.onInstallProgress({
        phase: event.payload.stage,
        message: event.payload.message,
        percent: event.payload.percent,
        stream: event.payload.stream,
      }),
    ),
    listen<NativeInstallComplete>("prime-agent://install-complete", (event) => {
      if (!event.payload.success) {
        handlers.onInstallComplete({ installed: false, error: event.payload.error ?? "L’installation a échoué.", prerequisites: [] });
        return;
      }
      void detectPrimeAgent()
        .then(handlers.onInstallComplete)
        .catch((error) => handlers.onInstallComplete({ installed: false, error: String(error), prerequisites: [] }));
    }),
  ]);
  return () => unlisteners.forEach((unlisten) => unlisten());
}
