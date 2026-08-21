import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Archive,
  Blocks,
  Bot,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Circle,
  Command,
  Folder,
  FolderOpen,
  Gauge,
  GripVertical,
  Home,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  Plus,
  Search,
  Settings,
  Sparkles,
  LoaderCircle,
} from "lucide-react";
import type { AppView, Conversation, Project } from "../types";
import { useI18n, type AppLanguage } from "../i18n";
import { useDismissableLayer } from "../hooks/useDismissableLayer";
import { IconButton } from "./Ui";

interface GlobalRailProps {
  view: AppView;
  onView: (view: AppView) => void;
  onOpenProject: () => void;
  onCommandPalette: () => void;
  activeRuns: number;
}

export function GlobalRail({ view, onView, onOpenProject, onCommandPalette, activeRuns }: GlobalRailProps) {
  const { language } = useI18n();
  const t = (key: NavKey, params?: TextParams) => navText(language, key, params);
  const items: Array<{ view: AppView; label: string; icon: typeof Home }> = [
    { view: "home", label: t("nav.home"), icon: Home },
    { view: "projects", label: t("nav.projects"), icon: Folder },
    { view: "runs", label: t("nav.runs"), icon: Activity },
    { view: "connections", label: t("nav.connections"), icon: Blocks },
  ];
  return (
    <nav className="global-rail" aria-label={t("nav.main")}>
      <button className="brand-mark" type="button" onClick={() => onView("home")} aria-label={t("nav.brandHome")}>
        <span className="orbit-ring"><span /></span>
      </button>
      <div className="rail-items">
        {items.map((item) => {
          const ItemIcon = item.icon;
          const selected = view === item.view || (item.view === "projects" && view === "chat");
          return (
            <button key={item.view} className={`rail-item ${selected ? "is-active" : ""}`} type="button" onClick={() => onView(item.view)} aria-label={item.label} title={item.label}>
              <ItemIcon size={20} strokeWidth={1.8} />
              {item.view === "runs" && activeRuns > 0 ? <span className="rail-count">{activeRuns}</span> : null}
            </button>
          );
        })}
      </div>
      <div className="rail-spacer" />
      <button className="rail-item" type="button" onClick={onOpenProject} aria-label={t("nav.openFolder")} title={t("nav.openFolder")}>
        <FolderOpen size={20} strokeWidth={1.8} />
      </button>
      <button className="rail-item" type="button" onClick={onCommandPalette} aria-label={t("nav.commandPalette")} title={t("nav.commandPaletteShortcut")}>
        <Command size={20} strokeWidth={1.8} />
      </button>
      <button className={`rail-item ${view === "settings" ? "is-active" : ""}`} type="button" onClick={() => onView("settings")} aria-label={t("nav.settings")} title={t("nav.settings")}>
        <Settings size={20} strokeWidth={1.8} />
      </button>
      <span className="user-avatar" role="img" aria-label={t("nav.userProfile")} title={t("nav.userProfile")}>ZE</span>
    </nav>
  );
}

interface ProjectSidebarProps {
  projects: Project[];
  project?: Project;
  /** All non-runtime workspace conversations; the sidebar groups them by project. */
  conversations: Conversation[];
  selectedConversationId?: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSelectProject: (id: string) => void;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onNewConversationForProject: (projectId: string) => void;
  onPinConversation: (id: string, pinned: boolean) => void;
  onArchiveConversation: (id: string) => void;
  onRenameConversation: (id: string, title: string) => void;
  onReorderProject: (sourceId: string, targetId: string, placement: ReorderPlacement) => void;
  onReorderConversation: (sourceId: string, targetId: string, placement: ReorderPlacement) => void;
}

type ReorderPlacement = "before" | "after";
type DragItem = { kind: "project"; id: string } | { kind: "conversation"; id: string; projectId: string };
type DropTarget = { kind: DragItem["kind"]; id: string; placement: ReorderPlacement };

const SIDEBAR_REORDER_MIME = "application/x-prime-orbit-sidebar-item";

export function ProjectSidebar(props: ProjectSidebarProps) {
  const { language } = useI18n();
  const t = (key: NavKey, params?: TextParams) => navText(language, key, params);
  const {
    projects,
    project,
    conversations,
    selectedConversationId,
    collapsed,
    onToggleCollapsed,
    onSelectProject,
    onSelectConversation,
    onNewConversation,
    onNewConversationForProject,
    onPinConversation,
    onArchiveConversation,
    onRenameConversation,
    onReorderProject,
    onReorderConversation,
  } = props;
  const [search, setSearch] = useState("");
  const [menuId, setMenuId] = useState<string>();
  const [renamingId, setRenamingId] = useState<string>();
  const [dragItem, setDragItem] = useState<DragItem>();
  const [dropTarget, setDropTarget] = useState<DropTarget>();
  // WebView2 can enter its native drag loop before React has committed the
  // drag-start state update. Keep the active item synchronously as well so the
  // very first dragover can opt into a move drop instead of showing Windows'
  // prohibited cursor.
  const dragItemRef = useRef<DragItem | undefined>(undefined);
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    () => new Set(project?.id ? [project.id] : []),
  );
  const dismissMenus = useCallback(() => setMenuId(undefined), []);
  useDismissableLayer(menuId ? `navigation-conversation-${menuId}` : null, dismissMenus);

  useEffect(() => {
    if (!project?.id) return;
    setExpandedProjectIds((current) => {
      if (current.has(project.id)) return current;
      const next = new Set(current);
      next.add(project.id);
      return next;
    });
  }, [project?.id]);

  useEffect(() => {
    if (collapsed) {
      setMenuId(undefined);
      setSearch("");
    }
  }, [collapsed]);

  const toggleConversationMenu = (id: string) => {
    setMenuId((current) => current === id ? undefined : id);
  };

  const orderedProjects = useMemo(() => [...projects].sort(compareManualOrder), [projects]);
  const reorderDisabled = !collapsed && Boolean(search.trim());
  const projectSections = useMemo(() => {
    const normalized = search.toLowerCase().trim();
    const visibleConversations = conversations.filter(
      (item) => !item.archived && (item.hasContent !== false || item.id === selectedConversationId),
    );
    return orderedProjects
      .map((item) => {
        const projectMatches = !normalized
          || item.name.toLowerCase().includes(normalized)
          || item.path.toLowerCase().includes(normalized);
        const items = visibleConversations
          .filter((conversation) => conversation.projectId === item.id)
          .filter((conversation) => projectMatches || conversation.title.toLowerCase().includes(normalized))
          .sort(compareManualOrder);
        return { project: item, conversations: items, visible: projectMatches || items.length > 0 };
      })
      .filter((section) => section.visible);
  }, [conversations, orderedProjects, search, selectedConversationId]);

  const toggleProject = (projectId: string) => {
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const selectProject = (projectId: string) => {
    setExpandedProjectIds((current) => new Set(current).add(projectId));
    onSelectProject(projectId);
  };

  const beginDrag = (event: React.DragEvent, item: DragItem) => {
    if (reorderDisabled) {
      event.preventDefault();
      return;
    }
    dragItemRef.current = item;
    event.dataTransfer.clearData();
    event.dataTransfer.setData(SIDEBAR_REORDER_MIME, JSON.stringify(item));
    event.dataTransfer.setData("text/plain", `${item.kind}:${item.id}`);
    event.dataTransfer.effectAllowed = "move";
    setDragItem(item);
    setDropTarget(undefined);
  };

  const updateDropTarget = (event: React.DragEvent, kind: DragItem["kind"], id: string) => {
    const activeItem = dragItemRef.current;
    if (!activeItem || activeItem.kind !== kind || reorderDisabled) return;
    if (kind === "conversation" && activeItem.kind === "conversation") {
      const target = conversations.find((conversation) => conversation.id === id);
      if (!target || target.projectId !== activeItem.projectId) return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    // The source itself is a valid part of the drag surface. Cancelling its
    // dragover prevents a misleading no-drop cursor while still making drop a
    // no-op until another item is targeted.
    if (activeItem.id === id) {
      setDropTarget(undefined);
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const placement: ReorderPlacement = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
    setDropTarget({ kind, id, placement });
  };

  const finishDrop = (event: React.DragEvent, kind: DragItem["kind"], id: string) => {
    const activeItem = dragItemRef.current;
    if (!activeItem || activeItem.kind !== kind || reorderDisabled) return;
    if (kind === "conversation" && activeItem.kind === "conversation") {
      const target = conversations.find((conversation) => conversation.id === id);
      if (!target || target.projectId !== activeItem.projectId) return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (activeItem.id === id) {
      endDrag();
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const placement: ReorderPlacement = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
    if (kind === "project" && activeItem.kind === "project") {
      onReorderProject(activeItem.id, id, placement);
    } else if (kind === "conversation" && activeItem.kind === "conversation") {
      const target = conversations.find((conversation) => conversation.id === id);
      if (target?.projectId === activeItem.projectId) {
        onReorderConversation(activeItem.id, id, placement);
      }
    }
    endDrag();
  };

  const endDrag = () => {
    dragItemRef.current = undefined;
    setDragItem(undefined);
    setDropTarget(undefined);
  };

  const moveProjectByKeyboard = (projectId: string, direction: -1 | 1) => {
    if (reorderDisabled) return;
    const index = orderedProjects.findIndex((item) => item.id === projectId);
    const target = orderedProjects[index + direction];
    if (!target) return;
    onReorderProject(projectId, target.id, direction < 0 ? "before" : "after");
  };

  if (collapsed) {
    return (
      <aside className="project-sidebar is-collapsed" aria-label={t("nav.projectsAndConversations")}>
        <IconButton label={t("nav.showSidebar")} onClick={onToggleCollapsed}><PanelLeftOpen size={18} /></IconButton>
        <div className="collapsed-project-list" role="list" aria-label={t("nav.projects")}>
          {orderedProjects.map((item) => (
            <button
              key={item.id}
              type="button"
              data-context-type="project"
              data-context-id={item.id}
              className={`collapsed-project-dot ${item.id === project?.id ? "is-active" : ""} ${dragItem?.kind === "project" && dragItem.id === item.id ? "is-dragging" : ""} ${dropClass(dropTarget, "project", item.id)}`}
              style={{ "--project-color": item.color } as React.CSSProperties}
              onClick={() => selectProject(item.id)}
              draggable={!reorderDisabled}
              onDragStart={(event) => beginDrag(event, { kind: "project", id: item.id })}
              onDragOver={(event) => updateDropTarget(event, "project", item.id)}
              onDrop={(event) => finishDrop(event, "project", item.id)}
              onDragEnd={endDrag}
              onKeyDown={(event) => {
                if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
                event.preventDefault();
                moveProjectByKeyboard(item.id, event.key === "ArrowUp" ? -1 : 1);
              }}
              aria-haspopup="menu"
              aria-label={t("nav.openProject", { name: item.name })}
              title={item.name}
            />
          ))}
        </div>
        <IconButton label={t("nav.newConversation")} onClick={onNewConversation}><Plus size={18} /></IconButton>
      </aside>
    );
  }

  return (
    <aside className="project-sidebar" aria-label={t("nav.projectsAndConversations")}>
      <header className="sidebar-header">
        <div className="sidebar-heading">
          <span className="sidebar-heading-icon"><FolderOpen size={15} /></span>
          <span><strong>{t("nav.workspace")}</strong><small>{t(projects.length === 1 ? "nav.projectCount.one" : "nav.projectCount.other", { count: projects.length })}</small></span>
        </div>
        <IconButton label={t("nav.hideSidebar")} onClick={onToggleCollapsed}><PanelLeftClose size={17} /></IconButton>
      </header>

      <button type="button" className="new-chat-row" onClick={onNewConversation}>
        <span><Sparkles size={17} /> {t("nav.newConversation")}</span>
        <kbd>Ctrl N</kbd>
      </button>

      <div className="sidebar-search">
        <Search size={15} />
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("nav.search")} aria-label={t("nav.searchProjectsConversations")} />
      </div>

      <div className="conversation-scroll project-tree">
        {projectSections.map((section) => {
          const isCurrent = section.project.id === project?.id;
          const expanded = Boolean(search.trim()) || expandedProjectIds.has(section.project.id);
          const regionId = `project-conversations-${section.project.id}`;
          const projectIndex = orderedProjects.findIndex((item) => item.id === section.project.id);
          return (
            <section key={section.project.id} className={`project-section ${isCurrent ? "is-current" : ""} ${dragItem?.kind === "project" && dragItem.id === section.project.id ? "is-dragging" : ""}`}>
              <div
                className={`project-section-header ${dropClass(dropTarget, "project", section.project.id)}`}
                data-context-type="project"
                data-context-id={section.project.id}
                onDragOver={(event) => updateDropTarget(event, "project", section.project.id)}
                onDrop={(event) => finishDrop(event, "project", section.project.id)}
              >
                <span
                  className={`sidebar-drag-handle ${reorderDisabled ? "is-disabled" : ""}`}
                  draggable={!reorderDisabled}
                  onDragStart={(event) => beginDrag(event, { kind: "project", id: section.project.id })}
                  onDragEnd={endDrag}
                  title={reorderDisabled ? t("nav.reorderSearchDisabled") : t("nav.dragProject", { name: section.project.name })}
                  aria-hidden="true"
                ><GripVertical size={12} /></span>
                <button
                  type="button"
                  className="project-disclosure"
                  onClick={() => toggleProject(section.project.id)}
                  tabIndex={-1}
                  aria-hidden="true"
                >
                  {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
                <button
                  type="button"
                  className="project-tree-select"
                  onClick={() => toggleProject(section.project.id)}
                  aria-current={isCurrent ? "page" : undefined}
                  aria-haspopup="menu"
                  aria-expanded={expanded}
                  aria-controls={regionId}
                  aria-label={t(expanded ? "nav.collapseProject" : "nav.expandProject", { name: section.project.name })}
                >
                  <span className="project-color" style={{ background: section.project.color }} />
                  <span>{section.project.name}</span>
                  {section.project.pinned ? <Pin size={11} aria-label={t("nav.pinnedProject")} /> : null}
                </button>
                <button
                  type="button"
                  className="project-new-conversation"
                  onClick={() => onNewConversationForProject(section.project.id)}
                  aria-label={t("nav.newConversationInProject", { name: section.project.name })}
                  title={t("nav.newConversationInProject", { name: section.project.name })}
                >
                  <Plus size={13} />
                </button>
                <span className="project-conversation-count" aria-label={t(section.conversations.length === 1 ? "nav.conversationCount.one" : "nav.conversationCount.other", { count: section.conversations.length })}>{section.conversations.length}</span>
                <span className="project-order-actions">
                  <IconButton label={t("nav.moveProjectUp", { name: section.project.name })} disabled={reorderDisabled || projectIndex <= 0} onClick={() => moveProjectByKeyboard(section.project.id, -1)}><ArrowUp size={12} /></IconButton>
                  <IconButton label={t("nav.moveProjectDown", { name: section.project.name })} disabled={reorderDisabled || projectIndex >= orderedProjects.length - 1} onClick={() => moveProjectByKeyboard(section.project.id, 1)}><ArrowDown size={12} /></IconButton>
                </span>
              </div>
              {expanded ? (
                <div id={regionId} className="project-conversation-list">
                  {section.conversations.map((conversation, conversationIndex) => (
                    <ConversationRow
                      key={conversation.id}
                      conversation={conversation}
                      selected={selectedConversationId === conversation.id}
                      menuOpen={menuId === conversation.id}
                      renaming={renamingId === conversation.id}
                      setMenuId={setMenuId}
                      setRenamingId={setRenamingId}
                      toggleMenu={toggleConversationMenu}
                      onSelect={onSelectConversation}
                      onPin={onPinConversation}
                      onArchive={onArchiveConversation}
                      onRename={onRenameConversation}
                      reorderDisabled={reorderDisabled}
                      dragging={dragItem?.kind === "conversation" && dragItem.id === conversation.id}
                      dropPlacement={dropTarget?.kind === "conversation" && dropTarget.id === conversation.id ? dropTarget.placement : undefined}
                      canMoveUp={!reorderDisabled && conversationIndex > 0}
                      canMoveDown={!reorderDisabled && conversationIndex < section.conversations.length - 1}
                      onMove={(direction) => {
                        const target = section.conversations[conversationIndex + direction];
                        if (target) onReorderConversation(conversation.id, target.id, direction < 0 ? "before" : "after");
                      }}
                      onDragStart={(event) => beginDrag(event, { kind: "conversation", id: conversation.id, projectId: conversation.projectId })}
                      onDragOver={(event) => updateDropTarget(event, "conversation", conversation.id)}
                      onDrop={(event) => finishDrop(event, "conversation", conversation.id)}
                      onDragEnd={endDrag}
                    />
                  ))}
                  {section.conversations.length === 0 ? <span className="project-empty-label">{t("nav.noConversation")}</span> : null}
                </div>
              ) : null}
            </section>
          );
        })}
        {projectSections.length === 0 ? (
          <div className="sidebar-empty"><Bot size={24} /><span>{t(search ? "nav.noResult" : "nav.noProject")}</span></div>
        ) : null}
      </div>

      <footer className="sidebar-footer">
        <div className="project-health">
          <span className="health-icon"><Gauge size={15} /></span>
          <span><strong>{t("nav.localProject")}</strong><small>{t("nav.userPermissions")}</small></span>
          <span className="status-dot is-online" />
        </div>
      </footer>
    </aside>
  );
}

interface ConversationRowProps {
  conversation: Conversation;
  selected: boolean;
  menuOpen: boolean;
  renaming: boolean;
  setMenuId: (id?: string) => void;
  setRenamingId: (id?: string) => void;
  toggleMenu: (id: string) => void;
  onSelect: (id: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onArchive: (id: string) => void;
  onRename: (id: string, title: string) => void;
  reorderDisabled: boolean;
  dragging: boolean;
  dropPlacement?: ReorderPlacement;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (direction: -1 | 1) => void;
  onDragStart: (event: React.DragEvent) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent) => void;
  onDragEnd: () => void;
}

function ConversationRow({ conversation, selected, menuOpen, renaming, setMenuId, setRenamingId, toggleMenu, onSelect, onPin, onArchive, onRename, reorderDisabled, dragging, dropPlacement, canMoveUp, canMoveDown, onMove, onDragStart, onDragOver, onDrop, onDragEnd }: ConversationRowProps) {
  const { language, locale } = useI18n();
  const t = (key: NavKey, params?: TextParams) => navText(language, key, params);
  return (
    <div
      className={`conversation-row ${selected ? "is-active" : ""} ${dragging ? "is-dragging" : ""} ${dropPlacement ? `is-drop-${dropPlacement}` : ""}`}
      data-context-type="conversation"
      data-context-id={conversation.id}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <span
        className={`sidebar-drag-handle conversation-drag-handle ${reorderDisabled ? "is-disabled" : ""}`}
        draggable={!reorderDisabled}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        title={reorderDisabled ? t("nav.reorderSearchDisabled") : t("nav.dragConversation", { name: conversation.title })}
        aria-hidden="true"
      ><GripVertical size={11} /></span>
      {renaming ? (
        <form onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const title = String(form.get("title") ?? "").trim(); if (title) onRename(conversation.id, title); setRenamingId(undefined); }}>
          <input name="title" defaultValue={conversation.title} autoFocus aria-label={t("nav.newConversationName")} onBlur={(event) => { const title = event.currentTarget.value.trim(); if (title) onRename(conversation.id, title); setRenamingId(undefined); }} />
        </form>
      ) : (
        <button type="button" className="conversation-select" onClick={() => onSelect(conversation.id)} aria-current={selected ? "page" : undefined}>
          <span className="conversation-copy"><strong>{conversation.title}</strong><small>{conversationSubtitle(conversation, t, locale)}</small></span>
        </button>
      )}
      <div className="conversation-trailing">
        <ConversationRunIndicator conversation={conversation} />
        <IconButton label={t("nav.actionsFor", { name: conversation.title })} className="conversation-menu-button" aria-haspopup="menu" aria-expanded={menuOpen} data-dismissable-layer={`navigation-conversation-${conversation.id}`} onClick={() => toggleMenu(conversation.id)}><MoreHorizontal size={15} /></IconButton>
      </div>
      {menuOpen ? (
        <div className="popover conversation-menu" role="menu" data-dismissable-layer={`navigation-conversation-${conversation.id}`}>
          <button type="button" role="menuitem" disabled={!canMoveUp} onClick={() => { onMove(-1); setMenuId(undefined); }}><ArrowUp size={14} />{t("nav.moveUp")}</button>
          <button type="button" role="menuitem" disabled={!canMoveDown} onClick={() => { onMove(1); setMenuId(undefined); }}><ArrowDown size={14} />{t("nav.moveDown")}</button>
          <button type="button" role="menuitem" onClick={() => { onPin(conversation.id, !conversation.pinned); setMenuId(undefined); }}><Pin size={14} />{t(conversation.pinned ? "nav.unpin" : "nav.pin")}</button>
          <button type="button" role="menuitem" onClick={() => { setRenamingId(conversation.id); setMenuId(undefined); }}><MoreHorizontal size={14} />{t("nav.rename")}</button>
          <button type="button" role="menuitem" onClick={() => { onArchive(conversation.id); setMenuId(undefined); }}><Archive size={14} />{t("nav.archive")}</button>
        </div>
      ) : null}
    </div>
  );
}

function ConversationRunIndicator({ conversation }: { conversation: Conversation }) {
  const { language } = useI18n();
  const t = (key: NavKey, params?: TextParams) => navText(language, key, params);
  if (["starting", "queued", "streaming", "tool"].includes(conversation.status)) {
    return <span className="conversation-run-state is-working" role="status" aria-label={t("nav.workInProgress")} title={t("nav.workInProgress")}><LoaderCircle size={13} /></span>;
  }
  if (conversation.status === "error") {
    return <span className="conversation-run-state is-error" role="img" aria-label={t("nav.attentionRequired")} title={t("nav.attentionRequired")}><AlertCircle size={13} /></span>;
  }
  if (conversation.hasContent !== false) {
    return <span className="conversation-run-state is-done" role="img" aria-label={t("nav.workComplete")} title={t("nav.workComplete")}><CheckCircle2 size={13} /></span>;
  }
  return <span className="conversation-run-state is-ready" role="img" aria-label={t("nav.ready")} title={t("nav.ready")}><Circle size={11} /></span>;
}

type TextParams = Record<string, string | number>;
type Translator = (key: NavKey, params?: TextParams) => string;

function conversationSubtitle(conversation: Conversation, t: Translator, locale: string) {
  if (conversation.status === "streaming") return t("nav.responseInProgress");
  if (conversation.status === "tool") return t("nav.toolInProgress");
  if (conversation.status === "queued") return t("nav.messageQueued");
  if (conversation.status === "error") return t("nav.attentionRequired");
  const last = conversation.messages.at(-1)?.content;
  return last ? last.replace(/\s+/g, " ").slice(0, 58) : relativeTime(conversation.updatedAt, t, locale);
}

function relativeTime(value: string, t: Translator, locale: string) {
  const delta = Date.now() - new Date(value).getTime();
  const minutes = Math.max(1, Math.round(delta / 60_000));
  if (minutes < 60) return t("nav.minutesAgo", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("nav.hoursAgo", { count: hours });
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(new Date(value));
}

function compareManualOrder<T extends { id: string; manualOrder?: number }>(left: T, right: T) {
  const leftOrder = Number.isFinite(left.manualOrder) ? left.manualOrder! : Number.MAX_SAFE_INTEGER;
  const rightOrder = Number.isFinite(right.manualOrder) ? right.manualOrder! : Number.MAX_SAFE_INTEGER;
  return leftOrder - rightOrder || left.id.localeCompare(right.id);
}

function dropClass(target: DropTarget | undefined, kind: DragItem["kind"], id: string) {
  return target?.kind === kind && target.id === id ? `is-drop-${target.placement}` : "";
}

const NAV_COPY = {
  "nav.home": ["Accueil", "Home"],
  "nav.projects": ["Projets", "Projects"],
  "nav.runs": ["Exécutions", "Runs"],
  "nav.connections": ["Connexions", "Connections"],
  "nav.main": ["Navigation principale", "Main navigation"],
  "nav.brandHome": ["Prime Orbit — Accueil", "Prime Orbit — Home"],
  "nav.newConversation": ["Nouvelle conversation", "New conversation"],
  "nav.newConversationInProject": ["Nouvelle conversation dans {name}", "New conversation in {name}"],
  "nav.openFolder": ["Ouvrir un dossier", "Open folder"],
  "nav.commandPalette": ["Palette de commandes", "Command palette"],
  "nav.commandPaletteShortcut": ["Palette de commandes (Ctrl+K)", "Command palette (Ctrl+K)"],
  "nav.settings": ["Réglages", "Settings"],
  "nav.profile": ["Profil", "Profile"],
  "nav.userProfile": ["Profil utilisateur", "User profile"],
  "nav.projectsAndConversations": ["Projets et conversations", "Projects and conversations"],
  "nav.showSidebar": ["Afficher la barre latérale", "Show sidebar"],
  "nav.openProject": ["Ouvrir le projet {name}", "Open project {name}"],
  "nav.workspace": ["Espace de travail", "Workspace"],
  "nav.projectCount.one": ["1 projet", "1 project"],
  "nav.projectCount.other": ["{count} projets", "{count} projects"],
  "nav.hideSidebar": ["Masquer la barre latérale", "Hide sidebar"],
  "nav.search": ["Rechercher", "Search"],
  "nav.searchProjectsConversations": ["Rechercher dans les projets et conversations", "Search projects and conversations"],
  "nav.collapseProject": ["Replier {name}", "Collapse {name}"],
  "nav.expandProject": ["Déplier {name}", "Expand {name}"],
  "nav.pinnedProject": ["Projet épinglé", "Pinned project"],
  "nav.conversationCount.one": ["1 conversation", "1 conversation"],
  "nav.conversationCount.other": ["{count} conversations", "{count} conversations"],
  "nav.noConversation": ["Aucune conversation", "No conversations"],
  "nav.noResult": ["Aucun résultat", "No results"],
  "nav.noProject": ["Aucun projet", "No projects"],
  "nav.localProject": ["Projet local", "Local project"],
  "nav.userPermissions": ["Prime Agent · droits utilisateur", "Prime Agent · user permissions"],
  "nav.modeAutonomous": ["Mode autonome", "Autonomous mode"],
  "nav.modeGuarded": ["Accès prudent", "Guarded access"],
  "nav.modeStandard": ["Accès standard", "Standard access"],
  "nav.newConversationName": ["Nouveau nom de la conversation", "New conversation name"],
  "nav.actionsFor": ["Actions pour {name}", "Actions for {name}"],
  "nav.unpin": ["Désépingler", "Unpin"],
  "nav.pin": ["Épingler", "Pin"],
  "nav.rename": ["Renommer", "Rename"],
  "nav.archive": ["Archiver", "Archive"],
  "nav.workInProgress": ["Travail en cours", "Work in progress"],
  "nav.attentionRequired": ["Attention requise", "Attention required"],
  "nav.workComplete": ["Travail terminé", "Work complete"],
  "nav.ready": ["Prête", "Ready"],
  "nav.responseInProgress": ["Réponse en cours", "Response in progress"],
  "nav.toolInProgress": ["Outil en cours", "Tool in progress"],
  "nav.messageQueued": ["Message en attente", "Message queued"],
  "nav.minutesAgo": ["Il y a {count} min", "{count} min ago"],
  "nav.hoursAgo": ["Il y a {count} h", "{count} hr ago"],
  "nav.dragProject": ["Faire glisser le projet {name}", "Drag project {name}"],
  "nav.dragConversation": ["Faire glisser la conversation {name}", "Drag conversation {name}"],
  "nav.reorderSearchDisabled": ["Effacez la recherche pour réordonner", "Clear the search to reorder"],
  "nav.moveProjectUp": ["Monter le projet {name}", "Move project {name} up"],
  "nav.moveProjectDown": ["Descendre le projet {name}", "Move project {name} down"],
  "nav.moveUp": ["Monter", "Move up"],
  "nav.moveDown": ["Descendre", "Move down"],
} as const;

type NavKey = keyof typeof NAV_COPY;

function bi(language: AppLanguage, fr: string, en: string) {
  return language === "en" ? en : fr;
}

function navText(language: AppLanguage, key: NavKey, params?: TextParams) {
  const [fr, en] = NAV_COPY[key];
  const value = bi(language, fr, en);
  if (!params) return value;
  return value.replace(/\{([a-zA-Z0-9_]+)\}/g, (token, name: string) => String(params[name] ?? token));
}
