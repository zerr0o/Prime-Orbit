import { useCallback, useEffect, useMemo, useState } from "react";
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
import { deleteMcpServer, inspectPrimeAgentConnections, openPrimeAgentTerminal, quickInstallPrimeAgent, readModelsJson, saveMcpServer, saveModelsJson } from "../lib/bridge";
import { useI18n } from "../i18n";
import type { AppView, Conversation, McpAuthKind, McpScope, McpServerSummary, ModelInfo, PersistedAppState, PrimeAgentConnections, Project, RuntimeDetection } from "../types";
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
          <div className="active-run-grid">{active.map((conversation) => { const project = projects.find((item) => item.id === conversation.projectId); return <button type="button" key={conversation.id} className="active-run-card" onClick={() => onConversation(conversation.id)}><span className="active-run-signal"><i /></span><div className="run-card-copy"><div><span className="project-color" style={{ background: project?.color }} /><small>{project?.name}</small></div><strong>{conversation.title}</strong><p>{conversation.activities.at(-1)?.title ?? t("home.agentWorking")}</p></div><div className="run-card-state"><LoaderCircle size={17} className="spin" /><small>{conversation.status === "tool" ? t("home.tool") : t("home.inProgress")}</small></div></button>; })}</div>
        </section>
      ) : null}

      <div className="dashboard-columns">
        <section className="dashboard-section recent-work">
          <SectionHeader title={t("home.recent")} subtitle={t("home.recentSubtitle")} action={<button type="button" onClick={() => onView("projects")}>{t("home.browse")} <ArrowRight size={14} /></button>} />
          {recent.length ? <div className="recent-list">{recent.map((conversation) => { const project = projects.find((item) => item.id === conversation.projectId); return <button type="button" key={conversation.id} onClick={() => onConversation(conversation.id)}><span className="recent-project-icon" style={{ "--project-color": project?.color } as React.CSSProperties}><Folder size={17} /></span><span><strong>{conversation.title}</strong><small>{project?.name} · {relativeTime(conversation.updatedAt, t)}</small></span><Badge tone={conversation.status === "error" ? "danger" : "neutral"}>{conversation.status === "error" ? t("home.error") : shortModel(conversation.model) ?? t("common.default")}</Badge><ChevronRight size={16} /></button>; })}</div> : <EmptyState icon={<Sparkles size={24} />} title={t("home.startConversation")} description={t("home.recentEmpty")}><Button variant="primary" onClick={onNewConversation}>{t("home.start")}</Button></EmptyState>}
        </section>
        <aside className="dashboard-side">
          <section className="dashboard-section quick-start">
            <SectionHeader title={t("home.quickStart")} />
            <button type="button" onClick={onNewConversation}><span><Sparkles size={17} /></span><div><strong>{t("home.newTask")}</strong><small>{t("home.newTaskHint")}</small></div><ChevronRight size={15} /></button>
            <button type="button" onClick={onOpenProject}><span><FolderOpen size={17} /></span><div><strong>{t("home.openFolder")}</strong><small>{t("home.openFolderHint")}</small></div><ChevronRight size={15} /></button>
            <button type="button" onClick={() => onView("connections")}><span><Blocks size={17} /></span><div><strong>{t("home.connectTool")}</strong><small>{t("home.connectToolHint")}</small></div><ChevronRight size={15} /></button>
          </section>
          <section className="insight-card"><div className="insight-icon"><Zap size={18} /></div><div><Badge tone="accent">{t("home.tip")}</Badge><strong>{t("home.tipTitle")}</strong><p>{t("home.tipText")}</p><button type="button" onClick={() => onView("runs")}>{t("home.discoverGoals")} <ArrowRight size={14} /></button></div></section>
        </aside>
      </div>

      <section className="dashboard-section project-row-section">
        <SectionHeader title={t("projects.title")} subtitle={t("home.workspaces", { count: projects.length })} action={<button type="button" onClick={() => onView("projects")}>{t("home.manageProjects")} <ArrowRight size={14} /></button>} />
        <div className="project-row">{projects.slice(0, 4).map((project) => { const count = visibleConversations.filter((conversation) => conversation.projectId === project.id).length; return <button type="button" key={project.id} onClick={() => onProject(project.id)}><span className="project-folder-visual" style={{ "--folder-accent": project.color } as React.CSSProperties}><Folder size={23} /></span><div><strong>{project.name}</strong><small>{t(count === 1 ? "home.conversation.one" : "home.conversation.other", { count })}</small><span>{shortPath(project.path)}</span></div>{project.pinned ? <Pin size={14} /> : null}</button>; })}<button type="button" className="add-project-tile" onClick={onOpenProject}><Plus size={22} /><strong>{t("home.addProject")}</strong><small>{t("home.addProjectHint")}</small></button></div>
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
      {filtered.length ? <div className="projects-grid">{filtered.map((project) => { const items = conversations.filter((conversation) => conversation.projectId === project.id && !conversation.archived && conversation.hasContent !== false); const active = items.filter((conversation) => ["streaming", "tool", "queued", "starting"].includes(conversation.status)).length; return <div key={project.id} className="project-card-shell"><button type="button" className="project-card" onClick={() => onProject(project.id)}><header><span className="large-project-icon" style={{ "--project-color": project.color } as React.CSSProperties}><Folder size={24} /></span><span className="project-card-badges">{project.pinned ? <Pin size={14} /> : null}{active ? <Badge tone="success">{t("projects.active", { count: active })}</Badge> : null}</span></header><h3>{project.name}</h3><p>{project.path}</p><div className="project-card-stats"><span><Bot size={14} />{t(items.length === 1 ? "home.conversation.one" : "home.conversation.other", { count: items.length })}</span><span><Clock3 size={14} />{relativeTime(project.lastOpenedAt, t)}</span></div><footer><span className="preset-dot" />{t(project.permissionPreset === "guarded" ? "projects.permission.guarded" : project.permissionPreset === "autonomous" ? "projects.permission.autonomous" : "projects.permission.standard")}<ChevronRight size={15} /></footer></button><button type="button" className="project-delete-button" aria-label={t("projects.deleteLabel", { name: project.name })} title={t("projects.deleteTitle")} onClick={() => onDeleteProject(project)}><Trash2 size={15} /></button></div>; })}<button type="button" className="project-card project-card-add" onClick={onOpenProject}><span><Plus size={28} /></span><h3>{t("home.addProject")}</h3><p>{t("projects.addText")}</p></button></div> : <EmptyState icon={<FolderOpen size={28} />} title={t("projects.empty")} description={search ? t("projects.emptySearch") : filter === "pinned" ? t("projects.emptyPinned") : t("projects.emptyDefault")}><Button variant="primary" onClick={onOpenProject}>{t("home.openFolder")}</Button></EmptyState>}
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
      <div className="runs-table"><header><span>{t("runs.conversation")}</span><span>{t("runs.project")}</span><span>{t("runs.state")}</span><span>{t("runs.model")}</span><span>{t("runs.updated")}</span><span /></header>{runs.map((conversation) => { const project = projects.find((item) => item.id === conversation.projectId); return <button type="button" key={conversation.id} onClick={() => onConversation(conversation.id)}><span className="run-title-cell"><i className={`conversation-status status-${conversation.status}`} /><span><strong>{conversation.title}</strong><small>{conversation.activities.at(-1)?.title ?? t("common.ready")}</small></span></span><span><span className="project-color" style={{ background: project?.color }} />{project?.name}</span><span><Badge tone={conversation.status === "error" ? "danger" : ["streaming", "tool", "starting", "queued"].includes(conversation.status) ? "accent" : "neutral"}>{runStatus(conversation.status, t)}</Badge></span><span className="mono">{shortModel(conversation.model) ?? t("common.default")}</span><span>{relativeTime(conversation.updatedAt, t)}</span><ChevronRight size={15} /></button>; })}</div>
    </div>
  );
}

export function ConnectionsView({ models, projectPath, onOpenSetup }: { models: ModelInfo[]; projectPath?: string; onOpenSetup: (kind: "provider" | "mcp") => void }) {
  const { t } = useI18n();
  const providers = useMemo(() => {
    const map = new Map<string, ModelInfo[]>();
    for (const model of models) map.set(model.provider, [...(map.get(model.provider) ?? []), model]);
    return Array.from(map.entries());
  }, [models]);
  const [connections, setConnections] = useState<PrimeAgentConnections>();
  const [loadingConnections, setLoadingConnections] = useState(true);
  const [notice, setNotice] = useState<{ tone: "success" | "error" | "info"; message: string }>();
  const [mcpEditor, setMcpEditor] = useState<McpEditorDraft>();
  const [mcpToDelete, setMcpToDelete] = useState<McpServerSummary>();

  const refreshConnections = useCallback(async () => {
    setLoadingConnections(true);
    try {
      setConnections(await inspectPrimeAgentConnections(projectPath));
    } catch (error) {
      setNotice({ tone: "error", message: t("connections.readFailed", { error: error instanceof Error ? error.message : String(error) }) });
    } finally {
      setLoadingConnections(false);
    }
  }, [projectPath, t]);

  useEffect(() => {
    void refreshConnections();
  }, [refreshConnections]);

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
    try {
      await saveMcpServer(projectPath, draft.scope, {
        name: draft.name.trim(),
        url: draft.url.trim(),
        enabled: draft.enabled,
        authKind: draft.authKind,
        ...(draft.authKind === "bearer-env" ? { bearerTokenEnvVar: draft.bearerTokenEnvVar.trim() } : {}),
      });
      setMcpEditor(undefined);
      await refreshConnections();
      setNotice({ tone: "success", message: t("connections.mcpSaved", { name: draft.name }) });
    } catch (error) {
      setNotice({ tone: "error", message: t("connections.mcpRejected", { error: error instanceof Error ? error.message : String(error) }) });
      throw error;
    }
  };

  const removeMcp = async (server: McpServerSummary) => {
    try {
      await deleteMcpServer(projectPath, server.scope, server.name);
      setMcpToDelete(undefined);
      await refreshConnections();
      setNotice({ tone: "success", message: t(server.scope === "project" ? "connections.mcpRemovedProject" : "connections.mcpRemovedGlobal", { name: server.name }) });
    } catch (error) {
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
      <PageHeader eyebrow={t("connections.eyebrow")} title={t("connections.title")} description={t("connections.description")} actions={<><Button variant="ghost" loading={loadingConnections} onClick={() => void refreshConnections()}><RefreshCw size={15} />{t("common.refresh")}</Button><Button variant="secondary" onClick={() => onOpenSetup("provider")}><Settings2 size={16} />{t("connections.officialGuide")}</Button></>} />
      {notice ? <div className={`connection-notice is-${notice.tone}`}><Info size={16} /><span>{notice.message}</span><button type="button" onClick={() => setNotice(undefined)} aria-label={t("connections.closeNotice")}><X size={14} /></button></div> : null}
      <section className="connections-section">
        <SectionHeader title={t("connections.providers")} subtitle={t("connections.providerSummary", { auth: providerIds.length, catalogs: providers.length })} />
        <div className="provider-grid">{known.map((provider) => {
          const connectedModels = providers.filter(([id]) => provider.aliases.includes(id)).flatMap(([, entries]) => entries);
          const configuredIds = providerIds.filter((id) => provider.aliases.some((alias) => id === alias || id.startsWith(`${alias}:`)));
          const configured = configuredIds.length > 0 || connectedModels.length > 0;
          const ProviderIcon = provider.icon;
          const status = provider.id === "openai" && configuredIds.some((id) => id.startsWith("openai-codex")) ? t("connections.codexConfigured") : configuredIds.length ? t("connections.authConfigured") : connectedModels.length ? t("connections.modelsAvailable", { count: connectedModels.length }) : t("connections.notConfigured");
          return <article key={provider.id} className="provider-card"><header><span className={`connection-logo logo-${provider.id}`}><ProviderIcon size={22} /></span><div><h3>{provider.name}</h3><p>{provider.description}</p></div><span className={`status-dot ${configured ? "is-online" : ""}`} /></header><div className="provider-card-meta"><span>{status}</span>{connectedModels.some((model) => model.input?.includes("image")) ? <Badge><Image size={12} /> Vision</Badge> : null}</div><footer>{configured ? <span><Check size={14} />{t("connections.configured")}</span> : <span className="muted-status">{t("connections.toConnect")}</span>}<Button variant={configured ? "ghost" : "secondary"} onClick={() => void openOfficialSetup("/login", `${t("common.manage")} ${provider.name}.`)}>{configured ? <Settings2 size={14} /> : <KeyRound size={14} />}{configured ? t("common.manage") : t("common.configure")}</Button></footer></article>;
        })}</div>
      </section>
      <section className="connections-section">
        <SectionHeader title={t("connections.mcpTitle")} subtitle={t("connections.mcpSubtitle")} action={<><Button variant="ghost" onClick={() => void openOfficialSetup("/mcp list", t("connections.mcpTitle"))}><Terminal size={15} />{t("connections.openMcp")}</Button><Button variant="secondary" onClick={() => setMcpEditor(emptyMcpDraft(Boolean(projectPath)))}><Plus size={15} />{t("connections.addServer")}</Button></>} />
        <div className="mcp-grid">
          <McpCard name="Linear" description="Issues, projects & cycles" color="#5e6ad2" status={builtinMcp("linear")?.enabled ? t("connections.oauthConfigured") : t("connections.oauthRequired")} connected={Boolean(builtinMcp("linear")?.enabled)} actionLabel={builtinMcp("linear")?.enabled ? t("common.manage") : t("common.connect")} onConfigure={() => void openOfficialSetup("/mcp login linear", `${t("common.configure")} Linear.`)} />
          <McpCard name="Notion" description="Pages, databases & search" color="#f4f4f2" status={builtinMcp("notion")?.enabled ? t("connections.oauthConfigured") : t("connections.oauthRequired")} connected={Boolean(builtinMcp("notion")?.enabled)} dark actionLabel={builtinMcp("notion")?.enabled ? t("common.manage") : t("common.connect")} onConfigure={() => void openOfficialSetup("/mcp login notion", `${t("common.configure")} Notion.`)} />
          {customMcp.map((server) => { const editable = Boolean(server.url); return <article key={`${server.scope}:${server.name}`} className="mcp-card"><span className="mcp-logo custom-server-logo"><Server size={18} /></span><div><strong>{server.name}</strong><p>{server.url ?? t("connections.stdioReadonly")}</p><small><span className={`status-dot ${server.enabled ? "is-online" : ""}`} />{editable ? (server.enabled ? authKindLabel(server.authKind, t) : t("connections.disabled")) : t("connections.kernelUnsupported")} · {server.scope === "project" ? t("connections.projectScope") : t("connections.globalScope")}</small></div><div className="mcp-card-actions"><Button variant="ghost" disabled={!editable} title={editable ? t("common.edit") : t("connections.stdioEditDisabled")} onClick={() => setMcpEditor(mcpDraftFromServer(server))}>{t("common.edit")}</Button><button type="button" className="inline-danger" disabled={!editable} aria-label={t("projects.deleteLabel", { name: server.name })} title={editable ? t("common.delete") : t("connections.stdioKept")} onClick={() => setMcpToDelete(server)}><Trash2 size={14} /></button></div></article>; })}
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

function isValidMcpUrl(value: string) {
  if (!value || value.trim() !== value) return false;
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && Boolean(parsed.hostname) && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

function McpEditorModal({ draft: initialDraft, projectAvailable, onClose, onSave }: { draft: McpEditorDraft; projectAvailable: boolean; onClose: () => void; onSave: (draft: McpEditorDraft) => Promise<void> }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(initialDraft);
  const [saving, setSaving] = useState(false);
  const validName = /^[a-z][a-z0-9_]{0,63}$/.test(draft.name.trim()) && !["linear", "notion"].includes(draft.name.trim());
  const validUrl = isValidMcpUrl(draft.url);
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

export function SettingsView({ state, setState, detection, installState, onRefreshDetection }: {
  state: PersistedAppState;
  setState: (updater: (current: PersistedAppState) => PersistedAppState) => void;
  detection?: RuntimeDetection;
  installState: { running: boolean; phase?: string; lines: string[] };
  onRefreshDetection: () => void;
}) {
  const { t } = useI18n();
  const [section, setSection] = useState<"general" | "appearance" | "agent" | "models" | "security" | "about">("general");
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
      <aside className="settings-nav"><div><p className="eyebrow">{t("settings.eyebrow")}</p><h1>{t("settings.title")}</h1></div><nav>{settingsSections.map((item) => { const ItemIcon = item.icon; return <button key={item.id} type="button" className={section === item.id ? "is-active" : ""} onClick={() => setSection(item.id)}><ItemIcon size={16} />{item.label}</button>; })}</nav><footer><span className="mini-orbit"><span /></span><div><strong>Prime Orbit</strong><small>Version 0.1.9</small></div></footer></aside>
      <main className="settings-content">
        {section === "general" ? <SettingsSection title={t("settings.general")} description={t("settings.generalDescription")}><SettingsGroup title={t("settings.startup")}><SettingRow title={t("settings.restore")} description={t("settings.restoreText")}><Switch checked={prefs.restoreLastWorkspace} onChange={(restoreLastWorkspace) => patchPreferences({ restoreLastWorkspace })} label={t("settings.restore")} /></SettingRow><SettingRow title={t("settings.language")} description={t("settings.languageText")}><select value={prefs.language} onChange={(event) => patchPreferences({ language: event.target.value as "fr" | "en" })}><option value="fr">Français</option><option value="en">English</option></select></SettingRow></SettingsGroup><SettingsGroup title={t("settings.newConversations")}><SettingRow title={t("settings.defaultReasoning")} description={t("settings.defaultReasoningText")}><select value={prefs.defaultThinking} onChange={(event) => patchPreferences({ defaultThinking: event.target.value as typeof prefs.defaultThinking })}><option value="low">{t("settings.light")}</option><option value="medium">{t("settings.balanced")}</option><option value="high">{t("settings.deep")}</option><option value="xhigh">{t("settings.veryDeep")}</option></select></SettingRow><SettingRow title={t("settings.defaultSupervision")} description={t("settings.defaultSupervisionText")}><select value={prefs.defaultPermissionPreset} onChange={(event) => patchPreferences({ defaultPermissionPreset: event.target.value as typeof prefs.defaultPermissionPreset })}><option value="guarded">{t("settings.strict")}</option><option value="standard">{t("settings.standard")}</option><option value="autonomous">{t("settings.autonomy")}</option></select></SettingRow></SettingsGroup><SettingsGroup title={t("settings.privacy")}><SettingRow title={t("settings.telemetry")} description={t("settings.telemetryText")}><Switch checked={prefs.telemetry} onChange={(telemetry) => patchPreferences({ telemetry })} label={t("settings.telemetry")} /></SettingRow></SettingsGroup></SettingsSection> : null}
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
              <Button variant="primary" loading={installState.running} onClick={() => void quickInstallPrimeAgent()}><Download size={15} />{t("settings.managedInstall")}</Button>
            </div>
          </div>
          {runtimeBroken ? <div className="runtime-diagnostic" role="alert"><ShieldAlert size={17} /><pre>{detection?.error}</pre></div> : null}
          {installState.running || installState.lines.length ? <div className="install-progress"><header><span><LoaderCircle size={15} className={installState.running ? "spin" : ""} />{installState.phase ?? t("settings.installation")}</span><small>{installState.running ? t("common.running") : t("common.complete")}</small></header><pre>{installState.lines.slice(-18).join("\n")}</pre></div> : null}
          <SettingsGroup title={t("settings.prerequisites")}>{(detection?.prerequisites ?? []).map((item) => <SettingRow key={item.name} title={item.name} description={item.path ?? t("common.systemComponent")}><Badge tone={item.found ? "success" : "danger"}>{item.found ? item.version ?? t("common.detected") : t("common.missing")}</Badge></SettingRow>)}</SettingsGroup>
          <div className="warning-card"><ShieldAlert size={19} /><div><strong>{t("settings.notSandbox")}</strong><p>{t("settings.notSandboxText")}</p></div></div>
        </SettingsSection> : null}
        {section === "models" ? <SettingsSection title={t("settings.models")} description={t("settings.modelsDescription")}><div className="settings-callout"><FileJson2 size={22} /><div><h3>{t("settings.customCatalog")}</h3><p>{t("settings.customCatalogText")}</p></div><Button variant="secondary" onClick={() => void openModels()}><FileJson2 size={15} />{t("settings.openEditor")}</Button></div><SettingsGroup title={t("settings.displayRules")}><SettingRow title={t("settings.checkVision")} description={t("settings.checkVisionText")}><Switch checked onChange={() => undefined} label={t("settings.checkVision")} /></SettingRow><SettingRow title={t("settings.technicalIds")} description={t("settings.technicalIdsText")}><Switch checked={false} onChange={() => undefined} label={t("settings.technicalIds")} /></SettingRow></SettingsGroup></SettingsSection> : null}
        {section === "security" ? <SettingsSection title={t("settings.security")} description={t("settings.securityDescription")}><div className="security-principles"><SecurityPrinciple icon={<Folder size={18} />} title={t("settings.visibleFolder")} text={t("settings.visibleFolderText")} /><SecurityPrinciple icon={<Terminal size={18} />} title={t("settings.inspectableCommands")} text={t("settings.inspectableCommandsText")} /><SecurityPrinciple icon={<ShieldAlert size={18} />} title={t("settings.noImplicitIsolation")} text={t("settings.noImplicitIsolationText")} /></div><SettingsGroup title={t("settings.protection")}><SettingRow title={t("settings.confirmInstall")} description={t("settings.confirmInstallText")}><Switch checked onChange={() => undefined} label={t("settings.confirmInstall")} /></SettingRow><SettingRow title={t("settings.hideSecrets")} description={t("settings.hideSecretsText")}><Switch checked onChange={() => undefined} label={t("settings.hideSecrets")} /></SettingRow></SettingsGroup><div className="warning-card"><Info size={19} /><div><strong>{t("settings.realIsolation")}</strong><p>{t("settings.realIsolationText")}</p></div></div></SettingsSection> : null}
        {section === "about" ? <SettingsSection title={t("settings.about")} description={t("settings.aboutDescription")}><div className="about-card"><span className="about-orbit"><span /></span><h2>Prime Orbit</h2><p>{t("settings.aboutText")}</p><Badge tone="accent">Version 0.1.9 · Preview</Badge><div><a href="https://github.com/PrimeIntellect-ai/prime-agent" target="_blank" rel="noreferrer"><Code2 size={15} />Prime Agent<ExternalLink size={12} /></a><a href="https://github.com/PrimeIntellect-ai/prime-agent/blob/main/LICENSE" target="_blank" rel="noreferrer"><Globe2 size={15} />{t("settings.licenses")}<ExternalLink size={12} /></a></div></div></SettingsSection> : null}
      </main>
      {modelsEditor ? <Modal title={t("settings.modelCatalog")} description={modelsEditor.path} width="820px" onClose={() => setModelsEditor(undefined)} footer={<><span className={`editor-status is-${modelSaveState}`}>{modelSaveState === "error" ? t("settings.invalidJson") : modelSaveState === "saved" ? t("settings.saved") : t("settings.backupNotice")}</span><Button variant="secondary" onClick={() => setModelsEditor(undefined)}>{t("common.cancel")}</Button><Button variant="primary" loading={modelSaveState === "saving"} onClick={() => void saveModels()}>{t("settings.validateSave")}</Button></>}><textarea className="json-editor" value={modelsEditor.content} spellCheck={false} onChange={(event) => { setModelsEditor({ ...modelsEditor, content: event.target.value }); setModelSaveState("idle"); }} /></Modal> : null}
    </div>
  );
}

export function Onboarding({ detection, installState, onInstall, onUseExisting, onContinue }: { detection?: RuntimeDetection; installState: { running: boolean; phase?: string; lines: string[] }; onInstall: () => void; onUseExisting: () => void; onContinue: () => void }) {
  const { t } = useI18n();
  const runtimeBroken = Boolean(detection && !detection.installed && detection.error);
  return (
    <div className="onboarding-page"><div className="onboarding-ambient ambient-one" /><div className="onboarding-ambient ambient-two" /><header><span className="brand-mark"><span className="orbit-ring"><span /></span></span><strong>Prime Orbit</strong><Badge>{t("onboarding.preview")}</Badge></header><main><div className="onboarding-copy"><p className="eyebrow">{t("onboarding.welcome")}</p><h1>{t("onboarding.title")}<br /><span>{t("onboarding.forAgent")}</span></h1><p>{t("onboarding.description")}</p><ul><li><span><Folder size={17} /></span><div><strong>{t("onboarding.projectTitle")}</strong><small>{t("onboarding.projectText")}</small></div></li><li><span><Activity size={17} /></span><div><strong>{t("onboarding.activityTitle")}</strong><small>{t("onboarding.activityText")}</small></div></li><li><span><Maximize2 size={17} /></span><div><strong>{t("onboarding.windowsTitle")}</strong><small>{t("onboarding.windowsText")}</small></div></li></ul></div><section className={`onboarding-card ${runtimeBroken ? "has-runtime-error" : ""}`}><div className="setup-progress"><span className="is-done"><Check size={13} /></span><i /><span className={detection ? "is-current" : ""}>2</span><i /><span>3</span></div><div className="setup-icon">{detection?.installed ? <PackageCheck size={28} /> : runtimeBroken ? <ShieldAlert size={28} /> : <Download size={28} />}</div><Badge tone={detection?.installed ? "success" : runtimeBroken ? "danger" : "accent"}>{detection?.installed ? t("onboarding.installDetected") : runtimeBroken ? t("onboarding.installBroken") : t("onboarding.initialSetup")}</Badge><h2>{detection?.installed ? t("onboarding.agentReady", { version: detection.version ?? "" }) : runtimeBroken ? t("onboarding.repairTitle") : t("onboarding.chooseInstall")}</h2><p>{detection?.installed ? t("onboarding.existingText") : runtimeBroken ? t("onboarding.repairText") : t("onboarding.managedText")}</p>{runtimeBroken ? <pre className="onboarding-runtime-error" role="alert">{detection?.error}</pre> : null}{installState.lines.length ? <pre className="onboarding-logs">{installState.lines.slice(-10).join("\n")}</pre> : null}<div className="onboarding-actions">{detection?.installed ? <Button variant="primary" onClick={onContinue}>{t("onboarding.continue")} <ArrowRight size={15} /></Button> : <><Button variant="primary" loading={installState.running} onClick={onInstall}><Download size={15} />{t("onboarding.autoInstall")}</Button><Button variant="secondary" onClick={onUseExisting}><FolderOpen size={15} />{t("onboarding.useExisting")}</Button></>}</div><small className="setup-note"><ShieldCheck size={13} />{t("onboarding.noApiKey")}</small></section></main></div>
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
