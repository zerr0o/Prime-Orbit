import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  Blocks,
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  FileText,
  FolderOpen,
  Keyboard,
  Maximize2,
  MessageSquarePlus,
  PanelBottomClose,
  PanelBottomOpen,
  Search,
  Settings,
  Sparkles,
  SquareTerminal,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { ConversationView } from "./components/ConversationView";
import { ConnectionsView, HomeView, Onboarding, ProjectsView, RunsView, SettingsView } from "./components/DashboardViews";
import { GlobalRail, ProjectSidebar } from "./components/Navigation";
import { Button, IconButton, Modal, Skeleton } from "./components/Ui";
import { useAgentRuntime } from "./hooks/useAgentRuntime";
import { useWorkspace } from "./hooks/useWorkspace";
import { setAppLanguage, useI18n } from "./i18n";
import {
  createWorkspaceWindow,
  detectPrimeAgent,
  listGitChanges,
  openPrimeAgentTerminal,
  pickProjectFolder,
  quickInstallPrimeAgent,
  stopAgent,
} from "./lib/bridge";
import type { AppView, ExtensionUiRequest, GitChange, PermissionPreset, PersistedAppState, Project, RuntimeDetection } from "./types";

interface InstallState {
  running: boolean;
  phase?: string;
  lines: string[];
}

function App() {
  const { t } = useI18n();
  const workspace = useWorkspace();
  const {
    state,
    updateState,
    view,
    setView,
    loaded,
    selectedProject,
    selectedConversation,
    addProject,
    selectProject,
    createConversation,
    selectConversation,
    updateConversation,
    updateProject,
    reorderProject,
    reorderConversation,
    deleteProject,
    archiveConversation,
  } = workspace;
  const [detection, setDetection] = useState<RuntimeDetection>();
  const [installState, setInstallState] = useState<InstallState>({ running: false, lines: [] });
  const [commandPalette, setCommandPalette] = useState(false);
  const [bottomDock, setBottomDock] = useState(false);
  const [dockMode, setDockMode] = useState<"logs" | "terminal" | "setup">("logs");
  const [setupKind, setSetupKind] = useState<"provider" | "mcp">("provider");
  const [changes, setChanges] = useState<GitChange[]>([]);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const [toast, setToast] = useState<{ tone: "info" | "success" | "error"; message: string }>();
  const [projectToDelete, setProjectToDelete] = useState<Project>();

  useEffect(() => {
    setAppLanguage(state.preferences.language);
  }, [state.preferences.language]);

  const refreshDetection = useCallback(() => {
    void detectPrimeAgent()
      .then(setDetection)
      .catch((error) => setDetection({ installed: false, error: String(error), prerequisites: [] }));
  }, []);

  useEffect(() => refreshDetection(), [refreshDetection]);

  const onInstallProgress = useCallback((phase: string, message: string) => {
    setInstallState((current) => ({ running: true, phase, lines: [...current.lines, message].slice(-250) }));
  }, []);
  const onInstallComplete = useCallback((result: RuntimeDetection) => {
    setDetection(result);
    setInstallState((current) => ({ ...current, running: false, phase: result.installed ? t("app.installComplete") : t("app.installInterrupted") }));
    setToast({ tone: result.installed ? "success" : "error", message: result.installed ? t("app.agentReady") : result.error ?? t("app.installFailed") });
  }, [t]);

  const getProject = useCallback((projectId: string) => state.projects.find((project) => project.id === projectId), [state.projects]);
  const getConversation = useCallback((conversationId: string) => state.conversations.find((conversation) => conversation.id === conversationId), [state.conversations]);

  const agent = useAgentRuntime({
    active: view === "chat",
    detection,
    selectedProject,
    selectedConversation,
    getProject,
    getConversation,
    updateConversation,
    onInstallProgress,
    onInstallComplete,
  });

  useEffect(() => {
    if (!selectedProject) {
      setChanges([]);
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const refreshChanges = async () => {
      try {
        const next = await listGitChanges(selectedProject.path);
        if (!cancelled) setChanges(next);
      } catch {
        if (!cancelled) setChanges([]);
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void refreshChanges(), 8_000);
      }
    };
    void refreshChanges();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [selectedProject?.id, selectedProject?.path]);

  const activeRuns = state.conversations.filter(
    (conversation) => !conversation.archived && conversation.hasContent !== false && ["starting", "streaming", "tool", "queued"].includes(conversation.status),
  ).length;
  const openProject = useCallback(async () => {
    const path = await pickProjectFolder();
    if (path) addProject(path);
  }, [addProject]);

  const newConversation = useCallback(() => {
    if (state.selectedProjectId) createConversation();
    else void openProject();
  }, [createConversation, openProject, state.selectedProjectId]);

  const archiveConversationAndStop = useCallback((conversationId: string) => {
    void stopAgent(conversationId)
      .then(() => archiveConversation(conversationId))
      .catch((error) => setToast({
        tone: "error",
        message: t("app.archiveFailed", { error: error instanceof Error ? error.message : String(error) }),
      }));
  }, [archiveConversation, t]);

  const toggleInspector = useCallback(() => {
    updateState((current) => ({ ...current, preferences: { ...current.preferences, inspectorOpen: !current.preferences.inspectorOpen } }));
  }, [updateState]);

  const openSetup = useCallback((kind: "provider" | "mcp") => {
    setSetupKind(kind);
    setDockMode("setup");
    setBottomDock(true);
  }, []);

  const terminalProjectPath = selectedProject?.path ?? state.projects[0]?.path;
  const launchPrimeAgentTerminal = useCallback(async () => {
    const cwd = selectedProject?.path ?? state.projects[0]?.path;
    if (!cwd) {
      setToast({ tone: "error", message: t("app.openProjectFirst") });
      return;
    }
    try {
      await openPrimeAgentTerminal(cwd);
      setToast({ tone: "success", message: t("app.terminalOpened") });
    } catch (error) {
      setToast({ tone: "error", message: t("app.openAgentFailed", { error: error instanceof Error ? error.message : String(error) }) });
    }
  }, [selectedProject?.path, state.projects, t]);

  const removeProject = useCallback(async (project: Project) => {
    const conversations = state.conversations.filter((conversation) => conversation.projectId === project.id);
    await Promise.allSettled(conversations.map((conversation) => stopAgent(conversation.id)));
    deleteProject(project.id);
    setProjectToDelete(undefined);
    setToast({ tone: "success", message: t("app.projectRemoved", { name: project.name }) });
  }, [deleteProject, state.conversations, t]);

  useEffect(() => {
    const handleKeydown = (event: globalThis.KeyboardEvent) => {
      if (event.repeat || event.defaultPrevented) return;
      const modifier = event.ctrlKey || event.metaKey;
      const target = event.target instanceof HTMLElement ? event.target : undefined;
      const isEditing = Boolean(target?.closest("input, textarea, select, [contenteditable='true'], [role='textbox']"));

      if (isEditing && !(modifier && event.key.toLowerCase() === "k")) {
        if (event.key === "Escape" && commandPalette) setCommandPalette(false);
        return;
      }
      if (modifier && event.key.toLowerCase() === "k") { event.preventDefault(); setCommandPalette(true); }
      if (modifier && event.key.toLowerCase() === "o") { event.preventDefault(); void openProject(); }
      if (modifier && event.key.toLowerCase() === "n" && !event.shiftKey) { event.preventDefault(); newConversation(); }
      if (modifier && event.key.toLowerCase() === "n" && event.shiftKey) { event.preventDefault(); void createWorkspaceWindow(); }
      if (modifier && event.key === ",") { event.preventDefault(); setView("settings"); }
      if (modifier && event.key === "`") { event.preventDefault(); setDockMode("terminal"); setBottomDock((current) => !current); }
      if (event.key === "Escape" && commandPalette) setCommandPalette(false);
    };
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [commandPalette, newConversation, openProject, setView]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(undefined), 3_500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  if (!loaded || !detection) return <AppBoot />;

  const showOnboarding = !onboardingDismissed && !detection.installed;
  if (showOnboarding) {
    return (
      <Onboarding
        detection={detection}
        installState={installState}
        onInstall={() => { setInstallState({ running: true, phase: t("app.installPreparing"), lines: [t("app.installStarting")] }); void quickInstallPrimeAgent(); }}
        onUseExisting={() => { setOnboardingDismissed(true); setView("settings"); }}
        onContinue={() => setOnboardingDismissed(true)}
      />
    );
  }

  const showProjectSidebar = view === "chat" && Boolean(selectedProject);
  return (
    <div className="app-shell">
      <GlobalRail view={view} onView={setView} onNewConversation={newConversation} onOpenProject={() => void openProject()} onCommandPalette={() => setCommandPalette(true)} activeRuns={activeRuns} />
      {showProjectSidebar ? (
        <ProjectSidebar
          projects={state.projects}
          project={selectedProject}
          conversations={state.conversations}
          selectedConversationId={state.selectedConversationId}
          collapsed={state.preferences.compactSidebar}
          onToggleCollapsed={() => updateState((current) => ({ ...current, preferences: { ...current.preferences, compactSidebar: !current.preferences.compactSidebar } }))}
          onSelectProject={selectProject}
          onSelectConversation={selectConversation}
          onNewConversation={newConversation}
          onPinConversation={(id, pinned) => updateConversation(id, { pinned })}
          onArchiveConversation={archiveConversationAndStop}
          onRenameConversation={(id, title) => updateConversation(id, { title })}
          onReorderProject={reorderProject}
          onReorderConversation={reorderConversation}
        />
      ) : null}
      <main className={`app-content ${showProjectSidebar ? "has-sidebar" : ""} ${bottomDock ? "has-dock" : ""}`}>
        {view === "home" ? <HomeView projects={state.projects} conversations={state.conversations} detection={detection} onView={setView} onProject={selectProject} onConversation={selectConversation} onOpenProject={() => void openProject()} onNewConversation={newConversation} /> : null}
        {view === "projects" ? <ProjectsView projects={state.projects} conversations={state.conversations} onProject={selectProject} onOpenProject={() => void openProject()} onDeleteProject={(project) => setProjectToDelete(project)} /> : null}
        {view === "runs" ? <RunsView projects={state.projects} conversations={state.conversations} onConversation={selectConversation} /> : null}
        {view === "connections" ? <ConnectionsView models={agent.models} projectPath={terminalProjectPath} onOpenSetup={openSetup} /> : null}
        {view === "settings" ? <SettingsView state={state} setState={updateState} detection={detection} installState={installState} onRefreshDetection={refreshDetection} /> : null}
        {view === "chat" && selectedProject && selectedConversation ? (
          <ConversationView
            project={selectedProject}
            conversation={selectedConversation}
            models={agent.models}
            commands={agent.commands}
            stats={agent.stats}
            sessionState={agent.sessionState}
            inspectorOpen={state.preferences.inspectorOpen}
            changes={changes}
            onToggleInspector={toggleInspector}
            onDraftChange={(draft) => updateConversation(selectedConversation.id, { draft })}
            onSend={agent.sendPrompt}
            onAbort={agent.abort}
            onModel={agent.chooseModel}
            onThinking={agent.setThinking}
            onPermissionPreset={async (preset: PermissionPreset) => updateProject(selectedProject.id, { permissionPreset: preset })}
            onRunCommand={agent.runCommand}
            onNewWindow={() => void createWorkspaceWindow(selectedProject.id, selectedConversation.id)}
            onOpenTerminal={() => { setDockMode("terminal"); setBottomDock(true); }}
          />
        ) : null}
        {view === "chat" && !selectedProject ? <NoProject onOpenProject={() => void openProject()} /> : null}
        {view === "chat" && selectedProject && !selectedConversation ? <NoConversation projectName={selectedProject.name} onNewConversation={newConversation} /> : null}
      </main>
      {bottomDock ? (
        <BottomDock
          mode={dockMode}
          setupKind={setupKind}
          logs={agent.logs}
          projectPath={terminalProjectPath}
          onMode={setDockMode}
          onClose={() => setBottomDock(false)}
          onCommand={(command) => agent.runCommand("bash", { command })}
          onOpenPrimeAgent={launchPrimeAgentTerminal}
        />
      ) : (
        <button type="button" className="dock-toggle" onClick={() => { setDockMode("logs"); setBottomDock(true); }} title={t("app.showOutput")}><PanelBottomOpen size={15} /><span>{t("app.output")}</span></button>
      )}
      {commandPalette ? (
        <CommandPalette
          projects={state.projects}
          conversations={state.conversations}
          onClose={() => setCommandPalette(false)}
          onView={(next) => { setView(next); setCommandPalette(false); }}
          onProject={(id) => { selectProject(id); setCommandPalette(false); }}
          onConversation={(id) => { selectConversation(id); setCommandPalette(false); }}
          onNewConversation={() => { newConversation(); setCommandPalette(false); }}
          onOpenProject={() => { void openProject(); setCommandPalette(false); }}
          onNewWindow={() => { void createWorkspaceWindow(); setCommandPalette(false); }}
        />
      ) : null}
      {agent.extensionRequest ? <ExtensionRequestModal request={agent.extensionRequest} onAnswer={agent.answerExtensionRequest} /> : null}
      {projectToDelete ? <DeleteProjectModal project={projectToDelete} conversationCount={state.conversations.filter((conversation) => conversation.projectId === projectToDelete.id).length} onClose={() => setProjectToDelete(undefined)} onConfirm={removeProject} /> : null}
      {toast ? <div className={`toast toast-${toast.tone}`}>{toast.tone === "success" ? <Check size={16} /> : toast.tone === "error" ? <CircleAlert size={16} /> : <Sparkles size={16} />}{toast.message}<IconButton label={t("common.close")} onClick={() => setToast(undefined)}><X size={14} /></IconButton></div> : null}
    </div>
  );
}

function DeleteProjectModal({ project, conversationCount, onClose, onConfirm }: { project: Project; conversationCount: number; onClose: () => void; onConfirm: (project: Project) => Promise<void> }) {
  const { t } = useI18n();
  const [confirmation, setConfirmation] = useState("");
  const [deleting, setDeleting] = useState(false);
  const matches = confirmation.trim() === project.name;
  const confirm = async () => {
    if (!matches || deleting) return;
    setDeleting(true);
    try {
      await onConfirm(project);
    } finally {
      setDeleting(false);
    }
  };
  return (
    <Modal
      title={t("app.deleteProjectTitle", { name: project.name })}
      description={t("app.deleteProjectDescription")}
      onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose} disabled={deleting}>{t("common.cancel")}</Button><Button variant="danger" loading={deleting} disabled={!matches} onClick={() => void confirm()}><Trash2 size={15} />{t("app.deleteProjectAction")}</Button></>}
    >
      <div className="delete-project-warning">
        <CircleAlert size={20} />
        <div><strong>{t(conversationCount === 1 ? "app.deleteProjectConversations.one" : "app.deleteProjectConversations.other", { count: conversationCount })}</strong><p>{t("app.deleteProjectFilesKept", { path: project.path })}</p></div>
      </div>
      <label className="confirmation-field">
        <span>{t("app.deleteProjectConfirm", { name: project.name })}</span>
        <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void confirm(); }} autoFocus autoComplete="off" spellCheck={false} />
      </label>
    </Modal>
  );
}

function AppBoot() {
  const { t } = useI18n();
  return <div className="app-boot"><div className="boot-orbit"><span /><i /></div><h1>Prime Orbit</h1><p>{t("app.boot")}</p><div className="boot-skeleton"><Skeleton width="180px" height={10} /><Skeleton width="260px" height={8} /></div></div>;
}

function NoProject({ onOpenProject }: { onOpenProject: () => void }) {
  const { t } = useI18n();
  return <div className="no-project"><span><FolderOpen size={30} /></span><h1>{t("app.noProjectTitle")}</h1><p>{t("app.noProjectText")}</p><Button variant="primary" onClick={onOpenProject}><FolderOpen size={16} />{t("app.chooseFolder")}</Button></div>;
}

function NoConversation({ projectName, onNewConversation }: { projectName: string; onNewConversation: () => void }) {
  const { t } = useI18n();
  return <div className="no-project"><span><MessageSquarePlus size={30} /></span><h1>{t("app.noConversationTitle")}</h1><p>{t("app.noConversationText", { project: projectName })}</p><Button variant="primary" onClick={onNewConversation}><MessageSquarePlus size={16} />{t("app.newConversation")}</Button></div>;
}

function BottomDock({ mode, setupKind, logs, projectPath, onMode, onClose, onCommand, onOpenPrimeAgent }: {
  mode: "logs" | "terminal" | "setup";
  setupKind: "provider" | "mcp";
  logs: Array<{ id: string; stream: "rpc" | "stderr"; text: string; createdAt: string }>;
  projectPath?: string;
  onMode: (mode: "logs" | "terminal" | "setup") => void;
  onClose: () => void;
  onCommand: (command: string) => Promise<void>;
  onOpenPrimeAgent: () => Promise<void>;
}) {
  const { locale, t } = useI18n();
  const [command, setCommand] = useState("");
  const run = () => { if (!command.trim()) return; void onCommand(command); setCommand(""); };
  return (
    <section className="bottom-dock">
      <header><nav><button type="button" className={mode === "logs" ? "is-active" : ""} onClick={() => onMode("logs")}><FileText size={14} />{t("dock.events")}</button><button type="button" className={mode === "terminal" ? "is-active" : ""} onClick={() => onMode("terminal")}><SquareTerminal size={14} />{t("dock.command")}</button><button type="button" className={mode === "setup" ? "is-active" : ""} onClick={() => onMode("setup")}><Settings size={14} />{t("dock.configuration")}</button></nav><span className="dock-path">{projectPath}</span><IconButton label={t("dock.hide")} onClick={onClose}><PanelBottomClose size={16} /></IconButton></header>
      <div className="dock-body">
        {mode === "logs" ? <div className="log-view">{logs.length ? logs.slice(-180).map((log) => <div key={log.id} className={`log-line stream-${log.stream}`}><time>{new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(log.createdAt))}</time><span>{log.stream}</span><code>{prettyLog(log.text)}</code></div>) : <div className="dock-empty"><Activity size={20} /><span>{t("dock.emptyEvents")}</span></div>}</div> : null}
        {mode === "terminal" ? <div className="command-dock"><div className="terminal-output">{logs.filter((log) => log.stream === "rpc").slice(-20).map((log) => <code key={log.id}>{prettyLog(log.text)}</code>)}</div><form onSubmit={(event) => { event.preventDefault(); run(); }}><span>›</span><input value={command} onChange={(event) => setCommand(event.target.value)} placeholder={t("dock.commandPlaceholder")} autoFocus /><kbd>Enter</kbd></form></div> : null}
        {mode === "setup" ? <div className="setup-dock"><span className="setup-dock-icon">{setupKind === "mcp" ? <Blocks size={20} /> : <Bot size={20} />}</span><div><strong>{setupKind === "mcp" ? t("dock.mcpTitle") : t("dock.providerTitle")}</strong><p>{t("dock.setupText")}</p></div><Button variant="primary" disabled={!projectPath} onClick={() => void onOpenPrimeAgent()}><Terminal size={15} />{t("dock.openAgent")}</Button></div> : null}
      </div>
    </section>
  );
}

function CommandPalette({ projects, conversations, onClose, onView, onProject, onConversation, onNewConversation, onOpenProject, onNewWindow }: {
  projects: PersistedAppState["projects"];
  conversations: PersistedAppState["conversations"];
  onClose: () => void;
  onView: (view: AppView) => void;
  onProject: (id: string) => void;
  onConversation: (id: string) => void;
  onNewConversation: () => void;
  onOpenProject: () => void;
  onNewWindow: () => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const actions = [
    { id: "new", label: t("palette.newConversation"), detail: "Ctrl N", icon: MessageSquarePlus, run: onNewConversation },
    { id: "open", label: t("palette.openProject"), detail: "Ctrl O", icon: FolderOpen, run: onOpenProject },
    { id: "window", label: t("palette.newWindow"), detail: "Ctrl ⇧ N", icon: Maximize2, run: onNewWindow },
    { id: "settings", label: t("palette.openSettings"), detail: "Ctrl ,", icon: Settings, run: () => onView("settings") },
    { id: "runs", label: t("palette.viewRuns"), detail: "", icon: Activity, run: () => onView("runs") },
  ].filter((item) => item.label.toLowerCase().includes(query.toLowerCase()));
  const foundProjects = projects.filter((project) => `${project.name} ${project.path}`.toLowerCase().includes(query.toLowerCase())).slice(0, 5);
  const foundConversations = conversations
    .filter((conversation) => !conversation.archived && conversation.hasContent !== false && conversation.title.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 6);
  return (
    <div className="command-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="command-palette" role="dialog" aria-modal="true" aria-label={t("palette.title")}><header><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("palette.searchFull")} autoFocus /><kbd>ESC</kbd></header><div className="command-results">{actions.length ? <CommandGroup title={t("palette.actions")}>{actions.map((item) => { const ItemIcon = item.icon; return <button type="button" key={item.id} onClick={item.run}><span><ItemIcon size={16} /></span><strong>{item.label}</strong><small>{item.detail}</small></button>; })}</CommandGroup> : null}{foundProjects.length ? <CommandGroup title={t("palette.projects")}>{foundProjects.map((project) => <button type="button" key={project.id} onClick={() => onProject(project.id)}><span className="project-color" style={{ background: project.color }} /><strong>{project.name}</strong><small>{project.path}</small></button>)}</CommandGroup> : null}{foundConversations.length ? <CommandGroup title={t("palette.conversations")}>{foundConversations.map((conversation) => <button type="button" key={conversation.id} onClick={() => onConversation(conversation.id)}><span><Sparkles size={15} /></span><strong>{conversation.title}</strong><small>{projects.find((project) => project.id === conversation.projectId)?.name}</small></button>)}</CommandGroup> : null}</div><footer><span><Keyboard size={13} />{t("palette.navigate")}</span><span>{t("palette.open")}</span></footer></section></div>
  );
}

function CommandGroup({ title, children }: React.PropsWithChildren<{ title: string }>) { return <section className="command-group"><h3>{title}</h3>{children}</section>; }

function ExtensionRequestModal({ request, onAnswer }: { request: ExtensionUiRequest & { conversationId: string }; onAnswer: (response: Record<string, unknown>) => Promise<void> }) {
  const { t } = useI18n();
  const [value, setValue] = useState(request.prefill ?? "");
  const title = request.title ?? (request.method === "confirm" ? t("extension.confirmRequired") : t("extension.feedback"));
  return (
    <Modal title={title} description={request.message} onClose={() => void onAnswer({ cancelled: true })} footer={request.method === "confirm" ? <><Button variant="secondary" onClick={() => void onAnswer({ confirmed: false })}>{t("extension.deny")}</Button><Button variant="primary" onClick={() => void onAnswer({ confirmed: true })}>{t("extension.allow")}</Button></> : request.method === "select" ? null : <><Button variant="secondary" onClick={() => void onAnswer({ cancelled: true })}>{t("common.cancel")}</Button><Button variant="primary" onClick={() => void onAnswer({ value })}>{t("extension.continue")}</Button></>}>
      {request.method === "select" ? <div className="extension-options">{request.options?.map((option) => <button type="button" key={option} onClick={() => void onAnswer({ value: option })}><span>{option}</span><ChevronRight size={15} /></button>)}</div> : request.method === "input" ? <input className="modal-input" value={value} onChange={(event) => setValue(event.target.value)} placeholder={request.placeholder} autoFocus /> : request.method === "editor" ? <textarea className="modal-editor" value={value} onChange={(event) => setValue(event.target.value)} autoFocus /> : null}
    </Modal>
  );
}

function prettyLog(line: string) {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed.type === "message_update") return `message_update · streaming`;
    if (parsed.type === "response") return `${parsed.command} · ${parsed.success ? "ok" : parsed.error}`;
    return [parsed.type, parsed.toolName, parsed.error].filter(Boolean).join(" · ");
  } catch {
    return line;
  }
}

export default App;
