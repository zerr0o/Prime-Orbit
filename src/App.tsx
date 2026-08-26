import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Activity,
  Archive,
  Blocks,
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  Download,
  FileText,
  FolderOpen,
  Keyboard,
  LoaderCircle,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
  PackageCheck,
  PanelBottomClose,
  PanelBottomOpen,
  Power,
  Search,
  Settings,
  Sparkles,
  SquareTerminal,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { AppContextMenu } from "./components/AppContextMenu";
import {
  ConversationView,
  releaseAllConversationAttachmentDrafts,
  releaseConversationAttachmentDrafts,
} from "./components/ConversationView";
import { ConnectionsView, HomeView, Onboarding, ProjectsView, RunsView, SavedSessionView, SettingsView } from "./components/DashboardViews";
import { GlobalRail, ProjectSidebar } from "./components/Navigation";
import { Button, IconButton, Modal, Skeleton } from "./components/Ui";
import { useAgentRuntime } from "./hooks/useAgentRuntime";
import { useAppUpdater } from "./hooks/useAppUpdater";
import { useWorkspace } from "./hooks/useWorkspace";
import { getAppLanguage, setAppLanguage, useI18n } from "./i18n";
import {
  createWorkspaceWindow,
  checkOllamaHealth,
  detectPrimeAgent,
  hideCurrentWindowToTray,
  inspectPrimeAgentDefaults,
  listenToPrimeAgentDefaults,
  listGitChanges,
  listPrimeAgentSessions,
  openPrimeAgentTerminal,
  pickProjectFolder,
  quickInstallPrimeAgent,
  openProjectFolder,
  isNative,
  quitPrimeOrbit,
  setTrayLanguage,
  stopAgent,
} from "./lib/bridge";
import { redactText } from "./lib/redaction";
import { toggleFavoriteModelRef } from "./lib/model-favorites";
import { loadRlmPreferences, snapshotRlmPreferences } from "./lib/rlm-preferences";
import { runtimeNoticeToast, type RuntimeNoticeToast } from "./lib/runtime-notices";
import { printShortcutDisposition } from "./lib/app-shortcuts";
import { conversationMoveTarget } from "./lib/conversation-context";
import type { AppView, Conversation, ExtensionUiRequest, GitChange, OllamaHealth, PersistedAppState, PrimeAgentDefaults, PrimeAgentSessionSummary, Project, RuntimeDetection, SettingsSectionId } from "./types";

interface InstallState {
  running: boolean;
  outcome?: "success" | "error";
  phase?: string;
  lines: string[];
}

interface OllamaHealthState {
  checking: boolean;
  result?: OllamaHealth;
  error?: string;
}

interface PrimeAgentDefaultsState {
  loading: boolean;
  value?: PrimeAgentDefaults;
  error?: string;
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
    openProjectConversation,
    createConversation,
    importPrimeAgentSessions,
    openCatalogSession,
    preserveConversationReference,
    discardConversationReference,
    selectConversation,
    updateConversation,
    updateProject,
    reorderProject,
    reorderConversation,
    deleteProject,
    archiveConversation,
    workspaceSaveError,
    retryWorkspaceSave,
    flushWorkspaceState,
  } = workspace;

  const [sessionCatalog, setSessionCatalog] = useState<PrimeAgentSessionSummary[]>([]);
  const [sessionCatalogLoading, setSessionCatalogLoading] = useState(false);
  const [sessionCatalogError, setSessionCatalogError] = useState<string>();
  const [savedSessionReader, setSavedSessionReader] = useState<PrimeAgentSessionSummary>();
  const catalogGeneration = useRef(0);
  const catalogLastRefreshedAt = useRef(0);
  const refreshSessionCatalog = useCallback(async (force = false) => {
    if (!loaded) return;
    const now = Date.now();
    if (!force && now - catalogLastRefreshedAt.current < 30_000) return;
    const generation = ++catalogGeneration.current;
    setSessionCatalogLoading(true);
    setSessionCatalogError(undefined);
    try {
      const sessions = await listPrimeAgentSessions(state.projects.map((project) => project.path));
      if (catalogGeneration.current !== generation) return;
      catalogLastRefreshedAt.current = Date.now();
      setSessionCatalog(sessions);
      importPrimeAgentSessions(sessions);
    } catch (error) {
      if (catalogGeneration.current === generation) {
        setSessionCatalogError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (catalogGeneration.current === generation) setSessionCatalogLoading(false);
    }
  }, [importPrimeAgentSessions, loaded, state.projects]);

  useEffect(() => {
    if (!loaded) return;
    void refreshSessionCatalog(true);
    const onFocus = () => void refreshSessionCatalog(false);
    window.addEventListener("focus", onFocus);
    return () => {
      catalogGeneration.current += 1;
      window.removeEventListener("focus", onFocus);
    };
  }, [loaded, refreshSessionCatalog]);
  const [detection, setDetection] = useState<RuntimeDetection>();
  const primeAgentDefaultsGeneration = useRef(0);
  const [primeAgentDefaults, setPrimeAgentDefaults] = useState<PrimeAgentDefaultsState>({ loading: false });
  const [installState, setInstallState] = useState<InstallState>({ running: false, lines: [] });
  const [commandPalette, setCommandPalette] = useState(false);
  const [bottomDock, setBottomDock] = useState(false);
  const [dockMode, setDockMode] = useState<"logs" | "terminal" | "setup">("logs");
  const [setupKind, setSetupKind] = useState<"provider" | "mcp">("provider");
  const [changes, setChanges] = useState<GitChange[]>([]);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const [toast, setToast] = useState<({ tone: "info"; message: string; persistent?: boolean } | RuntimeNoticeToast | { tone: "success" | "error"; message: string; persistent?: boolean })>();
  const [projectToDelete, setProjectToDelete] = useState<Project>();
  const [projectToRename, setProjectToRename] = useState<Project>();
  const [projectToArchive, setProjectToArchive] = useState<Project>();
  const [conversationToRename, setConversationToRename] = useState<Conversation>();
  const [ollamaHealth, setOllamaHealth] = useState<OllamaHealthState>();
  const [updateBlockingAgents, setUpdateBlockingAgents] = useState<number>();
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>("general");
  const [dismissedUpdateVersion, setDismissedUpdateVersion] = useState<string>();
  const [closeDecisionOpen, setCloseDecisionOpen] = useState(false);
  const [closeDontAskAgain, setCloseDontAskAgain] = useState(false);
  const [closeActionPending, setCloseActionPending] = useState<"minimize" | "quit">();
  const [closeActionError, setCloseActionError] = useState<string>();
  const closeDecisionOpenRef = useRef(false);
  const closeActionBusyRef = useRef(false);
  const appUpdater = useAppUpdater({
    automaticChecks: loaded && state.preferences.automaticUpdateChecks,
  });

  useEffect(() => {
    const releaseDraftAttachments = () => {
      void releaseAllConversationAttachmentDrafts().catch(() => undefined);
    };
    window.addEventListener("pagehide", releaseDraftAttachments);
    return () => {
      window.removeEventListener("pagehide", releaseDraftAttachments);
      releaseDraftAttachments();
    };
  }, []);
  const [ollamaHealthGeneration, setOllamaHealthGeneration] = useState(0);

  const handleRuntimeNotice = useCallback((notice: Parameters<typeof runtimeNoticeToast>[1]) => {
    setToast(runtimeNoticeToast(getAppLanguage(), notice));
  }, []);

  useEffect(() => {
    setAppLanguage(state.preferences.language);
    void setTrayLanguage(state.preferences.language).catch(() => undefined);
  }, [state.preferences.language]);

  const refreshDetection = useCallback(() => {
    void detectPrimeAgent()
      .then(setDetection)
      .catch((error) => setDetection({ installed: false, error: String(error), prerequisites: [] }));
  }, []);

  useEffect(() => refreshDetection(), [refreshDetection]);

  const applyPrimeAgentDefaults = useCallback((defaults: PrimeAgentDefaults) => {
    setPrimeAgentDefaults({ loading: false, value: defaults });
    if (defaults.defaultThinkingLevel) {
      updateState((current) => current.preferences.defaultThinking === defaults.defaultThinkingLevel
        ? current
        : { ...current, preferences: { ...current.preferences, defaultThinking: defaults.defaultThinkingLevel! } });
    }
  }, [updateState]);

  useEffect(() => {
    if (!detection?.installed) {
      primeAgentDefaultsGeneration.current += 1;
      setPrimeAgentDefaults({ loading: false });
      return;
    }
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const stop = await listenToPrimeAgentDefaults((defaults) => {
          primeAgentDefaultsGeneration.current += 1;
          applyPrimeAgentDefaults(defaults);
        });
        if (cancelled) {
          stop();
          return;
        }
        unlisten = stop;
      } catch {
        // The authoritative snapshot below still keeps this window usable.
      }
      if (cancelled) return;
      const generation = ++primeAgentDefaultsGeneration.current;
      setPrimeAgentDefaults((current) => ({ ...current, loading: true, error: undefined }));
      try {
        const defaults = await inspectPrimeAgentDefaults();
        if (!cancelled && primeAgentDefaultsGeneration.current === generation) {
          applyPrimeAgentDefaults(defaults);
        }
      } catch (error) {
        if (!cancelled && primeAgentDefaultsGeneration.current === generation) {
          setPrimeAgentDefaults((current) => ({
            ...current,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [applyPrimeAgentDefaults, detection?.installed, detection?.version]);

  const onInstallProgress = useCallback((phase: string, message: string) => {
    setInstallState((current) => ({ running: true, phase, lines: [...current.lines, message].slice(-250) }));
  }, []);
  const onInstallComplete = useCallback((result: RuntimeDetection) => {
    setDetection(result);
    setInstallState((current) => ({
      ...current,
      running: false,
      outcome: result.installed ? "success" : "error",
      phase: result.installed ? t("app.installComplete") : t("app.installInterrupted"),
    }));
    setToast({ tone: result.installed ? "success" : "error", message: result.installed ? t("app.agentReady") : result.error ?? t("app.installFailed") });
  }, [t]);

  const installPrimeAgent = useCallback(async () => {
    if (installState.running) return;
    setInstallState({
      running: true,
      outcome: undefined,
      phase: t("app.installPreparing"),
      lines: [t("app.installStarting")],
    });
    try {
      await quickInstallPrimeAgent();
    } catch (error) {
      const message = redactText(error instanceof Error ? error.message : String(error));
      setInstallState((current) => ({
        ...current,
        running: false,
        outcome: "error",
        phase: t("app.installInterrupted"),
        lines: [...current.lines, message].slice(-250),
      }));
      setToast({ tone: "error", message: t("app.installFailed") + `: ${message}` });
    }
  }, [installState.running, t]);

  const getProject = useCallback((projectId: string) => state.projects.find((project) => project.id === projectId), [state.projects]);
  const getConversation = useCallback((conversationId: string) => state.conversations.find((conversation) => conversation.id === conversationId), [state.conversations]);

  const agent = useAgentRuntime({
    active: view === "chat",
    detection,
    selectedProject,
    selectedConversation,
    getProject,
    getConversation,
    preserveSessionReference: (conversationId, title) => preserveConversationReference(
      conversationId,
      state.preferences.language === "en" ? title.replace(/ · origine$/, " · source") : title,
    ),
    discardSessionReference: discardConversationReference,
    updateConversation,
    flushWorkspaceState: workspace.flushWorkspaceState,
    onInstallProgress,
    onInstallComplete,
    onNotice: handleRuntimeNotice,
  });

  const selectedProvider = selectedConversation?.model?.split("/", 1)[0]?.toLowerCase();
  const ollamaSelected = selectedProvider === "ollama";
  const ollamaCatalogAvailable = agent.models.some((model) => model.provider.toLowerCase() === "ollama");
  const shouldCheckOllama = ollamaSelected || (view === "connections" && ollamaCatalogAvailable);

  useEffect(() => {
    if (!shouldCheckOllama) {
      setOllamaHealth(undefined);
      return;
    }
    let cancelled = false;
    setOllamaHealth((current) => ({ checking: true, result: current?.result }));
    void checkOllamaHealth()
      .then((result) => {
        if (!cancelled) setOllamaHealth({ checking: false, result });
      })
      .catch((error) => {
        if (!cancelled) {
          setOllamaHealth({
            checking: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [ollamaHealthGeneration, shouldCheckOllama]);

  const recheckOllama = useCallback(() => {
    setOllamaHealthGeneration((current) => current + 1);
  }, []);

  const checkAppUpdate = useCallback(async () => {
    await appUpdater.check("manual");
  }, [appUpdater.check]);

  const downloadAvailableAppUpdate = useCallback(async () => {
    await appUpdater.download();
  }, [appUpdater.download]);

  const requestAppUpdateInstall = useCallback(async (force = false) => {
    const result = await appUpdater.install(force);
    if (result?.status === "busy") setUpdateBlockingAgents(result.activeAgents);
  }, [appUpdater.install]);

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
  const globalDefaultModel = primeAgentModelRef(primeAgentDefaults.value);
  const openProject = useCallback(async () => {
    const path = await pickProjectFolder();
    if (path) addProject(path, globalDefaultModel, snapshotRlmPreferences(loadRlmPreferences(), detection?.version));
  }, [addProject, detection?.version, globalDefaultModel]);

  const newConversationInProject = useCallback((projectId: string) => {
    createConversation(
      projectId,
      undefined,
      globalDefaultModel,
      snapshotRlmPreferences(loadRlmPreferences(), detection?.version),
    );
  }, [createConversation, detection?.version, globalDefaultModel]);

  const newConversation = useCallback(() => {
    if (state.selectedProjectId) newConversationInProject(state.selectedProjectId);
    else void openProject();
  }, [newConversationInProject, openProject, state.selectedProjectId]);

  const resumeProject = useCallback((projectId: string) => {
    openProjectConversation(
      projectId,
      globalDefaultModel,
      snapshotRlmPreferences(loadRlmPreferences(), detection?.version),
    );
  }, [detection?.version, globalDefaultModel, openProjectConversation]);

  const navigateToView = useCallback((next: AppView) => {
    if (next !== "runs") setSavedSessionReader(undefined);
    setView(next);
  }, [setView]);

  const openCatalogEntry = useCallback((session: PrimeAgentSessionSummary) => {
    const normalizedCwd = session.cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
    const belongsToOrbit = state.projects.some((project) => (
      project.path.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase() === normalizedCwd
    ));
    if (belongsToOrbit && session.folderAvailable) {
      setSavedSessionReader(undefined);
      openCatalogSession(session);
      return;
    }
    setSavedSessionReader(session);
  }, [openCatalogSession, state.projects]);

  const addCatalogSessionProject = useCallback((session: PrimeAgentSessionSummary) => {
    if (!session.folderAvailable) return;
    setSavedSessionReader(undefined);
    openCatalogSession(session);
    void refreshSessionCatalog(true);
  }, [openCatalogSession, refreshSessionCatalog]);

  const archiveConversationAndStop = useCallback((conversationId: string) => {
    void stopAgent(conversationId)
      .then(async () => {
        await releaseConversationAttachmentDrafts(conversationId).catch(() => undefined);
        archiveConversation(conversationId);
      })
      .catch((error) => setToast({
        tone: "error",
        message: t("app.archiveFailed", { error: error instanceof Error ? error.message : String(error) }),
      }));
  }, [archiveConversation, t]);

  const renameConversationAndSync = useCallback((conversation: Conversation, title: string) => {
    updateConversation(conversation.id, { title, sessionNameSyncPending: true });
    setConversationToRename(undefined);
    if (conversation.id !== selectedConversation?.id) return;
    void agent.renameSession(title).catch((error) => setToast({
      tone: "error",
      message: state.preferences.language === "en"
        ? `Session renamed locally, but Prime Agent could not be updated: ${error instanceof Error ? error.message : String(error)}`
        : `Session renommée localement, mais Prime Agent n’a pas pu être mis à jour : ${error instanceof Error ? error.message : String(error)}`,
    }));
  }, [agent, selectedConversation?.id, state.preferences.language, updateConversation]);

  const moveConversationFromContext = useCallback((conversation: Conversation, direction: -1 | 1) => {
    const target = conversationMoveTarget(state.conversations, conversation, direction);
    if (target) reorderConversation(conversation.id, target.id, direction < 0 ? "before" : "after");
  }, [reorderConversation, state.conversations]);

  const toggleInspector = useCallback(() => {
    updateState((current) => ({ ...current, preferences: { ...current.preferences, inspectorOpen: !current.preferences.inspectorOpen } }));
  }, [updateState]);

  const toggleFavoriteModel = useCallback((ref: string) => {
    updateState((current) => ({
      ...current,
      preferences: {
        ...current.preferences,
        favoriteModels: toggleFavoriteModelRef(current.preferences.favoriteModels, ref),
      },
    }));
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
    await Promise.allSettled([
      ...conversations.map((conversation) => stopAgent(conversation.id)),
      releaseConversationAttachmentDrafts(conversations.map((conversation) => conversation.id)),
    ]);
    const wasSelected = state.selectedProjectId === project.id;
    deleteProject(project.id);
    if (wasSelected) setView("projects");
    setProjectToDelete(undefined);
    setToast({ tone: "success", message: t("app.projectRemoved", { name: project.name }) });
  }, [deleteProject, setView, state.conversations, state.selectedProjectId, t]);

  const toggleProjectPin = useCallback((project: Project) => {
    updateProject(project.id, { pinned: !project.pinned });
  }, [updateProject]);

  const renameProject = useCallback((project: Project, name: string) => {
    updateProject(project.id, { name });
    setProjectToRename(undefined);
    setToast({ tone: "success", message: t("app.projectRenamed", { name }) });
  }, [t, updateProject]);

  const revealProject = useCallback(async (project: Project) => {
    try {
      await openProjectFolder(project.path);
    } catch (error) {
      setToast({
        tone: "error",
        message: t("app.revealProjectFailed", { error: error instanceof Error ? error.message : String(error) }),
      });
    }
  }, [t]);

  const archiveProjectConversations = useCallback(async (project: Project) => {
    const conversations = state.conversations.filter(
      (conversation) => conversation.projectId === project.id && !conversation.archived,
    );
    const results = await Promise.allSettled(conversations.map((conversation) => stopAgent(conversation.id)));
    let archivedCount = 0;
    results.forEach((result, index) => {
      if (result.status !== "fulfilled") return;
      archiveConversation(conversations[index]!.id);
      archivedCount += 1;
    });
    const archivedIds = conversations
      .filter((_, index) => results[index]?.status === "fulfilled")
      .map((conversation) => conversation.id);
    await releaseConversationAttachmentDrafts(archivedIds).catch(() => undefined);
    const failedCount = conversations.length - archivedCount;
    setProjectToArchive(undefined);
    setToast(failedCount > 0
      ? { tone: "error", message: t(failedCount === 1 ? "app.archiveProjectFailed.one" : "app.archiveProjectFailed.other", { count: failedCount }) }
      : { tone: "success", message: t(archivedCount === 1 ? "app.projectChatsArchived.one" : "app.projectChatsArchived.other", { count: archivedCount, name: project.name }) });
  }, [archiveConversation, state.conversations, t]);

  useEffect(() => {
    const handleKeydown = (event: globalThis.KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;
      const printShortcut = printShortcutDisposition(event);
      if (printShortcut.block) {
        event.preventDefault();
        if (printShortcut.notify) setToast({ tone: "info", message: t("app.printDisabled") });
        return;
      }
      if (event.repeat || event.defaultPrevented) return;
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
    window.addEventListener("keydown", handleKeydown, true);
    return () => window.removeEventListener("keydown", handleKeydown, true);
  }, [commandPalette, newConversation, openProject, setView, t]);

  useEffect(() => {
    if (!toast || toast.persistent) return;
    const timer = window.setTimeout(() => setToast(undefined), 3_500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const setClosePromptOpen = useCallback((open: boolean) => {
    closeDecisionOpenRef.current = open;
    setCloseDecisionOpen(open);
  }, []);

  const performDesktopCloseAction = useCallback(async (
    action: "minimize" | "quit",
    rememberChoice: boolean,
  ) => {
    if (closeActionBusyRef.current) return;
    closeActionBusyRef.current = true;
    setCloseActionPending(action);
    setCloseActionError(undefined);
    try {
      if (rememberChoice) {
        updateState((current) => ({
          ...current,
          preferences: {
            ...current.preferences,
            askBeforeClose: false,
            closeAction: action,
          },
        }));
      }
      if (rememberChoice || action === "quit") {
        const saved = await flushWorkspaceState();
        if (!saved) throw new Error(t("app.closeSaveFailed"));
      }
      if (action === "minimize") {
        await hideCurrentWindowToTray();
        setClosePromptOpen(false);
        setCloseDontAskAgain(false);
      } else {
        await quitPrimeOrbit();
      }
    } catch (error) {
      setCloseActionError(error instanceof Error ? error.message : String(error));
      setClosePromptOpen(true);
    } finally {
      closeActionBusyRef.current = false;
      setCloseActionPending(undefined);
    }
  }, [flushWorkspaceState, setClosePromptOpen, t, updateState]);

  useEffect(() => {
    if (!loaded || !isNative()) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow().onCloseRequested((event) => {
      event.preventDefault();
      if (closeActionBusyRef.current || closeDecisionOpenRef.current) return;
      const preferences = workspace.state.preferences;
      if (preferences.askBeforeClose) {
        setCloseDontAskAgain(false);
        setCloseActionError(undefined);
        setClosePromptOpen(true);
        return;
      }
      void performDesktopCloseAction(preferences.closeAction, false);
    }).then((stop) => {
      if (active) unlisten = stop;
      else stop();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [loaded, performDesktopCloseAction, setClosePromptOpen, workspace.state.preferences]);

  if (!loaded || !detection) return <><AppBoot /><AppContextMenu /></>;

  const closeDecisionModal = closeDecisionOpen ? (
    <CloseDecisionModal
      dontAskAgain={closeDontAskAgain}
      pendingAction={closeActionPending}
      error={closeActionError}
      onDontAskAgain={setCloseDontAskAgain}
      onClose={() => {
        if (closeActionBusyRef.current) return;
        setCloseActionError(undefined);
        setClosePromptOpen(false);
      }}
      onAction={(action) => void performDesktopCloseAction(action, closeDontAskAgain)}
    />
  ) : null;

  const showOnboarding = !onboardingDismissed && !detection.installed;
  if (showOnboarding) {
    return (
      <>
        <Onboarding
          detection={detection}
          installState={installState}
          onInstall={() => void installPrimeAgent()}
          onUseExisting={() => { setOnboardingDismissed(true); setView("settings"); }}
          onContinue={() => setOnboardingDismissed(true)}
        />
        <AppContextMenu />
        {closeDecisionModal}
      </>
    );
  }

  const showProjectSidebar = view === "chat" && Boolean(selectedProject);
  const extensionRequest = agent.extensionRequest;
  return (
    <div className="app-shell">
      <GlobalRail view={view} onView={navigateToView} onOpenProject={() => void openProject()} onCommandPalette={() => setCommandPalette(true)} activeRuns={activeRuns} />
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
          onNewConversationForProject={newConversationInProject}
          onPinConversation={(id, pinned) => updateConversation(id, { pinned })}
          onArchiveConversation={archiveConversationAndStop}
          onRenameConversation={(id, title) => {
            const conversation = state.conversations.find((item) => item.id === id);
            if (conversation) renameConversationAndSync(conversation, title);
          }}
          onReorderProject={reorderProject}
          onReorderConversation={reorderConversation}
        />
      ) : null}
      <main className={`app-content ${showProjectSidebar ? "has-sidebar" : ""} ${bottomDock ? "has-dock" : ""}`}>
        {view === "home" ? <HomeView projects={state.projects} conversations={state.conversations} detection={detection} onView={navigateToView} onProject={resumeProject} onConversation={selectConversation} onOpenProject={() => void openProject()} onNewConversation={newConversation} /> : null}
        {view === "projects" ? <ProjectsView projects={state.projects} conversations={state.conversations} onProject={resumeProject} onOpenProject={() => void openProject()} onDeleteProject={(project) => setProjectToDelete(project)} /> : null}
        {view === "runs" ? savedSessionReader
          ? <SavedSessionView session={savedSessionReader} onBack={() => setSavedSessionReader(undefined)} onAddProject={addCatalogSessionProject} />
          : <RunsView projects={state.projects} conversations={state.conversations} sessions={sessionCatalog} loading={sessionCatalogLoading} error={sessionCatalogError} onRefresh={() => void refreshSessionCatalog(true)} onConversation={selectConversation} onSession={openCatalogEntry} />
          : null}
        {view === "connections" ? <ConnectionsView models={agent.models} projectPath={terminalProjectPath} ollamaHealth={ollamaHealth?.result} ollamaHealthChecking={Boolean(ollamaHealth?.checking)} onCheckOllama={recheckOllama} onOpenSetup={openSetup} /> : null}
        {view === "settings" ? <SettingsView section={settingsSection} onSectionChange={setSettingsSection} state={state} setState={updateState} detection={detection} installState={installState} appUpdate={appUpdater.state} models={agent.models} primeAgentDefaults={primeAgentDefaults.value} primeAgentDefaultsLoading={primeAgentDefaults.loading} primeAgentDefaultsError={primeAgentDefaults.error} onPrimeAgentDefaultsChange={applyPrimeAgentDefaults} onRefreshDetection={refreshDetection} onInstall={installPrimeAgent} onCheckAppUpdate={checkAppUpdate} onDownloadAppUpdate={downloadAvailableAppUpdate} onInstallAppUpdate={() => requestAppUpdateInstall(false)} /> : null}
        {view === "chat" && selectedProject && selectedConversation ? (
          <ConversationView
            project={selectedProject}
            conversation={selectedConversation}
            models={agent.models}
            favoriteModels={state.preferences.favoriteModels}
            commands={agent.commands}
            stats={agent.stats}
            sessionState={agent.sessionState}
            goalMutation={agent.goalMutation}
            isCompacting={agent.isCompacting}
            isRefining={agent.isRefining}
            refinements={agent.refinements}
            harnessEntries={agent.harnessEntries}
            divergences={agent.divergences}
            schedules={agent.schedules}
            heartbeat={agent.heartbeat}
            heartbeats={agent.heartbeats}
            subagents={agent.subagents}
            observedSubagent={agent.observedSubagent}
            inspectorOpen={state.preferences.inspectorOpen}
            changes={changes}
            resourceReloadSupported={detection.mode !== "system"}
            planRequest={agent.planExtensionRequest}
            isPlanRequestReplayPending={agent.isPlanRequestReplayPending}
            onPlanMode={(mode) => agent.setConversationRuntimeMode(selectedConversation.id, mode)}
            onRetryPlanFinalization={agent.retryPlanFinalization}
            onRecoverPlanDialogs={agent.recoverPlanDialogs}
            onAnswerPlanRequest={agent.answerExtensionRequest}
            onToggleInspector={toggleInspector}
            onDraftChange={(draft) => updateConversation(selectedConversation.id, { draft })}
            onSend={agent.sendPrompt}
            onRetryMessage={agent.retryMessage}
            onAbort={agent.abort}
            onModel={agent.chooseModel}
            onToggleFavoriteModel={toggleFavoriteModel}
            onThinking={agent.setThinking}
            onRunCommand={agent.runCommand}
            onObserveSubagent={agent.observeSubagent}
            onForkMessage={(messageId) => agent.forkFromMessage(messageId).catch((error) => setToast({
              tone: "error",
              message: state.preferences.language === "en"
                ? `Prime Agent could not create this branch: ${error instanceof Error ? error.message : String(error)}`
                : `Prime Agent n’a pas pu créer cette branche : ${error instanceof Error ? error.message : String(error)}`,
            }))}
            onCloneSession={() => agent.cloneSession().catch((error) => setToast({
              tone: "error",
              message: state.preferences.language === "en"
                ? `Prime Agent could not duplicate this session: ${error instanceof Error ? error.message : String(error)}`
                : `Prime Agent n’a pas pu dupliquer cette session : ${error instanceof Error ? error.message : String(error)}`,
            }))}
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
      {extensionRequest ? (
        <ExtensionRequestModal
          key={extensionRequest.requestKey}
          request={extensionRequest}
          onAnswer={(response) => agent.answerExtensionRequest(extensionRequest, response)}
        />
      ) : null}
      <AppContextMenu
        projects={state.projects}
        conversations={state.conversations}
        onToggleProjectPin={toggleProjectPin}
        onRenameProject={setProjectToRename}
        onRevealProject={revealProject}
        onArchiveProjectConversations={setProjectToArchive}
        onDeleteProject={setProjectToDelete}
        onMoveConversation={moveConversationFromContext}
        onToggleConversationPin={(conversation) => updateConversation(conversation.id, { pinned: !conversation.pinned })}
        onRenameConversation={setConversationToRename}
        onArchiveConversation={(conversation) => archiveConversationAndStop(conversation.id)}
      />
      {projectToRename ? <RenameProjectModal project={projectToRename} onClose={() => setProjectToRename(undefined)} onConfirm={renameProject} /> : null}
      {conversationToRename ? <RenameConversationModal conversation={conversationToRename} onClose={() => setConversationToRename(undefined)} onConfirm={renameConversationAndSync} /> : null}
      {projectToArchive ? <ArchiveProjectModal project={projectToArchive} conversationCount={state.conversations.filter((conversation) => conversation.projectId === projectToArchive.id && !conversation.archived).length} onClose={() => setProjectToArchive(undefined)} onConfirm={archiveProjectConversations} /> : null}
      {projectToDelete ? <DeleteProjectModal project={projectToDelete} conversationCount={state.conversations.filter((conversation) => conversation.projectId === projectToDelete.id).length} onClose={() => setProjectToDelete(undefined)} onConfirm={removeProject} /> : null}
      {closeDecisionModal}
      {updateBlockingAgents !== undefined ? (
        <Modal
          title={t("settings.updateBusyTitle")}
          description={t("settings.updateBusyDescription")}
          onClose={() => setUpdateBlockingAgents(undefined)}
          footer={<><Button variant="secondary" onClick={() => setUpdateBlockingAgents(undefined)}>{t("settings.installLater")}</Button><Button variant="danger" onClick={() => { setUpdateBlockingAgents(undefined); void requestAppUpdateInstall(true); }}>{t("settings.installAnyway")}</Button></>}
        >
          <div className="update-restart-warning" role="alert"><CircleAlert size={19} /><div><strong>{t(updateBlockingAgents === 1 ? "settings.updateBusyRuns.one" : "settings.updateBusyRuns.other", { count: updateBlockingAgents })}</strong><p>{t("settings.updateBusyWarning")}</p></div></div>
        </Modal>
      ) : null}
      {(appUpdater.state.phase === "available" || appUpdater.state.phase === "ready") && appUpdater.state.update && dismissedUpdateVersion !== appUpdater.state.update.version ? (
        <aside className={`update-discovery is-${appUpdater.state.phase}`} role="status" aria-live="polite" aria-atomic="true">
          <span className="update-discovery-icon">{appUpdater.state.phase === "ready" ? <PackageCheck size={18} /> : <Download size={18} />}</span>
          <div><strong>{t(appUpdater.state.phase === "ready" ? "settings.updateReady" : "settings.updateAvailable", { version: appUpdater.state.update.version })}</strong><small>{t(appUpdater.state.phase === "ready" ? "settings.updateReadyNotice" : "settings.updateAvailableNotice")}</small></div>
          <Button variant="ghost" onClick={() => { setDismissedUpdateVersion(appUpdater.state.update?.version); setSettingsSection("about"); setView("settings"); }}>{t("settings.viewUpdate")}</Button>
          <IconButton label={t("settings.dismissUpdateNotice")} onClick={() => setDismissedUpdateVersion(appUpdater.state.update?.version)}><X size={14} /></IconButton>
        </aside>
      ) : null}
      {toast ? <div className={`toast toast-${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"} aria-live={toast.tone === "error" ? "assertive" : "polite"}>{toast.tone === "success" ? <Check size={16} /> : toast.tone === "error" ? <CircleAlert size={16} /> : <Sparkles size={16} />}<span>{toast.message}</span><IconButton label={t("common.close")} onClick={() => setToast(undefined)}><X size={14} /></IconButton></div> : null}
      {workspaceSaveError ? (
        <div className="toast toast-error" role="alert" title={workspaceSaveError} style={{ bottom: toast ? 94 : 42 }}>
          <CircleAlert size={16} />
          <span>{state.preferences.language === "en" ? "Workspace changes could not be saved." : "Les modifications de l’espace de travail n’ont pas pu être enregistrées."}</span>
          <Button variant="ghost" onClick={retryWorkspaceSave}>{state.preferences.language === "en" ? "Retry" : "Réessayer"}</Button>
        </div>
      ) : null}
      {ollamaSelected && (ollamaHealth?.result?.reachable === false || ollamaHealth?.error) ? (
        <div
          className="toast toast-error"
          role="alert"
          style={{ bottom: 42 + (toast ? 52 : 0) + (workspaceSaveError ? 52 : 0), maxWidth: 500 }}
          title={ollamaHealth.result?.error ?? ollamaHealth.error}
        >
          <CircleAlert size={16} />
          <span>{t("app.ollamaUnavailable", { endpoint: ollamaHealth.result?.endpoint ?? "Ollama" })}</span>
          <Button variant="ghost" loading={ollamaHealth.checking} onClick={recheckOllama}>{t("app.ollamaRecheck")}</Button>
        </div>
      ) : null}
    </div>
  );
}

function primeAgentModelRef(defaults?: PrimeAgentDefaults) {
  const provider = defaults?.defaultProvider?.trim();
  const model = defaults?.defaultModel?.trim();
  return provider && model ? `${provider}/${model}` : undefined;
}

function CloseDecisionModal({ dontAskAgain, pendingAction, error, onDontAskAgain, onClose, onAction }: {
  dontAskAgain: boolean;
  pendingAction?: "minimize" | "quit";
  error?: string;
  onDontAskAgain: (checked: boolean) => void;
  onClose: () => void;
  onAction: (action: "minimize" | "quit") => void;
}) {
  const { t } = useI18n();
  const busy = Boolean(pendingAction);
  return (
    <Modal
      title={t("app.closeTitle")}
      description={t("app.closeDescription")}
      width="600px"
      onClose={onClose}
    >
      <div className="close-decision-options">
        <button type="button" className="close-decision-option is-primary" disabled={busy} data-modal-autofocus="" onClick={() => onAction("minimize")}><span>{pendingAction === "minimize" ? <LoaderCircle size={20} className="spin" /> : <Minimize2 size={20} />}</span><div><strong>{t("app.closeMinimize")}</strong><p>{t("app.closeMinimizeText")}</p></div></button>
        <button type="button" className="close-decision-option is-quit" disabled={busy} onClick={() => onAction("quit")}><span>{pendingAction === "quit" ? <LoaderCircle size={20} className="spin" /> : <Power size={20} />}</span><div><strong>{t("app.closeQuit")}</strong><p>{t("app.closeQuitText")}</p></div></button>
      </div>
      <label className="close-remember-option">
        <input type="checkbox" checked={dontAskAgain} disabled={busy} onChange={(event) => onDontAskAgain(event.target.checked)} />
        <span className="close-remember-checkbox" aria-hidden="true">{dontAskAgain ? <Check size={13} /> : null}</span>
        <span><strong>{t("app.closeDontAskAgain")}</strong><small>{t("app.closeRememberText")}</small></span>
      </label>
      {error ? <div className="close-decision-error" role="alert"><CircleAlert size={16} /><span>{error}</span></div> : null}
    </Modal>
  );
}

function RenameProjectModal({ project, onClose, onConfirm }: { project: Project; onClose: () => void; onConfirm: (project: Project, name: string) => void }) {
  const { t } = useI18n();
  const [name, setName] = useState(project.name);
  const normalized = name.trim();
  const confirm = () => {
    if (!normalized) return;
    onConfirm(project, normalized);
  };
  return (
    <Modal
      title={t("app.renameProjectTitle")}
      description={t("app.renameProjectDescription")}
      onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button><Button variant="primary" disabled={!normalized} onClick={confirm}>{t("app.renameProjectAction")}</Button></>}
    >
      <label className="confirmation-field">
        <span>{t("app.projectName")}</span>
        <input value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") confirm(); }} autoFocus data-modal-autofocus="" autoComplete="off" />
      </label>
    </Modal>
  );
}

function RenameConversationModal({ conversation, onClose, onConfirm }: { conversation: Conversation; onClose: () => void; onConfirm: (conversation: Conversation, name: string) => void }) {
  const { t } = useI18n();
  const [name, setName] = useState(conversation.title);
  const normalized = name.trim();
  const confirm = () => {
    if (!normalized) return;
    onConfirm(conversation, normalized);
  };
  return (
    <Modal
      title={t("app.renameConversationTitle")}
      description={t("app.renameConversationDescription")}
      onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button><Button variant="primary" disabled={!normalized} onClick={confirm}>{t("app.renameConversationAction")}</Button></>}
    >
      <label className="confirmation-field">
        <span>{t("app.conversationName")}</span>
        <input value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") confirm(); }} autoFocus data-modal-autofocus="" autoComplete="off" />
      </label>
    </Modal>
  );
}

function ArchiveProjectModal({ project, conversationCount, onClose, onConfirm }: { project: Project; conversationCount: number; onClose: () => void; onConfirm: (project: Project) => Promise<void> }) {
  const { t } = useI18n();
  const [archiving, setArchiving] = useState(false);
  const confirm = async () => {
    if (archiving || conversationCount === 0) return;
    setArchiving(true);
    try {
      await onConfirm(project);
    } finally {
      setArchiving(false);
    }
  };
  return (
    <Modal
      title={t("app.archiveProjectTitle", { name: project.name })}
      description={t("app.archiveProjectDescription")}
      onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose} disabled={archiving}>{t("common.cancel")}</Button><Button variant="primary" loading={archiving} disabled={conversationCount === 0} onClick={() => void confirm()}><Archive size={15} />{t("app.archiveProjectAction")}</Button></>}
    >
      <div className="delete-project-warning">
        <Archive size={20} />
        <div><strong>{t(conversationCount === 1 ? "app.archiveProjectConversations.one" : "app.archiveProjectConversations.other", { count: conversationCount })}</strong><p>{t("app.archiveProjectFilesKept")}</p></div>
      </div>
    </Modal>
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
