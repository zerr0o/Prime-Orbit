import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  Blocks,
  Bot,
  Check,
  ChevronRight,
  Clock3,
  Cloud,
  Code2,
  Cpu,
  Download,
  ExternalLink,
  FileJson2,
  Folder,
  FolderOpen,
  Globe2,
  HardDrive,
  HeartPulse,
  Image,
  Info,
  KeyRound,
  Laptop,
  LoaderCircle,
  Maximize2,
  Network,
  PackageCheck,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { deleteMcpServer, inspectPrimeAgentConnections, openPrimeAgentTerminal, readModelsJson, saveMcpServer, saveModelsJson, savePrimeAgentDefaults } from "../lib/bridge";
import { appUpdateProgressPercent } from "../lib/app-updater";
import { isCompleteModelReference, loadRlmPreferences, patchRlmPreferences, RLM_PREFERENCES_STORAGE_KEY, supportsRlmThinking, type RlmPreferences, type RlmThinkingPreference } from "../lib/rlm-preferences";
import { useI18n } from "../i18n";
import packageMetadata from "../../package.json";
import type { AppUpdateState, AppView, Conversation, McpAuthKind, McpScope, McpServerSummary, ModelInfo, OllamaHealth, PersistedAppState, PrimeAgentConnections, PrimeAgentDefaults, Project, RuntimeDetection, SettingsSectionId, ThinkingLevel } from "../types";
import { Badge, Button, EmptyState, Modal, Switch } from "./Ui";

interface HomeViewProps {
  projects: Project[];
  conversations: Conversation[];
  detection?: RuntimeDetection;
  onView: (view: AppView) => void;
  onProject: (id: string) => void;
  onConversation: (id: string) => void;
  onOpenProject: () => void;
  onNewConversation: () => void;
}

export function HomeView({ projects, conversations, detection, onView, onProject, onConversation, onOpenProject, onNewConversation }: HomeViewProps) {
  const { t } = useI18n();
  const visibleConversations = conversations.filter((conversation) => !conversation.archived && conversation.hasContent !== false);
  const active = visibleConversations.filter((conversation) => ["starting", "streaming", "tool", "queued"].includes(conversation.status));
  const recent = [...visibleConversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);
  return (
    <div className="page-scroll dashboard-page">
      <PageHeader eyebrow="PRIME ORBIT" title={t("home.greeting")} description={t("home.description")} actions={<><Button variant="secondary" onClick={onOpenProject}><FolderOpen size={16} />{t("home.openProject")}</Button><Button variant="primary" onClick={onNewConversation}><Plus size={16} />{t("app.newConversation")}</Button></>} />
      <div className="overview-strip">
        <OverviewMetric icon={<Folder size={18} />} value={projects.length} label={t("home.projects")} tone="purple" />
        <OverviewMetric icon={<Activity size={18} />} value={active.length} label={t("home.activeRuns")} tone="cyan" live={active.length > 0} />
        <OverviewMetric icon={<Bot size={18} />} value={visibleConversations.length} label={t("home.conversations")} tone="green" />
        <OverviewMetric
          icon={detection ? <HeartPulse size={18} /> : <LoaderCircle size={18} className="spin" />}
          value={!detection ? t("home.checking") : detection.installed ? t("home.operational") : t("home.toInstall")}
          label={detection ? `Prime Agent ${detection.version ?? ""}`.trim() : "Prime Agent"}
          tone={!detection ? "cyan" : detection.installed ? "green" : "orange"}
        />
      </div>

      {active.length ? (
        <section className="dashboard-section">
          <SectionHeader title={t("home.inProgress")} subtitle={t("home.inProgressSubtitle")} action={<button type="button" onClick={() => onView("runs")}>{t("home.viewAll")} <ArrowRight size={14} /></button>} />
          <div className="active-run-grid">{active.map((conversation) => { const project = projects.find((item) => item.id === conversation.projectId); return <button type="button" key={conversation.id} className="active-run-card" data-context-type="conversation" data-context-id={conversation.id} aria-haspopup="menu" onClick={() => onConversation(conversation.id)}><span className="active-run-signal"><i /></span><div className="run-card-copy"><div><span className="project-color" style={{ background: project?.color }} /><small>{project?.name}</small></div><strong>{conversation.title}</strong><p>{conversation.activities.at(-1)?.title ?? t("home.agentWorking")}</p></div><div className="run-card-state"><LoaderCircle size={17} className="spin" /><small>{conversation.status === "tool" ? t("home.tool") : t("home.inProgress")}</small></div></button>; })}</div>
        </section>
      ) : null}

      <div className="dashboard-columns">
        <section className="dashboard-section recent-work">
          <SectionHeader title={t("home.recent")} subtitle={t("home.recentSubtitle")} action={<button type="button" onClick={() => onView("projects")}>{t("home.browse")} <ArrowRight size={14} /></button>} />
          {recent.length ? <div className="recent-list">{recent.map((conversation) => { const project = projects.find((item) => item.id === conversation.projectId); return <button type="button" key={conversation.id} data-context-type="conversation" data-context-id={conversation.id} aria-haspopup="menu" onClick={() => onConversation(conversation.id)}><span className="recent-project-icon" style={{ "--project-color": project?.color } as React.CSSProperties}><Folder size={17} /></span><span><strong>{conversation.title}</strong><small>{project?.name} · {relativeTime(conversation.updatedAt, t)}</small></span><Badge tone={conversation.status === "error" ? "danger" : "neutral"}>{conversation.status === "error" ? t("home.error") : shortModel(conversation.model) ?? t("common.default")}</Badge><ChevronRight size={16} /></button>; })}</div> : <EmptyState icon={<Sparkles size={24} />} title={t("home.startConversation")} description={t("home.recentEmpty")}><Button variant="primary" onClick={onNewConversation}>{t("home.start")}</Button></EmptyState>}
        </section>
        <aside className="dashboard-side">
          <section className="dashboard-section quick-start">
            <SectionHeader title={t("home.quickStart")} />
            <button type="button" onClick={onNewConversation}><span><Sparkles size={17} /></span><div><strong>{t("home.newTask")}</strong><small>{t("home.newTaskHint")}</small></div><ChevronRight size={15} /></button>
            <button type="button" onClick={onOpenProject}><span><FolderOpen size={17} /></span><div><strong>{t("home.openFolder")}</strong><small>{t("home.openFolderHint")}</small></div><ChevronRight size={15} /></button>
            <button type="button" onClick={() => onView("connections")}><span><Blocks size={17} /></span><div><strong>{t("home.connectTool")}</strong><small>{t("home.connectToolHint")}</small></div><ChevronRight size={15} /></button>
          </section>
          <section className="insight-card"><div className="insight-icon"><Zap size={18} /></div><div><Badge tone="accent">{t("home.tip")}</Badge><strong>{t("home.tipTitle")}</strong><p>{t("home.tipText")}</p></div></section>
        </aside>
      </div>

      <section className="dashboard-section project-row-section">
        <SectionHeader title={t("projects.title")} subtitle={t("home.workspaces", { count: projects.length })} action={<button type="button" onClick={() => onView("projects")}>{t("home.manageProjects")} <ArrowRight size={14} /></button>} />
        <div className="project-row">{projects.slice(0, 4).map((project) => { const count = visibleConversations.filter((conversation) => conversation.projectId === project.id).length; return <button type="button" key={project.id} data-context-type="project" data-context-id={project.id} aria-haspopup="menu" onClick={() => onProject(project.id)}><span className="project-folder-visual" style={{ "--folder-accent": project.color } as React.CSSProperties}><Folder size={23} /></span><div><strong>{project.name}</strong><small>{t(count === 1 ? "home.conversation.one" : "home.conversation.other", { count })}</small><span>{shortPath(project.path)}</span></div>{project.pinned ? <Pin size={14} /> : null}</button>; })}<button type="button" className="add-project-tile" onClick={onOpenProject}><Plus size={22} /><strong>{t("home.addProject")}</strong><small>{t("home.addProjectHint")}</small></button></div>
      </section>
    </div>
  );
}

export function ProjectsView({ projects, conversations, onProject, onOpenProject, onDeleteProject }: { projects: Project[]; conversations: Conversation[]; onProject: (id: string) => void; onOpenProject: () => void; onDeleteProject: (project: Project) => void }) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "pinned" | "recent">("all");
  const filtered = [...projects]
    .filter((project) => `${project.name} ${project.path}`.toLowerCase().includes(search.toLowerCase()))
    .filter((project) => filter !== "pinned" || project.pinned)
    .sort((a, b) => filter === "recent" ? b.lastOpenedAt.localeCompare(a.lastOpenedAt) : 0);
  return (
    <div className="page-scroll standard-page">
      <PageHeader eyebrow={t("projects.eyebrow")} title={t("projects.title")} description={t("projects.description")} actions={<Button variant="primary" onClick={onOpenProject}><FolderOpen size={16} />{t("home.openFolder")}</Button>} />
      <div className="page-tools"><div className="large-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("projects.search")} /></div><div className="segmented"><button type="button" className={filter === "all" ? "is-active" : ""} onClick={() => setFilter("all")}>{t("projects.all")}</button><button type="button" className={filter === "pinned" ? "is-active" : ""} onClick={() => setFilter("pinned")}>{t("projects.pinned")}</button><button type="button" className={filter === "recent" ? "is-active" : ""} onClick={() => setFilter("recent")}>{t("projects.recent")}</button></div></div>
      {filtered.length ? <div className="projects-grid">{filtered.map((project) => { const items = conversations.filter((conversation) => conversation.projectId === project.id && !conversation.archived && conversation.hasContent !== false); const active = items.filter((conversation) => ["streaming", "tool", "queued", "starting"].includes(conversation.status)).length; return <div key={project.id} className="project-card-shell" data-context-type="project" data-context-id={project.id}><button type="button" className="project-card" aria-haspopup="menu" onClick={() => onProject(project.id)}><header><span className="large-project-icon" style={{ "--project-color": project.color } as React.CSSProperties}><Folder size={24} /></span><span className="project-card-badges">{project.pinned ? <Pin size={14} /> : null}{active ? <Badge tone="success">{t("projects.active", { count: active })}</Badge> : null}</span></header><h3>{project.name}</h3><p>{project.path}</p><div className="project-card-stats"><span><Bot size={14} />{t(items.length === 1 ? "home.conversation.one" : "home.conversation.other", { count: items.length })}</span><span><Clock3 size={14} />{relativeTime(project.lastOpenedAt, t)}</span></div><footer><span className="preset-dot" />{t("projects.runtimePermissions")}<ChevronRight size={15} /></footer></button><button type="button" className="project-delete-button" aria-label={t("projects.deleteLabel", { name: project.name })} title={t("projects.deleteTitle")} onClick={() => onDeleteProject(project)}><Trash2 size={15} /></button></div>; })}<button type="button" className="project-card project-card-add" onClick={onOpenProject}><span><Plus size={28} /></span><h3>{t("home.addProject")}</h3><p>{t("projects.addText")}</p></button></div> : <EmptyState icon={<FolderOpen size={28} />} title={t("projects.empty")} description={search ? t("projects.emptySearch") : filter === "pinned" ? t("projects.emptyPinned") : t("projects.emptyDefault")}><Button variant="primary" onClick={onOpenProject}>{t("home.openFolder")}</Button></EmptyState>}
    </div>
  );
}

export function RunsView({ projects, conversations, onConversation }: { projects: Project[]; conversations: Conversation[]; onConversation: (id: string) => void }) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<"all" | "active" | "error">("all");
  const runs = [...conversations].filter((conversation) => !conversation.archived && conversation.hasContent !== false && (filter === "all" || (filter === "active" ? ["streaming", "tool", "queued", "starting"].includes(conversation.status) : conversation.status === "error"))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <div className="page-scroll standard-page">
      <PageHeader eyebrow={t("runs.eyebrow")} title={t("runs.title")} description={t("runs.description")} />
      <div className="page-tools"><div className="segmented"><button type="button" className={filter === "all" ? "is-active" : ""} onClick={() => setFilter("all")}>{t("runs.all")}</button><button type="button" className={filter === "active" ? "is-active" : ""} onClick={() => setFilter("active")}>{t("runs.active")}</button><button type="button" className={filter === "error" ? "is-active" : ""} onClick={() => setFilter("error")}>{t("runs.verify")}</button></div></div>
      <div className="runs-table"><header><span>{t("runs.conversation")}</span><span>{t("runs.project")}</span><span>{t("runs.state")}</span><span>{t("runs.model")}</span><span>{t("runs.updated")}</span><span /></header>{runs.map((conversation) => { const project = projects.find((item) => item.id === conversation.projectId); return <button type="button" key={conversation.id} data-context-type="conversation" data-context-id={conversation.id} aria-haspopup="menu" onClick={() => onConversation(conversation.id)}><span className="run-title-cell"><i className={`conversation-status status-${conversation.status}`} /><span><strong>{conversation.title}</strong><small>{conversation.activities.at(-1)?.title ?? t("common.ready")}</small></span></span><span><span className="project-color" style={{ background: project?.color }} />{project?.name}</span><span><Badge tone={conversation.status === "error" ? "danger" : ["streaming", "tool", "starting", "queued"].includes(conversation.status) ? "accent" : "neutral"}>{runStatus(conversation.status, t)}</Badge></span><span className="mono">{shortModel(conversation.model) ?? t("common.default")}</span><span>{relativeTime(conversation.updatedAt, t)}</span><ChevronRight size={15} /></button>; })}</div>
    </div>
  );
}

export function ConnectionsView({ models, projectPath, ollamaHealth, ollamaHealthChecking, onCheckOllama, onOpenSetup }: { models: ModelInfo[]; projectPath?: string; ollamaHealth?: OllamaHealth; ollamaHealthChecking: boolean; onCheckOllama: () => void; onOpenSetup: (kind: "provider" | "mcp") => void }) {
  const { t } = useI18n();
  const providers = useMemo(() => {
    const map = new Map<string, ModelInfo[]>();
    for (const model of models) map.set(model.provider, [...(map.get(model.provider) ?? []), model]);
    return Array.from(map.entries());
  }, [models]);
  const [connectionSnapshot, setConnectionSnapshot] = useState<{ projectPath?: string; data: PrimeAgentConnections }>();
  const [loadingConnections, setLoadingConnections] = useState(true);
  const [notice, setNotice] = useState<{ tone: "success" | "error" | "info"; message: string }>();
  const [mcpEditor, setMcpEditor] = useState<McpEditorDraft>();
  const [mcpToDelete, setMcpToDelete] = useState<McpServerSummary>();
  const refreshGeneration = useRef(0);
  const activeProjectPath = useRef(projectPath);
  activeProjectPath.current = projectPath;
  const connections = connectionSnapshot && connectionSnapshot.projectPath === projectPath ? connectionSnapshot.data : undefined;

  const refreshConnections = useCallback(async (requestedProjectPath?: string) => {
    const generation = ++refreshGeneration.current;
    setLoadingConnections(true);
    try {
      const data = await inspectPrimeAgentConnections(requestedProjectPath);
      if (refreshGeneration.current !== generation) return;
      setConnectionSnapshot({ projectPath: requestedProjectPath, data });
    } catch (error) {
      if (refreshGeneration.current !== generation) return;
      setNotice({ tone: "error", message: t("connections.readFailed", { error: error instanceof Error ? error.message : String(error) }) });
    } finally {
      if (refreshGeneration.current === generation) setLoadingConnections(false);
    }
  }, [t]);

  useEffect(() => {
    setNotice(undefined);
    setMcpEditor(undefined);
    setMcpToDelete(undefined);
    void refreshConnections(projectPath);
    return () => {
      refreshGeneration.current += 1;
    };
  }, [projectPath, refreshConnections]);

  const openOfficialSetup = async (command: string, label: string) => {
    if (!projectPath) {
      setNotice({ tone: "error", message: t("connections.openProjectFirst") });
      return;
    }
    try {
      await navigator.clipboard.writeText(command).catch(() => undefined);
      await openPrimeAgentTerminal(projectPath);
      setNotice({ tone: "success", message: t("connections.commandCopied", { label, command }) });
    } catch (error) {
      setNotice({ tone: "error", message: t("app.openAgentFailed", { error: error instanceof Error ? error.message : String(error) }) });
    }
  };

  const saveMcp = async (draft: McpEditorDraft) => {
    const ownerProjectPath = projectPath;
    try {
      await saveMcpServer(ownerProjectPath, draft.scope, {
        name: draft.name.trim(),
        url: draft.url.trim(),
        enabled: draft.enabled,
        authKind: draft.authKind,
        ...(draft.authKind === "bearer-env" ? { bearerTokenEnvVar: draft.bearerTokenEnvVar.trim() } : {}),
      });
      if (activeProjectPath.current !== ownerProjectPath) return;
      setMcpEditor(undefined);
      await refreshConnections(ownerProjectPath);
      if (activeProjectPath.current !== ownerProjectPath) return;
      setNotice({ tone: "success", message: t("connections.mcpSaved", { name: draft.name }) });
    } catch (error) {
      if (activeProjectPath.current !== ownerProjectPath) return;
      setNotice({ tone: "error", message: t("connections.mcpRejected", { error: error instanceof Error ? error.message : String(error) }) });
    }
  };

  const removeMcp = async (server: McpServerSummary) => {
    const ownerProjectPath = projectPath;
    try {
      await deleteMcpServer(ownerProjectPath, server.scope, server.name);
      if (activeProjectPath.current !== ownerProjectPath) return;
      setMcpToDelete(undefined);
      await refreshConnections(ownerProjectPath);
      if (activeProjectPath.current !== ownerProjectPath) return;
      setNotice({ tone: "success", message: t(server.scope === "project" ? "connections.mcpRemovedProject" : "connections.mcpRemovedGlobal", { name: server.name }) });
    } catch (error) {
      if (activeProjectPath.current !== ownerProjectPath) return;
      setNotice({ tone: "error", message: t("connections.mcpDeleteFailed", { error: error instanceof Error ? error.message : String(error) }) });
    }
  };

  const known = [
    { id: "prime-inference", aliases: ["prime-inference"], name: "Prime Inference", icon: Sparkles, description: t("connections.providerPrime") },
    { id: "anthropic", aliases: ["anthropic"], name: "Anthropic", icon: Cloud, description: t("connections.providerAnthropic") },
    { id: "openai", aliases: ["openai", "openai-codex"], name: "OpenAI", icon: Bot, description: t("connections.providerOpenAI") },
    { id: "ollama", aliases: ["ollama"], name: "Ollama", icon: Laptop, description: t("connections.providerOllama") },
    { id: "openrouter", aliases: ["openrouter"], name: "OpenRouter", icon: Network, description: t("connections.providerOpenRouter") },
  ];
  const providerIds = (connections?.providerIds ?? []).filter((id) => !id.startsWith("mcp:"));
  const customMcp = (connections?.mcpServers ?? []).filter((server) => !server.builtin);
  const builtinMcp = (name: string) => connections?.mcpServers.find((server) => server.builtin && server.name.toLowerCase() === name);
  return (
    <div className="page-scroll standard-page connections-page">
      <PageHeader eyebrow={t("connections.eyebrow")} title={t("connections.title")} description={t("connections.description")} actions={<><Button variant="ghost" loading={loadingConnections || ollamaHealthChecking} onClick={() => { void refreshConnections(projectPath); onCheckOllama(); }}><RefreshCw size={15} />{t("common.refresh")}</Button><Button variant="secondary" onClick={() => onOpenSetup("provider")}><Settings2 size={16} />{t("connections.officialGuide")}</Button></>} />
      {notice ? <div className={`connection-notice is-${notice.tone}`}><Info size={16} /><span>{notice.message}</span><button type="button" onClick={() => setNotice(undefined)} aria-label={t("connections.closeNotice")}><X size={14} /></button></div> : null}
      <section className="connections-section">
        <SectionHeader title={t("connections.providers")} subtitle={t("connections.providerSummary", { auth: providerIds.length, catalogs: providers.length })} />
        <div className="provider-grid">{known.map((provider) => {
          const connectedModels = providers.filter(([id]) => provider.aliases.includes(id)).flatMap(([, entries]) => entries);
          const configuredIds = providerIds.filter((id) => provider.aliases.some((alias) => id === alias || id.startsWith(`${alias}:`)));
          const configured = configuredIds.length > 0 || connectedModels.length > 0;
          const isOllama = provider.id === "ollama";
          const ProviderIcon = provider.icon;
          const status = isOllama && ollamaHealthChecking
            ? t("connections.ollamaChecking")
            : isOllama && ollamaHealth?.reachable && ollamaHealth.verified
              ? t("connections.ollamaOnline", { latency: ollamaHealth.latencyMs })
              : isOllama && ollamaHealth?.reachable
                ? t("connections.ollamaEndpointReachable")
              : isOllama && ollamaHealth?.reachable === false
                ? t("connections.ollamaUnavailable")
                : provider.id === "openai" && configuredIds.some((id) => id.startsWith("openai-codex"))
                  ? t("connections.codexConfigured")
                  : configuredIds.length
                    ? t("connections.authConfigured")
                    : connectedModels.length
                      ? t("connections.modelsAvailable", { count: connectedModels.length })
                      : t("connections.notConfigured");
          const providerOnline = configured && (!isOllama || (ollamaHealth?.reachable === true && ollamaHealth.verified));
          const retryOllama = isOllama && configured && (ollamaHealthChecking || ollamaHealth?.reachable === false);
          const providerFooterStatus = !configured
            ? t("connections.toConnect")
            : isOllama && ollamaHealthChecking
              ? t("connections.ollamaChecking")
              : isOllama && ollamaHealth?.reachable === false
                ? t("connections.ollamaUnavailable")
                : isOllama && ollamaHealth?.reachable && !ollamaHealth.verified
                  ? t("connections.ollamaEndpointReachable")
                  : t("connections.configured");
          return <article key={provider.id} className="provider-card"><header><span className={`connection-logo logo-${provider.id}`}><ProviderIcon size={22} /></span><div><h3>{provider.name}</h3><p>{provider.description}</p></div><span className={`status-dot ${providerOnline ? "is-online" : ""}`} /></header><div className="provider-card-meta"><span>{status}</span>{connectedModels.some((model) => model.input?.includes("image")) ? <Badge><Image size={12} /> Vision</Badge> : null}</div><footer>{providerOnline ? <span><Check size={14} />{providerFooterStatus}</span> : <span className="muted-status">{providerFooterStatus}</span>}<Button variant={configured ? "ghost" : "secondary"} loading={retryOllama && ollamaHealthChecking} onClick={() => retryOllama ? onCheckOllama() : void openOfficialSetup("/login", `${t("common.manage")} ${provider.name}.`)}>{retryOllama ? <RefreshCw size={14} /> : configured ? <Settings2 size={14} /> : <KeyRound size={14} />}{retryOllama ? t("app.ollamaRecheck") : configured ? t("common.manage") : t("common.configure")}</Button></footer></article>;
        })}</div>
      </section>
      <section className="connections-section">
        <SectionHeader title={t("connections.mcpTitle")} subtitle={t("connections.mcpSubtitle")} action={<><Button variant="ghost" onClick={() => void openOfficialSetup("/mcp list", t("connections.mcpTitle"))}><Terminal size={15} />{t("connections.openMcp")}</Button><Button variant="secondary" onClick={() => setMcpEditor(emptyMcpDraft(Boolean(projectPath)))}><Plus size={15} />{t("connections.addServer")}</Button></>} />
        <div className="mcp-grid">
          <McpCard name="Linear" description="Issues, projects & cycles" color="#5e6ad2" status={builtinMcp("linear")?.enabled ? t("connections.oauthConfigured") : t("connections.oauthRequired")} connected={Boolean(builtinMcp("linear")?.enabled)} actionLabel={builtinMcp("linear")?.enabled ? t("common.manage") : t("common.connect")} onConfigure={() => void openOfficialSetup("/mcp login linear", `${t("common.configure")} Linear.`)} />
          <McpCard name="Notion" description="Pages, databases & search" color="#f4f4f2" status={builtinMcp("notion")?.enabled ? t("connections.oauthConfigured") : t("connections.oauthRequired")} connected={Boolean(builtinMcp("notion")?.enabled)} dark actionLabel={builtinMcp("notion")?.enabled ? t("common.manage") : t("common.connect")} onConfigure={() => void openOfficialSetup("/mcp login notion", `${t("common.configure")} Notion.`)} />
          {customMcp.map((server) => { const deletable = Boolean(server.url); const editable = deletable && !server.hasCustomHeaders; const status = !deletable ? t("connections.kernelUnsupported") : !server.enabled ? t("connections.disabled") : server.hasCustomHeaders ? t("connections.customHeaders") : authKindLabel(server.authKind, t); return <article key={`${server.scope}:${server.name}`} className="mcp-card"><span className="mcp-logo custom-server-logo"><Server size={18} /></span><div><strong>{server.name}</strong><p>{server.url ?? t("connections.stdioReadonly")}</p><small><span className={`status-dot ${server.enabled ? "is-online" : ""}`} />{status} · {server.scope === "project" ? t("connections.projectScope") : t("connections.globalScope")}</small></div><div className="mcp-card-actions"><Button variant="ghost" disabled={!editable} title={editable ? t("common.edit") : server.hasCustomHeaders ? t("connections.customHeadersReadonly") : t("connections.stdioEditDisabled")} onClick={() => setMcpEditor(mcpDraftFromServer(server))}>{t("common.edit")}</Button><button type="button" className="inline-danger" disabled={!deletable} aria-label={t("projects.deleteLabel", { name: server.name })} title={deletable ? t("common.delete") : t("connections.stdioKept")} onClick={() => setMcpToDelete(server)}><Trash2 size={14} /></button></div></article>; })}
          <button type="button" className="mcp-card mcp-custom" onClick={() => setMcpEditor(emptyMcpDraft(Boolean(projectPath)))}><span><Plus size={20} /></span><div><strong>{t("connections.customServer")}</strong><p>{t("connections.customServerText")}</p></div><ChevronRight size={16} /></button>
        </div>
        <p className="capability-note"><Info size={15} />{t("connections.capabilityNote")}</p>
      </section>
      <section className="connections-section"><SectionHeader title={t("connections.localCapabilities")} subtitle={t("connections.localCapabilitiesSubtitle")} /><div className="local-capabilities"><Capability icon={<Code2 size={18} />} title="IPython" description={t("connections.ipythonDescription")} status={t("connections.integrated")} /><Capability icon={<GitBranchIcon />} title="Git" description={t("connections.gitDescription")} status={t("common.detected")} /><Capability icon={<HardDrive size={18} />} title={t("connections.filesystem")} description={t("connections.filesystemDescription")} status={t("connections.localAccess")} /></div></section>
      {mcpEditor ? <McpEditorModal draft={mcpEditor} projectAvailable={Boolean(projectPath)} onClose={() => setMcpEditor(undefined)} onSave={saveMcp} /> : null}
      {mcpToDelete ? <Modal title={t("connections.deleteMcpTitle", { name: mcpToDelete.name })} description={t("connections.deleteMcpDescription")} onClose={() => setMcpToDelete(undefined)} footer={<><Button variant="secondary" onClick={() => setMcpToDelete(undefined)}>{t("common.cancel")}</Button><Button variant="danger" onClick={() => void removeMcp(mcpToDelete)}><Trash2 size={14} />{t("common.delete")}</Button></>}><div className="delete-project-warning"><Info size={19} /><div><strong>{t("connections.deleteMcpWarning")}</strong><p>{t("connections.deleteMcpText")}</p></div></div></Modal> : null}
    </div>
  );
}

interface McpEditorDraft {
  name: string;
  url: string;
  enabled: boolean;
  scope: McpScope;
  authKind: McpAuthKind;
  bearerTokenEnvVar: string;
  existing: boolean;
}

function emptyMcpDraft(projectAvailable: boolean): McpEditorDraft {
  return { name: "", url: "", enabled: true, scope: projectAvailable ? "project" : "global", authKind: "none", bearerTokenEnvVar: "", existing: false };
}

function mcpDraftFromServer(server: McpServerSummary): McpEditorDraft {
  return { name: server.name, url: server.url ?? "https://", enabled: server.enabled, scope: server.scope, authKind: server.authKind, bearerTokenEnvVar: "", existing: true };
}

function authKindLabel(kind: McpAuthKind, t: ReturnType<typeof useI18n>["t"]) {
  return kind === "oauth" ? "OAuth" : kind === "bearer-env" ? t("mcp.bearerVariable") : t("mcp.none");
}

function isValidMcpUrl(value: string, authKind: McpAuthKind) {
  if (!value || value.trim() !== value) return false;
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) return false;
    if (parsed.protocol === "https:") return true;
    const loopback = parsed.hostname === "localhost"
      || parsed.hostname === "[::1]"
      || /^127(?:\.\d{1,3}){3}$/.test(parsed.hostname);
    return loopback && authKind === "none";
  } catch {
    return false;
  }
}

function McpEditorModal({ draft: initialDraft, projectAvailable, onClose, onSave }: { draft: McpEditorDraft; projectAvailable: boolean; onClose: () => void; onSave: (draft: McpEditorDraft) => Promise<void> }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(initialDraft);
  const [saving, setSaving] = useState(false);
  const validName = /^[a-z][a-z0-9_]{0,63}$/.test(draft.name.trim()) && !["linear", "notion"].includes(draft.name.trim());
  const validUrl = isValidMcpUrl(draft.url, draft.authKind);
  const validEnv = draft.authKind !== "bearer-env" || /^[A-Z_][A-Z0-9_]*$/.test(draft.bearerTokenEnvVar.trim());
  const valid = validName && validUrl && validEnv && (draft.scope !== "project" || projectAvailable);
  const save = async () => {
    if (!valid || saving) return;
    setSaving(true);
    try { await onSave(draft); } finally { setSaving(false); }
  };
  return <Modal title={draft.existing ? t("mcp.editTitle", { name: draft.name }) : t("mcp.addTitle")} description={t("mcp.editorDescription")} onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button><Button variant="primary" loading={saving} disabled={!valid} onClick={() => void save()}><Check size={14} />{t("common.save")}</Button></>}><div className="mcp-editor-form"><label><span>{t("mcp.name")}</span><input value={draft.name} disabled={draft.existing} onChange={(event) => setDraft({ ...draft, name: event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "") })} placeholder="my_server" autoFocus={!draft.existing} />{draft.name && !validName ? <small>{t("mcp.nameHelp")}</small> : null}</label><label><span>HTTP URL</span><input value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="https://mcp.example.com" autoFocus={draft.existing} />{draft.url && !validUrl ? <small>{t("mcp.invalidUrl")}</small> : null}</label><div className="mcp-form-grid"><label><span>{t("mcp.scope")}</span><select value={draft.scope} disabled={draft.existing} onChange={(event) => setDraft({ ...draft, scope: event.target.value as McpScope })}><option value="global">{t("mcp.allProjects")}</option><option value="project" disabled={!projectAvailable}>{t("mcp.currentProject")}</option></select></label><label><span>{t("mcp.authentication")}</span><select value={draft.authKind} onChange={(event) => setDraft({ ...draft, authKind: event.target.value as McpAuthKind })}><option value="none">{t("mcp.none")}</option><option value="oauth">OAuth via Prime Agent</option><option value="bearer-env">{t("mcp.bearerVariable")}</option></select></label></div>{draft.authKind === "bearer-env" ? <label><span>{t("mcp.envName")}</span><input value={draft.bearerTokenEnvVar} onChange={(event) => setDraft({ ...draft, bearerTokenEnvVar: event.target.value.toUpperCase() })} placeholder="MY_MCP_TOKEN" /><small>{t("mcp.envHelp")}</small></label> : null}<div className="mcp-enabled-row"><div><strong>{t("mcp.enabled")}</strong><small>{t("mcp.enabledHelp")}</small></div><Switch checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} label={t("mcp.enableLabel")} /></div></div></Modal>;
}

function McpCard({ name, description, color, status, connected, dark, actionLabel, onConfigure }: { name: string; description: string; color: string; status: string; connected: boolean; dark?: boolean; actionLabel: string; onConfigure: () => void }) {
  return <article className="mcp-card"><span className={`mcp-logo ${dark ? "is-dark" : ""}`} style={{ background: color }}>{name.slice(0, 1)}</span><div><strong>{name}</strong><p>{description}</p><small><span className={`status-dot ${connected ? "is-online" : ""}`} />{status}</small></div><Button variant="ghost" onClick={onConfigure}>{actionLabel}</Button></article>;
}

function Capability({ icon, title, description, status }: { icon: React.ReactNode; title: string; description: string; status: string }) {
  return <article><span>{icon}</span><div><strong>{title}</strong><small>{description}</small></div><Badge tone="success">{status}</Badge></article>;
}

export function SettingsView({ section, onSectionChange, state, setState, detection, installState, appUpdate, models, primeAgentDefaults, primeAgentDefaultsLoading, primeAgentDefaultsError, onPrimeAgentDefaultsChange, onRefreshDetection, onInstall, onCheckAppUpdate, onDownloadAppUpdate, onInstallAppUpdate }: {
  section: SettingsSectionId;
  onSectionChange: (section: SettingsSectionId) => void;
  state: PersistedAppState;
  setState: (updater: (current: PersistedAppState) => PersistedAppState) => void;
  detection?: RuntimeDetection;
  installState: { running: boolean; outcome?: "success" | "error"; phase?: string; lines: string[] };
  appUpdate: AppUpdateState;
  models: ModelInfo[];
  primeAgentDefaults?: PrimeAgentDefaults;
  primeAgentDefaultsLoading: boolean;
  primeAgentDefaultsError?: string;
  onPrimeAgentDefaultsChange: (defaults: PrimeAgentDefaults) => void;
  onRefreshDetection: () => void;
  onInstall: () => Promise<void>;
  onCheckAppUpdate: () => Promise<void>;
  onDownloadAppUpdate: () => Promise<void>;
  onInstallAppUpdate: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [modelsEditor, setModelsEditor] = useState<{ path: string; content: string }>();
  const [modelSaveState, setModelSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const settingsSections = [
    { id: "general" as const, label: t("settings.general"), icon: Settings2 },
    { id: "appearance" as const, label: t("settings.appearance"), icon: Sparkles },
    { id: "agent" as const, label: "Prime Agent", icon: Bot },
    { id: "models" as const, label: t("settings.models"), icon: Cpu },
    { id: "security" as const, label: t("settings.security"), icon: ShieldCheck },
    { id: "about" as const, label: t("settings.about"), icon: Info },
  ];
  const prefs = state.preferences;
  const runtimeBroken = Boolean(detection && !detection.installed && detection.error);
  const patchPreferences = (patch: Partial<typeof prefs>) => setState((current) => ({ ...current, preferences: { ...current.preferences, ...patch } }));
  const openModels = async () => {
    try {
      const result = await readModelsJson();
      setModelsEditor(result);
    } catch {
      setModelsEditor({ path: "~/.prime/agent/models.json", content: "{}" });
    }
  };
  const saveModels = async () => {
    if (!modelsEditor) return;
    setModelSaveState("saving");
    try {
      JSON.parse(modelsEditor.content);
      await saveModelsJson(modelsEditor.content, modelsEditor.path);
      setModelSaveState("saved");
      window.setTimeout(() => setModelSaveState("idle"), 1600);
    } catch {
      setModelSaveState("error");
    }
  };
  return (
    <div className="settings-layout">
      <aside className="settings-nav"><div><p className="eyebrow">{t("settings.eyebrow")}</p><h1>{t("settings.title")}</h1></div><nav>{settingsSections.map((item) => { const ItemIcon = item.icon; return <button key={item.id} type="button" className={section === item.id ? "is-active" : ""} aria-current={section === item.id ? "page" : undefined} onClick={() => onSectionChange(item.id)}><ItemIcon size={16} />{item.label}</button>; })}</nav><footer><span className="mini-orbit"><span /></span><div><strong>Prime Orbit</strong><small>Version {packageMetadata.version}</small></div></footer></aside>
      <main className="settings-content">
        {section === "general" ? <SettingsSection title={t("settings.general")} description={t("settings.generalDescription")}><SettingsGroup title={t("settings.startup")}><SettingRow title={t("settings.restore")} description={t("settings.restoreText")}><Switch checked={prefs.restoreLastWorkspace} onChange={(restoreLastWorkspace) => patchPreferences({ restoreLastWorkspace })} label={t("settings.restore")} /></SettingRow><SettingRow title={t("settings.language")} description={t("settings.languageText")}><select value={prefs.language} onChange={(event) => patchPreferences({ language: event.target.value as "fr" | "en" })}><option value="fr">Français</option><option value="en">English</option></select></SettingRow></SettingsGroup></SettingsSection> : null}
        {section === "appearance" ? <SettingsSection title={t("settings.appearance")} description={t("settings.appearanceDescription")}><SettingsGroup title={t("settings.theme")}><div className="theme-picker">{(["dark", "light", "system"] as const).map((theme) => <button key={theme} type="button" className={prefs.theme === theme ? "is-active" : ""} onClick={() => patchPreferences({ theme })}><span className={`theme-preview theme-${theme}`}><i /><i /><i /></span><strong>{theme === "dark" ? t("settings.dark") : theme === "light" ? t("settings.lightTheme") : t("settings.system")}</strong>{prefs.theme === theme ? <Check size={15} /> : null}</button>)}</div></SettingsGroup><SettingsGroup title={t("settings.interface")}><SettingRow title={t("settings.compactSidebar")} description={t("settings.compactSidebarText")}><Switch checked={prefs.compactSidebar} onChange={(compactSidebar) => patchPreferences({ compactSidebar })} label={t("settings.compactSidebar")} /></SettingRow><SettingRow title={t("settings.reduceMotion")} description={t("settings.reduceMotionText")}><Switch checked={prefs.reduceMotion} onChange={(reduceMotion) => patchPreferences({ reduceMotion })} label={t("settings.reduceMotion")} /></SettingRow></SettingsGroup></SettingsSection> : null}
        {section === "agent" ? <SettingsSection title="Prime Agent" description={t("settings.agentDescription")}>
          <div className={`runtime-hero ${detection?.installed ? "is-ready" : runtimeBroken ? "is-broken" : "is-missing"}`}>
            <span>{detection?.installed ? <PackageCheck size={27} /> : runtimeBroken ? <ShieldAlert size={27} /> : <Download size={27} />}</span>
            <div>
              <Badge tone={detection?.installed ? "success" : runtimeBroken ? "danger" : "warning"}>{detection?.installed ? t("home.operational") : runtimeBroken ? t("settings.runtimeBroken") : t("settings.notInstalled")}</Badge>
              <h3>{detection?.installed ? `Prime Agent ${detection.version ?? ""}` : runtimeBroken ? t("settings.repairAgent") : t("settings.installAgent")}</h3>
              <p>{detection?.installed ? t("settings.detectedVia", { mode: detection.mode ?? t("settings.system"), executable: detection.executable ?? "prime-agent" }) : runtimeBroken ? t("settings.runtimeBrokenText") : t("settings.managedInstallText")}</p>
            </div>
            <div>
              <Button variant="secondary" onClick={onRefreshDetection}><RefreshCw size={15} />{t("settings.recheck")}</Button>
              <Button variant="primary" loading={installState.running} onClick={() => void onInstall()}><Download size={15} />{t("settings.managedInstall")}</Button>
            </div>
          </div>
          {runtimeBroken ? <div className="runtime-diagnostic" role="alert"><ShieldAlert size={17} /><pre>{detection?.error}</pre></div> : null}
          {installState.running || installState.lines.length ? <div className="install-progress"><header><span><LoaderCircle size={15} className={installState.running ? "spin" : ""} />{installState.phase ?? t("settings.installation")}</span><small>{installState.running ? t("common.running") : installState.outcome === "error" ? t("common.failed") : t("common.complete")}</small></header><pre>{installState.lines.slice(-18).join("\n")}</pre></div> : null}
          <SettingsGroup title={t("settings.prerequisites")}>{(detection?.prerequisites ?? []).map((item) => <SettingRow key={item.name} title={item.name} description={item.path ?? t("common.systemComponent")}><Badge tone={item.found ? "success" : "danger"}>{item.found ? item.version ?? t("common.detected") : t("common.missing")}</Badge></SettingRow>)}</SettingsGroup>
          <div className="warning-card"><ShieldAlert size={19} /><div><strong>{t("settings.notSandbox")}</strong><p>{t("settings.notSandboxText")}</p></div></div>
        </SettingsSection> : null}
        {section === "models" ? <SettingsSection title={t("settings.models")} description={t("settings.modelsDescription")}><AgentDefaultsSettings models={models} defaults={primeAgentDefaults} loading={primeAgentDefaultsLoading} loadError={primeAgentDefaultsError} runtimeVersion={detection?.version} runtimeInstalled={Boolean(detection?.installed)} localThinking={prefs.defaultThinking} onLocalThinkingChange={(defaultThinking) => patchPreferences({ defaultThinking })} onDefaultsChange={onPrimeAgentDefaultsChange} onUpdatePrimeAgent={onInstall} /><div className="settings-callout"><FileJson2 size={22} /><div><h3>{t("settings.customCatalog")}</h3><p>{t("settings.customCatalogText")}</p></div><Button variant="secondary" onClick={() => void openModels()}><FileJson2 size={15} />{t("settings.openEditor")}</Button></div></SettingsSection> : null}
        {section === "security" ? <SettingsSection title={t("settings.security")} description={t("settings.securityDescription")}><div className="security-principles"><SecurityPrinciple icon={<Folder size={18} />} title={t("settings.visibleFolder")} text={t("settings.visibleFolderText")} /><SecurityPrinciple icon={<Terminal size={18} />} title={t("settings.inspectableCommands")} text={t("settings.inspectableCommandsText")} /><SecurityPrinciple icon={<ShieldAlert size={18} />} title={t("settings.noImplicitIsolation")} text={t("settings.noImplicitIsolationText")} /></div><div className="warning-card"><Info size={19} /><div><strong>{t("settings.realIsolation")}</strong><p>{t("settings.realIsolationText")}</p></div></div></SettingsSection> : null}
        {section === "about" ? <SettingsSection title={t("settings.about")} description={t("settings.aboutDescription")}><SettingsGroup title={t("settings.updates")}><AppUpdatePanel state={appUpdate} onCheck={onCheckAppUpdate} onDownload={onDownloadAppUpdate} onInstall={onInstallAppUpdate} /><SettingRow title={t("settings.autoUpdateChecks")} description={t("settings.autoUpdateChecksText")}><Switch checked={prefs.automaticUpdateChecks} onChange={(automaticUpdateChecks) => patchPreferences({ automaticUpdateChecks })} label={t("settings.autoUpdateChecks")} /></SettingRow></SettingsGroup><div className="about-card"><span className="about-orbit"><span /></span><h2>Prime Orbit</h2><p>{t("settings.aboutText")}</p><Badge tone="accent">Version {packageMetadata.version} · Preview</Badge><div><a href="https://github.com/PrimeIntellect-ai/prime-agent" target="_blank" rel="noreferrer"><Code2 size={15} />Prime Agent<ExternalLink size={12} /></a><a href="https://github.com/PrimeIntellect-ai/prime-agent/blob/main/LICENSE" target="_blank" rel="noreferrer"><Globe2 size={15} />{t("settings.licenses")}<ExternalLink size={12} /></a></div></div></SettingsSection> : null}
      </main>
      {modelsEditor ? <Modal title={t("settings.modelCatalog")} description={modelsEditor.path} width="820px" onClose={() => setModelsEditor(undefined)} footer={<><span className={`editor-status is-${modelSaveState}`}>{modelSaveState === "error" ? t("settings.invalidJson") : modelSaveState === "saved" ? t("settings.saved") : t("settings.backupNotice")}</span><Button variant="secondary" onClick={() => setModelsEditor(undefined)}>{t("common.cancel")}</Button><Button variant="primary" loading={modelSaveState === "saving"} onClick={() => void saveModels()}>{t("settings.validateSave")}</Button></>}><textarea className="json-editor" value={modelsEditor.content} spellCheck={false} onChange={(event) => { setModelsEditor({ ...modelsEditor, content: event.target.value }); setModelSaveState("idle"); }} /></Modal> : null}
    </div>
  );
}

const THINKING_LEVELS: Array<{ value: ThinkingLevel; label: "settings.thinkingOff" | "settings.thinkingMinimal" | "settings.thinkingLow" | "settings.thinkingMedium" | "settings.thinkingHigh" | "settings.thinkingXhigh" | "settings.thinkingMax" }> = [
  { value: "off", label: "settings.thinkingOff" },
  { value: "minimal", label: "settings.thinkingMinimal" },
  { value: "low", label: "settings.thinkingLow" },
  { value: "medium", label: "settings.thinkingMedium" },
  { value: "high", label: "settings.thinkingHigh" },
  { value: "xhigh", label: "settings.thinkingXhigh" },
  { value: "max", label: "settings.thinkingMax" },
];

function AgentDefaultsSettings({ models, defaults, loading, loadError, runtimeVersion, runtimeInstalled, localThinking, onLocalThinkingChange, onDefaultsChange, onUpdatePrimeAgent }: {
  models: ModelInfo[];
  defaults?: PrimeAgentDefaults;
  loading: boolean;
  loadError?: string;
  runtimeVersion?: string;
  runtimeInstalled: boolean;
  localThinking: ThinkingLevel;
  onLocalThinkingChange: (thinking: ThinkingLevel) => void;
  onDefaultsChange: (defaults: PrimeAgentDefaults) => void;
  onUpdatePrimeAgent: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [mainModel, setMainModel] = useState(() => modelRef(defaults));
  const [mainThinking, setMainThinking] = useState<ThinkingLevel>(defaults?.defaultThinkingLevel ?? localThinking);
  const [mainDirty, setMainDirty] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string>();
  const [rlmPreferences, setRlmPreferences] = useState<RlmPreferences>(() => loadRlmPreferences());
  const [updatingRuntime, setUpdatingRuntime] = useState(false);
  const rlmThinkingAvailable = supportsRlmThinking(runtimeVersion);
  const rlmModelInvalid = Boolean(rlmPreferences.preferredModel && !isCompleteModelReference(rlmPreferences.preferredModel));

  useEffect(() => {
    if (mainDirty) return;
    setMainModel(modelRef(defaults));
    setMainThinking(defaults?.defaultThinkingLevel ?? localThinking);
  }, [defaults, localThinking, mainDirty]);

  useEffect(() => {
    const synchronizeRlmPreferences = (event: StorageEvent) => {
      if (event.storageArea === window.localStorage && event.key === RLM_PREFERENCES_STORAGE_KEY) {
        setRlmPreferences(loadRlmPreferences());
      }
    };
    window.addEventListener("storage", synchronizeRlmPreferences);
    return () => window.removeEventListener("storage", synchronizeRlmPreferences);
  }, []);

  const modelGroups = useMemo(() => {
    const groups = new Map<string, Array<ModelInfo & { ref: string }>>();
    const seen = new Set<string>();
    for (const model of models) {
      const ref = `${model.provider}/${model.id}`;
      if (seen.has(ref)) continue;
      seen.add(ref);
      groups.set(model.provider, [...(groups.get(model.provider) ?? []), { ...model, ref }]);
    }
    return [...groups.entries()].map(([provider, entries]) => [
      provider,
      entries.sort((left, right) => (left.name ?? left.id).localeCompare(right.name ?? right.id)),
    ] as const).sort(([left], [right]) => left.localeCompare(right));
  }, [models]);
  const knownModelRefs = useMemo(() => new Set(modelGroups.flatMap(([, entries]) => entries.map((model) => model.ref))), [modelGroups]);

  const changeMainModel = (value: string) => {
    setMainModel(value || undefined);
    setMainDirty(true);
    setSaveState("idle");
  };
  const changeMainThinking = (value: ThinkingLevel) => {
    setMainThinking(value);
    setMainDirty(true);
    setSaveState("idle");
  };
  const saveDefaults = async () => {
    if (saveState === "saving" || !runtimeInstalled) return;
    if (mainModel && !isCompleteModelReference(mainModel)) {
      setSaveError(t("settings.modelReferenceInvalid"));
      setSaveState("error");
      return;
    }
    const parsed = splitModelRef(mainModel);
    setSaveState("saving");
    setSaveError(undefined);
    try {
      const result = await savePrimeAgentDefaults({
        defaultProvider: parsed?.provider ?? null,
        defaultModel: parsed?.model ?? null,
        defaultThinkingLevel: mainThinking,
      });
      onDefaultsChange(result.defaults);
      onLocalThinkingChange(result.defaults.defaultThinkingLevel ?? mainThinking);
      setMainDirty(false);
      setSaveState("saved");
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
      setSaveState("error");
    }
  };
  const changeRlmPreferences = (patch: Partial<RlmPreferences>) => {
    // Read the authoritative localStorage value again before merging so a
    // near-simultaneous edit from another Orbit window cannot be clobbered by
    // this component's stale React snapshot.
    setRlmPreferences(patchRlmPreferences(patch));
  };
  const updateRuntime = async () => {
    if (updatingRuntime) return;
    setUpdatingRuntime(true);
    try {
      await onUpdatePrimeAgent();
    } finally {
      setUpdatingRuntime(false);
    }
  };

  return (
    <>
      <SettingsGroup title={t("settings.mainAgent")}>
        <div className="settings-group-intro"><Bot size={16} /><span>{t("settings.mainAgentText")}</span></div>
        <SettingRow title={t("settings.defaultModel")} description={t("settings.defaultModelText")}>
          {modelGroups.length > 0 ? <select aria-label={t("settings.defaultModel")} value={mainModel ?? ""} disabled={loading || saveState === "saving" || !runtimeInstalled} onChange={(event) => changeMainModel(event.target.value)}>
              <option value="">{t("settings.inheritPrimeAgent")}</option>
              {mainModel && !knownModelRefs.has(mainModel) ? <option value={mainModel}>{mainModel}</option> : null}
              {modelGroups.map(([provider, entries]) => <optgroup key={provider} label={provider}>{entries.map((model) => <option key={model.ref} value={model.ref}>{model.name ?? model.id}</option>)}</optgroup>)}
            </select>
            : <input aria-label={t("settings.defaultModel")} value={mainModel ?? ""} placeholder={t("settings.modelReferencePlaceholder")} disabled={loading || saveState === "saving" || !runtimeInstalled} spellCheck={false} onChange={(event) => changeMainModel(event.target.value)} />}
        </SettingRow>
        <SettingRow title={t("settings.defaultReasoning")} description={t("settings.defaultReasoningText")}>
          <select aria-label={t("settings.defaultReasoning")} value={mainThinking} disabled={loading || saveState === "saving" || !runtimeInstalled} onChange={(event) => changeMainThinking(event.target.value as ThinkingLevel)}>
            {THINKING_LEVELS.map((level) => <option key={level.value} value={level.value}>{t(level.label)}</option>)}
          </select>
        </SettingRow>
        {modelGroups.length === 0 ? <div className="settings-inline-notice"><Info size={15} /><span>{t("settings.modelCatalogUnavailable")}</span></div> : null}
        {loading ? <div className="settings-inline-notice" role="status"><LoaderCircle size={15} className="spin" /><span>{t("settings.defaultsLoading")}</span></div> : null}
        {loadError ? <div className="settings-inline-notice is-error" role="alert"><ShieldAlert size={15} /><span>{t("settings.defaultsReadError", { error: loadError })}</span></div> : null}
        {saveError ? <div className="settings-inline-notice is-error" role="alert"><ShieldAlert size={15} /><span>{t("settings.defaultsSaveError", { error: saveError })}</span></div> : null}
        <div className="settings-group-actions"><span className={`settings-save-status is-${saveState}`} aria-live="polite">{saveState === "saved" ? <><Check size={14} />{t("settings.defaultsSaved")}</> : null}</span><Button variant="primary" loading={saveState === "saving"} disabled={!runtimeInstalled || loading || !mainDirty} onClick={() => void saveDefaults()}>{t("settings.saveDefaults")}</Button></div>
      </SettingsGroup>

      <SettingsGroup title={t("settings.subagents")}>
        <div className="settings-group-intro"><Blocks size={16} /><span>{t("settings.subagentsText")}</span></div>
        <SettingRow title={t("settings.subagentModel")} description={t("settings.subagentModelText")}>
          {modelGroups.length > 0 ? <select aria-label={t("settings.subagentModel")} value={rlmPreferences.preferredModel ?? ""} onChange={(event) => changeRlmPreferences({ preferredModel: event.target.value || undefined })}>
              <option value="">{t("settings.inheritMainAgent")}</option>
              {rlmPreferences.preferredModel && !knownModelRefs.has(rlmPreferences.preferredModel) ? <option value={rlmPreferences.preferredModel}>{rlmPreferences.preferredModel}</option> : null}
              {modelGroups.map(([provider, entries]) => <optgroup key={provider} label={provider}>{entries.map((model) => <option key={model.ref} value={model.ref}>{model.name ?? model.id}</option>)}</optgroup>)}
            </select>
            : <input aria-label={t("settings.subagentModel")} value={rlmPreferences.preferredModel ?? ""} placeholder={t("settings.modelReferencePlaceholder")} spellCheck={false} onChange={(event) => changeRlmPreferences({ preferredModel: event.target.value || undefined })} />}
        </SettingRow>
        <SettingRow title={t("settings.subagentThinking")} description={t("settings.subagentThinkingText")}>
          <select aria-label={t("settings.subagentThinking")} value={rlmPreferences.thinking} disabled={!rlmThinkingAvailable} onChange={(event) => changeRlmPreferences({ thinking: event.target.value as RlmThinkingPreference })}>
            <option value="inherit">{t("settings.inheritMainAgent")}</option>
            {THINKING_LEVELS.map((level) => <option key={level.value} value={level.value}>{t(level.label)}</option>)}
          </select>
        </SettingRow>
        {rlmModelInvalid ? <div className="settings-inline-notice is-error" role="alert"><ShieldAlert size={15} /><span>{t("settings.modelReferenceInvalid")}</span></div> : null}
        <div className="settings-inline-notice"><Info size={15} /><span>{t("settings.rlmStoredLocally")}</span></div>
        {!rlmThinkingAvailable ? <div className="settings-compatibility" role="status"><ShieldAlert size={18} /><div><strong>{t("settings.rlmUpdateRequired")}</strong><p>{t("settings.rlmUpdateRequiredText", { version: runtimeVersion ?? "?" })}</p></div><Button variant="secondary" loading={updatingRuntime} onClick={() => void updateRuntime()}>{t("settings.updatePrimeAgent")}</Button></div> : null}
      </SettingsGroup>
    </>
  );
}

function modelRef(defaults?: PrimeAgentDefaults) {
  const provider = defaults?.defaultProvider?.trim();
  const model = defaults?.defaultModel?.trim();
  return provider && model ? `${provider}/${model}` : undefined;
}

function splitModelRef(ref?: string) {
  if (!ref) return undefined;
  const value = ref.trim();
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return { provider: value.slice(0, separator), model: value.slice(separator + 1) };
}

export function Onboarding({ detection, installState, onInstall, onUseExisting, onContinue }: { detection?: RuntimeDetection; installState: { running: boolean; outcome?: "success" | "error"; phase?: string; lines: string[] }; onInstall: () => void; onUseExisting: () => void; onContinue: () => void }) {
  const { t } = useI18n();
  const runtimeBroken = Boolean(detection && !detection.installed && detection.error);
  return (
    <div className="onboarding-page"><div className="onboarding-ambient ambient-one" /><div className="onboarding-ambient ambient-two" /><header><span className="brand-mark"><span className="orbit-ring"><span /></span></span><strong>Prime Orbit</strong><Badge>{t("onboarding.preview")}</Badge></header><main><div className="onboarding-copy"><p className="eyebrow">{t("onboarding.welcome")}</p><h1>{t("onboarding.title")}<br /><span>{t("onboarding.forAgent")}</span></h1><p>{t("onboarding.description")}</p><ul><li><span><Folder size={17} /></span><div><strong>{t("onboarding.projectTitle")}</strong><small>{t("onboarding.projectText")}</small></div></li><li><span><Activity size={17} /></span><div><strong>{t("onboarding.activityTitle")}</strong><small>{t("onboarding.activityText")}</small></div></li><li><span><Maximize2 size={17} /></span><div><strong>{t("onboarding.windowsTitle")}</strong><small>{t("onboarding.windowsText")}</small></div></li></ul></div><section className={`onboarding-card ${runtimeBroken ? "has-runtime-error" : ""}`}><div className="setup-progress"><span className="is-done"><Check size={13} /></span><i /><span className={detection ? "is-current" : ""}>2</span><i /><span>3</span></div><div className="setup-icon">{detection?.installed ? <PackageCheck size={28} /> : runtimeBroken ? <ShieldAlert size={28} /> : <Download size={28} />}</div><Badge tone={detection?.installed ? "success" : runtimeBroken ? "danger" : "accent"}>{detection?.installed ? t("onboarding.installDetected") : runtimeBroken ? t("onboarding.installBroken") : t("onboarding.initialSetup")}</Badge><h2>{detection?.installed ? t("onboarding.agentReady", { version: detection.version ?? "" }) : runtimeBroken ? t("onboarding.repairTitle") : t("onboarding.chooseInstall")}</h2><p>{detection?.installed ? t("onboarding.existingText") : runtimeBroken ? t("onboarding.repairText") : t("onboarding.managedText")}</p>{runtimeBroken ? <pre className="onboarding-runtime-error" role="alert">{detection?.error}</pre> : null}{installState.lines.length ? <pre className="onboarding-logs">{installState.lines.slice(-10).join("\n")}</pre> : null}<div className="onboarding-actions">{detection?.installed ? <Button variant="primary" onClick={onContinue}>{t("onboarding.continue")} <ArrowRight size={15} /></Button> : <><Button variant="primary" loading={installState.running} onClick={onInstall}><Download size={15} />{t("onboarding.autoInstall")}</Button><Button variant="secondary" onClick={onUseExisting}><FolderOpen size={15} />{t("onboarding.useExisting")}</Button></>}</div><small className="setup-note"><ShieldCheck size={13} />{t("onboarding.noApiKey")}</small></section></main></div>
  );
}

function formatUpdateBytes(bytes: number | undefined, locale: string) {
  if (bytes === undefined || !Number.isFinite(bytes)) return undefined;
  const units = ["B", "KB", "MB", "GB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1_024 && unit < units.length - 1) {
    value /= 1_024;
    unit += 1;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value)} ${units[unit]}`;
}

function formatUpdateDate(value: string | undefined, locale: string) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function updateReleaseUrl(version: string) {
  const tag = version.startsWith("v") ? version : `v${version}`;
  return `https://github.com/zerr0o/Prime-Orbit/releases/tag/${encodeURIComponent(tag)}`;
}

function AppUpdatePanel({ state, onCheck, onDownload, onInstall }: {
  state: AppUpdateState;
  onCheck: () => Promise<void>;
  onDownload: () => Promise<void>;
  onInstall: () => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const progress = appUpdateProgressPercent(state);
  const downloaded = formatUpdateBytes(state.downloadedBytes, locale);
  const total = formatUpdateBytes(state.totalBytes, locale);
  const lastChecked = formatUpdateDate(state.lastCheckedAt, locale);
  const publishedAt = formatUpdateDate(state.update?.publishedAt, locale);
  const busy = state.phase === "checking" || state.phase === "downloading" || state.phase === "installing";

  let title = t("settings.currentVersion", { version: state.currentVersion });
  let description = t("settings.updateIdleText");
  let icon: React.ReactNode = <Info size={19} />;
  if (state.phase === "checking") {
    title = t("settings.checkingForUpdates");
    description = t("settings.updateCheckingText");
    icon = <LoaderCircle size={19} className="spin" />;
  } else if (state.phase === "upToDate") {
    title = t("settings.upToDate");
    description = t("settings.upToDateText", { version: state.currentVersion });
    icon = <Check size={19} />;
  } else if (state.phase === "available") {
    title = t("settings.updateAvailable", { version: state.update?.version ?? "" });
    description = t("settings.updateAvailableText");
    icon = <Download size={19} />;
  } else if (state.phase === "downloading") {
    title = t("settings.downloadingUpdate", { version: state.update?.version ?? "" });
    description = t("settings.updateDownloadText");
    icon = <LoaderCircle size={19} className="spin" />;
  } else if (state.phase === "ready") {
    title = t("settings.updateReady");
    description = t("settings.updateReadyText", { version: state.update?.version ?? "" });
    icon = <PackageCheck size={19} />;
  } else if (state.phase === "installing") {
    title = t("settings.installingUpdate");
    description = t("settings.installingUpdateText");
    icon = <LoaderCircle size={19} className="spin" />;
  } else if (state.phase === "error") {
    title = t("settings.updateFailed");
    description = t("settings.updateFailedText");
    icon = <ShieldAlert size={19} />;
  }

  const retryCheck = state.phase === "idle" || state.phase === "upToDate" || (state.phase === "error" && state.operation !== "download" && state.operation !== "install");
  const retryDownload = state.phase === "available" || (state.phase === "error" && state.operation === "download" && Boolean(state.update));
  const retryInstall = state.phase === "ready" || (state.phase === "error" && state.operation === "install" && Boolean(state.update));

  return (
    <section className={`update-panel is-${state.phase}`} aria-busy={busy} aria-labelledby="app-update-status-title">
      <div className="update-panel-main">
        <span className="update-status-icon" aria-hidden="true">{icon}</span>
        <div className="update-panel-copy" role="status" aria-live="polite" aria-atomic="true">
          <strong id="app-update-status-title">{title}</strong>
          <p>{description}</p>
          {lastChecked ? <small>{t("settings.lastChecked", { date: lastChecked })}</small> : null}
          {publishedAt && state.update ? <small>{t("settings.updatePublished", { date: publishedAt })}</small> : null}
        </div>
        <div className="update-panel-actions">
          {retryCheck ? <Button variant="secondary" onClick={() => void onCheck()}><RefreshCw size={15} />{state.phase === "error" ? t("settings.retryUpdate") : t("settings.checkForUpdates")}</Button> : null}
          {retryDownload ? <Button variant="primary" onClick={() => void onDownload()}><Download size={15} />{state.phase === "error" ? t("settings.retryUpdate") : t("settings.downloadUpdate")}</Button> : null}
          {retryInstall ? <Button variant="primary" onClick={() => void onInstall()}><PackageCheck size={15} />{state.phase === "error" ? t("settings.retryUpdate") : t("settings.restartAndUpdate")}</Button> : null}
        </div>
      </div>
      {state.phase === "downloading" ? <div className="update-progress"><progress max={state.totalBytes} value={state.totalBytes ? state.downloadedBytes ?? 0 : undefined} aria-label={t("settings.downloadingUpdate", { version: state.update?.version ?? "" })} aria-valuetext={progress !== undefined && downloaded && total ? t("settings.downloadProgress", { percent: progress, received: downloaded, total }) : downloaded ? t("settings.downloadProgressUnknown", { received: downloaded }) : t("settings.downloadStarting")} /><span className="update-progress-copy" aria-live="polite">{progress !== undefined && downloaded && total ? t("settings.downloadProgress", { percent: progress, received: downloaded, total }) : downloaded ? t("settings.downloadProgressUnknown", { received: downloaded }) : t("settings.downloadStarting")}</span></div> : null}
      {state.phase === "error" ? <div className="update-error-details" role="alert"><ShieldAlert size={15} /><span>{state.error ?? t("settings.updateUnknownError")}</span></div> : null}
      {state.update?.notes ? <details className="update-release-notes"><summary>{t("settings.releaseNotes")}</summary><p>{state.update.notes}</p><a href={updateReleaseUrl(state.update.version)} target="_blank" rel="noreferrer">{t("settings.openReleasePage")}<ExternalLink size={12} /></a></details> : null}
    </section>
  );
}

function PageHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: React.ReactNode }) { return <header className="page-header"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>{actions ? <div className="page-header-actions">{actions}</div> : null}</header>; }
function SectionHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) { return <header className="section-header"><div><h2>{title}</h2>{subtitle ? <p>{subtitle}</p> : null}</div>{action}</header>; }
function OverviewMetric({ icon, value, label, tone, live }: { icon: React.ReactNode; value: string | number; label: string; tone: string; live?: boolean }) { return <div className={`overview-metric tone-${tone}`}><span>{icon}</span><div><strong>{value}</strong><small>{label}</small></div>{live ? <i className="live-indicator" /> : null}</div>; }
function SettingsSection({ title, description, children }: React.PropsWithChildren<{ title: string; description: string }>) { return <section className="settings-section"><header><h2>{title}</h2><p>{description}</p></header>{children}</section>; }
function SettingsGroup({ title, children }: React.PropsWithChildren<{ title: string }>) { return <section className="settings-group"><h3>{title}</h3><div>{children}</div></section>; }
function SettingRow({ title, description, children }: React.PropsWithChildren<{ title: string; description: string }>) { return <div className="setting-row"><div><strong>{title}</strong><p>{description}</p></div><div>{children}</div></div>; }
function SecurityPrinciple({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) { return <article><span>{icon}</span><div><strong>{title}</strong><p>{text}</p></div></article>; }
function GitBranchIcon() { return <Code2 size={18} />; }
function runStatus(status: Conversation["status"], t: ReturnType<typeof useI18n>["t"]) { return t(`status.${status}` as `status.${Conversation["status"]}`); }
function shortModel(model?: string) { return model?.includes("/") ? model.slice(model.indexOf("/") + 1) : model; }
function shortPath(path: string) { const parts = path.split(/[\\/]/).filter(Boolean); return parts.length > 3 ? `…/${parts.slice(-2).join("/")}` : parts.join("/"); }
function relativeTime(value: string, t: ReturnType<typeof useI18n>["t"]) { const delta = Date.now() - new Date(value).getTime(); const minutes = Math.max(1, Math.round(delta / 60_000)); if (minutes < 60) return t("time.minutesAgo", { count: minutes }); const hours = Math.round(minutes / 60); if (hours < 24) return t("time.hoursAgo", { count: hours }); const days = Math.round(hours / 24); return t("time.daysAgo", { count: days }); }
