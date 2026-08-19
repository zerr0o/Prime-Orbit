import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Activity,
  ArchiveRestore,
  CalendarClock,
  ArrowDown,
  ArrowUp,
  Box,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleStop,
  Clock3,
  Code2,
  Copy,
  File,
  FileCode2,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  HeartPulse,
  Eye,
  EyeOff,
  Image,
  Info,
  Layers3,
  ListTree,
  LoaderCircle,
  Maximize2,
  MoreHorizontal,
  Paperclip,
  Pause,
  Pencil,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Terminal,
  Target,
  Trash2,
  WandSparkles,
  X,
  Zap,
} from "lucide-react";
import { getGitFileDiff, openGitFileFolder, pickAttachments, releaseAttachmentHandles } from "../lib/bridge";
import { useDismissableLayer } from "../hooks/useDismissableLayer";
import { useI18n, type AppLanguage } from "../i18n";
import type {
  ActivityItem,
  AgentSessionState,
  AgentSchedule,
  AgentHeartbeatSummary,
  AgentRlmChild,
  Attachment,
  ChatMessage,
  Conversation,
  GitChange,
  GitFileDiff,
  ModelInfo,
  Project,
  SessionStats,
  SlashCommand,
  ThinkingLevel,
  ToolActivity,
} from "../types";
import { Badge, Button, IconButton, Modal } from "./Ui";

function bi(language: AppLanguage, french: string, english: string) {
  return language === "en" ? english : french;
}

interface ConversationViewProps {
  project: Project;
  conversation: Conversation;
  models: ModelInfo[];
  commands: SlashCommand[];
  stats?: SessionStats;
  sessionState?: AgentSessionState;
  schedules?: AgentSchedule[];
  heartbeat?: AgentSchedule | null;
  heartbeats?: AgentHeartbeatSummary[];
  subagents?: AgentRlmChild[];
  observedSubagent?: { activeSessionId: string; messages: ChatMessage[]; closed?: boolean; error?: string };
  inspectorOpen: boolean;
  changes: GitChange[];
  onToggleInspector: () => void;
  onDraftChange: (draft: string) => void;
  onSend: (message: string, attachments: Attachment[], delivery?: "steer" | "follow_up") => Promise<void>;
  onMutateQueuedMessage: (input: { messageId: string; lane: "steering" | "followUp"; index: number; expectedText: string; mutation: { type: "delete" } | { type: "replace"; text: string; lane: "steering" | "followUp" } }) => Promise<void>;
  onRetryMessage: (assistantMessageId: string) => Promise<void>;
  onAbort: () => Promise<void>;
  onModel: (model: ModelInfo) => Promise<void>;
  onThinking: (level: ThinkingLevel) => Promise<void>;
  onRunCommand: (type: string, fields?: Record<string, unknown>) => Promise<void>;
  onObserveSubagent: (activeSessionId?: string) => Promise<void>;
  onForkMessage: (assistantMessageId: string) => Promise<void>;
  onCloneSession: () => Promise<void>;
  onNewWindow: () => void;
  onOpenTerminal: () => void;
}

export function ConversationView(props: ConversationViewProps) {
  const { project, conversation, models, commands, stats, sessionState, schedules = [], heartbeat, heartbeats = [], subagents = [], observedSubagent, inspectorOpen, changes, onToggleInspector, onDraftChange, onSend, onMutateQueuedMessage, onRetryMessage, onAbort, onModel, onThinking, onRunCommand, onObserveSubagent, onForkMessage, onCloneSession, onNewWindow, onOpenTerminal } = props;
  const isRunning = ["starting", "streaming", "tool", "queued"].includes(conversation.status);
  const [inspectorTab, setInspectorTab] = useState<"activity" | "session" | "changes" | "details">("changes");
  const [openPopover, setOpenPopover] = useState<ConversationPopover>(null);
  const closePopover = useCallback(() => setOpenPopover(null), []);
  const togglePopover = useCallback((popover: Exclude<ConversationPopover, null>) => {
    setOpenPopover((current) => current === popover ? null : popover);
  }, []);
  useDismissableLayer(openPopover, closePopover);
  useEffect(closePopover, [conversation.id, closePopover]);

  return (
    <div className="conversation-workspace">
      <div className="conversation-main">
        <ConversationHeader
          project={project}
          conversation={conversation}
          models={models}
          sessionState={sessionState}
          inspectorOpen={inspectorOpen}
          onModel={onModel}
          onToggleInspector={onToggleInspector}
          onNewWindow={onNewWindow}
          onOpenTerminal={onOpenTerminal}
          onRunCommand={onRunCommand}
          onCloneSession={onCloneSession}
          openPopover={openPopover}
          onTogglePopover={togglePopover}
          onClosePopover={closePopover}
        />
        <Transcript conversation={conversation} project={project} onSuggestion={(text) => onDraftChange(text)} onRunCommand={onRunCommand} onRetryMessage={onRetryMessage} onForkMessage={onForkMessage} />
        {isRunning ? <ActiveRunBar conversation={conversation} onAbort={onAbort} onActivity={() => { setInspectorTab("activity"); if (!inspectorOpen) onToggleInspector(); }} /> : null}
        <Composer
          key={conversation.id}
          project={project}
          conversation={conversation}
          models={models}
          commands={commands}
          stats={stats}
          sessionState={sessionState}
          isRunning={isRunning}
          onDraftChange={onDraftChange}
          onSend={onSend}
          onMutateQueuedMessage={onMutateQueuedMessage}
          onAbort={onAbort}
          onModel={onModel}
          onThinking={onThinking}
          onRunCommand={onRunCommand}
          openPopover={openPopover}
          onTogglePopover={togglePopover}
          onClosePopover={closePopover}
        />
      </div>
      {inspectorOpen ? (
        <RunInspector
          project={project}
          conversation={conversation}
          stats={stats}
          sessionState={sessionState}
          schedules={schedules}
          heartbeat={heartbeat}
          heartbeats={heartbeats}
          subagents={subagents}
          observedSubagent={observedSubagent}
          changes={changes}
          tab={inspectorTab}
          onTab={setInspectorTab}
          onClose={onToggleInspector}
          onRunCommand={onRunCommand}
          onObserveSubagent={onObserveSubagent}
          onCloneSession={onCloneSession}
          onDraftChange={onDraftChange}
        />
      ) : null}
    </div>
  );
}

type ConversationPopover = "header-model" | "header-actions" | "composer-tools" | "composer-queue" | "composer-model" | "composer-thinking" | null;

function ConversationHeader({ project, conversation, models, sessionState, inspectorOpen, onModel, onToggleInspector, onNewWindow, onOpenTerminal, onRunCommand, onCloneSession, openPopover, onTogglePopover, onClosePopover }: {
  project: Project;
  conversation: Conversation;
  models: ModelInfo[];
  sessionState?: AgentSessionState;
  inspectorOpen: boolean;
  onModel: (model: ModelInfo) => Promise<void>;
  onToggleInspector: () => void;
  onNewWindow: () => void;
  onOpenTerminal: () => void;
  onRunCommand: (type: string, fields?: Record<string, unknown>) => Promise<void>;
  onCloneSession: () => Promise<void>;
  openPopover: ConversationPopover;
  onTogglePopover: (popover: Exclude<ConversationPopover, null>) => void;
  onClosePopover: () => void;
}) {
  const { language } = useI18n();
  const activeModel = models.find((model) => `${model.provider}/${model.id}` === conversation.model);
  return (
    <header className="conversation-header">
      <div className="conversation-heading">
        <div className="breadcrumbs"><span>{project.name}</span><ChevronRight size={13} /><strong title={conversation.title}>{conversation.title}</strong></div>
        <div className="workspace-meta"><GitBranch size={13} /><span>{shortPath(project.path)}</span><span className="meta-separator" /> <span className={`connection-state status-${conversation.status}`}>{statusLabel(conversation.status, language)}</span></div>
      </div>
      <div className="conversation-header-actions">
        <div className="header-model-wrap" data-dismissable-layer="header-model">
          <button type="button" className="header-model" aria-haspopup="menu" aria-expanded={openPopover === "header-model"} onClick={() => onTogglePopover("header-model")}>
            <span className="model-provider-icon"><Sparkles size={14} /></span>
            <span>{activeModel?.name ?? activeModel?.id ?? shortModel(conversation.model) ?? bi(language, "Modèle", "Model")}</span>
            <ChevronDown size={14} />
          </button>
          {openPopover === "header-model" ? <ModelPopover models={models} active={conversation.model} onChoose={(model) => { void onModel(model); onClosePopover(); }} /> : null}
        </div>
        <IconButton label={bi(language, "Ouvrir le terminal", "Open terminal")} onClick={onOpenTerminal}><Terminal size={18} /></IconButton>
        <IconButton label={bi(language, "Ouvrir dans une nouvelle fenêtre", "Open in a new window")} onClick={onNewWindow}><Maximize2 size={17} /></IconButton>
        <IconButton label={inspectorOpen ? bi(language, "Masquer l’inspecteur", "Hide inspector") : bi(language, "Afficher l’inspecteur", "Show inspector")} className={inspectorOpen ? "is-active" : ""} onClick={onToggleInspector}>
          {inspectorOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
        </IconButton>
        <div className="header-model-wrap" data-dismissable-layer="header-actions">
          <IconButton label={bi(language, "Plus d’actions", "More actions")} className={openPopover === "header-actions" ? "is-active" : ""} onClick={() => onTogglePopover("header-actions")}><MoreHorizontal size={18} /></IconButton>
          {openPopover === "header-actions" ? <SessionActionsPopover sessionState={sessionState} onClone={() => { void onCloneSession(); onClosePopover(); }} onChoose={(type, fields, keepOpen) => { void onRunCommand(type, fields); if (!keepOpen) onClosePopover(); }} /> : null}
        </div>
      </div>
    </header>
  );
}

function SessionActionsPopover({ sessionState, onChoose, onClone }: {
  sessionState?: AgentSessionState;
  onChoose: (type: string, fields?: Record<string, unknown>, keepOpen?: boolean) => void;
  onClone: () => void;
}) {
  const { language } = useI18n();
  const steeringMode = sessionState?.steeringMode ?? "one-at-a-time";
  const followUpMode = sessionState?.followUpMode ?? "one-at-a-time";
  return (
    <div className="popover session-actions-popover">
      <div className="popover-label">{bi(language, "Session", "Session")}</div>
      <button type="button" onClick={onClone}><Copy size={15} /><span><strong>{bi(language, "Dupliquer la session", "Duplicate session")}</strong><small>{bi(language, "Conserver l’origine et ouvrir une copie", "Keep the source and open a copy")}</small></span></button>
      <button type="button" onClick={() => onChoose("export_html")}><ArrowDown size={15} /><span><strong>{bi(language, "Exporter en HTML", "Export as HTML")}</strong><small>{bi(language, "Créer une copie lisible de la session", "Create a readable copy of the session")}</small></span></button>
      <div className="popover-separator" />
      <div className="popover-label">{bi(language, "Comportement", "Behavior")}</div>
      <button type="button" onClick={() => onChoose("set_auto_compaction", { enabled: !sessionState?.autoCompactionEnabled })}><ArchiveRestore size={15} /><span><strong>{bi(language, "Compactage automatique", "Automatic compaction")}</strong><small>{sessionState?.autoCompactionEnabled ? bi(language, "Activé · cliquer pour désactiver", "Enabled · click to disable") : bi(language, "Désactivé · cliquer pour activer", "Disabled · click to enable")}</small></span><Badge tone={sessionState?.autoCompactionEnabled ? "success" : "neutral"}>{sessionState?.autoCompactionEnabled ? "On" : "Off"}</Badge></button>
      <QueueModeRow icon={<Layers3 size={15} />} title={bi(language, "Orienter le travail en cours", "Steer current work")} detail={bi(language, "Livré après les outils du tour actuel, avant le prochain appel au modèle.", "Delivered after the current turn's tools, before the next model call.")} mode={steeringMode} language={language} onMode={(mode) => onChoose("set_steering_mode", { mode }, true)} />
      <QueueModeRow icon={<Clock3 size={15} />} title={bi(language, "Démarrer un nouveau tour ensuite", "Start a follow-up turn")} detail={bi(language, "Attend la fin complète de l’exécution, puis démarre un nouveau tour utilisateur.", "Waits for the run to finish, then starts a new user turn.")} mode={followUpMode} language={language} onMode={(mode) => onChoose("set_follow_up_mode", { mode }, true)} />
      <button type="button" onClick={() => onChoose("get_state")}><RefreshCw size={15} /><span><strong>{bi(language, "Resynchroniser", "Resync")}</strong><small>{bi(language, "Recharger l’état de Prime Agent", "Reload Prime Agent state")}</small></span></button>
    </div>
  );
}

function Transcript({ conversation, project, onSuggestion, onRunCommand, onRetryMessage, onForkMessage }: { conversation: Conversation; project: Project; onSuggestion: (text: string) => void; onRunCommand: (type: string, fields?: Record<string, unknown>) => Promise<void>; onRetryMessage: (assistantMessageId: string) => Promise<void>; onForkMessage: (assistantMessageId: string) => Promise<void> }) {
  const { language } = useI18n();
  const viewport = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const messages = conversation.messages.filter((message) => !message.queueDelivery);
  const entries = buildTranscriptEntries(messages);
  const isHistoryLoading = messages.length === 0 && conversation.status === "starting";

  useEffect(() => {
    if (atBottom) viewport.current?.scrollTo({ top: viewport.current.scrollHeight, behavior: "smooth" });
  }, [atBottom, messages]);

  const handleScroll = () => {
    const node = viewport.current;
    if (!node) return;
    setAtBottom(node.scrollHeight - node.scrollTop - node.clientHeight < 120);
  };

  return (
    <div className="transcript-viewport" ref={viewport} onScroll={handleScroll}>
      {isHistoryLoading ? (
        <ConversationLoading conversation={conversation} />
      ) : messages.length === 0 && conversation.lastError ? (
        <ConversationLoadError conversation={conversation} onRetry={() => onRunCommand("get_state")} />
      ) : messages.length === 0 ? (
        <ConversationWelcome project={project} onSuggestion={onSuggestion} />
      ) : (
        <div className="transcript-content">
          <div className="transcript-date"><span>{bi(language, "Aujourd’hui", "Today")}</span></div>
          {entries.map((entry) => entry.kind === "message"
            ? <MessageItem key={entry.message.id} message={entry.message} onRetryMessage={onRetryMessage} onForkMessage={onForkMessage} />
            : <PythonTranscriptRun key={entry.id} messages={entry.messages} tools={entry.tools} onRetryMessage={onRetryMessage} onForkMessage={onForkMessage} />)}
          {conversation.lastError ? (
            <div className="inline-error"><Info size={17} /><div><strong>{bi(language, "Prime Agent a besoin d’attention", "Prime Agent needs attention")}</strong><p>{conversation.lastError}</p></div><Button variant="ghost" onClick={() => void onRunCommand("get_state")}>{bi(language, "Réessayer", "Retry")}</Button></div>
          ) : null}
        </div>
      )}
      {!atBottom ? <IconButton label={bi(language, "Aller au dernier message", "Go to latest message")} className="scroll-bottom" onClick={() => viewport.current?.scrollTo({ top: viewport.current.scrollHeight, behavior: "smooth" })}><ArrowDown size={17} /></IconButton> : null}
    </div>
  );
}

function ConversationLoadError({ conversation, onRetry }: { conversation: Conversation; onRetry: () => Promise<void> }) {
  const { language } = useI18n();
  const titleId = `conversation-load-error-title-${conversation.id}`;
  const detailId = `conversation-load-error-detail-${conversation.id}`;

  return (
    <section className="conversation-load-error" role="alert" aria-live="assertive" aria-atomic="true" aria-labelledby={titleId} aria-describedby={detailId}>
      <div className="conversation-load-error-card">
        <span className="conversation-load-error-icon" aria-hidden="true"><Info size={21} /></span>
        <div className="conversation-load-error-content">
          <p className="eyebrow">{bi(language, "CONVERSATION INDISPONIBLE", "CONVERSATION UNAVAILABLE")}</p>
          <h2 id={titleId}>{bi(language, "Impossible de charger cette conversation", "Unable to load this conversation")}</h2>
          <p>{bi(language, "Prime Agent n’a pas pu restaurer l’historique. Vous pouvez relancer le chargement sans créer une nouvelle conversation.", "Prime Agent could not restore the history. You can retry loading without creating a new conversation.")}</p>
          <p className="conversation-load-error-detail" id={detailId}>{conversation.lastError}</p>
          <Button variant="secondary" onClick={() => { void onRetry().catch(() => undefined); }}><RefreshCw size={14} />{bi(language, "Relancer le chargement", "Retry loading")}</Button>
        </div>
      </div>
    </section>
  );
}

function ConversationLoading({ conversation }: { conversation: Conversation }) {
  const { language } = useI18n();
  const isSavedConversation = Boolean(conversation.hasContent || conversation.sessionId || conversation.sessionPath);
  const titleId = `conversation-loading-title-${conversation.id}`;
  const detailId = `conversation-loading-detail-${conversation.id}`;
  const title = isSavedConversation
    ? bi(language, "Chargement de la conversation", "Loading conversation")
    : bi(language, "Préparation de la conversation", "Preparing conversation");
  const detail = isSavedConversation
    ? bi(language, "Récupération de l’historique de cette conversation…", "Fetching this conversation’s history…")
    : bi(language, "Connexion à Prime Agent et préparation de votre espace de travail…", "Connecting to Prime Agent and preparing your workspace…");

  return (
    <section className="conversation-loading" role="status" aria-live="polite" aria-atomic="true" aria-busy="true" aria-labelledby={titleId} aria-describedby={detailId}>
      <div className="conversation-loading-heading">
        <span className="conversation-loading-icon" aria-hidden="true"><LoaderCircle size={20} className="spin" /></span>
        <div>
          <p className="eyebrow">{bi(language, "CONVERSATION", "CONVERSATION")}</p>
          <h2 id={titleId}>{title}</h2>
          <p id={detailId}>{detail}</p>
        </div>
      </div>
      <div className="conversation-loading-skeleton" aria-hidden="true">
        <div className="conversation-loading-message is-wide">
          <span className="skeleton conversation-loading-avatar" />
          <div><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /></div>
        </div>
        <div className="conversation-loading-message is-compact">
          <span className="skeleton conversation-loading-avatar" />
          <div><span className="skeleton" /><span className="skeleton" /></div>
        </div>
        <div className="conversation-loading-message is-wide">
          <span className="skeleton conversation-loading-avatar" />
          <div><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /></div>
        </div>
      </div>
    </section>
  );
}

function ConversationWelcome({ project, onSuggestion }: { project: Project; onSuggestion: (text: string) => void }) {
  const { language } = useI18n();
  const suggestions = [
    { icon: <Search size={18} />, title: bi(language, "Comprendre le projet", "Understand the project"), text: bi(language, "Analyse ce projet, explique son architecture et identifie les points importants pour commencer.", "Analyze this project, explain its architecture, and identify the key starting points.") },
    { icon: <WandSparkles size={18} />, title: bi(language, "Développer une fonctionnalité", "Build a feature"), text: bi(language, "Aide-moi à développer une nouvelle fonctionnalité dans ce projet. Commence par proposer un plan concret.", "Help me build a new feature in this project. Start by proposing a concrete plan.") },
    { icon: <ShieldCheck size={18} />, title: bi(language, "Auditer le code", "Audit the code"), text: bi(language, "Audite le projet pour trouver les bugs, risques de sécurité et problèmes de maintenabilité prioritaires.", "Audit the project for priority bugs, security risks, and maintainability issues.") },
    { icon: <Play size={18} />, title: bi(language, "Lancer et vérifier", "Run and verify"), text: bi(language, "Trouve comment lancer et tester ce projet, puis corrige les problèmes qui empêchent son démarrage.", "Find out how to run and test this project, then fix anything preventing it from starting.") },
  ];
  return (
    <div className="conversation-welcome">
      <div className="welcome-orbit"><span className="welcome-core"><Sparkles size={26} /></span><i /><i /></div>
      <p className="eyebrow">{bi(language, "ESPACE DE TRAVAIL", "WORKSPACE")}</p>
      <h1>{bi(language, "Que voulez-vous construire dans", "What would you like to build in")}<br /><span>{project.name}</span> ?</h1>
      <p className="welcome-copy">{bi(language, "Prime Agent peut explorer le projet, écrire du code, lancer des outils et poursuivre des objectifs longs depuis ce dossier.", "Prime Agent can explore the project, write code, run tools, and pursue long-running goals from this folder.")}</p>
      <div className="suggestion-grid">
        {suggestions.map((suggestion) => (
          <button key={suggestion.title} type="button" onClick={() => onSuggestion(suggestion.text)}>
            <span>{suggestion.icon}</span><div><strong>{suggestion.title}</strong><small>{suggestion.text.slice(0, 72)}…</small></div><ArrowUp size={15} />
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageItem({ message, onRetryMessage, onForkMessage, showTools = true }: { message: ChatMessage; onRetryMessage: (assistantMessageId: string) => Promise<void>; onForkMessage: (assistantMessageId: string) => Promise<void>; showTools?: boolean }) {
  const { language, locale } = useI18n();
  const isUser = message.role === "user";
  return (
    <article className={`message message-${message.role}`}>
      <div className="message-avatar">{isUser ? "ZE" : <span className="mini-orbit"><span /></span>}</div>
      <div className="message-column">
        <header className="message-header"><strong>{isUser ? bi(language, "Vous", "You") : "Prime Agent"}</strong><time>{formatTime(message.createdAt, locale)}</time>{message.model ? <Badge>{shortModel(message.model)}</Badge> : null}</header>
        <div className={isUser ? "user-message-card" : "assistant-message-body"}>
          {message.attachments?.length ? <AttachmentStrip attachments={message.attachments} /> : null}
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
            a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
            code: ({ children, className, ...props }) => <code {...props} className={className}>{children}</code>,
          }}>{message.content || (message.status === "streaming" ? " " : "")}</ReactMarkdown>
          {message.status === "streaming" ? <span className="streaming-cursor" /> : null}
        </div>
        {showTools && message.tools?.length ? <MessageToolSequence tools={message.tools} /> : null}
        {!isUser && message.status === "complete" && message.content.trim() ? (
          <footer className="message-actions">
            <IconButton label={bi(language, "Copier la réponse", "Copy response")} onClick={() => void navigator.clipboard.writeText(message.content)}><Copy size={14} /></IconButton>
            <IconButton label={bi(language, "Réutiliser le texte dans le composeur", "Reuse text in the composer")} onClick={() => void onRetryMessage(message.id)}><RefreshCw size={14} /></IconButton>
            <IconButton label={bi(language, "Créer une branche depuis ce tour", "Branch from this turn")} onClick={() => void onForkMessage(message.id)}><GitBranch size={14} /></IconButton>
            <span />
            {message.durationMs ? <small><Clock3 size={12} /> {formatDuration(message.durationMs)}</small> : null}
            {message.usage?.total ? <small>{compactNumber(message.usage.total, locale)} tokens</small> : null}
          </footer>
        ) : null}
      </div>
    </article>
  );
}

type TranscriptEntry =
  | { kind: "message"; message: ChatMessage }
  | { kind: "python-run"; id: string; messages: ChatMessage[]; tools: ToolActivity[] };

/**
 * A user message, visible non-Python tool, or mixed tool set always starts a new
 * block. Only uninterrupted assistant messages containing Python tools alone are
 * folded together; their visible text is still rendered in its original order.
 */
function buildTranscriptEntries(messages: ChatMessage[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (let index = 0; index < messages.length;) {
    const message = messages[index]!;
    if (!isPythonOnlyAssistantMessage(message)) {
      entries.push({ kind: "message", message });
      index += 1;
      continue;
    }

    const runMessages: ChatMessage[] = [];
    const tools: ToolActivity[] = [];
    let cursor = index;
    while (cursor < messages.length && isPythonOnlyAssistantMessage(messages[cursor]!)) {
      const candidate = messages[cursor]!;
      runMessages.push(candidate);
      tools.push(...(candidate.tools ?? []));
      cursor += 1;
    }

    const uniqueTools = mergeToolCalls(tools);
    if (uniqueTools.length < 2) {
      runMessages.forEach((candidate) => entries.push({ kind: "message", message: candidate }));
    } else {
      entries.push({ kind: "python-run", id: `python-run:${runMessages[0]!.id}`, messages: runMessages, tools: uniqueTools });
    }
    index = cursor;
  }
  return entries;
}

function isPythonOnlyAssistantMessage(message: ChatMessage) {
  return message.role === "assistant" && Boolean(message.tools?.length) && message.tools!.every(isPythonTool);
}

function PythonTranscriptRun({ messages, tools, onRetryMessage, onForkMessage }: { messages: ChatMessage[]; tools: ToolActivity[]; onRetryMessage: (assistantMessageId: string) => Promise<void>; onForkMessage: (assistantMessageId: string) => Promise<void> }) {
  const { language, locale } = useI18n();
  const visibleMessages = messages.filter((message) => message.content.trim() || (message.attachments?.length ?? 0) > 0);
  const lastMessage = messages.at(-1)!;
  return (
    <>
      {visibleMessages.map((message) => <MessageItem key={message.id} message={message} onRetryMessage={onRetryMessage} onForkMessage={onForkMessage} showTools={false} />)}
      <article className="message message-assistant message-python-run">
        <div className="message-avatar"><span className="mini-orbit"><span /></span></div>
        <div className="message-column">
          <header className="message-header"><strong>Prime Agent</strong><time>{formatTime(lastMessage.createdAt, locale)}</time><Badge>{bi(language, "Séquence technique", "Technical sequence")}</Badge></header>
          <div className="message-tools"><PythonExecutionGroup tools={tools} /></div>
        </div>
      </article>
    </>
  );
}

function MessageToolSequence({ tools }: { tools: ToolActivity[] }) {
  const segments: Array<{ kind: "tool"; tool: ToolActivity } | { kind: "python"; tools: ToolActivity[] }> = [];
  for (let index = 0; index < tools.length;) {
    if (!isPythonTool(tools[index]!)) {
      segments.push({ kind: "tool", tool: tools[index]! });
      index += 1;
      continue;
    }
    const pythonTools: ToolActivity[] = [];
    while (index < tools.length && isPythonTool(tools[index]!)) {
      pythonTools.push(tools[index]!);
      index += 1;
    }
    if (pythonTools.length === 1) segments.push({ kind: "tool", tool: pythonTools[0]! });
    else segments.push({ kind: "python", tools: pythonTools });
  }
  return <div className="message-tools">{segments.map((segment) => segment.kind === "tool"
    ? <ToolCard key={segment.tool.id} tool={segment.tool} />
    : <PythonExecutionGroup key={`python:${segment.tools[0]!.id}`} tools={segment.tools} />)}</div>;
}

function AttachmentStrip({ attachments }: { attachments: Attachment[] }) {
  const { language, locale } = useI18n();
  return (
    <div className="message-attachments">
      {attachments.map((attachment) => (
        attachment.isImage && attachment.previewDataUrl
          ? <figure key={attachment.id}><img src={attachment.previewDataUrl} alt={attachment.name} /><figcaption>{attachment.name} · {formatBytes(attachment.size, language, locale)}</figcaption></figure>
          : <div key={attachment.id} className="file-attachment">{attachment.isImage ? <Image size={17} /> : <File size={17} />}<span><strong>{attachment.name}</strong><small>{formatBytes(attachment.size, language, locale)}</small></span></div>
      ))}
    </div>
  );
}

function PythonExecutionGroup({ tools }: { tools: ToolActivity[] }) {
  const { language } = useI18n();
  const executions = mergeToolCalls(tools);
  const summary = summarizePythonTools(executions);
  const [open, setOpen] = useState(summary.failed > 0);
  const previousFailures = useRef(summary.failed);
  useEffect(() => {
    if (summary.failed > previousFailures.current) setOpen(true);
    previousFailures.current = summary.failed;
  }, [summary.failed]);

  const status = summary.running > 0 ? "running" : summary.failed > 0 ? "failed" : summary.cancelled > 0 ? "cancelled" : "completed";
  const details = [
    summary.running ? `${summary.running} ${bi(language, "en cours", "running")}` : "",
    summary.completed ? `${summary.completed} ${bi(language, "terminée", "complete")}${summary.completed > 1 && language === "fr" ? "s" : ""}` : "",
    summary.failed ? `${summary.failed} ${summary.failed > 1 ? bi(language, "échecs", "failed") : bi(language, "échec", "failed")}` : "",
    summary.cancelled ? `${summary.cancelled} ${bi(language, "annulée", "cancelled")}${summary.cancelled > 1 && language === "fr" ? "s" : ""}` : "",
  ].filter(Boolean).join(" · ");

  return (
    <section className={`python-execution-group is-${status}`}>
      <button type="button" className="python-group-summary" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="python-group-icon">{summary.running ? <LoaderCircle size={15} className="spin" /> : summary.failed ? <X size={15} /> : <Terminal size={15} />}</span>
        <span><strong>{bi(language, "Exécutions Python", "Python executions")} <em>{executions.length}</em></strong><small>{details}</small></span>
        <ChevronDown size={15} className={open ? "is-open" : ""} />
      </button>
      {open ? <div className="python-execution-list">{executions.map((tool, index) => (
        <ToolCard key={tool.id} tool={{ ...tool, title: `${bi(language, "Python", "Python")} #${index + 1}` }} />
      ))}</div> : null}
    </section>
  );
}

function isPythonTool(tool: ToolActivity) {
  const name = tool.name.trim().toLowerCase();
  return name === "ipython" || name === "python" || name.endsWith(".ipython") || name.includes("python");
}

function mergeToolCalls(tools: ToolActivity[]) {
  const merged: ToolActivity[] = [];
  const positions = new Map<string, number>();
  for (const tool of tools) {
    const position = positions.get(tool.id);
    if (position === undefined) {
      positions.set(tool.id, merged.length);
      merged.push(tool);
      continue;
    }
    const previous = merged[position]!;
    merged[position] = {
      ...previous,
      ...tool,
      input: tool.input ?? previous.input,
      output: tool.output ?? previous.output,
      startedAt: previous.startedAt < tool.startedAt ? previous.startedAt : tool.startedAt,
      endedAt: tool.endedAt ?? previous.endedAt,
    };
  }
  return merged;
}

function summarizePythonTools(tools: ToolActivity[]) {
  return tools.reduce((summary, tool) => {
    if (tool.status === "running" || tool.status === "queued") summary.running += 1;
    else if (tool.status === "failed") summary.failed += 1;
    else if (tool.status === "cancelled") summary.cancelled += 1;
    else summary.completed += 1;
    return summary;
  }, { running: 0, completed: 0, failed: 0, cancelled: 0 });
}

function ToolCard({ tool }: { tool: ToolActivity }) {
  const { language } = useI18n();
  const [open, setOpen] = useState(tool.status === "running");
  const previousStatus = useRef(tool.status);
  useEffect(() => {
    if (previousStatus.current === "running" && tool.status !== "running") setOpen(false);
    previousStatus.current = tool.status;
  }, [tool.status]);
  const statusIcon = tool.status === "running"
    ? <LoaderCircle size={15} className="spin" />
    : tool.status === "queued"
      ? <Clock3 size={15} />
      : tool.status === "failed"
        ? <X size={15} />
        : tool.status === "cancelled" ? <CircleStop size={15} /> : <Check size={15} />;
  const statusText = tool.status === "running"
    ? bi(language, "En cours", "Running")
    : tool.status === "queued"
      ? bi(language, "En attente", "Queued")
      : tool.status === "failed"
        ? bi(language, "Échec", "Failed")
        : tool.status === "cancelled" ? bi(language, "Annulé", "Cancelled") : bi(language, "Terminé", "Complete");
  return (
    <section className={`tool-card tool-${tool.status}`}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="tool-icon">{statusIcon}</span>
        <span><strong>{tool.title}</strong><small>{statusText}</small></span>
        <ChevronDown size={15} className={open ? "is-open" : ""} />
      </button>
      {open ? <div className="tool-details">{tool.input !== undefined ? <div><label>{bi(language, "Entrée", "Input")}</label><pre>{pretty(tool.input, language)}</pre></div> : null}{tool.output !== undefined ? <div><label>{bi(language, "Sortie", "Output")}</label><pre>{pretty(tool.output, language)}</pre></div> : null}</div> : null}
    </section>
  );
}

function ActiveRunBar({ conversation, onAbort, onActivity }: { conversation: Conversation; onAbort: () => Promise<void>; onActivity: () => void }) {
  const { language } = useI18n();
  return (
    <div className="active-run-bar">
      <button type="button" className="run-summary" onClick={onActivity}>
        <span className="pulse-ring"><span /></span>
        <div><strong>{conversation.status === "tool" ? bi(language, "Prime Agent utilise un outil", "Prime Agent is using a tool") : conversation.status === "queued" ? bi(language, "Message ajouté à la file", "Message added to queue") : conversation.status === "starting" ? bi(language, "Connexion à Prime Agent", "Connecting to Prime Agent") : bi(language, "Prime Agent travaille", "Prime Agent is working")}</strong><small>{bi(language, "Voir la chronologie de l’exécution", "View the run timeline")}</small></div>
        <ChevronRight size={15} />
      </button>
      <button type="button" className="stop-run" onClick={() => void onAbort()}><CircleStop size={16} />{bi(language, "Arrêter", "Stop")}</button>
    </div>
  );
}

function Composer({ project, conversation, models, commands, stats, sessionState, isRunning, onDraftChange, onSend, onMutateQueuedMessage, onAbort, onModel, onThinking, onRunCommand, openPopover, onTogglePopover, onClosePopover }: {
  project: Project;
  conversation: Conversation;
  models: ModelInfo[];
  commands: SlashCommand[];
  stats?: SessionStats;
  sessionState?: AgentSessionState;
  isRunning: boolean;
  onDraftChange: (draft: string) => void;
  onSend: (message: string, attachments: Attachment[], delivery?: "steer" | "follow_up") => Promise<void>;
  onMutateQueuedMessage: (input: { messageId: string; lane: "steering" | "followUp"; index: number; expectedText: string; mutation: { type: "delete" } | { type: "replace"; text: string; lane: "steering" | "followUp" } }) => Promise<void>;
  onAbort: () => Promise<void>;
  onModel: (model: ModelInfo) => Promise<void>;
  onThinking: (level: ThinkingLevel) => Promise<void>;
  onRunCommand: (type: string, fields?: Record<string, unknown>) => Promise<void>;
  openPopover: ConversationPopover;
  onTogglePopover: (popover: Exclude<ConversationPopover, null>) => void;
  onClosePopover: () => void;
}) {
  const { language, locale } = useI18n();
  const [draft, setDraft] = useState(conversation.draft);
  const draftRef = useRef(conversation.draft);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const attachmentsRef = useRef<Attachment[]>([]);
  const submittingRef = useRef(false);
  const [adding, setAdding] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string>();
  const [queueEditor, setQueueEditor] = useState<{ id: string; text: string }>();
  const [queueBusyId, setQueueBusyId] = useState<string>();
  const [queueError, setQueueError] = useState<string>();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const activeModel = models.find((model) => `${model.provider}/${model.id}` === conversation.model);

  useEffect(() => {
    setDraft(conversation.draft);
    draftRef.current = conversation.draft;
  }, [conversation.draft]);
  useEffect(() => {
    const abandonedHandles = attachmentHandles(attachmentsRef.current);
    attachmentsRef.current = [];
    setAttachments([]);
    setAttachmentError(undefined);
    setQueueEditor(undefined);
    setQueueBusyId(undefined);
    setQueueError(undefined);
    void releaseAttachmentHandles(abandonedHandles).catch(() => undefined);
  }, [conversation.id]);
  useEffect(() => () => {
    void releaseAttachmentHandles(attachmentHandles(attachmentsRef.current)).catch(() => undefined);
  }, []);
  useEffect(() => {
    const node = textarea.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 210)}px`;
  }, [draft]);

  const updateDraft = (value: string) => {
    setDraft(value);
    draftRef.current = value;
    onDraftChange(value);
  };

  const submit = async (delivery?: "steer" | "follow_up") => {
    if ((!draft.trim() && attachments.length === 0) || adding || submittingRef.current) return;
    submittingRef.current = true;
    const sentDraft = draft;
    const sentAttachments = attachments;
    setDraft("");
    draftRef.current = "";
    setAttachments([]);
    attachmentsRef.current = [];
    setAttachmentError(undefined);
    onDraftChange("");
    try {
      await onSend(sentDraft, sentAttachments, delivery);
    } catch (error) {
      const currentDraft = draftRef.current;
      const restoredDraft = !currentDraft.trim() || currentDraft === sentDraft
        ? sentDraft
        : [sentDraft, currentDraft].filter(Boolean).join("\n\n");
      const currentAttachments = attachmentsRef.current.filter(
        (item) => !sentAttachments.some((sent) => sent.id === item.id),
      );
      const restored = mergeAttachmentSelection(sentAttachments, currentAttachments);
      setDraft(restoredDraft);
      draftRef.current = restoredDraft;
      setAttachments(restored.attachments);
      attachmentsRef.current = restored.attachments;
      setAttachmentError(
        restored.issue
          ? attachmentIssueLabel(restored.issue, language)
          : attachmentSubmitError(error, language),
      );
      onDraftChange(restoredDraft);
    } finally {
      submittingRef.current = false;
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit(isRunning ? "follow_up" : undefined);
    }
    if (event.key === "Escape" && isRunning) void onAbort();
  };

  const acceptAttachments = (incoming: Attachment[]) => {
    const result = mergeAttachmentSelection(attachmentsRef.current, incoming);
    const acceptedIds = new Set(result.attachments.map((attachment) => attachment.id));
    const rejectedHandles = attachmentHandles(
      incoming.filter((attachment) => !acceptedIds.has(attachment.id)),
    );
    void releaseAttachmentHandles(rejectedHandles).catch(() => undefined);
    attachmentsRef.current = result.attachments;
    setAttachments(result.attachments);
    setAttachmentError(result.issue ? attachmentIssueLabel(result.issue, language) : undefined);
  };

  const addFiles = async () => {
    setAdding(true);
    setAttachmentError(undefined);
    try {
      const current = attachmentsRef.current;
      const remainingCount = Math.max(0, MAX_ATTACHMENT_COUNT - current.length);
      const currentImageBytes = current.reduce(
        (total, attachment) => total + (attachment.isImage ? attachment.size : 0),
        0,
      );
      if (remainingCount === 0) {
        setAttachmentError(attachmentIssueLabel("count", language));
        return;
      }
      const results = await pickAttachments(
        remainingCount,
        Math.max(0, MAX_TOTAL_IMAGE_BYTES - currentImageBytes),
      );
      acceptAttachments(results.map((result) => ({
        id: crypto.randomUUID(),
        name: result.name,
        path: result.path,
        mimeType: result.mimeType,
        size: result.size,
        attachmentHandle: result.attachmentHandle,
        previewDataUrl: result.previewDataUrl,
        isImage: result.isImage,
      })));
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : String(error));
    } finally {
      setAdding(false);
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (!files.length) return;
    event.preventDefault();
    setAttachmentError(attachmentIssueLabel("native-picker-required", language));
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) return;
    setAttachmentError(attachmentIssueLabel("native-picker-required", language));
  };

  const contextPercent = stats?.contextUsage?.percent;
  const queuedRows = buildQueuedRows(conversation, sessionState);
  const applyQueuedMutation = async (
    item: QueuedMessageRow,
    mutation: { type: "delete" } | { type: "replace"; text: string; lane: "steering" | "followUp" },
  ) => {
    if (item.index === undefined || queueBusyId) return;
    setQueueBusyId(item.id);
    setQueueError(undefined);
    try {
      await onMutateQueuedMessage({
        messageId: item.id,
        lane: item.lane,
        index: item.index,
        expectedText: item.expectedText,
        mutation,
      });
      setQueueEditor(undefined);
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : String(error));
    } finally {
      setQueueBusyId(undefined);
    }
  };
  const saveQueuedEdit = (item: QueuedMessageRow) => {
    const text = queueEditor?.text.trim() ?? "";
    if (!text) {
      setQueueError(bi(language, "Le message en attente ne peut pas être vide.", "The queued message cannot be empty."));
      return;
    }
    if (text === item.expectedText) {
      setQueueEditor(undefined);
      return;
    }
    void applyQueuedMutation(item, { type: "replace", text, lane: item.lane });
  };
  return (
    <div className={`composer-shell ${dragging ? "is-dragging" : ""}`} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => event.currentTarget === event.target && setDragging(false)} onDrop={handleDrop}>
      {dragging ? <div className="drop-overlay"><Paperclip size={24} /><strong>{bi(language, "Utilisez + pour autoriser ces fichiers", "Use + to authorize these files")}</strong></div> : null}
      {queuedRows.length ? (
        <div className="queued-message-tray" aria-label={bi(language, "Instructions en attente", "Queued instructions")}>
          {queuedRows.map((item) => {
            const editing = queueEditor?.id === item.id;
            const busy = queueBusyId === item.id;
            const editBlocked = item.index === undefined || Boolean(item.attachments?.length);
            return (
              <div className={`queued-message-row ${editing ? "is-editing" : ""}`} key={item.id}>
                <span className="queued-message-icon">{busy ? <LoaderCircle size={13} className="spin" /> : <Layers3 size={13} />}</span>
                {editing ? (
                  <input
                    className="queued-message-input"
                    value={queueEditor.text}
                    autoFocus
                    aria-label={bi(language, "Modifier le message en attente", "Edit queued message")}
                    onChange={(event) => setQueueEditor({ id: item.id, text: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); saveQueuedEdit(item); }
                      if (event.key === "Escape") { event.preventDefault(); setQueueEditor(undefined); setQueueError(undefined); }
                    }}
                  />
                ) : (
                  <span className="queued-message-copy"><strong>{item.text}</strong>{item.attachments?.length ? <small>{item.attachments.length} {item.attachments.length === 1 ? bi(language, "pièce jointe", "attachment") : bi(language, "pièces jointes", "attachments")}</small> : item.index === undefined ? <small>{bi(language, "Synchronisation…", "Syncing…")}</small> : null}</span>
                )}
                <Badge tone={item.delivery === "steer" ? "accent" : "neutral"}>{item.delivery === "steer" ? bi(language, "Immédiat", "Steer") : bi(language, "Suivi", "Follow-up")}</Badge>
                <span className="queued-message-actions">
                  {editing ? (
                    <>
                      <IconButton label={bi(language, "Enregistrer la modification", "Save edit")} onClick={() => saveQueuedEdit(item)} disabled={busy}><Check size={13} /></IconButton>
                      <IconButton label={bi(language, "Annuler la modification", "Cancel edit")} onClick={() => { setQueueEditor(undefined); setQueueError(undefined); }} disabled={busy}><X size={13} /></IconButton>
                    </>
                  ) : (
                    <>
                      <IconButton label={item.attachments?.length ? bi(language, "Les messages avec pièces jointes ne peuvent pas être modifiés après envoi", "Messages with attachments cannot be edited after sending") : bi(language, "Modifier le message en attente", "Edit queued message")} onClick={() => { setQueueEditor({ id: item.id, text: item.expectedText }); setQueueError(undefined); }} disabled={editBlocked || busy}><Pencil size={13} /></IconButton>
                      <IconButton label={bi(language, "Supprimer le message en attente", "Delete queued message")} onClick={() => void applyQueuedMutation(item, { type: "delete" })} disabled={item.index === undefined || busy}><Trash2 size={13} /></IconButton>
                    </>
                  )}
                </span>
              </div>
            );
          })}
          {queueError ? <p className="queued-message-error" role="alert"><CircleAlert size={13} />{queueError}</p> : null}
        </div>
      ) : null}
      {attachments.length ? <div className="composer-attachments">{attachments.map((attachment) => <div key={attachment.id}>{attachment.isImage && attachment.previewDataUrl ? <img src={attachment.previewDataUrl} alt="" /> : attachment.isImage ? <Image size={18} /> : <FileCode2 size={18} />}<span><strong>{attachment.name}</strong><small>{formatBytes(attachment.size, language, locale)}</small></span><IconButton label={`${bi(language, "Retirer", "Remove")} ${attachment.name}`} onClick={() => { const removed = attachmentsRef.current.find((item) => item.id === attachment.id); const next = attachmentsRef.current.filter((item) => item.id !== attachment.id); attachmentsRef.current = next; setAttachments(next); setAttachmentError(undefined); if (removed) void releaseAttachmentHandles(attachmentHandles([removed])).catch(() => undefined); }}><X size={14} /></IconButton></div>)}</div> : null}
      {attachmentError ? <p className="trust-note" role="alert"><Info size={14} />{attachmentError}</p> : null}
      <div className="composer-editor">
        <textarea ref={textarea} value={draft} onChange={(event) => updateDraft(event.target.value)} onKeyDown={handleKeyDown} onPaste={handlePaste} placeholder={isRunning ? bi(language, "Ajoutez une instruction à la suite…", "Add a follow-up instruction…") : `${bi(language, "Demandez quelque chose sur", "Ask something about")} ${project.name}…`} rows={1} aria-label={bi(language, "Message à Prime Agent", "Message Prime Agent")} />
      </div>
      <div className="composer-toolbar">
        <div className="composer-tools-left">
          <IconButton label={bi(language, "Joindre des fichiers", "Attach files")} onClick={() => void addFiles()} disabled={adding}>{adding ? <LoaderCircle size={17} className="spin" /> : <Plus size={18} />}</IconButton>
          <div className="composer-popover-wrap" data-dismissable-layer="composer-tools">
            <button type="button" className="composer-chip" aria-haspopup="menu" aria-expanded={openPopover === "composer-tools"} onClick={() => onTogglePopover("composer-tools")}><Box size={14} />{bi(language, "Outils", "Tools")}<ChevronDown size={13} /></button>
            {openPopover === "composer-tools" ? <ToolsPopover commands={commands} onChoose={(command) => { updateDraft(`/${command.name} `); onClosePopover(); textarea.current?.focus(); }} onCompact={() => { void onRunCommand("compact"); onClosePopover(); }} onRefine={() => { void onRunCommand("refine"); onClosePopover(); }} /> : null}
          </div>
          <div className="composer-popover-wrap" data-dismissable-layer="composer-queue">
            <button type="button" className="composer-chip permission-chip" aria-haspopup="menu" aria-expanded={openPopover === "composer-queue"} title={bi(language, "File d’instructions réellement gérée par Prime Agent", "Instruction queue managed by Prime Agent")} onClick={() => onTogglePopover("composer-queue")}><Layers3 size={14} />{queueLabel(sessionState, language)}<ChevronDown size={13} /></button>
            {openPopover === "composer-queue" ? <QueuePopover sessionState={sessionState} onChoose={(type, fields) => { void onRunCommand(type, fields); }} /> : null}
          </div>
        </div>
        <div className="composer-tools-right">
          {typeof contextPercent === "number" ? <span className={`context-meter ${contextPercent > 84 ? "is-warning" : ""}`} title={`${Math.round(contextPercent)} % ${bi(language, "du contexte utilisé", "of context used")}`}><i style={{ "--context": `${contextPercent}%` } as React.CSSProperties} />{Math.round(contextPercent)}%</span> : null}
          <div className="composer-popover-wrap" data-dismissable-layer="composer-model">
            <button type="button" className="model-compact-button" aria-haspopup="menu" aria-expanded={openPopover === "composer-model"} aria-label={`${bi(language, "Modèle", "Model")}: ${activeModel?.name ?? activeModel?.id ?? shortModel(conversation.model) ?? bi(language, "non sélectionné", "not selected")}`} onClick={() => onTogglePopover("composer-model")}><Sparkles size={14} /><span>{activeModel?.name ?? activeModel?.id ?? shortModel(conversation.model) ?? bi(language, "Modèle", "Model")}</span><ChevronDown size={13} /></button>
            {openPopover === "composer-model" ? <ModelPopover models={models} active={conversation.model} align="right" onChoose={(model) => { void onModel(model); onClosePopover(); }} /> : null}
          </div>
          <div className="composer-popover-wrap" data-dismissable-layer="composer-thinking">
            <button type="button" className="thinking-button" aria-haspopup="menu" aria-expanded={openPopover === "composer-thinking"} onClick={() => onTogglePopover("composer-thinking")} title={bi(language, "Niveau de raisonnement", "Reasoning level")}><Brain size={15} /><span>{thinkingLabel(conversation.thinkingLevel, language)}</span><ChevronDown size={13} /></button>
            {openPopover === "composer-thinking" ? <ThinkingPopover active={conversation.thinkingLevel} onChoose={(level) => { void onThinking(level); onClosePopover(); }} /> : null}
          </div>
          {isRunning ? <IconButton label={bi(language, "Arrêter l’exécution", "Stop run")} className="composer-stop" onClick={() => void onAbort()}><CircleStop size={18} /></IconButton> : null}
          {isRunning ? <button type="button" className="queued-force-send" disabled={(!draft.trim() && !attachments.length) || adding} onClick={() => void submit("steer")} title={bi(language, "Livrer après les outils en cours, avant le prochain appel au modèle", "Deliver after current tools, before the next model call")}><Zap size={15} />{bi(language, "Orienter", "Steer")}</button> : null}
          <button type="button" className={`send-button ${draft.trim() || attachments.length ? "is-ready" : ""}`} disabled={(!draft.trim() && !attachments.length) || adding} onClick={() => void submit(isRunning ? "follow_up" : undefined)} aria-label={isRunning ? bi(language, "Ajouter à la file", "Add to queue") : bi(language, "Envoyer", "Send")} title={isRunning ? bi(language, "Attendre la fin puis démarrer un nouveau tour", "Wait for completion, then start a new turn") : bi(language, "Envoyer (Entrée)", "Send (Enter)")}>{isRunning ? <Layers3 size={18} /> : <Send size={18} />}</button>
        </div>
      </div>
    </div>
  );
}

function RunInspector({ project, conversation, stats, sessionState, schedules, heartbeat, heartbeats, subagents, observedSubagent, changes, tab, onTab, onClose, onRunCommand, onObserveSubagent, onCloneSession, onDraftChange }: {
  project: Project;
  conversation: Conversation;
  stats?: SessionStats;
  sessionState?: AgentSessionState;
  schedules: AgentSchedule[];
  heartbeat?: AgentSchedule | null;
  heartbeats: AgentHeartbeatSummary[];
  subagents: AgentRlmChild[];
  observedSubagent?: { activeSessionId: string; messages: ChatMessage[]; closed?: boolean; error?: string };
  changes: GitChange[];
  tab: "activity" | "session" | "changes" | "details";
  onTab: (tab: "activity" | "session" | "changes" | "details") => void;
  onClose: () => void;
  onRunCommand: (type: string, fields?: Record<string, unknown>) => Promise<void>;
  onObserveSubagent: (activeSessionId?: string) => Promise<void>;
  onCloneSession: () => Promise<void>;
  onDraftChange: (draft: string) => void;
}) {
  const { language } = useI18n();
  const tabs = [
    { id: "changes" as const, label: bi(language, "Modifs", "Changes"), icon: Code2, count: changes.length },
    { id: "activity" as const, label: bi(language, "Activité", "Activity"), icon: Activity },
    { id: "session" as const, label: "Session", icon: ListTree },
    { id: "details" as const, label: bi(language, "Détails", "Details"), icon: Info },
  ];
  return (
    <aside className="run-inspector">
      <header className="inspector-header"><div><p className="eyebrow">{bi(language, "SESSION ACTIVE", "ACTIVE SESSION")}</p><h2>{bi(language, "Inspecteur", "Inspector")}</h2></div><IconButton label={bi(language, "Fermer l’inspecteur", "Close inspector")} onClick={onClose}><X size={17} /></IconButton></header>
      <nav className="inspector-tabs" aria-label={bi(language, "Inspecteur de session", "Session inspector")}>{tabs.map((item) => { const TabIcon = item.icon; return <button key={item.id} type="button" className={tab === item.id ? "is-active" : ""} onClick={() => onTab(item.id)}><TabIcon size={14} />{item.label}{item.count ? <span>{item.count}</span> : null}</button>; })}</nav>
      <div className="inspector-content">
        {tab === "activity" ? <ActivityPanel activities={conversation.activities} conversation={conversation} /> : null}
        {tab === "session" ? <SessionPanel project={project} conversation={conversation} sessionState={sessionState} schedules={schedules} heartbeat={heartbeat} heartbeats={heartbeats} subagents={subagents} observedSubagent={observedSubagent} onRunCommand={onRunCommand} onObserveSubagent={onObserveSubagent} /> : null}
        {tab === "changes" ? <ChangesPanel projectPath={project.path} changes={changes} draft={conversation.draft} onDraftChange={onDraftChange} /> : null}
        {tab === "details" ? <DetailsPanel project={project} conversation={conversation} stats={stats} sessionState={sessionState} onRunCommand={onRunCommand} onCloneSession={onCloneSession} /> : null}
      </div>
    </aside>
  );
}

function ActivityPanel({ activities, conversation }: { activities: ActivityItem[]; conversation: Conversation }) {
  const { language, locale } = useI18n();
  const reversed = [...groupActivities(activities, language)].reverse();
  const representedEvents = reversed.reduce((total, item) => total + item.updateCount, 0);
  const isRunning = ["streaming", "tool", "starting", "queued"].includes(conversation.status);
  const needsAttention = conversation.status === "error" || conversation.status === "offline";
  const overviewDetail = needsAttention
    ? conversation.lastError ?? bi(language, "La session nécessite votre attention", "This session needs your attention")
    : reversed[0]?.title ?? bi(language, "Prêt pour une nouvelle instruction", "Ready for a new instruction");
  return (
    <div className="inspector-section">
      <section className={`run-overview status-${conversation.status}`}>
        <div className="run-overview-icon">{isRunning ? <LoaderCircle size={18} className="spin" /> : needsAttention ? <CircleAlert size={18} /> : <Check size={18} />}</div>
        <div><strong>{statusLabel(conversation.status, language)}</strong><small>{overviewDetail}</small></div>
      </section>
      <div className="section-title"><span>{bi(language, "Chronologie", "Timeline")}</span><small>{reversed.length} {reversed.length === 1 ? bi(language, "étape", "step") : bi(language, "étapes", "steps")} · {representedEvents} {representedEvents === 1 ? bi(language, "événement", "event") : bi(language, "événements", "events")}</small></div>
      {reversed.length ? <div className="activity-timeline">{reversed.map((item) => {
        const groupedLabel = item.updateCount > 1 && !item.pythonSummary ? `${item.updateCount} ${bi(language, "mises à jour regroupées", "updates grouped")}` : undefined;
        const detail = [item.detail, groupedLabel].filter(Boolean).join(" · ");
        const displayCount = item.pythonSummary ? pythonExecutionCount(item.pythonSummary) : item.updateCount;
        return <div key={item.id} className={`activity-entry is-${item.status} ${item.pythonSummary ? "is-python-group" : ""}`}><span className="timeline-node" /><div><header><strong>{item.title}{displayCount > 1 ? <em>×{displayCount}</em> : null}</strong><time>{formatTime(item.updatedAt ?? item.createdAt, locale)}</time></header>{detail ? <p>{detail}</p> : null}</div></div>;
      })}</div> : <InspectorEmpty icon={<Activity size={22} />} text={bi(language, "L’activité des outils apparaîtra ici.", "Tool activity will appear here.")} />}
    </div>
  );
}

function SessionPanel({ project, conversation, sessionState, schedules, heartbeat, heartbeats, subagents, observedSubagent, onRunCommand, onObserveSubagent }: { project: Project; conversation: Conversation; sessionState?: AgentSessionState; schedules: AgentSchedule[]; heartbeat?: AgentSchedule | null; heartbeats: AgentHeartbeatSummary[]; subagents: AgentRlmChild[]; observedSubagent?: { activeSessionId: string; messages: ChatMessage[]; closed?: boolean; error?: string }; onRunCommand: (type: string, fields?: Record<string, unknown>) => Promise<void>; onObserveSubagent: (activeSessionId?: string) => Promise<void> }) {
  const { language, locale } = useI18n();
  const attachments = conversation.messages.flatMap((message) => message.attachments ?? []);
  const sessionActions = sessionState?.sessionActions;
  const queued = [
    ...(sessionActions?.steering ?? []).map((text) => ({ lane: bi(language, "Immédiate", "Immediate"), text })),
    ...(sessionActions?.followUps ?? []).map((text) => ({ lane: bi(language, "Suivi", "Follow-up"), text })),
  ];
  return (
    <div className="inspector-section">
      <div className="section-title"><span>{bi(language, "Espace de travail", "Workspace")}</span></div>
      <div className="detail-card"><div><FolderIcon /><span><strong>{project.name}</strong><small>{project.path}</small></span></div><Badge tone="success">{bi(language, "Local", "Local")}</Badge></div>
      <div className="section-title"><span>{bi(language, "Pièces jointes explicites", "Explicit attachments")}</span><small>{attachments.length} {attachments.length === 1 ? bi(language, "fichier", "file") : bi(language, "fichiers", "files")}</small></div>
      {attachments.length ? <div className="context-files">{attachments.map((attachment) => <div key={attachment.id}>{attachment.isImage && attachment.previewDataUrl ? <img className="context-file-preview" src={attachment.previewDataUrl} alt="" /> : attachment.isImage ? <Image size={16} /> : <File size={16} />}<span><strong>{attachment.name}</strong><small>{formatBytes(attachment.size, language, locale)}</small></span></div>)}</div> : <InspectorEmpty icon={<Layers3 size={22} />} text={bi(language, "Ajoutez des fichiers ou des images depuis le composer.", "Add files or images from the composer.")} />}
      <div className="section-title"><span>{bi(language, "File d’instructions Prime Agent", "Prime Agent instruction queue")}</span><Badge tone={queued.length ? "accent" : "neutral"}>{queued.length}</Badge></div>
      {sessionActions?.active ? <div className="detail-card"><div><LoaderCircle size={16} className="spin" /><span><strong>{bi(language, "Action active", "Active action")}</strong><small>{sessionActions.active.label ?? (sessionActions.active.kind === "turn" ? bi(language, "Tour de l’agent", "Agent turn") : bi(language, "Commande de session", "Session command"))} · {sessionActions.active.phase}</small></span></div><Badge tone="accent">Live</Badge></div> : null}
      {queued.length ? <div className="context-files queue-items">{queued.map((item, index) => <div key={`${item.lane}:${index}:${item.text.slice(0, 32)}`}><Layers3 size={16} /><span><strong>{item.lane}</strong><small>{item.text}</small></span></div>)}</div> : <InspectorEmpty icon={<Layers3 size={22} />} text={bi(language, "Aucune instruction en attente dans Prime Agent.", "No instruction is queued in Prime Agent.")} />}
      <GoalPanel conversation={conversation} goal={sessionState?.goal} onRunCommand={onRunCommand} />
      <SubagentsPanel subagents={subagents} observed={observedSubagent} onObserve={onObserveSubagent} />
      <SupervisionPanel schedules={schedules} heartbeat={heartbeat} heartbeats={heartbeats} onRunCommand={onRunCommand} />
      <Button variant="ghost" className="full-button" onClick={() => void onRunCommand("get_state")}><RefreshCw size={14} />{bi(language, "Actualiser la session", "Refresh session")}</Button>
    </div>
  );
}

function GoalPanel({ conversation, goal, onRunCommand }: { conversation: Conversation; goal?: AgentSessionState["goal"]; onRunCommand: (type: string, fields?: Record<string, unknown>) => Promise<void> }) {
  const { language, locale } = useI18n();
  const [editing, setEditing] = useState(false);
  const [objective, setObjective] = useState("");
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const runGoal = async (command: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await onRunCommand("prompt", {
        message: command,
        ...(["starting", "streaming", "tool", "queued"].includes(conversation.status) ? { streamingBehavior: "steer" } : {}),
      });
      setEditing(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const submit = () => {
    const trimmed = objective.trim();
    if (!trimmed) return;
    const parsedBudget = Number.parseInt(budget, 10);
    void runGoal(`/goal${Number.isFinite(parsedBudget) && parsedBudget > 0 ? ` --budget ${parsedBudget}` : ""} ${trimmed}`);
  };
  const tokens = goal?.tokensUsed ? compactNumber(goal.tokensUsed, locale) : "0";
  return <section className="goal-panel"><div className="section-title"><span>{bi(language, "Objectif persistant", "Persistent goal")}</span><Badge tone={goal?.status === "active" ? "accent" : goal?.status === "error" ? "danger" : "neutral"}>{goal?.status ?? bi(language, "inactif", "inactive")}</Badge></div><p className="supervision-explainer">{bi(language, "Le mode Goal poursuit un objectif entre plusieurs tours et peut continuer jusqu’à son achèvement ou sa limite de tokens.", "Goal mode pursues an objective across turns and can continue until completion or its token limit.")}</p>{goal?.objective ? <div className="goal-card"><Target size={17} /><div><strong>{goal.objective}</strong><small>{tokens} {bi(language, "tokens utilisés", "tokens used")}{goal.tokenBudget ? ` / ${compactNumber(goal.tokenBudget, locale)}` : ""}{goal.lastReason ? ` · ${goal.lastReason}` : ""}</small></div></div> : <InspectorEmpty icon={<Target size={21} />} text={bi(language, "Aucun objectif persistant pour cette session.", "No persistent goal for this session.")} />}{goal?.objective ? <div className="goal-actions">{goal.status === "paused" ? <Button variant="ghost" disabled={busy} onClick={() => void runGoal("/goal resume")}><Play size={14} />{bi(language, "Reprendre", "Resume")}</Button> : <Button variant="ghost" disabled={busy || goal.status !== "active"} onClick={() => void runGoal("/goal pause")}><Pause size={14} />{bi(language, "Pause", "Pause")}</Button>}<Button variant="ghost" disabled={busy} onClick={() => void runGoal("/goal clear")}><X size={14} />{bi(language, "Effacer", "Clear")}</Button></div> : <Button variant="ghost" onClick={() => setEditing((current) => !current)}><Plus size={14} />{bi(language, "Nouvel objectif", "New goal")}</Button>}{editing ? <div className="supervision-editor"><label><span>{bi(language, "Objectif", "Objective")}</span><textarea rows={3} value={objective} onChange={(event) => setObjective(event.target.value)} autoFocus /></label><label><span>{bi(language, "Budget de tokens (optionnel)", "Token budget (optional)")}</span><input inputMode="numeric" value={budget} onChange={(event) => setBudget(event.target.value.replace(/[^0-9]/g, ""))} placeholder="50000" /></label><Button disabled={!objective.trim() || busy} onClick={submit}>{busy ? <LoaderCircle size={14} className="spin" /> : <Target size={14} />}{bi(language, "Démarrer", "Start")}</Button></div> : null}{error ? <p className="trust-note" role="alert"><CircleAlert size={14} />{error}</p> : null}</section>;
}

function SubagentsPanel({ subagents, observed, onObserve }: { subagents: AgentRlmChild[]; observed?: { activeSessionId: string; messages: ChatMessage[]; closed?: boolean; error?: string }; onObserve: (activeSessionId?: string) => Promise<void> }) {
  const { language, locale } = useI18n();
  const [error, setError] = useState<string>();
  const ordered = [...subagents].sort((a, b) => Number(["done", "error", "cancelled"].includes(a.status)) - Number(["done", "error", "cancelled"].includes(b.status)));
  const toggle = async (child: AgentRlmChild) => {
    if (!child.activeSessionId) return;
    setError(undefined);
    try {
      await onObserve(observed?.activeSessionId === child.activeSessionId ? undefined : child.activeSessionId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  return <section className="subagents-panel"><div className="section-title"><span>{bi(language, "Sous-agents", "Subagents")}</span><Badge tone={ordered.some((child) => child.status === "running") ? "accent" : "neutral"}>{ordered.length}</Badge></div><p className="supervision-explainer">{bi(language, "Consultez les sous-sessions RLM réellement créées par Prime Agent. Le modèle affiché est celui choisi lors de leur création.", "Inspect the RLM child sessions actually created by Prime Agent. The displayed model is the one chosen when they were spawned.")}</p>{ordered.length ? <div className="subagent-list">{ordered.map((child) => { const observing = Boolean(child.activeSessionId && observed?.activeSessionId === child.activeSessionId); return <div className={`subagent-row is-${child.status}`} key={child.id}><Bot size={16} /><span><strong>{child.label || child.sessionName || child.id}</strong><small>{child.model ?? bi(language, "Modèle hérité", "Inherited model")}{child.toolUseCount ? ` · ${child.toolUseCount} ${bi(language, "outils", "tools")}` : ""}{child.durationMs ? ` · ${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(child.durationMs / 1000)} s` : ""}</small></span><Badge tone={child.status === "running" ? "accent" : child.status === "error" ? "danger" : "neutral"}>{child.status}</Badge>{child.activeSessionId ? <IconButton label={observing ? bi(language, "Fermer la sous-session", "Close child session") : bi(language, "Consulter la sous-session", "Inspect child session")} onClick={() => void toggle(child)}>{observing ? <EyeOff size={14} /> : <Eye size={14} />}</IconButton> : null}</div>; })}</div> : <InspectorEmpty icon={<Bot size={21} />} text={bi(language, "Aucun sous-agent signalé dans cette session.", "No subagent has been reported in this session.")} />}{observed ? <div className="observed-subagent"><header><strong>{bi(language, "Sous-session observée", "Observed child session")}</strong><Badge tone={observed.closed ? "neutral" : "accent"}>{observed.closed ? bi(language, "fermée", "closed") : "Live"}</Badge></header>{observed.messages.length ? <div>{observed.messages.slice(-12).map((message) => <article key={message.id} className={`observed-message is-${message.role}`}><strong>{message.role === "assistant" ? "Agent" : bi(language, "Tâche", "Task")}</strong><p>{message.content.slice(0, 900)}</p></article>)}</div> : <p>{bi(language, "En attente d’un message de la sous-session…", "Waiting for a child-session message…")}</p>}{observed.error ? <p className="trust-note" role="alert"><CircleAlert size={14} />{observed.error}</p> : null}</div> : null}<p className="trust-note"><Info size={14} />{bi(language, "Prime Agent ne permet pas de changer le modèle d’un sous-agent déjà lancé via son RPC classique. Les préférences de futurs sous-agents nécessitent le catalogue de modèles scoped du daemon.", "Prime Agent's classic RPC cannot change the model of an already running child. Future-subagent preferences require the daemon's scoped-model catalog.")}</p>{error ? <p className="trust-note" role="alert"><CircleAlert size={14} />{error}</p> : null}</section>;
}

function SupervisionPanel({ schedules, heartbeat, heartbeats, onRunCommand }: { schedules: AgentSchedule[]; heartbeat?: AgentSchedule | null; heartbeats: AgentHeartbeatSummary[]; onRunCommand: (type: string, fields?: Record<string, unknown>) => Promise<void> }) {
  const { language, locale } = useI18n();
  const [editor, setEditor] = useState<"schedule" | "heartbeat">();
  const [schedule, setSchedule] = useState("every 30m");
  const [prompt, setPrompt] = useState("");
  const [deliveryMode, setDeliveryMode] = useState<"steer" | "follow_up">("steer");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const runAction = async (type: string, fields: Record<string, unknown>) => {
    setError(undefined);
    try {
      await onRunCommand(type, fields);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const submit = async () => {
    if (!prompt.trim() || !schedule.trim() || submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await onRunCommand(editor === "heartbeat" ? "set_heartbeat" : "add_schedule", {
        schedule: schedule.trim(),
        prompt: prompt.trim(),
        ...(editor === "heartbeat" ? { deliveryMode } : {}),
      });
      setPrompt("");
      setEditor(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSubmitting(false);
    }
  };
  const activeSchedules = schedules.filter((job) => job.source !== "heartbeat" && job.source !== "rlm_heartbeat" && job.status === "active");
  const remoteHeartbeats = heartbeats.filter((item) => item.job.id !== heartbeat?.id);
  const supervisionCount = (heartbeat ? 1 : 0) + activeSchedules.length + remoteHeartbeats.length;
  return (
    <section className="supervision-panel">
      <div className="section-title"><span>{bi(language, "Supervision Prime Agent", "Prime Agent supervision")}</span><Badge tone={supervisionCount ? "accent" : "neutral"}>{supervisionCount}</Badge></div>
      <p className="supervision-explainer">{bi(language, "Surveille et relance le travail en arrière-plan avec les heartbeats et les tâches planifiées réelles de Prime Agent.", "Monitor and resume background work with Prime Agent's real heartbeats and scheduled jobs.")}</p>
      {heartbeat ? <div className="supervision-job"><HeartPulse size={16} /><span><strong>{bi(language, "Heartbeat de cette session", "This session heartbeat")}</strong><small>{heartbeat.schedule.expression} · {heartbeat.deliveryMode === "follow_up" ? bi(language, "nouveau tour", "new turn") : bi(language, "oriente le tour", "steers turn")}{heartbeat.nextRunAt ? ` · ${new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(heartbeat.nextRunAt))}` : ""}</small></span><IconButton label={heartbeat.status === "paused" ? bi(language, "Reprendre", "Resume") : bi(language, "Mettre en pause", "Pause")} onClick={() => void runAction("update_heartbeat", { action: heartbeat.status === "paused" ? "resume" : "pause" })}>{heartbeat.status === "paused" ? <Play size={14} /> : <Pause size={14} />}</IconButton><IconButton label={bi(language, "Supprimer le heartbeat", "Clear heartbeat")} onClick={() => void runAction("update_heartbeat", { action: "clear" })}><X size={14} /></IconButton></div> : null}
      {activeSchedules.map((job) => <div className="supervision-job" key={job.id}><CalendarClock size={16} /><span><strong>{job.label || job.prompt}</strong><small>{job.schedule.expression}{job.nextRunAt ? ` · ${new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(new Date(job.nextRunAt))}` : ""}</small></span><IconButton label={bi(language, "Annuler la tâche", "Cancel job")} onClick={() => void runAction("cancel_schedule", { jobId: job.id })}><X size={14} /></IconButton></div>)}
      {remoteHeartbeats.slice(0, 8).map((item) => <div className="supervision-job is-remote" key={item.job.id}><HeartPulse size={16} /><span><strong>{item.sessionName || item.firstMessage || item.job.label || item.job.sessionId}</strong><small>{item.job.schedule.expression} · {item.job.status}</small></span><IconButton label={item.job.status === "paused" ? bi(language, "Reprendre", "Resume") : bi(language, "Mettre en pause", "Pause")} onClick={() => void runAction("manage_heartbeat", { activeSessionId: item.job.activeSessionId, jobId: item.job.id, action: item.job.status === "paused" ? "resume" : "pause" })}>{item.job.status === "paused" ? <Play size={14} /> : <Pause size={14} />}</IconButton><IconButton label={bi(language, "Arrêter", "Stop")} onClick={() => void runAction("manage_heartbeat", { activeSessionId: item.job.activeSessionId, jobId: item.job.id, action: "stop" })}><X size={14} /></IconButton></div>)}
      {!heartbeat && activeSchedules.length === 0 ? <InspectorEmpty icon={<HeartPulse size={21} />} text={bi(language, "Aucune supervision planifiée pour cette session.", "No scheduled supervision for this session.")} /> : null}
      <div className="supervision-actions"><Button variant="ghost" onClick={() => setEditor((current) => current === "heartbeat" ? undefined : "heartbeat")}><HeartPulse size={14} />{bi(language, "Heartbeat", "Heartbeat")}</Button><Button variant="ghost" onClick={() => setEditor((current) => current === "schedule" ? undefined : "schedule")}><CalendarClock size={14} />{bi(language, "Planifier", "Schedule")}</Button></div>
      {error && !editor ? <p className="trust-note" role="alert"><CircleAlert size={14} />{error}</p> : null}
      {editor ? <div className="supervision-editor"><label><span>{bi(language, "Fréquence ou date", "Frequency or date")}</span><input value={schedule} onChange={(event) => setSchedule(event.target.value)} placeholder="every 30m" /></label><label><span>{bi(language, "Instruction à exécuter", "Instruction to run")}</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={3} /></label>{editor === "heartbeat" ? <label><span>{bi(language, "Si l’agent travaille déjà", "If the agent is already working")}</span><select value={deliveryMode} onChange={(event) => setDeliveryMode(event.target.value as "steer" | "follow_up")}><option value="steer">{bi(language, "Orienter le travail en cours", "Steer current work")}</option><option value="follow_up">{bi(language, "Attendre puis ouvrir un nouveau tour", "Wait, then start a new turn")}</option></select></label> : null}{error ? <p className="trust-note" role="alert"><CircleAlert size={14} />{error}</p> : null}<Button disabled={!prompt.trim() || !schedule.trim() || submitting} onClick={() => void submit()}>{submitting ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}{bi(language, "Activer", "Enable")}</Button></div> : null}
    </section>
  );
}

type GitPromptAction = "commit-push" | "release";

function ChangesPanel({ projectPath, changes, draft, onDraftChange }: { projectPath: string; changes: GitChange[]; draft: string; onDraftChange: (draft: string) => void }) {
  const { language } = useI18n();
  const [expandedPath, setExpandedPath] = useState<string>();
  const [diff, setDiff] = useState<GitFileDiff>();
  const [loadingPath, setLoadingPath] = useState<string>();
  const [diffError, setDiffError] = useState<string>();
  const [pendingPrompt, setPendingPrompt] = useState<GitPromptAction>();
  const [fileMenu, setFileMenu] = useState<{ change: GitChange; x: number; y: number }>();
  const [fileActionError, setFileActionError] = useState<string>();
  const diffRequest = useRef(0);
  const totals = changes.reduce((sum, change) => ({ additions: sum.additions + change.additions, deletions: sum.deletions + change.deletions }), { additions: 0, deletions: 0 });
  const binaryCount = changes.filter((change) => change.binary).length;

  const applyPrompt = (action: GitPromptAction) => {
    onDraftChange(gitActionPrompt(action, language));
    setPendingPrompt(undefined);
    requestAnimationFrame(() => {
      const composer = document.querySelector<HTMLTextAreaElement>(".composer-shell textarea");
      composer?.focus();
      composer?.setSelectionRange(composer.value.length, composer.value.length);
    });
  };

  const preparePrompt = (action: GitPromptAction) => {
    if (draft.trim()) {
      setPendingPrompt(action);
      return;
    }
    applyPrompt(action);
  };

  useEffect(() => {
    diffRequest.current += 1;
    setExpandedPath(undefined);
    setDiff(undefined);
    setLoadingPath(undefined);
    setDiffError(undefined);
  }, [projectPath]);

  useEffect(() => {
    if (!fileMenu) return;
    const close = () => setFileMenu(undefined);
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", keydown);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [fileMenu]);

  const openContainingFolder = async (change: GitChange) => {
    setFileMenu(undefined);
    setFileActionError(undefined);
    try {
      await openGitFileFolder(projectPath, change.path);
    } catch (error) {
      setFileActionError(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    if (expandedPath && !changes.some((change) => change.path === expandedPath)) {
      diffRequest.current += 1;
      setExpandedPath(undefined);
      setDiff(undefined);
      setLoadingPath(undefined);
      setDiffError(undefined);
    }
  }, [changes, expandedPath]);

  const toggleDiff = async (change: GitChange) => {
    const request = ++diffRequest.current;
    if (expandedPath === change.path) {
      setExpandedPath(undefined);
      setDiff(undefined);
      setLoadingPath(undefined);
      setDiffError(undefined);
      return;
    }
    setExpandedPath(change.path);
    setDiff(undefined);
    setDiffError(undefined);
    setLoadingPath(change.path);
    try {
      const result = await getGitFileDiff(projectPath, change);
      if (request === diffRequest.current) setDiff(result);
    } catch (error) {
      if (request === diffRequest.current) setDiffError(error instanceof Error ? error.message : String(error));
    } finally {
      if (request === diffRequest.current) setLoadingPath(undefined);
    }
  };

  return (
    <div className="inspector-section">
      <div className="changes-actions">
        <Button variant="secondary" onClick={() => preparePrompt("commit-push")}><GitCommitHorizontal size={14} />Commit + push</Button>
        <Button variant="secondary" onClick={() => preparePrompt("release")}><Rocket size={14} />{bi(language, "Publier une release", "Publish release")}</Button>
      </div>
      {changes.length ? <><div className="changes-summary"><div><strong>{changes.length}</strong><span>{changes.length === 1 ? bi(language, "fichier modifié", "modified file") : bi(language, "fichiers modifiés", "modified files")}{binaryCount ? ` · ${binaryCount} ${bi(language, "binaire", "binary")}` : ""}</span></div><div className="diff-count"><b>+{totals.additions}</b><em>-{totals.deletions}</em></div></div><div className="change-list">{changes.map((change) => {
        const expanded = expandedPath === change.path;
        const loading = loadingPath === change.path;
        return <div className={`change-item ${expanded ? "is-expanded" : ""}`} key={`${change.originalPath ?? ""}:${change.path}`}><button type="button" aria-expanded={expanded} onClick={() => void toggleDiff(change)} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setFileActionError(undefined); setFileMenu({ change, x: Math.min(event.clientX, window.innerWidth - 230), y: Math.min(event.clientY, window.innerHeight - 90) }); }} title={bi(language, "Afficher le diff", "Show diff")}><span className={`change-status ${changeStatusClass(change.status)}`} title={changeStatusTitle(change.status, language)}>{changeStatusLabel(change.status)}</span><FileCode2 size={15} /><span><strong>{fileName(change.path)}</strong><small>{change.originalPath ? `${change.originalPath} → ${parentPath(change.path) || "."}` : parentPath(change.path)}</small></span>{change.binary ? <span className="change-binary">{bi(language, "Binaire", "Binary")}</span> : change.additions || change.deletions ? <span className="change-stats"><b>+{change.additions}</b><em>-{change.deletions}</em></span> : <span className="change-metadata">{bi(language, "Métadonnées", "Metadata")}</span>}{loading ? <LoaderCircle size={14} className="spin" /> : expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>{expanded ? <div className="change-preview" aria-live="polite">{loading ? <div className="diff-loading"><LoaderCircle size={15} className="spin" />{bi(language, "Chargement du diff…", "Loading diff…")}</div> : diffError ? <div className="diff-error"><CircleAlert size={15} />{diffError}</div> : diff?.binary ? <div className="diff-empty"><FileCode2 size={18} />{bi(language, "Fichier binaire : aucun aperçu textuel disponible.", "Binary file: no text preview available.")}</div> : diff?.patch ? <><pre className="git-diff" aria-label={bi(language, `Diff de ${change.path}`, `Diff for ${change.path}`)}>{diff.patch.split("\n").map((line, index) => <span className={`diff-line ${diffLineClass(line)}`} key={`${index}:${line.slice(0, 24)}`}>{line || " "}</span>)}</pre>{diff.truncated ? <p className="diff-truncated"><Info size={13} />{bi(language, "Aperçu tronqué pour préserver les performances.", "Preview truncated to preserve performance.")}</p> : null}</> : <div className="diff-empty"><Check size={18} />{bi(language, "Aucune différence textuelle à afficher.", "No textual difference to display.")}</div>}</div> : null}</div>;
      })}</div><p className="trust-note"><Info size={14} />{bi(language, "Cliquez sur un fichier pour afficher son diff Git. Les aperçus volumineux sont tronqués automatiquement.", "Click a file to view its Git diff. Large previews are truncated automatically.")}</p></> : <InspectorEmpty icon={<Code2 size={22} />} text={bi(language, "Aucun changement Git détecté dans ce projet.", "No Git changes detected in this project.")} />}
      {fileActionError ? <p className="trust-note" role="alert"><CircleAlert size={14} />{fileActionError}</p> : null}
      {fileMenu ? <div className="git-file-context-menu" role="menu" style={{ left: fileMenu.x, top: fileMenu.y }} onPointerDown={(event) => event.stopPropagation()}><button type="button" role="menuitem" autoFocus onClick={() => void openContainingFolder(fileMenu.change)}><FolderOpen size={15} /><span><strong>{bi(language, "Ouvrir le dossier contenant", "Open containing folder")}</strong><small>{parentPath(fileMenu.change.path) || "."}</small></span></button></div> : null}
      {pendingPrompt ? <Modal title={bi(language, "Remplacer le message en cours ?", "Replace the current message?")} description={bi(language, "Le texte déjà saisi sera effacé et remplacé par l’instruction préparée.", "The text already entered will be erased and replaced by the prepared instruction.")} width="470px" onClose={() => setPendingPrompt(undefined)} footer={<><Button variant="secondary" onClick={() => setPendingPrompt(undefined)}>{bi(language, "Conserver mon texte", "Keep my text")}</Button><Button variant="danger" onClick={() => applyPrompt(pendingPrompt)}>{bi(language, "Effacer et remplacer", "Erase and replace")}</Button></>}><div className="draft-replace-warning"><CircleAlert size={20} /><div><strong>{bi(language, "Cette action ne peut pas être annulée.", "This action cannot be undone.")}</strong><p>{bi(language, "L’instruction sera seulement préparée dans le champ de saisie : elle ne sera pas envoyée automatiquement.", "The instruction will only be prepared in the composer; it will not be sent automatically.")}</p></div></div></Modal> : null}
    </div>
  );
}

function DetailsPanel({ project, conversation, stats, sessionState, onRunCommand, onCloneSession }: { project: Project; conversation: Conversation; stats?: SessionStats; sessionState?: AgentSessionState; onRunCommand: (type: string, fields?: Record<string, unknown>) => Promise<void>; onCloneSession: () => Promise<void> }) {
  const { language, locale } = useI18n();
  return (
    <div className="inspector-section">
      <div className="stats-grid">
        <Stat label={bi(language, "Contexte", "Context")} value={stats?.contextUsage?.percent == null ? "—" : `${Math.round(stats.contextUsage.percent)}%`} sub={stats?.contextUsage?.tokens ? compactNumber(stats.contextUsage.tokens, locale) : bi(language, "En attente", "Pending")} />
        <Stat label="Tokens" value={stats?.tokens?.total ? compactNumber(stats.tokens.total, locale) : "—"} sub={bi(language, "Total session", "Session total")} />
        <Stat label={bi(language, "Outils", "Tools")} value={String(stats?.toolCalls ?? 0)} sub={bi(language, "Appels", "Calls")} />
        <Stat label={bi(language, "Coût", "Cost")} value={typeof stats?.cost === "number" ? `$${stats.cost.toFixed(3)}` : bi(language, "Local", "Local")} sub={stats?.cost ? bi(language, "Estimation", "Estimate") : bi(language, "Aucun relevé", "No data")} />
      </div>
      <div className="section-title"><span>{bi(language, "Configuration", "Configuration")}</span></div>
      <dl className="details-list"><div><dt>{bi(language, "Modèle", "Model")}</dt><dd>{sessionState?.model?.name ?? shortModel(conversation.model) ?? bi(language, "Par défaut", "Default")}</dd></div><div><dt>{bi(language, "Raisonnement", "Reasoning")}</dt><dd>{thinkingLabel(conversation.thinkingLevel, language)}</dd></div><div><dt>{bi(language, "Projet", "Project")}</dt><dd>{project.name}</dd></div><div><dt>Session</dt><dd className="mono">{sessionState?.sessionId?.slice(0, 12) ?? conversation.sessionId?.slice(0, 12) ?? bi(language, "En attente", "Pending")}</dd></div><div><dt>{bi(language, "Persistance", "Persistence")}</dt><dd>{conversation.sessionPath ? bi(language, "Activée", "Enabled") : bi(language, "Nouvelle session", "New session")}</dd></div></dl>
      <div className="section-title"><span>{bi(language, "Maintenance", "Maintenance")}</span></div>
      <div className="maintenance-actions"><Button variant="secondary" onClick={() => void onRunCommand("compact")}><ArchiveRestore size={15} />{bi(language, "Compacter", "Compact")}</Button><Button variant="secondary" onClick={() => void onRunCommand("refine")}><WandSparkles size={15} />{bi(language, "Raffiner", "Refine")}</Button><Button variant="secondary" onClick={() => void onCloneSession()}><Copy size={15} />{bi(language, "Dupliquer", "Duplicate")}</Button><Button variant="secondary" onClick={() => void onRunCommand("export_html")}><ArrowDown size={15} />{bi(language, "Exporter", "Export")}</Button></div>
    </div>
  );
}

function ToolsPopover({ commands, onChoose, onCompact, onRefine }: { commands: SlashCommand[]; onChoose: (command: SlashCommand) => void; onCompact: () => void; onRefine: () => void }) {
  const { language } = useI18n();
  return (
    <div className="popover tools-popover">
      <div className="popover-label">{bi(language, "Actions rapides", "Quick actions")}</div>
      <button type="button" onClick={onCompact}><ArchiveRestore size={15} /><span><strong>{bi(language, "Compacter le contexte", "Compact context")}</strong><small>{bi(language, "Résumer la session pour libérer de la place", "Summarize the session to free up context")}</small></span></button>
      <button type="button" onClick={onRefine}><WandSparkles size={15} /><span><strong>{bi(language, "Raffiner le harness", "Refine the harness")}</strong><small>{bi(language, "Capitaliser les apprentissages de la session", "Capture what the session learned")}</small></span></button>
      {commands.length ? <><div className="popover-separator" /><div className="popover-label">{bi(language, "Skills et commandes", "Skills and commands")}</div>{commands.slice(0, 8).map((command) => <button key={command.name} type="button" onClick={() => onChoose(command)}><Zap size={15} /><span><strong>/{command.name}</strong><small>{command.description ?? command.source}</small></span></button>)}</> : null}
    </div>
  );
}

function ModelPopover({ models, active, onChoose, align = "left" }: { models: ModelInfo[]; active?: string; onChoose: (model: ModelInfo) => void; align?: "left" | "right" }) {
  const { language, locale } = useI18n();
  const [query, setQuery] = useState("");
  const filtered = models.filter((model) => `${model.provider} ${model.name ?? ""} ${model.id}`.toLowerCase().includes(query.toLowerCase())).slice(0, 50);
  const groups = new Map<string, ModelInfo[]>();
  for (const model of filtered) groups.set(model.provider, [...(groups.get(model.provider) ?? []), model]);
  return (
    <div className={`popover model-popover align-${align}`}>
      <div className="model-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={bi(language, "Rechercher un modèle", "Search models")} autoFocus /></div>
      <div className="model-list">
        {models.length === 0 ? <div className="popover-empty"><LoaderCircle size={18} className="spin" />{bi(language, "Chargement des modèles…", "Loading models…")}</div> : Array.from(groups.entries()).map(([provider, entries]) => <section key={provider}><div className="provider-heading"><span className="provider-logo">{provider.slice(0, 2).toUpperCase()}</span>{provider}</div>{entries.map((model) => { const ref = `${model.provider}/${model.id}`; return <button key={ref} type="button" className={ref === active ? "is-selected" : ""} onClick={() => onChoose(model)}><span><strong>{model.name ?? model.id}</strong><small>{model.id}{model.contextWindow ? ` · ${compactNumber(model.contextWindow, locale)} ctx` : ""}</small></span><span className="model-badges">{model.input?.includes("image") ? <Image size={13} /> : null}{model.reasoning ? <Brain size={13} /> : null}{ref === active ? <Check size={15} /> : null}</span></button>; })}</section>)}
      </div>
      <footer><Info size={13} />{bi(language, "Les modèles proviennent de Prime Agent.", "Models are provided by Prime Agent.")}</footer>
    </div>
  );
}

function ThinkingPopover({ active, onChoose }: { active: ThinkingLevel; onChoose: (level: ThinkingLevel) => void }) {
  const { language } = useI18n();
  const levels: Array<{ value: ThinkingLevel; label: string; detail: string }> = [
    { value: "off", label: bi(language, "Désactivé", "Off"), detail: bi(language, "Réponses les plus rapides", "Fastest responses") },
    { value: "low", label: bi(language, "Léger", "Light"), detail: bi(language, "Petites modifications", "Small changes") },
    { value: "medium", label: bi(language, "Équilibré", "Balanced"), detail: bi(language, "Usage quotidien", "Everyday use") },
    { value: "high", label: bi(language, "Approfondi", "Deep"), detail: bi(language, "Architecture et problèmes difficiles", "Architecture and difficult problems") },
    { value: "xhigh", label: bi(language, "Très approfondi", "Very deep"), detail: bi(language, "Temps et coût plus élevés", "Higher time and cost") },
    { value: "max", label: "Maximum", detail: bi(language, "Si le modèle le prend en charge", "If supported by the model") },
  ];
  return <div className="popover thinking-popover"><div className="popover-label">{bi(language, "Niveau de raisonnement", "Reasoning level")}</div>{levels.map((level) => <button key={level.value} type="button" className={active === level.value ? "is-selected" : ""} onClick={() => onChoose(level.value)}><span><strong>{level.label}</strong><small>{level.detail}</small></span>{active === level.value ? <Check size={15} /> : null}</button>)}</div>;
}

function QueuePopover({ sessionState, onChoose }: { sessionState?: AgentSessionState; onChoose: (type: string, fields?: Record<string, unknown>) => void }) {
  const { language } = useI18n();
  const steeringMode = sessionState?.steeringMode ?? "one-at-a-time";
  const followUpMode = sessionState?.followUpMode ?? "one-at-a-time";
  const actions = sessionState?.sessionActions;
  return (
    <div className="popover thinking-popover permission-popover">
      <div className="popover-label">{bi(language, "File Prime Agent", "Prime Agent queue")}</div>
      <QueueModeRow icon={<Zap size={15} />} title={bi(language, "Orienter le travail en cours", "Steer current work")} detail={bi(language, "Après les outils du tour actuel, avant le prochain appel au modèle.", "After the current turn's tools, before the next model call.")} mode={steeringMode} language={language} onMode={(mode) => onChoose("set_steering_mode", { mode })} />
      <QueueModeRow icon={<Clock3 size={15} />} title={bi(language, "Nouveau tour après l’exécution", "New turn after the run")} detail={bi(language, "Attend que l’agent soit libre, puis démarre un nouveau tour.", "Waits until the agent is idle, then starts a new turn.")} mode={followUpMode} language={language} onMode={(mode) => onChoose("set_follow_up_mode", { mode })} />
      <div className="popover-separator" />
      <div className="popover-label">{bi(language, "État réel", "Live state")}</div>
      <p className="trust-note"><Layers3 size={14} />{actions?.queuedCount
        ? bi(language, `${actions.queuedCount} instruction(s) en attente dans Prime Agent.`, `${actions.queuedCount} instruction(s) queued in Prime Agent.`)
        : bi(language, "Aucune instruction en attente.", "No queued instructions.")}</p>
    </div>
  );
}

interface QueuedMessageRow {
  id: string;
  text: string;
  delivery: "steer" | "follow_up";
  lane: "steering" | "followUp";
  index?: number;
  expectedText: string;
  attachments?: Attachment[];
}

export function buildQueuedRows(conversation: Conversation, sessionState?: AgentSessionState): QueuedMessageRow[] {
  const actions = sessionState?.sessionActions;
  const local = conversation.messages.flatMap((message) => message.queueDelivery ? [{
    message,
    delivery: message.queueDelivery,
    payload: message.queueText ?? message.content,
    used: false,
  }] : []);
  const authoritative = (["steer", "follow_up"] as const).flatMap((delivery) => {
    const lane = delivery === "steer" ? "steering" as const : "followUp" as const;
    const previews = delivery === "steer" ? actions?.steering ?? [] : actions?.followUps ?? [];
    return previews.map((text, index): QueuedMessageRow => {
      const match = local.find((item) => !item.used && item.delivery === delivery && item.payload === text);
      if (match) match.used = true;
      return {
        id: match?.message.id ?? `remote-queue:${delivery}:${index}:${text.slice(0, 32)}`,
        text: match?.message.content ?? text,
        delivery,
        lane,
        index,
        expectedText: text,
        attachments: match?.message.attachments,
      };
    });
  });
  const syncing = local.filter((item) => !item.used).map(({ message, delivery, payload }): QueuedMessageRow => ({
    id: message.id,
    text: message.content,
    delivery,
    lane: delivery === "steer" ? "steering" : "followUp",
    expectedText: payload,
    attachments: message.attachments,
  }));
  return [...authoritative, ...syncing];
}

function QueueModeRow({ icon, title, detail, mode, language, onMode }: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  mode: "all" | "one-at-a-time";
  language: "fr" | "en";
  onMode: (mode: "all" | "one-at-a-time") => void;
}) {
  return (
    <div className="queue-mode-row">
      <span className="queue-mode-icon">{icon}</span>
      <span className="queue-mode-copy"><strong>{title}</strong><small>{detail}</small></span>
      <span className="queue-mode-toggle" role="group" aria-label={`${title} · ${bi(language, "mode de distribution", "delivery mode")}`}>
        <button type="button" title={bi(language, "Livrer ensemble toutes les instructions en attente", "Deliver every queued instruction together")} className={mode === "all" ? "is-selected" : ""} aria-pressed={mode === "all"} onClick={() => onMode("all")}>{bi(language, "Tout", "All")}</button>
        <button type="button" title={bi(language, "Livrer une instruction, attendre la réponse, puis livrer la suivante", "Deliver one instruction, wait for its response, then deliver the next")} className={mode === "one-at-a-time" ? "is-selected" : ""} aria-pressed={mode === "one-at-a-time"} onClick={() => onMode("one-at-a-time")}>{bi(language, "Un à la fois", "One at a time")}</button>
      </span>
    </div>
  );
}

function InspectorEmpty({ icon, text }: { icon: React.ReactNode; text: string }) {
  return <div className="inspector-empty"><span>{icon}</span><p>{text}</p></div>;
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return <div className="stat-card"><small>{label}</small><strong>{value}</strong><span>{sub}</span></div>;
}

function FolderIcon() { return <span className="detail-icon"><ListTree size={16} /></span>; }

const MAX_IMAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENT_COUNT = 20;

function isSupportedInlineImageMime(mimeType: string) {
  return ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mimeType.toLowerCase());
}

export type AttachmentSelectionIssue = "count" | "image-size" | "image-total" | "missing-image-handle" | "pathless-file" | "unsupported-image" | "native-picker-required";

function attachmentHandles(attachments: Attachment[]) {
  return attachments.flatMap((attachment) => attachment.attachmentHandle ? [attachment.attachmentHandle] : []);
}

export function mergeAttachmentSelection(
  current: Attachment[],
  incoming: Attachment[],
): { attachments: Attachment[]; issue?: AttachmentSelectionIssue } {
  const accepted = [...current];
  let imageBytes = current.reduce((total, attachment) => total + (attachment.isImage ? attachment.size : 0), 0);
  let issue: AttachmentSelectionIssue | undefined;
  for (const attachment of incoming) {
    if (accepted.length >= MAX_ATTACHMENT_COUNT) {
      issue ??= "count";
      continue;
    }
    if (!attachment.isImage && !attachment.path) {
      issue ??= "pathless-file";
      continue;
    }
    if (attachment.isImage && attachment.size > MAX_IMAGE_ATTACHMENT_BYTES) {
      issue ??= "image-size";
      continue;
    }
    if (attachment.isImage && !isSupportedInlineImageMime(attachment.mimeType)) {
      issue ??= "unsupported-image";
      continue;
    }
    if (attachment.isImage && !attachment.attachmentHandle) {
      issue ??= "missing-image-handle";
      continue;
    }
    if (attachment.isImage && imageBytes + attachment.size > MAX_TOTAL_IMAGE_BYTES) {
      issue ??= "image-total";
      continue;
    }
    accepted.push(attachment);
    if (attachment.isImage) imageBytes += attachment.size;
  }
  return { attachments: accepted, issue };
}

function attachmentIssueLabel(issue: AttachmentSelectionIssue, language: AppLanguage) {
  if (issue === "count") return bi(language, "Vous pouvez joindre au maximum 20 fichiers.", "You can attach up to 20 files.");
  if (issue === "image-size") return bi(language, "Une image dépasse la limite de 8 Mio.", "An image exceeds the 8 MB limit.");
  if (issue === "image-total") return bi(language, "Le total des images jointes ne peut pas dépasser 10 Mio.", "Attached images cannot exceed 10 MB in total.");
  if (issue === "missing-image-handle") return bi(language, "Une image a expiré. Sélectionnez-la de nouveau avec le bouton +.", "An image has expired. Select it again with the + button.");
  if (issue === "unsupported-image") return bi(language, "Seules les images PNG, JPEG, WebP et GIF sont prises en charge.", "Only PNG, JPEG, WebP, and GIF images are supported.");
  if (issue === "native-picker-required") return bi(language, "Pour joindre un fichier en toute sécurité, utilisez le bouton + et confirmez-le dans le sélecteur système.", "To attach a file securely, use the + button and confirm it in the system picker.");
  return bi(language, "Pour joindre un document, utilisez le bouton + afin d’autoriser explicitement son chemin local.", "To attach a document, use the + button to explicitly authorize its local path.");
}

export function attachmentSubmitError(error: unknown, language: AppLanguage) {
  const detail = error instanceof Error ? error.message : String(error);
  if (/expir|handle|disponible|available/i.test(detail)) {
    return bi(
      language,
      "L’image jointe n’est plus disponible. Sélectionnez-la de nouveau avec le bouton +.",
      "The attached image is no longer available. Select it again with the + button.",
    );
  }
  return `${bi(language, "Envoi impossible.", "Could not send.")} ${detail}`.trim();
}

function statusLabel(status: Conversation["status"], language: AppLanguage) {
  const labels: Record<Conversation["status"], string> = language === "en"
    ? { idle: "Ready", starting: "Connecting", streaming: "Running", tool: "Tool active", queued: "Queued", error: "Error", offline: "Offline" }
    : { idle: "Prêt", starting: "Connexion", streaming: "En cours", tool: "Outil actif", queued: "En file", error: "Erreur", offline: "Hors ligne" };
  return labels[status];
}
function thinkingLabel(level: ThinkingLevel, language: AppLanguage) {
  return (language === "en"
    ? { off: "Off", minimal: "Minimal", low: "Light", medium: "Balanced", high: "Deep", xhigh: "Very deep", max: "Maximum" }
    : { off: "Off", minimal: "Minimal", low: "Léger", medium: "Équilibré", high: "Approfondi", xhigh: "Très approfondi", max: "Maximum" })[level];
}
function queueLabel(sessionState: AgentSessionState | undefined, language: AppLanguage) {
  const queued = sessionState?.sessionActions?.queuedCount ?? 0;
  if (queued > 0) return bi(language, `File · ${queued}`, `Queue · ${queued}`);
  return bi(language, "File", "Queue");
}
function shortModel(model?: string) { return model?.includes("/") ? model.slice(model.indexOf("/") + 1) : model; }
function shortPath(path: string) { const pieces = path.split(/[\\/]/).filter(Boolean); return pieces.length > 3 ? `…/${pieces.slice(-2).join("/")}` : pieces.join("/"); }
function formatTime(value: string, locale: string) { return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function formatDuration(ms: number) { const seconds = Math.round(ms / 1000); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`; }
function compactNumber(value: number, locale: string) { return new Intl.NumberFormat(locale, { notation: value >= 1_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value); }
function formatBytes(value: number, language: AppLanguage, locale: string) {
  if (value < 1024) return `${new Intl.NumberFormat(locale).format(value)} ${bi(language, "o", "B")}`;
  if (value < 1024 ** 2) return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value / 1024)} ${bi(language, "Ko", "KB")}`;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value / 1024 ** 2)} ${bi(language, "Mo", "MB")}`;
}
function pretty(value: unknown, language: AppLanguage) {
  const normalized = unwrapToolPayload(value);
  const text = typeof normalized === "string" ? normalized : (() => { try { return JSON.stringify(normalized, null, 2); } catch { return String(normalized); } })();
  return text.length > 16_000 ? `${text.slice(0, 16_000)}\n\n${bi(language, "… sortie tronquée dans la conversation. La sortie complète reste disponible dans les diagnostics.", "… output truncated in the conversation. The full output remains available in diagnostics.")}` : text;
}

function unwrapToolPayload(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const payload = value as Record<string, unknown>;
  if (!Array.isArray(payload.content)) return value;
  const text = payload.content
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
  return text || value;
}

interface PythonActivitySummary {
  running: number;
  success: number;
  error: number;
  warning: number;
}

interface GroupedActivity extends ActivityItem {
  updateCount: number;
  pythonSummary?: PythonActivitySummary;
}

function groupActivities(activities: ActivityItem[], language: AppLanguage): GroupedActivity[] {
  const groups: GroupedActivity[] = [];
  const stableGroups = new Map<string, number>();
  let pythonGroupIndex: number | undefined;
  for (const sourceActivity of activities) {
    const activity = normalizeLegacyActivity(sourceActivity, language);
    const updateCount = activity.updateCount ?? 1;
    if (isPythonActivity(activity)) {
      const bucket = pythonActivityBucket(activity.status);
      if (pythonGroupIndex === undefined) {
        pythonGroupIndex = groups.length;
        groups.push({
          ...activity,
          id: "activity-group:python-executions",
          title: bi(language, "Exécutions Python", "Python executions"),
          updateCount,
          pythonSummary: { running: 0, success: 0, error: 0, warning: 0, [bucket]: 1 },
        });
      } else {
        const previous = groups[pythonGroupIndex]!;
        const previousUpdatedAt = previous.updatedAt ?? previous.createdAt;
        const activityUpdatedAt = activity.updatedAt ?? activity.createdAt;
        const latest = activityUpdatedAt >= previousUpdatedAt ? activity : previous;
        const summary = { ...previous.pythonSummary! };
        summary[bucket] += 1;
        groups[pythonGroupIndex] = {
          ...latest,
          id: "activity-group:python-executions",
          title: bi(language, "Exécutions Python", "Python executions"),
          createdAt: previous.createdAt <= activity.createdAt ? previous.createdAt : activity.createdAt,
          updatedAt: activityUpdatedAt >= previousUpdatedAt ? activityUpdatedAt : previousUpdatedAt,
          updateCount: previous.updateCount + updateCount,
          pythonSummary: summary,
        };
      }
      continue;
    }
    const stableKey = activityGroupKey(activity);
    if (stableKey) {
      const groupIndex = stableGroups.get(stableKey);
      if (groupIndex !== undefined) {
        const previous = groups[groupIndex]!;
        const previousUpdatedAt = previous.updatedAt ?? previous.createdAt;
        const activityUpdatedAt = activity.updatedAt ?? activity.createdAt;
        const latest = activityUpdatedAt >= previousUpdatedAt ? activity : previous;
        groups[groupIndex] = {
          ...latest,
          id: `activity-group:${stableKey}`,
          createdAt: previous.createdAt <= activity.createdAt ? previous.createdAt : activity.createdAt,
          updatedAt: activityUpdatedAt >= previousUpdatedAt ? activityUpdatedAt : previousUpdatedAt,
          updateCount: previous.updateCount + updateCount,
        };
        continue;
      }
      stableGroups.set(stableKey, groups.length);
      groups.push({ ...activity, id: `activity-group:${stableKey}`, updateCount });
      continue;
    }

    const previous = groups.at(-1);
    if (previous && previous.title === activity.title && previous.status === activity.status && activity.type.startsWith("tool_execution")) {
      previous.updateCount += updateCount;
      previous.updatedAt = activity.updatedAt ?? activity.createdAt;
      continue;
    }
    groups.push({ ...activity, updateCount });
  }
  for (const group of groups) {
    if (!group.pythonSummary) continue;
    group.status = group.pythonSummary.running > 0 ? "running" : group.pythonSummary.error > 0 ? "error" : group.pythonSummary.warning > 0 ? "warning" : "success";
    group.detail = pythonActivitySummaryLabel(group.pythonSummary, language);
  }
  return groups.sort((left, right) => (left.updatedAt ?? left.createdAt).localeCompare(right.updatedAt ?? right.createdAt));
}

function pythonActivityBucket(status: ActivityItem["status"]): keyof PythonActivitySummary {
  if (status === "running" || status === "info") return "running";
  if (status === "error") return "error";
  if (status === "warning") return "warning";
  return "success";
}

function pythonExecutionCount(summary: PythonActivitySummary) {
  return summary.running + summary.success + summary.error + summary.warning;
}

function pythonActivitySummaryLabel(summary: PythonActivitySummary, language: AppLanguage) {
  return [
    summary.running ? `${summary.running} ${bi(language, "active", "running")}${summary.running > 1 && language === "fr" ? "s" : ""}` : "",
    summary.success ? `${summary.success} ${bi(language, "terminée", "complete")}${summary.success > 1 && language === "fr" ? "s" : ""}` : "",
    summary.error ? `${summary.error} ${summary.error > 1 ? bi(language, "erreurs", "failed") : bi(language, "erreur", "failed")}` : "",
    summary.warning ? `${summary.warning} ${bi(language, "interrompue", "cancelled")}${summary.warning > 1 && language === "fr" ? "s" : ""}` : "",
  ].filter(Boolean).join(" · ");
}

function isPythonActivity(activity: ActivityItem) {
  if (!activity.type.startsWith("tool_execution") && activity.type !== "observed_session_event") return false;
  const raw = activity.raw && typeof activity.raw === "object" ? activity.raw as Record<string, unknown> : undefined;
  const nested = raw?.event && typeof raw.event === "object" ? raw.event as Record<string, unknown> : undefined;
  const toolName = typeof raw?.toolName === "string" ? raw.toolName : typeof nested?.toolName === "string" ? nested.toolName : "";
  const normalized = `${toolName} ${activity.title}`.toLowerCase();
  return normalized.includes("ipython") || normalized.includes("python");
}

function normalizeLegacyActivity(activity: ActivityItem, language: AppLanguage): ActivityItem {
  if (activity.type !== "rlm_child_update") return activity;
  const raw = activity.raw && typeof activity.raw === "object" ? activity.raw as Record<string, unknown> : undefined;
  const child = raw?.child && typeof raw.child === "object" ? raw.child as Record<string, unknown> : undefined;
  if (!child) return activity;
  const label = typeof child.label === "string" ? child.label : typeof child.sessionName === "string" ? child.sessionName : bi(language, "sans nom", "unnamed");
  const status = typeof child.status === "string" ? child.status : "running";
  const childActivity = child.activity && typeof child.activity === "object" ? child.activity as Record<string, unknown> : undefined;
  const activityDetail = childActivity?.kind === "executing"
    ? `${bi(language, "Exécute", "Running")} ${typeof childActivity.toolName === "string" ? childActivity.toolName.replaceAll("_", " ") : bi(language, "un outil", "a tool")}`
    : childActivity?.kind === "writing" ? bi(language, "Rédige sa réponse", "Writing its response") : childActivity?.kind === "waiting" ? bi(language, "Attend une nouvelle étape", "Waiting for the next step") : undefined;
  const detail = typeof child.error === "string"
    ? child.error
    : typeof child.recap === "string"
      ? child.recap
      : activityDetail ?? (typeof child.answerPreview === "string" ? child.answerPreview : activity.detail);
  if (status === "done") return { ...activity, title: language === "en" ? `Sub-agent “${label}” complete` : `Sous-agent « ${label} » terminé`, detail, status: "success" };
  if (status === "error") return { ...activity, title: language === "en" ? `Sub-agent “${label}” failed` : `Échec du sous-agent « ${label} »`, detail, status: "error" };
  if (status === "cancelled") return { ...activity, title: language === "en" ? `Sub-agent “${label}” cancelled` : `Sous-agent « ${label} » annulé`, detail, status: "warning" };
  if (status === "queued") return { ...activity, title: language === "en" ? `Sub-agent “${label}” queued` : `Sous-agent « ${label} » en attente`, detail, status: "info" };
  return { ...activity, title: language === "en" ? `Sub-agent “${label}” is working` : `Sous-agent « ${label} » travaille`, detail, status: "running" };
}

function activityGroupKey(activity: ActivityItem): string | undefined {
  if (activity.id.startsWith("rlm-child:")) return activity.id;
  if (["session-actions", "session-recap"].includes(activity.id)) return activity.id;
  if (activity.id.startsWith("observed-session:") || activity.id.startsWith("goal:") || activity.id.startsWith("bash:")) return activity.id;

  const raw = activity.raw && typeof activity.raw === "object" ? activity.raw as Record<string, unknown> : undefined;
  if (activity.type === "rlm_child_update") {
    const child = raw?.child && typeof raw.child === "object" ? raw.child as Record<string, unknown> : undefined;
    const childId = typeof child?.id === "string" ? child.id : typeof child?.sessionName === "string" ? child.sessionName : activity.title;
    return `rlm-child:${childId}`;
  }
  if (activity.type === "session_action_update") return "session-actions";
  if (activity.type === "recap_update") return "session-recap";
  if (activity.type === "bash_output") return "legacy-bash-output";
  if (activity.type === "goal_update") {
    const goal = raw?.goal && typeof raw.goal === "object" ? raw.goal as Record<string, unknown> : undefined;
    return `goal:${typeof goal?.goalId === "string" ? goal.goalId : typeof goal?.objective === "string" ? goal.objective : "current"}`;
  }
  if (activity.type === "observed_session_event") {
    const activeSessionId = typeof raw?.activeSessionId === "string" ? raw.activeSessionId : "unknown";
    const nested = raw?.event && typeof raw.event === "object" ? raw.event as Record<string, unknown> : undefined;
    const nestedType = typeof nested?.type === "string" ? nested.type : "event";
    const nestedMessage = nested?.message && typeof nested.message === "object" ? nested.message as Record<string, unknown> : undefined;
    const nestedId = typeof nested?.toolCallId === "string" ? nested.toolCallId : typeof nestedMessage?.id === "string" ? nestedMessage.id : "current";
    return `observed-session:${activeSessionId}:${nestedType}:${nestedId}`;
  }
  return undefined;
}
function fileName(path: string) { return path.split(/[\\/]/).at(-1) ?? path; }
function parentPath(path: string) { const parts = path.split(/[\\/]/); return parts.slice(0, -1).join("/") || "/"; }
function changeStatusLabel(status: string) {
  const normalized = status.replace(/\s/g, "");
  if (normalized === "??") return "U";
  if (normalized.includes("U") || normalized === "AA" || normalized === "DD") return "!";
  if (normalized.includes("R")) return "R";
  if (normalized.includes("C")) return "C";
  if (normalized.includes("A")) return "A";
  if (normalized.includes("D")) return "D";
  return "M";
}
function changeStatusClass(status: string) {
  const label = changeStatusLabel(status);
  if (label === "U") return "status-untracked";
  if (label === "!") return "status-conflict";
  if (label === "R" || label === "C") return "status-renamed";
  if (label === "A") return "status-added";
  if (label === "D") return "status-deleted";
  return "status-modified";
}
function changeStatusTitle(status: string, language: AppLanguage) {
  const label = changeStatusLabel(status);
  const titles: Record<string, [string, string]> = {
    U: ["Non suivi", "Untracked"],
    "!": ["Conflit Git", "Git conflict"],
    R: ["Renommé", "Renamed"],
    C: ["Copié", "Copied"],
    A: ["Ajouté", "Added"],
    D: ["Supprimé", "Deleted"],
    M: ["Modifié", "Modified"],
  };
  const title = titles[label] ?? titles.M;
  return language === "en" ? title[1] : title[0];
}
function diffLineClass(line: string) {
  if (line.startsWith("@@")) return "is-hunk";
  if (/^(diff --git|index |--- |\+\+\+ |new file |deleted file |similarity |rename )/.test(line)) return "is-header";
  if (line.startsWith("+")) return "is-added";
  if (line.startsWith("-")) return "is-deleted";
  return "is-context";
}
function gitActionPrompt(action: GitPromptAction, language: AppLanguage) {
  if (action === "commit-push") {
    return bi(
      language,
      "Analyse les changements Git actuels de ce projet à partir du diff réel. Rédige un message de commit clair et concis, exécute les vérifications adaptées, puis commit les changements pertinents et pousse la branche courante vers son remote. Préserve les fichiers hors périmètre, ne publie aucun secret et n’écrase aucun changement existant. Si le commit ou le push est impossible, explique précisément le blocage.",
      "Analyze this project’s current Git changes from the actual diff. Write a clear, concise commit message, run the appropriate checks, then commit the relevant changes and push the current branch to its remote. Preserve out-of-scope files, publish no secrets, and do not overwrite existing changes. If committing or pushing is impossible, explain the blocker precisely.",
    );
  }
  return bi(
    language,
    "Prépare et publie une nouvelle release GitHub à partir de l’état actuel du projet. Analyse les changements depuis la dernière release, choisis la prochaine version SemVer appropriée, mets à jour les versions et les notes nécessaires, exécute les validations et le build, puis commit, pousse, crée le tag et publie la release GitHub avec des notes claires et les artefacts installables attendus. Vérifie qu’aucun secret ni fichier hors périmètre n’est inclus et n’écrase jamais un tag existant. Si une étape est bloquée, explique précisément pourquoi.",
    "Prepare and publish a new GitHub release from the project’s current state. Analyze changes since the previous release, choose the appropriate next SemVer version, update the required versions and notes, run validation and the build, then commit, push, create the tag, and publish the GitHub release with clear notes and the expected installable artifacts. Verify that no secrets or out-of-scope files are included, and never overwrite an existing tag. If a step is blocked, explain exactly why.",
  );
}
