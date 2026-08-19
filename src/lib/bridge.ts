import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  AgentExitPayload,
  AttachmentReadResult,
  GitChange,
  InstallProgressPayload,
  NativeEventPayload,
  McpScope,
  McpServerInput,
  McpServerSummary,
  PersistedAppState,
  PrimeAgentConnections,
  RuntimeDetection,
  SessionHistoryResult,
  ThinkingLevel,
} from "../types";
import { defaultAppState, demoAppState, demoDetection } from "./demo";

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
  files: Array<{ path: string; status: string; originalPath?: string }>;
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
  provider?: string;
  model?: string;
  thinking?: string;
  startedAt: number;
}

let detectionInFlight: Promise<RuntimeDetection> | undefined;

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

export interface StartAgentOptions {
  conversationId: string;
  cwd: string;
  sessionPath?: string;
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
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

export async function stopAgent(conversationId: string): Promise<void> {
  if (!isNative()) return;
  await invoke("stop_agent", { conversationId });
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
  if (!isNative()) return { messages: [], readOnly: true, truncated: false };
  return invoke<SessionHistoryResult>("load_session_history", {
    sessionPath,
    expectedSessionId: expectedSessionId ?? null,
    projectPath,
  });
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
  remainingImageBytes: number,
): Promise<AttachmentReadResult[]> {
  if (!isNative()) return [];
  return invoke<AttachmentReadResult[]>("pick_attachments", { remainingCount, remainingImageBytes });
}

export async function releaseAttachmentHandles(handles: string[]): Promise<void> {
  if (!isNative() || handles.length === 0) return;
  await invoke("release_attachment_handles", { handles });
}

export async function listGitChanges(cwd: string): Promise<GitChange[]> {
  if (!isNative()) {
    return [
      { path: "src/App.tsx", status: "M", additions: 182, deletions: 12 },
      { path: "src/styles.css", status: "M", additions: 346, deletions: 0 },
      { path: "src-tauri/src/lib.rs", status: "A", additions: 418, deletions: 0 },
    ];
  }
  const result = await invoke<NativeGitChanges>("list_git_changes", { cwd });
  return result.files.map((file) => ({ path: file.path, status: file.status.trim() || "M" }));
}

export async function openPrimeAgentTerminal(cwd: string): Promise<void> {
  if (!isNative()) return;
  await invoke("open_prime_agent_terminal", { cwd });
}

export async function openProjectFolder(path: string): Promise<void> {
  if (!isNative()) return;
  await invoke("open_project_folder", { path });
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
