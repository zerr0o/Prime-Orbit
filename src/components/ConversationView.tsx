import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Activity,
  ArchiveRestore,
  CalendarClock,
  ArrowLeft,
  ArrowDown,
  ArrowRight,
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
  FileArchive,
  FileCode2,
  FileText,
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
  Undo2,
  WandSparkles,
  X,
  Zap,
} from "lucide-react";
import {
  admitDroppedAttachment,
  deleteHarnessEntry,
  getGitFileDiff,
  openConversationPath,
  openGitFileFolder,
  openHarnessState,
  openRefinementJournal,
  pickAttachments,
  releaseAttachmentHandles,
} from "../lib/bridge";
import { classifyConversationLink } from "../lib/conversation-links";
import { agentMessagePreview } from "../lib/agent-message-notices";
import { sessionGoalCount, type GoalMutationRuntimeState } from "../lib/goal-control";
import {
  automaticCompactionAction,
  persistedRefinementHistory,
  refinementHistory,
  SESSION_MEMORY_CAPABILITIES,
  subagentStatusPresentation,
} from "../lib/session-inspector";
import {
  EMPTY_PLAN_MODE,
  decodePlanUiRequestTitle,
  encodePlanInlineRevisionResponse,
  PLAN_INLINE_REVISION_PROTOCOL,
  normalizePlanDocument,
  recoverablePlanDialogKind,
  resolvePlanState,
  type PlanDocument,
  type PlanReviewDecision,
  unresolvedPlanDialogSummary,
} from "../lib/plan-mode";
import { useDismissableLayer } from "../hooks/useDismissableLayer";
import { useI18n, type AppLanguage } from "../i18n";
import type {
  ActivityItem,
  AgentMessageRelationship,
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
  PendingExtensionUiRequest,
  Project,
  SessionHarnessEntry,
  SessionRefinementKind,
  SessionRefinementRecord,
  SessionStats,
  SlashCommand,
  ThinkingLevel,
  ToolActivity,
} from "../types";
import type { RuntimeDivergence } from "../hooks/useAgentRuntime";
import { Badge, Button, IconButton, Modal } from "./Ui";
import { ModelPickerPopover } from "./ModelPickerPopover";

function bi(language: AppLanguage, french: string, english: string) {
  return language === "en" ? english : french;
}

function useLatestCallback<Arguments extends unknown[], Result>(callback: (...args: Arguments) => Result) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  return useCallback((...args: Arguments) => callbackRef.current(...args), []);
}

interface ConversationViewProps {
  project: Project;
  conversation: Conversation;
  models: ModelInfo[];
  favoriteModels: string[];
  commands: SlashCommand[];
  stats?: SessionStats;
  sessionState?: AgentSessionState;
  goalMutation?: GoalMutationRuntimeState;
  isCompacting?: boolean;
  isRefining?: boolean;
  refinements?: SessionRefinementRecord[];
  harnessEntries?: SessionHarnessEntry[];
  divergences?: RuntimeDivergence[];
  schedules?: AgentSchedule[];
  heartbeat?: AgentSchedule | null;
  heartbeats?: AgentHeartbeatSummary[];
  subagents?: AgentRlmChild[];
  observedSubagent?: { activeSessionId: string; messages: ChatMessage[]; closed?: boolean; error?: string };
  inspectorOpen: boolean;
  changes: GitChange[];
  resourceReloadSupported: boolean;
  planRequest?: PendingExtensionUiRequest;
  isPlanRequestReplayPending?: boolean;
  onPlanMode: (mode: "normal" | "plan") => Promise<void>;
  onRetryPlanFinalization: (conversationId: string) => Promise<void>;
  onRecoverPlanDialogs: () => Promise<void>;
  onAnswerPlanRequest: (request: PendingExtensionUiRequest, response: Record<string, unknown>) => Promise<void>;
  onToggleInspector: () => void;
  onDraftChange: (draft: string) => void;
  onSend: (message: string, attachments: Attachment[], delivery?: "steer" | "follow_up") => Promise<void>;
  onRetryMessage: (assistantMessageId: string) => Promise<void>;
  onAbort: () => Promise<void>;
  onModel: (model: ModelInfo) => Promise<void>;
  onToggleFavoriteModel: (ref: string) => void;
  onThinking: (level: ThinkingLevel) => Promise<void>;
  onRunCommand: (type: string, fields?: Record<string, unknown>) => Promise<void>;
  onObserveSubagent: (activeSessionId?: string) => Promise<void>;
  onForkMessage: (assistantMessageId: string) => Promise<void>;
  onCloneSession: () => Promise<void>;
  onNewWindow: () => void;
  onOpenTerminal: () => void;
}

export interface ComposerSlashCommand {
  name: string;
  label: string;
  description: string;
  source: "prime" | "session" | "orbit";
  behavior: "prompt" | "action";
  action?: "compact" | "refine" | "reload_resources";
  requiresArgument?: boolean;
  disabledReason?: string;
}

export interface ActiveComposerSlashCommand {
  command: ComposerSlashCommand;
  argument: string;
}

const DRAFT_PERSIST_DEBOUNCE_MS = 180;

/**
 * Prime Agent remains authoritative for extensible slash commands. The
 * session commands below are also parsed by Prime Agent, but are not included
 * in its dynamic get_commands catalog.
 */
export function buildComposerSlashCommands(
  commands: SlashCommand[],
  language: AppLanguage,
  resourceReloadSupported = true,
): ComposerSlashCommand[] {
  const entries: ComposerSlashCommand[] = [
    {
      name: "plan",
      label: bi(language, "Mode Plan", "Plan mode"),
      description: bi(language, "Planifier en lecture seule dans cette conversation", "Plan read-only in this conversation"),
      source: "orbit",
      behavior: "prompt",
    },
    {
      name: "goal",
      label: bi(language, "Objectif", "Goal"),
      description: bi(language, "Définir un objectif persistant à poursuivre", "Set a persistent objective to pursue"),
      source: "session",
      behavior: "prompt",
      requiresArgument: true,
    },
    {
      name: "compact",
      label: bi(language, "Compacter", "Compact"),
      description: bi(language, "Résumer la session pour libérer du contexte", "Summarize the session to free context"),
      source: "session",
      behavior: "prompt",
    },
    {
      name: "refine",
      label: bi(language, "Raffiner", "Refine"),
      description: bi(language, "Capitaliser les apprentissages de la session", "Capture what the session learned"),
      source: "session",
      behavior: "prompt",
    },
    {
      name: "autonomous",
      label: bi(language, "Mode autonome", "Autonomous mode"),
      description: bi(language, "Afficher ou régler le mode autonome Prime Agent (status, on, off) — distinct des autorisations Orbit", "Show or set Prime Agent autonomous mode (status, on, off) — separate from Orbit permissions"),
      source: "session",
      behavior: "prompt",
    },
    {
      name: "reload",
      label: bi(language, "Recharger les ressources", "Reload resources"),
      description: bi(language, "Recharger les réglages, skills, extensions, prompts et intégrations MCP", "Reload settings, skills, extensions, prompts, and MCP integrations"),
      source: "session",
      behavior: "action",
      action: "reload_resources",
      ...(resourceReloadSupported ? {} : {
        disabledReason: bi(language, "Indisponible : l’intégration desktop /reload requiert une installation source ou gérée.", "Unavailable: desktop /reload requires a source or managed installation."),
      }),
    },
  ];
  const known = new Set(entries.map((entry) => entry.name));
  for (const command of commands) {
    const name = command.name.trim().replace(/^\/+/, "");
    if (!name || /\s/.test(name) || known.has(name.toLowerCase())) continue;
    known.add(name.toLowerCase());
    entries.push({
      name,
      label: name.replace(/[-_]+/g, " "),
      description: command.description?.trim() || command.source,
      source: "prime",
      behavior: "prompt",
    });
  }
  return entries;
}

export function filterComposerSlashCommands(commands: ComposerSlashCommand[], query: string) {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return commands;
  return commands.filter((command) => (
    `${command.name} ${command.label} ${command.description}`.toLocaleLowerCase().includes(normalized)
  ));
}

export function resolveComposerActionSubmission(draft: string, commands: ComposerSlashCommand[]) {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(draft.trim());
  if (!match) return undefined;
  const command = commands.find((entry) => entry.name.toLocaleLowerCase() === match[1].toLocaleLowerCase());
  if (!command || command.behavior !== "action" || !command.action) return undefined;
  const argument = (match[2] ?? "").trim();
  return {
    command,
    error: argument ? `/${command.name} n’accepte aucun argument.` : command.disabledReason,
  };
}

export function parseActiveComposerSlashCommand(
  draft: string,
  commands: ComposerSlashCommand[],
): ActiveComposerSlashCommand | undefined {
  const match = draft.match(/^\/([^\s]+)\s([\s\S]*)$/);
  if (!match) return undefined;
  const command = commands.find((entry) => entry.behavior === "prompt" && entry.name.toLowerCase() === match[1]?.toLowerCase());
  return command ? { command, argument: match[2] ?? "" } : undefined;
}

export function scheduleComposerDraftReport(
  report: (value: string) => void,
  value: string,
  schedule: (callback: () => void, delay: number) => number,
) {
  return schedule(() => report(value), DRAFT_PERSIST_DEBOUNCE_MS);
}

export function moveSlashCommandSelection(current: number, count: number, direction: -1 | 1) {
  if (count <= 0) return 0;
  return (current + direction + count) % count;
}

export function resolveComposerDraftAfterSelection(
  currentConversationId: string,
  nextConversationId: string,
  currentDraft: string,
  reportedDraft: string,
  nextPersistedDraft: string,
) {
  if (currentConversationId !== nextConversationId) return nextPersistedDraft;
  return nextPersistedDraft === reportedDraft ? currentDraft : nextPersistedDraft;
}

export interface ComposerListContinuation {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  action: "continue" | "exit";
}

/**
 * Applies the small amount of Markdown-aware editing a textarea needs for
 * comfortable lists. Plain Enter continues a dash or numbered item; Enter on
 * an empty item removes its marker and leaves the caret on a normal line.
 */
export function continueComposerMarkdownList(
  value: string,
  selectionStart: number,
  selectionEnd: number,
): ComposerListContinuation | undefined {
  if (selectionStart !== selectionEnd || selectionStart < 0 || selectionStart > value.length) return undefined;
  const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
  const nextNewline = value.indexOf("\n", selectionStart);
  const lineEnd = nextNewline === -1 ? value.length : nextNewline;
  const currentLine = value.slice(lineStart, lineEnd);
  const beforeCaret = value.slice(lineStart, selectionStart);
  const lineMatch = /^([ \t]*)(-|\d+\.)(?:[ \t]+)(.*)$/.exec(currentLine);
  const caretMatch = /^([ \t]*)(-|\d+\.)(?:[ \t]+)(.*)$/.exec(beforeCaret);
  if (!lineMatch || !caretMatch || lineMatch[1] !== caretMatch[1] || lineMatch[2] !== caretMatch[2]) return undefined;

  const indent = lineMatch[1] ?? "";
  const content = lineMatch[3] ?? "";
  if (!content.trim()) {
    const caret = lineStart + indent.length;
    return {
      value: `${value.slice(0, lineStart)}${indent}${value.slice(lineEnd)}`,
      selectionStart: caret,
      selectionEnd: caret,
      action: "exit",
    };
  }

  const marker = caretMatch[2] ?? "-";
  const number = marker === "-" ? undefined : Number.parseInt(marker, 10);
  const nextMarker = number === undefined
    ? "-"
    : `${Number.isSafeInteger(number) && number < Number.MAX_SAFE_INTEGER ? number + 1 : number}.`;
  const insertion = `\n${indent}${nextMarker} `;
  const caret = selectionStart + insertion.length;
  return {
    value: `${value.slice(0, selectionStart)}${insertion}${value.slice(selectionStart)}`,
    selectionStart: caret,
    selectionEnd: caret,
    action: "continue",
  };
}

export function ConversationView(props: ConversationViewProps) {
  const { project, conversation, models, favoriteModels, commands, stats, sessionState, goalMutation, isCompacting: runtimeCompacting = false, isRefining = false, refinements, harnessEntries, divergences = [], schedules = [], heartbeat, heartbeats = [], subagents = [], observedSubagent, inspectorOpen, changes, resourceReloadSupported, planRequest, isPlanRequestReplayPending = false, onPlanMode, onRetryPlanFinalization, onRecoverPlanDialogs, onAnswerPlanRequest, onToggleInspector, onDraftChange, onSend, onRetryMessage, onAbort, onModel, onToggleFavoriteModel, onThinking, onRunCommand, onObserveSubagent, onForkMessage, onCloneSession, onNewWindow, onOpenTerminal } = props;
  const { language } = useI18n();
  const isCompacting = runtimeCompacting || Boolean(sessionState?.isCompacting);
  const isRunning = !isCompacting && isConversationTurnActive(conversation.status);
  const showActiveRun = !isCompacting && (conversation.status === "starting" || isRunning);
  const conversationPlan = resolvePlanState(conversation.planMode) ?? EMPTY_PLAN_MODE;
  const planFinalizing = conversationPlan.phase === "idle"
    && (conversationPlan.outcome === "applied" || conversationPlan.outcome === "kept");
  const [inspectorTab, setInspectorTab] = useState<"activity" | "session" | "changes" | "details">("changes");
  const [openPopover, setOpenPopover] = useState<ConversationPopover>(null);
  const [restartDialogOpen, setRestartDialogOpen] = useState(false);
  const [restartBusy, setRestartBusy] = useState(false);
  const [restartError, setRestartError] = useState<string>();
  const [missingPlanDialogVisible, setMissingPlanDialogVisible] = useState(false);
  const [planRecoveryBusy, setPlanRecoveryBusy] = useState(false);
  const [planRecoveryError, setPlanRecoveryError] = useState<string>();
  const unresolvedPlanDialogs = unresolvedPlanDialogSummary(conversation);
  const recoverablePlanDialog = recoverablePlanDialogKind(conversation);
  const expectsPlanDialog = shouldShowMissingPlanDialog({
    hasLiveRequest: Boolean(planRequest),
    hasUnresolvedTranscript: unresolvedPlanDialogs.total > 0,
    status: conversation.status,
    recoverableKind: recoverablePlanDialog,
    phase: conversationPlan.phase,
    isCompacting,
    nativeProbePending: isPlanRequestReplayPending,
  });
  // Draft persistence updates the parent conversation object while the user is
  // typing. Stable event bridges let the transcript ignore those updates
  // without retaining callbacks that captured an older conversation.
  const transcriptSuggestion = useLatestCallback(onDraftChange);
  const transcriptRunCommand = useLatestCallback(onRunCommand);
  const transcriptRetryMessage = useLatestCallback(onRetryMessage);
  const transcriptForkMessage = useLatestCallback(onForkMessage);
  const closePopover = useCallback(() => setOpenPopover(null), []);
  const togglePopover = useCallback((popover: Exclude<ConversationPopover, null>) => {
    setOpenPopover((current) => current === popover ? null : popover);
  }, []);
  useDismissableLayer(openPopover, closePopover);
  useEffect(closePopover, [conversation.id, closePopover]);
  useEffect(() => {
    setRestartDialogOpen(false);
    setRestartBusy(false);
    setRestartError(undefined);
    setMissingPlanDialogVisible(false);
    setPlanRecoveryBusy(false);
    setPlanRecoveryError(undefined);
  }, [conversation.id]);
  useEffect(() => {
    if (!expectsPlanDialog) {
      setMissingPlanDialogVisible(false);
      setPlanRecoveryError(undefined);
      return;
    }
    const timeout = window.setTimeout(() => setMissingPlanDialogVisible(true), 1_200);
    return () => window.clearTimeout(timeout);
  }, [expectsPlanDialog, unresolvedPlanDialogs.latestKind, unresolvedPlanDialogs.total]);

  const recoverMissingPlanDialogs = useCallback(async () => {
    if (planRecoveryBusy) return;
    setPlanRecoveryBusy(true);
    setPlanRecoveryError(undefined);
    try {
      await onRecoverPlanDialogs();
      setPlanRecoveryBusy(false);
    } catch (error) {
      setPlanRecoveryError(error instanceof Error ? error.message : String(error));
      setPlanRecoveryBusy(false);
    }
  }, [onRecoverPlanDialogs, planRecoveryBusy]);

  const confirmEmergencyRestart = useCallback(async () => {
    if (restartBusy) return;
    setRestartBusy(true);
    setRestartError(undefined);
    try {
      await onRunCommand("restart_agent");
      setRestartDialogOpen(false);
    } catch (error) {
      setRestartError(error instanceof Error ? error.message : String(error));
    } finally {
      setRestartBusy(false);
    }
  }, [onRunCommand, restartBusy]);

  return (
    <div className="conversation-workspace">
      <div className="conversation-main">
        <ConversationHeader
          project={project}
          conversation={conversation}
          models={models}
          favoriteModels={favoriteModels}
          sessionState={sessionState}
          resourceReloadSupported={resourceReloadSupported}
          inspectorOpen={inspectorOpen}
          onModel={onModel}
          onToggleFavoriteModel={onToggleFavoriteModel}
          onToggleInspector={onToggleInspector}
          onNewWindow={onNewWindow}
          onOpenTerminal={onOpenTerminal}
          onRunCommand={onRunCommand}
          onCloneSession={onCloneSession}
          onEmergencyRestart={() => {
            closePopover();
            setRestartError(undefined);
            setRestartDialogOpen(true);
          }}
          openPopover={openPopover}
          onTogglePopover={togglePopover}
          onClosePopover={closePopover}
        />
        <Transcript conversation={conversation} project={project} onSuggestion={transcriptSuggestion} onRunCommand={transcriptRunCommand} onRetryMessage={transcriptRetryMessage} onForkMessage={transcriptForkMessage} />
        {showActiveRun ? <ActiveRunBar conversation={conversation} onAbort={onAbort} onActivity={() => { setInspectorTab("activity"); if (!inspectorOpen) onToggleInspector(); }} /> : null}
        {isCompacting ? <CompactionStatusBar /> : null}
        {isRefining ? <RefinementStatusBar /> : null}
        {shouldShowLivePlanRequest(planRequest, conversation.pendingPlanAction) ? (
          <PlanInteractionCard
            key={planRequest.requestKey}
            request={planRequest}
            conversation={conversation}
            project={project}
            onAnswer={onAnswerPlanRequest}
          />
        ) : missingPlanDialogVisible ? (
          <section className="plan-interaction plan-dialog-recovery" role="alert" aria-busy={planRecoveryBusy}>
            <header className="plan-interaction-header">
              <span className="plan-interaction-icon" aria-hidden="true"><RefreshCw size={18} /></span>
              <div>
                <strong>{recoverablePlanDialog === "review"
                  ? bi(language, "Validation du plan à reconnecter", "Plan review needs reconnection")
                  : bi(language, "Questions Plan à reconnecter", "Plan questions need reconnection")}</strong>
                <p>{recoverablePlanDialog === "review"
                  ? bi(language, "Prime Agent attend toujours votre décision sur le plan, mais le formulaire de validation n’a pas survécu à l’ancienne connexion.", "Prime Agent is still waiting for your plan decision, but the review form did not survive the previous connection.")
                  : bi(
                    language,
                    `${unresolvedPlanDialogs.questionCount} question${unresolvedPlanDialogs.questionCount > 1 ? "s sont" : " est"} encore bloquée${unresolvedPlanDialogs.questionCount > 1 ? "s" : ""} dans Prime Agent, mais leur formulaire n’a pas survécu à l’ancienne connexion.`,
                    `${unresolvedPlanDialogs.questionCount} question${unresolvedPlanDialogs.questionCount === 1 ? " is" : "s are"} still blocked in Prime Agent, but the form did not survive the previous connection.`,
                  )}</p>
              </div>
              <Badge tone="warning">{bi(language, "Récupération", "Recovery")}</Badge>
            </header>
            <footer className="plan-question-footer">
              <small>{bi(language, "Prime Orbit annule uniquement l’appel orphelin, recrée sa connexion interactive puis laisse Prime Agent reprendre l’instruction.", "Prime Orbit cancels only the orphaned call, recreates its interactive connection, then lets Prime Agent resume the instruction.")}</small>
              <Button variant="primary" loading={planRecoveryBusy} onClick={() => void recoverMissingPlanDialogs()}><RefreshCw size={14} />{recoverablePlanDialog === "review" ? bi(language, "Reconnecter le plan", "Reconnect plan review") : bi(language, "Reconnecter les questions", "Reconnect questions")}</Button>
            </footer>
            {planRecoveryError ? <p className="plan-interaction-error" role="alert"><CircleAlert size={14} />{planRecoveryError}</p> : null}
          </section>
        ) : planFinalizing ? (
          <div className={`plan-finalizing ${conversation.status === "error" ? "is-error" : ""}`} role={conversation.status === "error" ? "alert" : "status"}>
            {conversation.status === "error" ? <CircleAlert size={16} /> : <LoaderCircle size={16} className="spin" />}
            <span><strong>{conversation.status === "error" ? bi(language, "Le passage au runtime Normal a échoué", "Switching to the Normal runtime failed") : conversationPlan.outcome === "applied" ? bi(language, "Passage à l’implémentation…", "Switching to implementation…") : bi(language, "Enregistrement du plan…", "Saving the plan…")}</strong><small>{conversation.status === "error" ? conversation.lastError : bi(language, "Prime Orbit relance cette conversation avec le runtime Normal.", "Prime Orbit is restarting this conversation with the Normal runtime.")}</small></span>
            {conversation.status === "error" ? <Button variant="secondary" onClick={() => void onRetryPlanFinalization(conversation.id)}><RefreshCw size={14} />{bi(language, "Réessayer", "Retry")}</Button> : null}
          </div>
        ) : (
        <Composer
          key={conversation.id}
          project={project}
          conversation={conversation}
          models={models}
          favoriteModels={favoriteModels}
          commands={commands}
          stats={stats}
          sessionState={sessionState}
          resourceReloadSupported={resourceReloadSupported}
          isRunning={isRunning}
          isCompacting={isCompacting}
          isRefining={isRefining}
          onDraftChange={onDraftChange}
          onSend={onSend}
          onAbort={onAbort}
          onModel={onModel}
          onToggleFavoriteModel={onToggleFavoriteModel}
          onThinking={onThinking}
          onRunCommand={onRunCommand}
          onPlanMode={onPlanMode}
          openPopover={openPopover}
          onTogglePopover={togglePopover}
          onClosePopover={closePopover}
        />
        )}
      </div>
      {inspectorOpen ? (
        <RunInspector
          project={project}
          conversation={conversation}
          stats={stats}
          sessionState={sessionState}
          goalMutation={goalMutation}
          isCompacting={isCompacting}
          isRefining={isRefining}
          refinements={refinements}
          harnessEntries={harnessEntries}
          divergences={divergences}
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
      {restartDialogOpen ? (
        <Modal
          title={bi(language, "Redémarrer la connexion Prime Agent ?", "Restart the Prime Agent connection?")}
          description={bi(language, "Cette action force le remplacement du processus associé à cette conversation.", "This force-replaces the process associated with this conversation.")}
          width="500px"
          onClose={() => { if (!restartBusy) setRestartDialogOpen(false); }}
          footer={<><Button variant="secondary" autoFocus disabled={restartBusy} onClick={() => setRestartDialogOpen(false)}>{bi(language, "Annuler", "Cancel")}</Button><Button variant="danger" loading={restartBusy} onClick={() => void confirmEmergencyRestart()}><RefreshCw size={15} />{bi(language, "Redémarrer maintenant", "Restart now")}</Button></>}
        >
          <div className="draft-replace-warning"><CircleAlert size={20} /><div><strong>{bi(language, "Le travail en cours et les messages non livrés seront annulés.", "Current work and undelivered messages will be cancelled.")}</strong><p>{bi(language, "L’historique persistant est conservé et seule cette conversation est concernée. Si son processus est déjà arrêté, Prime Orbit rouvrira sa connexion.", "Persistent history is preserved and only this conversation is affected. If its process has already stopped, Prime Orbit will reopen its connection.")}</p></div></div>
          {restartError ? <p className="inline-error" role="alert"><CircleAlert size={16} />{restartError}</p> : null}
        </Modal>
      ) : null}
    </div>
  );
}

type ConversationPopover = "header-model" | "header-actions" | "composer-tools" | "composer-queue" | "composer-context" | "composer-model" | "composer-thinking" | null;

function ConversationHeader({ project, conversation, models, favoriteModels, sessionState, resourceReloadSupported, inspectorOpen, onModel, onToggleFavoriteModel, onToggleInspector, onNewWindow, onOpenTerminal, onRunCommand, onCloneSession, onEmergencyRestart, openPopover, onTogglePopover, onClosePopover }: {
  project: Project;
  conversation: Conversation;
  models: ModelInfo[];
  favoriteModels: string[];
  sessionState?: AgentSessionState;
  resourceReloadSupported: boolean;
  inspectorOpen: boolean;
  onModel: (model: ModelInfo) => Promise<void>;
  onToggleFavoriteModel: (ref: string) => void;
  onToggleInspector: () => void;
  onNewWindow: () => void;
  onOpenTerminal: () => void;
  onRunCommand: (type: string, fields?: Record<string, unknown>) => Promise<void>;
  onCloneSession: () => Promise<void>;
  onEmergencyRestart: () => void;
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
          <button type="button" className="header-model" aria-haspopup="dialog" aria-expanded={openPopover === "header-model"} onClick={() => onTogglePopover("header-model")}>
            <span className="model-provider-icon"><Sparkles size={14} /></span>
            <span>{activeModel?.name ?? activeModel?.id ?? shortModel(conversation.model) ?? bi(language, "Modèle", "Model")}</span>
            <ChevronDown size={14} />
          </button>
          {openPopover === "header-model" ? <ModelPickerPopover models={models} active={conversation.model} favorites={favoriteModels} onChoose={async (model) => { await onModel(model); onClosePopover(); }} onToggleFavorite={onToggleFavoriteModel} /> : null}
        </div>
        <IconButton label={bi(language, "Ouvrir le terminal", "Open terminal")} onClick={onOpenTerminal}><Terminal size={18} /></IconButton>
        <IconButton label={bi(language, "Ouvrir dans une nouvelle fenêtre", "Open in a new window")} onClick={onNewWindow}><Maximize2 size={17} /></IconButton>
        <IconButton label={inspectorOpen ? bi(language, "Masquer l’inspecteur", "Hide inspector") : bi(language, "Afficher l’inspecteur", "Show inspector")} className={inspectorOpen ? "is-active" : ""} onClick={onToggleInspector}>
          {inspectorOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
        </IconButton>
        <div className="header-model-wrap" data-dismissable-layer="header-actions">
          <IconButton label={bi(language, "Plus d’actions", "More actions")} className={openPopover === "header-actions" ? "is-active" : ""} onClick={() => onTogglePopover("header-actions")}><MoreHorizontal size={18} /></IconButton>
          {openPopover === "header-actions" ? <SessionActionsPopover sessionState={sessionState} resourceReloadSupported={resourceReloadSupported} onClone={() => { void onCloneSession(); onClosePopover(); }} onEmergencyRestart={onEmergencyRestart} onChoose={async (type, fields, keepOpen) => { await onRunCommand(type, fields); if (!keepOpen) onClosePopover(); }} /> : null}
        </div>
      </div>
    </header>
  );
}

function SessionActionsPopover({ sessionState, resourceReloadSupported, onChoose, onClone, onEmergencyRestart }: {
  sessionState?: AgentSessionState;
  resourceReloadSupported: boolean;
  onChoose: (type: string, fields?: Record<string, unknown>, keepOpen?: boolean) => Promise<void>;
  onClone: () => void;
  onEmergencyRestart: () => void;
}) {
  const { language } = useI18n();
  const [busyAction, setBusyAction] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const runAction = async (type: string, fields?: Record<string, unknown>, keepOpen?: boolean) => {
    if (busyAction) return;
    setBusyAction(type);
    setActionError(undefined);
    try {
      await onChoose(type, fields, keepOpen);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(undefined);
    }
  };
  return (
    <div className="popover session-actions-popover">
      <div className="popover-label">{bi(language, "Session", "Session")}</div>
      <button type="button" onClick={onClone}><Copy size={15} /><span><strong>{bi(language, "Dupliquer la session", "Duplicate session")}</strong><small>{bi(language, "Conserver l’origine et ouvrir une copie", "Keep the source and open a copy")}</small></span></button>
      <button type="button" disabled={Boolean(busyAction)} onClick={() => void runAction("export_html")}><ArrowDown size={15} /><span><strong>{bi(language, "Exporter en HTML", "Export as HTML")}</strong><small>{bi(language, "Choisir le dossier et le nom du fichier", "Choose the folder and file name")}</small></span>{busyAction === "export_html" ? <LoaderCircle size={14} className="spin" /> : null}</button>
      <div className="popover-separator" />
      <div className="popover-label">{bi(language, "Comportement", "Behavior")}</div>
      <AutoCompactionModeRow
        enabled={sessionState?.autoCompactionEnabled ?? false}
        disabled={Boolean(busyAction)}
        language={language}
        onEnabled={(enabled) => {
          const action = automaticCompactionAction(enabled);
          void runAction(action.type, action.fields, action.keepOpen);
        }}
      />
      <div className="popover-separator" />
      <div className="popover-label">{bi(language, "Diagnostic", "Diagnostics")}</div>
      <button type="button" disabled={Boolean(busyAction)} onClick={() => void runAction("get_state")}><RefreshCw size={15} /><span><strong>{bi(language, "Actualiser l’état", "Refresh state")}</strong><small>{bi(language, "Relire l’état sans interrompre Prime Agent", "Read state again without interrupting Prime Agent")}</small></span>{busyAction === "get_state" ? <LoaderCircle size={14} className="spin" /> : null}</button>
      <button type="button" disabled={Boolean(busyAction)} onClick={() => void runAction("resync_runtime")}><RefreshCw size={15} /><span><strong>{bi(language, "Resynchroniser", "Resynchronize")}</strong><small>{bi(language, "Confronter l’affichage à l’état réel et relire l’historique", "Check the display against real state and read history again")}</small></span>{busyAction === "resync_runtime" ? <LoaderCircle size={14} className="spin" /> : null}</button>
      <button type="button" className={!resourceReloadSupported ? "is-capability-unavailable" : undefined} disabled={Boolean(busyAction) || !resourceReloadSupported} onClick={() => void runAction("reload_resources")}><RefreshCw size={15} /><span><strong>{bi(language, "Recharger les ressources", "Reload resources")}</strong><small>{resourceReloadSupported ? bi(language, "Réappliquer réglages, skills, extensions, prompts et MCP", "Reapply settings, skills, extensions, prompts, and MCP") : bi(language, "Indisponible avec l’exécutable système", "Unavailable with the system executable")}</small></span>{busyAction === "reload_resources" ? <LoaderCircle size={14} className="spin" /> : null}</button>
      <button type="button" disabled={Boolean(busyAction)} className="session-danger-action" onClick={onEmergencyRestart}><CircleAlert size={15} /><span><strong>{bi(language, "Redémarrage d’urgence", "Emergency restart")}</strong><small>{bi(language, "Relancer uniquement cette connexion et annuler son travail en cours", "Restart only this connection and cancel its current work")}</small></span></button>
      {actionError ? <div className="popover-inline-error" role="alert"><CircleAlert size={14} /><span>{actionError}</span></div> : null}
    </div>
  );
}

interface TranscriptProps {
  conversation: Conversation;
  project: Project;
  onSuggestion: (text: string) => void;
  onRunCommand: (type: string, fields?: Record<string, unknown>) => Promise<void>;
  onRetryMessage: (assistantMessageId: string) => Promise<void>;
  onForkMessage: (assistantMessageId: string) => Promise<void>;
}

/** Drafts, inspector activity, and other conversation metadata do not affect
 * the transcript. Keeping this comparison O(1) prevents a persisted keystroke
 * from reparsing every historical Markdown block. */
export function hasSameTranscriptPresentation(
  previous: Pick<TranscriptProps, "conversation" | "project">,
  next: Pick<TranscriptProps, "conversation" | "project">,
) {
  return previous.conversation.id === next.conversation.id
    && previous.conversation.messages === next.conversation.messages
    && previous.conversation.status === next.conversation.status
    && previous.conversation.lastError === next.conversation.lastError
    && previous.conversation.hasContent === next.conversation.hasContent
    && previous.conversation.sessionId === next.conversation.sessionId
    && previous.conversation.sessionPath === next.conversation.sessionPath
    && previous.project.name === next.project.name
    && previous.project.path === next.project.path;
}

function areTranscriptPropsEqual(previous: TranscriptProps, next: TranscriptProps) {
  return hasSameTranscriptPresentation(previous, next)
    && previous.onSuggestion === next.onSuggestion
    && previous.onRunCommand === next.onRunCommand
    && previous.onRetryMessage === next.onRetryMessage
    && previous.onForkMessage === next.onForkMessage;
}

export function resetTranscriptScrollForConversation(
  previousConversationId: string,
  nextConversationId: string,
  viewport: Pick<HTMLDivElement, "scrollHeight" | "scrollTop"> | null,
) {
  if (previousConversationId === nextConversationId) return false;
  if (viewport) viewport.scrollTop = viewport.scrollHeight;
  return true;
}

const Transcript = memo(function Transcript({ conversation, project, onSuggestion, onRunCommand, onRetryMessage, onForkMessage }: TranscriptProps) {
  const { language } = useI18n();
  const viewport = useRef<HTMLDivElement>(null);
  const visibleConversationId = useRef(conversation.id);
  const [atBottom, setAtBottom] = useState(true);
  const [linkError, setLinkError] = useState<string>();
  const [stateRefreshBusy, setStateRefreshBusy] = useState(false);
  const messages = useMemo(
    () => conversation.messages.filter((message) => !message.queueDelivery && !message.internal),
    [conversation.messages],
  );
  const entries = useMemo(() => buildTranscriptEntries(messages), [messages]);
  const retrySourceMessageId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "assistant") return messages[index].id;
    }
    return undefined;
  }, [messages]);
  const isHistoryLoading = messages.length === 0 && conversation.status === "starting";

  useLayoutEffect(() => {
    const changed = resetTranscriptScrollForConversation(
      visibleConversationId.current,
      conversation.id,
      viewport.current,
    );
    visibleConversationId.current = conversation.id;
    if (changed) {
      setAtBottom(true);
      setLinkError(undefined);
      setStateRefreshBusy(false);
    }
  }, [conversation.id]);

  useEffect(() => {
    if (!atBottom) return;
    // Token streams can update many times per frame. Coalesce their layout read
    // and scroll write instead of stacking smooth-scroll animations.
    const frame = window.requestAnimationFrame(() => {
      const node = viewport.current;
      if (node) node.scrollTop = node.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [atBottom, messages]);

  const handleScroll = useCallback(() => {
    const node = viewport.current;
    if (!node) return;
    const nextAtBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
    setAtBottom((current) => current === nextAtBottom ? current : nextAtBottom);
  }, []);

  const openTranscriptLink = useCallback(async (href: string) => {
    setLinkError(undefined);
    const target = classifyConversationLink(href);
    try {
      if (target.kind === "external") {
        try {
          await openUrl(target.url);
        } catch (openError) {
          // The native opener can be unavailable (ACL or runtime); fall back
          // to the WebView shell for http(s), like the other link surfaces.
          if (!/^https?:/i.test(target.url)) throw openError;
          window.open(target.url, "_blank", "noopener,noreferrer");
        }
        return;
      }
      if (target.kind === "anchor") {
        document.getElementById(target.id)?.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      if (target.kind === "file") {
        await openConversationPath(project.path, target.path);
        return;
      }
      setLinkError(bi(language, "Ce type de lien n’est pas autorisé dans une réponse de l’agent.", "This link type is not allowed in an agent response."));
    } catch (error) {
      setLinkError(error instanceof Error ? error.message : String(error));
    }
  }, [language, project.path]);

  const refreshRuntimeState = useCallback(async () => {
    if (stateRefreshBusy) return;
    setStateRefreshBusy(true);
    try {
      await onRunCommand("get_state");
    } catch {
      // The runtime projects the native diagnostic onto the conversation.
    } finally {
      setStateRefreshBusy(false);
    }
  }, [onRunCommand, stateRefreshBusy]);

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
            ? <MessageItem key={entry.message.id} message={entry.message} onOpenLink={openTranscriptLink} onRetryMessage={onRetryMessage} onForkMessage={onForkMessage} />
            : <AssistantTurn key={entry.id} messages={entry.messages} onOpenLink={openTranscriptLink} onRetryMessage={onRetryMessage} onForkMessage={onForkMessage} />)}
          {linkError ? <div className="transcript-link-error" role="alert"><CircleAlert size={15} /><span>{linkError}</span><IconButton label={bi(language, "Fermer l’erreur", "Dismiss error")} onClick={() => setLinkError(undefined)}><X size={14} /></IconButton></div> : null}
          {conversation.lastError ? (
            <div className="inline-error"><Info size={17} /><div><strong>{bi(language, "Prime Agent a besoin d’attention", "Prime Agent needs attention")}</strong><p>{conversation.lastError}</p></div>{retrySourceMessageId ? <Button variant="ghost" onClick={() => void onRetryMessage(retrySourceMessageId)}>{bi(language, "Réutiliser la demande", "Reuse request")}</Button> : null}<Button variant="ghost" loading={stateRefreshBusy} onClick={() => void refreshRuntimeState()}>{bi(language, "Actualiser l’état", "Refresh state")}</Button></div>
          ) : null}
        </div>
      )}
      {!atBottom ? <IconButton label={bi(language, "Aller au dernier message", "Go to latest message")} className="scroll-bottom" onClick={() => viewport.current?.scrollTo({ top: viewport.current.scrollHeight, behavior: "smooth" })}><ArrowDown size={17} /></IconButton> : null}
    </div>
  );
}, areTranscriptPropsEqual);

const ignoreReadOnlyAction = async () => undefined;

/** Reuses the production transcript presentation without exposing project-file
 * links, retry, fork, queue, or runtime controls for an unattached session. */
export function ReadOnlyTranscript({ messages, sessionId }: { messages: ChatMessage[]; sessionId: string }) {
  const { language } = useI18n();
  const viewport = useRef<HTMLDivElement>(null);
  const [linkError, setLinkError] = useState<string>();
  const entries = useMemo(() => buildTranscriptEntries(messages), [messages]);

  useLayoutEffect(() => {
    const node = viewport.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [sessionId]);

  const openReadOnlyLink = useCallback(async (href: string) => {
    setLinkError(undefined);
    const target = classifyConversationLink(href);
    try {
      if (target.kind === "external") {
        try {
          await openUrl(target.url);
        } catch (openError) {
          if (!/^https?:/i.test(target.url)) throw openError;
          window.open(target.url, "_blank", "noopener,noreferrer");
        }
        return;
      }
      if (target.kind === "anchor") {
        document.getElementById(target.id)?.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      setLinkError(bi(
        language,
        "Ajoutez d’abord le dossier à Prime Orbit pour ouvrir les liens vers ses fichiers.",
        "Add the folder to Prime Orbit before opening links to its files.",
      ));
    } catch (error) {
      setLinkError(error instanceof Error ? error.message : String(error));
    }
  }, [language]);

  return (
    <div className="transcript-viewport saved-session-transcript" ref={viewport}>
      <div className="transcript-content">
        {entries.map((entry) => entry.kind === "message"
          ? <MessageItem key={entry.message.id} message={entry.message} onOpenLink={openReadOnlyLink} onRetryMessage={ignoreReadOnlyAction} onForkMessage={ignoreReadOnlyAction} readOnly />
          : <AssistantTurn key={entry.id} messages={entry.messages} onOpenLink={openReadOnlyLink} onRetryMessage={ignoreReadOnlyAction} onForkMessage={ignoreReadOnlyAction} readOnly />)}
        {linkError ? <div className="transcript-link-error" role="alert"><CircleAlert size={15} /><span>{linkError}</span><IconButton label={bi(language, "Fermer l’erreur", "Dismiss error")} onClick={() => setLinkError(undefined)}><X size={14} /></IconButton></div> : null}
      </div>
    </div>
  );
}

function ConversationLoadError({ conversation, onRetry }: { conversation: Conversation; onRetry: () => Promise<void> }) {
  const { language } = useI18n();
  const [busy, setBusy] = useState(false);
  const titleId = `conversation-load-error-title-${conversation.id}`;
  const detailId = `conversation-load-error-detail-${conversation.id}`;

  const retry = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onRetry();
    } catch {
      // The runtime keeps the native load error visible on the conversation.
    } finally {
      setBusy(false);
    }
  }, [busy, onRetry]);

  return (
    <section className="conversation-load-error" role="alert" aria-live="assertive" aria-atomic="true" aria-labelledby={titleId} aria-describedby={detailId}>
      <div className="conversation-load-error-card">
        <span className="conversation-load-error-icon" aria-hidden="true"><Info size={21} /></span>
        <div className="conversation-load-error-content">
          <p className="eyebrow">{bi(language, "CONVERSATION INDISPONIBLE", "CONVERSATION UNAVAILABLE")}</p>
          <h2 id={titleId}>{bi(language, "Impossible de charger cette conversation", "Unable to load this conversation")}</h2>
          <p>{bi(language, "Prime Agent n’a pas pu restaurer l’historique. Vous pouvez relancer le chargement sans créer une nouvelle conversation.", "Prime Agent could not restore the history. You can retry loading without creating a new conversation.")}</p>
          <p className="conversation-load-error-detail" id={detailId}>{conversation.lastError}</p>
          <Button variant="secondary" loading={busy} onClick={() => void retry()}>{busy ? null : <RefreshCw size={14} />}{bi(language, "Relancer le chargement", "Retry loading")}</Button>
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

const ConversationMarkdown = memo(function ConversationMarkdown({ content, onOpenLink }: { content: string; onOpenLink: (href: string) => Promise<void> }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={(url, key) => key === "href" ? url : defaultUrlTransform(url)} components={{
    a: ({ children, href }) => {
      const target = classifyConversationLink(href);
      const safeHref = target.kind === "external" ? target.url : target.kind === "anchor" ? `#${encodeURIComponent(target.id)}` : "#";
      return <a href={safeHref} aria-disabled={target.kind === "unsupported" || undefined} onClick={(event) => { event.preventDefault(); if (href) void onOpenLink(href); }}>{children}</a>;
    },
    code: ({ children, className, ...props }) => <code {...props} className={className}>{children}</code>,
  }}>{content}</ReactMarkdown>;
});

/**
 * A Plan decision is written to the native request before its durable tool
 * result reaches JSONL. During that short acknowledgement window the Plan
 * state has already moved on from `review`, but the still-owned request card
 * must keep rendering the exact document the user decided on.
 */
export function planReviewDisplayDocument(
  current: PlanDocument | undefined,
  retained: PlanDocument | undefined,
): PlanDocument | undefined {
  return current ?? retained;
}

function PlanInteractionCard({
  request,
  conversation,
  project,
  onAnswer,
}: {
  request: PendingExtensionUiRequest;
  conversation: Conversation;
  project: Project;
  onAnswer: (request: PendingExtensionUiRequest, response: Record<string, unknown>) => Promise<void>;
}) {
  const { language } = useI18n();
  const cardRef = useRef<HTMLElement>(null);
  const decoded = decodePlanUiRequestTitle(request.title);
  const planState = resolvePlanState(conversation.planMode) ?? EMPTY_PLAN_MODE;
  const [selected, setSelected] = useState<string>();
  const [customAnswer, setCustomAnswer] = useState(request.prefill ?? "");
  const [busy, setBusy] = useState(false);
  const [busyDecision, setBusyDecision] = useState<PlanReviewDecision>();
  const [revisionEditorOpen, setRevisionEditorOpen] = useState(false);
  const [revisionFeedback, setRevisionFeedback] = useState("");
  const [retainedPlanDocument, setRetainedPlanDocument] = useState<PlanDocument | undefined>(planState.document);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setSelected(undefined);
    setCustomAnswer(request.prefill ?? "");
    setBusy(false);
    setBusyDecision(undefined);
    setRevisionEditorOpen(false);
    setRevisionFeedback("");
    setError(undefined);
  }, [request.id, request.prefill]);

  useEffect(() => {
    if (planState.document) setRetainedPlanDocument(planState.document);
  }, [planState.document]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const card = cardRef.current;
      if (!card) return;
      card.scrollIntoView({ block: "nearest" });
      const primaryTarget = card.querySelector<HTMLElement>("textarea, button[aria-pressed]");
      (primaryTarget ?? card).focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [request.id, request.title]);

  const openPlanLink = async (href: string) => {
    const target = classifyConversationLink(href);
    if (target.kind === "external") {
      try {
        await openUrl(target.url);
      } catch {
        if (/^https?:/iu.test(target.url)) window.open(target.url, "_blank", "noopener,noreferrer");
      }
    } else if (target.kind === "file") {
      await openConversationPath(project.path, target.path);
    } else if (target.kind === "anchor") {
      document.getElementById(target.id)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  if (!decoded) {
    return (
      <section ref={cardRef} className="plan-interaction is-error" role="alert" tabIndex={-1}>
        <CircleAlert size={18} />
        <div><strong>{bi(language, "Dialogue Plan illisible", "Unreadable Plan dialog")}</strong><p>{bi(language, "Prime Orbit a bloqué une requête interne invalide.", "Prime Orbit blocked an invalid internal request.")}</p></div>
      </section>
    );
  }

  const answer = async (response: Record<string, unknown>, decision?: PlanReviewDecision) => {
    if (busy) return;
    setBusy(true);
    setBusyDecision(decision);
    setError(undefined);
    try {
      await onAnswer(request, response);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
      setBusyDecision(undefined);
    }
  };

  if (decoded.payload.kind === "review") {
    const planId = decoded.payload.planId;
    const document = planReviewDisplayDocument(planState.document, retainedPlanDocument);
    const choices = request.options ?? [];
    const supportsInlineRevision = decoded.payload.revisionResponse === PLAN_INLINE_REVISION_PROTOCOL;
    const canSubmitRevision = revisionFeedback.trim().length > 0;
    const decide = (index: number) => {
      const value = choices[index];
      if (!value) return;
      const decision = (["apply", "keep", "revise"] as const)[index];
      if (!decision) return;
      void answer({ value }, decision);
    };
    const revise = () => {
      if (!supportsInlineRevision) {
        decide(2);
        return;
      }
      setError(undefined);
      setRevisionEditorOpen(true);
    };
    const submitRevision = () => {
      const value = encodePlanInlineRevisionResponse(planId, revisionFeedback);
      if (!value) {
        setError(bi(
          language,
          "Décrivez précisément la modification demandée (4 096 caractères maximum).",
          "Describe the requested change precisely (4,096 characters maximum).",
        ));
        return;
      }
      void answer({ value }, "revise");
    };
    const progress = busyDecision === "revise"
      ? bi(language, "Envoi de la demande de révision…", "Sending the revision request…")
      : busyDecision === "keep"
        ? bi(language, "Enregistrement du plan…", "Saving the plan…")
        : busyDecision === "apply"
          ? bi(language, "Application du plan…", "Applying the plan…")
          : revisionEditorOpen
            ? bi(language, "Décrivez les modifications à apporter au plan.", "Describe the changes to make to the plan.")
            : bi(language, "Le plan est prêt. Vérifiez-le avant de choisir la suite.", "The plan is ready. Review it before choosing what happens next.");
    return (
      <section ref={cardRef} className="plan-interaction plan-review" role="region" aria-label={decoded.payload.title} aria-busy={busy} tabIndex={-1}>
        <header className="plan-interaction-header">
          <span className="plan-interaction-icon" aria-hidden="true"><FileText size={18} /></span>
          <div><strong>{decoded.payload.title}</strong><p aria-live="polite">{progress}</p></div>
          <Badge tone="accent">{bi(language, "Plan", "Plan")}</Badge>
        </header>
        {document ? (
          <div className="assistant-message-body plan-document-preview">
            <ConversationMarkdown content={document.markdown} onOpenLink={openPlanLink} />
          </div>
        ) : (
          <p className="plan-interaction-error" role="alert"><CircleAlert size={14} />{bi(language, "Le document est en cours de synchronisation. Réessayez dans un instant.", "The document is still syncing. Try again in a moment.")}</p>
        )}
        {revisionEditorOpen ? (
          <label className="plan-custom-answer">
            <span>{bi(language, "Modifications demandées", "Requested changes")}</span>
            <textarea
              autoFocus
              value={revisionFeedback}
              maxLength={4_096}
              rows={4}
              disabled={busy}
              onChange={(event) => setRevisionFeedback(event.target.value)}
              placeholder={bi(language, "Expliquez ce qui doit être corrigé ou approfondi…", "Explain what should be corrected or expanded…")}
            />
          </label>
        ) : null}
        <footer className="plan-review-actions">
          <div className="plan-review-copy">
            <ShieldCheck size={15} />
            <span>{bi(language, "Conserver ou Appliquer enregistre atomiquement dans .prime/plans. Aucun code n’a encore été modifié.", "Keep or Apply saves atomically to .prime/plans. No code has been changed yet.")}</span>
          </div>
          <div>
            {revisionEditorOpen ? (
              <>
                <Button variant="ghost" disabled={busy} onClick={() => { setRevisionEditorOpen(false); setError(undefined); }}>{bi(language, "Retour", "Back")}</Button>
                <Button variant="primary" loading={busyDecision === "revise"} disabled={busy || !document || !canSubmitRevision} onClick={submitRevision}>{bi(language, "Envoyer la révision", "Send revision")}</Button>
              </>
            ) : (
              <>
                <Button variant="ghost" loading={busyDecision === "revise"} disabled={busy || !document || !choices[2]} onClick={revise}>{bi(language, "Réviser", "Revise")}</Button>
                <Button variant="secondary" loading={busyDecision === "keep"} disabled={busy || !document || !choices[1]} onClick={() => decide(1)}>{bi(language, "Conserver", "Keep")}</Button>
                <Button variant="primary" loading={busyDecision === "apply"} disabled={busy || !document || !choices[0]} onClick={() => decide(0)}><Play size={14} />{bi(language, "Appliquer le plan", "Apply plan")}</Button>
              </>
            )}
          </div>
        </footer>
        {error ? <p className="plan-interaction-error" role="alert"><CircleAlert size={14} />{error}</p> : null}
      </section>
    );
  }

  if (decoded.payload.kind === "custom") {
    const canSubmit = customAnswer.trim().length > 0;
    return (
      <section ref={cardRef} className="plan-interaction plan-question" role="region" aria-label={decoded.payload.prompt} aria-live="polite" aria-busy={busy} tabIndex={-1}>
        <header className="plan-interaction-header">
          <span className="plan-interaction-icon" aria-hidden="true"><ListTree size={18} /></span>
          <div><strong>{decoded.payload.prompt}</strong><p>{bi(language, "Précisez votre réponse pour que l’agent puisse continuer le plan.", "Add your own answer so the agent can continue the plan.")}</p></div>
          <Badge tone="warning">{bi(language, "Réponse attendue", "Answer needed")}</Badge>
        </header>
        <label className="plan-custom-answer">
          <span>{bi(language, "Votre réponse", "Your answer")}</span>
          <textarea autoFocus value={customAnswer} maxLength={4_096} rows={3} onChange={(event) => setCustomAnswer(event.target.value)} placeholder={bi(language, "Écrivez une réponse précise…", "Write a precise answer…")} />
        </label>
        <footer className="plan-question-footer">
          <small>{bi(language, "Prime Agent reste en attente tant que vous ne répondez pas.", "Prime Agent waits until you answer.")}</small>
          <div>
            <Button variant="ghost" disabled={busy} onClick={() => void answer({ cancelled: true })}>{bi(language, "Annuler", "Cancel")}</Button>
            <Button variant="primary" loading={busy} disabled={!canSubmit} onClick={() => void answer({ value: customAnswer.trim() })}>{bi(language, "Envoyer la réponse", "Send answer")}</Button>
          </div>
        </footer>
        {error ? <p className="plan-interaction-error" role="alert"><CircleAlert size={14} />{error}</p> : null}
      </section>
    );
  }

  const responseOptions = request.options ?? [];
  const richOptions = decoded.payload.options;
  const otherIndex = decoded.payload.allowOther ? responseOptions.length - 1 : -1;
  return (
    <section ref={cardRef} className="plan-interaction plan-question" role="region" aria-label={decoded.payload.prompt} aria-live="polite" aria-busy={busy} tabIndex={-1}>
      <header className="plan-interaction-header">
        <span className="plan-interaction-icon" aria-hidden="true"><ListTree size={18} /></span>
        <div><strong>{decoded.payload.prompt}</strong>{decoded.payload.context ? <p>{decoded.payload.context}</p> : null}</div>
        <Badge tone="warning">{bi(language, "Réponse attendue", "Answer needed")}</Badge>
      </header>
      <div className="plan-choice-list" role="group" aria-label={decoded.payload.prompt}>
        {responseOptions.map((value, index) => {
          const option = index < richOptions.length ? richOptions[index] : undefined;
          const isOther = index === otherIndex && index >= richOptions.length;
          return (
            <button key={`${index}:${value}`} type="button" aria-pressed={selected === value} className={selected === value ? "is-selected" : ""} onClick={() => setSelected(value)}>
              <span className="plan-choice-marker" aria-hidden="true">{selected === value ? <Check size={13} /> : null}</span>
              <span><strong>{isOther ? bi(language, "Autre réponse", "Other answer") : option?.label ?? value}</strong>{isOther ? <small>{bi(language, "Saisir une réponse libre à l’étape suivante", "Enter a custom answer next")}</small> : option?.description ? <small>{option.description}</small> : null}</span>
            </button>
          );
        })}
      </div>
      <footer className="plan-question-footer">
        <small>{bi(language, "Cette question bloque la planification, sans modifier le projet.", "This question pauses planning without changing the project.")}</small>
        <div>
          <Button variant="ghost" disabled={busy} onClick={() => void answer({ cancelled: true })}>{bi(language, "Annuler", "Cancel")}</Button>
          <Button variant="primary" loading={busy} disabled={!selected} onClick={() => selected && void answer({ value: selected })}>{bi(language, "Continuer", "Continue")}</Button>
        </div>
      </footer>
      {error ? <p className="plan-interaction-error" role="alert"><CircleAlert size={14} />{error}</p> : null}
    </section>
  );
}

export function agentMessageRelationshipLabel(
  language: AppLanguage,
  relationship?: AgentMessageRelationship,
) {
  if (relationship === "child") return bi(language, "Message du sous-agent", "Subagent message");
  if (relationship === "parent") return bi(language, "Message de l’agent parent", "Parent agent message");
  if (relationship === "sibling") return bi(language, "Message d’un agent pair", "Peer agent message");
  return bi(language, "Message inter-agent", "Agent message");
}

/** Connecting creates no queue lane by itself. Only a real turn/tool/queue is
 * presented to the composer as active work. */
export function isConversationTurnActive(status: Conversation["status"]): boolean {
  return status === "streaming" || status === "tool" || status === "queued";
}

/** A live, native-owned Plan UUID is the only actionable dialog authority.
 * A persisted handoff is recovery metadata and must never hide a newer native
 * question or review after HMR, reconnect, or a delayed runtime transition. */
export function shouldShowLivePlanRequest(
  request: PendingExtensionUiRequest | undefined,
  _pendingPlanAction: Conversation["pendingPlanAction"],
): request is PendingExtensionUiRequest {
  return Boolean(request);
}

export function shouldShowMissingPlanDialog(input: {
  hasLiveRequest: boolean;
  hasUnresolvedTranscript?: boolean;
  status: Conversation["status"];
  recoverableKind?: "question" | "review";
  phase: "idle" | "planning" | "question" | "review";
  isCompacting?: boolean;
  nativeProbePending?: boolean;
}): boolean {
  const active = !input.isCompacting
    && (input.status === "starting" || isConversationTurnActive(input.status));
  if (input.nativeProbePending) return false;
  // `planning` only describes Orbit's last accepted local transition. Prime
  // Agent may already have persisted the next blocking question/review while
  // the matching native request was lost. The replay probe owns the grace
  // period; afterwards the exact unresolved transcript call is recoverable.
  return !input.hasLiveRequest
    && !input.isCompacting
    && Boolean(input.recoverableKind)
    && (Boolean(input.hasUnresolvedTranscript)
      || (active && (input.phase === "question" || input.phase === "review")));
}

export function unresolvedPlanQuestionCount(conversation: Pick<Conversation, "messages">): number {
  return unresolvedPlanDialogSummary(conversation).questionCount;
}

export function isConversationMaintenanceBlocked(status: Conversation["status"]): boolean {
  return status === "starting" || isConversationTurnActive(status);
}

export function initialAgentMessageNoticeExpanded() {
  return false;
}

const AgentMessageItem = memo(function AgentMessageItem({ message, onOpenLink }: { message: ChatMessage; onOpenLink: (href: string) => Promise<void> }) {
  const { language, locale } = useI18n();
  const [expanded, setExpanded] = useState(initialAgentMessageNoticeExpanded);
  const notice = message.notice?.kind === "agent_message" ? message.notice : undefined;
  const bodyId = `agent-message-body-${message.id.replace(/[^A-Za-z0-9_-]/gu, "-")}`;

  if (!notice) return null;

  return (
    <article className={`agent-message-notice ${expanded ? "is-expanded" : ""}`}>
      <button
        type="button"
        className="agent-message-notice-summary"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="agent-message-notice-icon" aria-hidden="true"><Bot size={15} /></span>
        <span className="agent-message-notice-copy">
          <span className="agent-message-notice-heading">
            <strong>{agentMessageRelationshipLabel(language, notice.relationship)}</strong>
            {notice.participant ? <span className="agent-message-notice-participant">{notice.participant}</span> : null}
          </span>
          <span className="agent-message-notice-preview">{agentMessagePreview(message.content, 180)}</span>
        </span>
        <time dateTime={message.createdAt}>{formatTime(message.createdAt, locale)}</time>
        <ChevronRight className="agent-message-notice-chevron" size={15} aria-hidden="true" />
      </button>
      <div id={bodyId} className="agent-message-notice-body assistant-message-body" hidden={!expanded}>
        {expanded ? <ConversationMarkdown content={message.content} onOpenLink={onOpenLink} /> : null}
      </div>
    </article>
  );
});

const RefinementOutcomeItem = memo(function RefinementOutcomeItem({ message }: { message: ChatMessage }) {
  const { language, locale } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const notice = message.notice?.kind === "refinement_outcome" ? message.notice : undefined;
  if (!notice) return null;
  const bodyId = `refinement-outcome-body-${message.id.replace(/[^A-Za-z0-9_-]/gu, "-")}`;
  const appliedCount = notice.edits.filter((edit) => edit.applied).length;
  const failedCount = notice.edits.length - appliedCount;
  const scopeLabel = notice.scope === "global"
    ? bi(language, "Global", "Global")
    : bi(language, "Session", "Session");
  const heading = notice.rollbackOf
    ? bi(language, "Refinement annulé", "Refinement rolled back")
    : bi(language, "Refinement terminé", "Refinement complete");

  return (
    <article className={`agent-message-notice refinement-outcome-notice ${expanded ? "is-expanded" : ""}`}>
      <button
        type="button"
        className="agent-message-notice-summary"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="agent-message-notice-icon" aria-hidden="true"><WandSparkles size={15} /></span>
        <span className="agent-message-notice-copy">
          <span className="agent-message-notice-heading">
            <strong>{heading}</strong>
            <span className="agent-message-notice-participant">{scopeLabel} · {appliedCount}/{notice.edits.length} {bi(language, "modifications", "edits")}</span>
          </span>
          <span className="agent-message-notice-preview">{notice.summary}</span>
        </span>
        <time dateTime={message.createdAt}>{formatTime(message.createdAt, locale)}</time>
        <ChevronRight className="agent-message-notice-chevron" size={15} aria-hidden="true" />
      </button>
      <div id={bodyId} className="agent-message-notice-body refinement-outcome-body" hidden={!expanded}>
        <p>{notice.summary}</p>
        {failedCount ? <p className="refinement-outcome-warning"><CircleAlert size={13} />{failedCount} {bi(language, "modification(s) non appliquée(s)", "edit(s) not applied")}</p> : null}
        {notice.edits.length ? (
          <ul>
            {notice.edits.map((edit, index) => (
              <li key={`${edit.kind}:${edit.id}:${index}`} className={edit.applied ? "is-applied" : "is-failed"}>
                <span>{edit.applied ? <Check size={13} /> : <CircleAlert size={13} />}</span>
                <div><strong>{edit.title ?? edit.id}</strong><small>{edit.action} · {edit.kind}{edit.error ? ` · ${edit.error}` : ""}</small></div>
              </li>
            ))}
          </ul>
        ) : <small>{bi(language, "Aucune modification du harness.", "No harness edits.")}</small>}
      </div>
    </article>
  );
});

const MessageItem = memo(function MessageItem({ message, onOpenLink, onRetryMessage, onForkMessage, showTools = true, readOnly = false }: { message: ChatMessage; onOpenLink: (href: string) => Promise<void>; onRetryMessage: (assistantMessageId: string) => Promise<void>; onForkMessage: (assistantMessageId: string) => Promise<void>; showTools?: boolean; readOnly?: boolean }) {
  const { language, locale } = useI18n();
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  if (message.notice?.kind === "agent_message") {
    return <AgentMessageItem message={message} onOpenLink={onOpenLink} />;
  }
  if (message.notice?.kind === "refinement_outcome") {
    return <RefinementOutcomeItem message={message} />;
  }
  return (
    <article className={`message message-${message.role}`}>
      <div className="message-avatar" aria-hidden="true">{isUser ? "ZE" : isSystem ? <Info size={14} /> : <span className="mini-orbit"><span /></span>}</div>
      <div className="message-column">
        <header className="message-header"><strong>{isUser ? bi(language, "Vous", "You") : isSystem ? bi(language, "Système", "System") : "Prime Agent"}</strong><time dateTime={message.createdAt}>{formatTime(message.createdAt, locale)}</time>{message.model ? <Badge>{shortModel(message.model)}</Badge> : null}</header>
        <div className={isUser ? "user-message-card" : "assistant-message-body"}>
          {message.attachments?.length ? <AttachmentStrip attachments={message.attachments} /> : null}
          <ConversationMarkdown content={message.content || (message.status === "streaming" ? " " : "")} onOpenLink={onOpenLink} />
          {message.status === "streaming" ? <span className="streaming-cursor" aria-hidden="true" /> : null}
        </div>
        {showTools && message.tools?.length ? <MessageToolSequence tools={message.tools} onOpenLink={onOpenLink} /> : null}
        {message.role === "assistant" && message.status === "complete" && message.content.trim() ? (
          <footer className="message-actions">
            <IconButton label={bi(language, "Copier la réponse", "Copy response")} onClick={() => void navigator.clipboard.writeText(message.content)}><Copy size={14} /></IconButton>
            {!readOnly ? <IconButton label={bi(language, "Réutiliser le texte dans le composeur", "Reuse text in the composer")} onClick={() => void onRetryMessage(message.id)}><RefreshCw size={14} /></IconButton> : null}
            {!readOnly ? <IconButton label={bi(language, "Créer une branche depuis ce tour", "Branch from this turn")} onClick={() => void onForkMessage(message.id)}><GitBranch size={14} /></IconButton> : null}
            <span />
            {message.durationMs ? <small><Clock3 size={12} /> {formatDuration(message.durationMs)}</small> : null}
            {message.usage?.total ? <small>{compactNumber(message.usage.total, locale)} tokens</small> : null}
          </footer>
        ) : null}
      </div>
    </article>
  );
});

interface AssistantTurnProps {
  messages: ChatMessage[];
  onOpenLink: (href: string) => Promise<void>;
  onRetryMessage: (assistantMessageId: string) => Promise<void>;
  onForkMessage: (assistantMessageId: string) => Promise<void>;
  readOnly?: boolean;
}

export function haveSameMessageReferences(previous: readonly ChatMessage[], next: readonly ChatMessage[]) {
  return previous.length === next.length && previous.every((message, index) => message === next[index]);
}

function areAssistantTurnPropsEqual(previous: AssistantTurnProps, next: AssistantTurnProps) {
  return haveSameMessageReferences(previous.messages, next.messages)
    && previous.onOpenLink === next.onOpenLink
    && previous.onRetryMessage === next.onRetryMessage
    && previous.onForkMessage === next.onForkMessage
    && previous.readOnly === next.readOnly;
}

const AssistantTurn = memo(function AssistantTurn({ messages, onOpenLink, onRetryMessage, onForkMessage, readOnly = false }: AssistantTurnProps) {
  const { language, locale } = useI18n();
  const firstMessage = messages[0]!;
  const model = [...messages].reverse().find((message) => message.model)?.model;
  const segments = buildAssistantTurnSegments(messages);
  const actionMessage = [...messages].reverse().find((message) => message.status === "complete" && message.content.trim());
  const isActive = messages.some((message) => message.status === "pending"
    || message.status === "streaming"
    || message.tools?.some((tool) => tool.status === "queued" || tool.status === "running"));
  const copyText = messages.map((message) => message.content.trim()).filter(Boolean).join("\n\n");
  const durationMs = messages.reduce((total, message) => total + (message.durationMs ?? 0), 0);
  const totalTokens = messages.reduce((total, message) => total + (message.usage?.total ?? 0), 0);

  return (
    <article className="message message-assistant message-agent-turn" aria-busy={isActive || undefined}>
      <div className="message-avatar" aria-hidden="true"><span className="mini-orbit"><span /></span></div>
      <div className="message-column">
        <header className="message-header"><strong>Prime Agent</strong><time dateTime={firstMessage.createdAt}>{formatTime(firstMessage.createdAt, locale)}</time>{model ? <Badge>{shortModel(model)}</Badge> : null}</header>
        {isActive ? <span className="visually-hidden" role="status">{bi(language, "Prime Agent poursuit ce tour.", "Prime Agent is continuing this turn.")}</span> : null}
        <div className="assistant-turn-sequence">
          {segments.map((segment) => segment.kind === "content" ? (
            <div className={`assistant-turn-content ${segment.message.status === "error" ? "is-error" : ""}`} key={segment.id}>
              {segment.message.attachments?.length ? <AttachmentStrip attachments={segment.message.attachments} /> : null}
              <div className="assistant-message-body">
                <ConversationMarkdown content={segment.message.content || (segment.message.status === "streaming" ? " " : "")} onOpenLink={onOpenLink} />
                {segment.message.status === "streaming" ? <span className="streaming-cursor" aria-hidden="true" /> : null}
              </div>
              {segment.message.status === "error" ? <p className="assistant-turn-error" role="alert"><CircleAlert size={14} />{bi(language, "Cette partie de la réponse a été interrompue.", "This part of the response was interrupted.")}</p> : null}
            </div>
          ) : <MessageToolSequence key={segment.id} tools={segment.tools} onOpenLink={onOpenLink} />)}
        </div>
        {!isActive && actionMessage ? (
          <footer className="message-actions">
            <IconButton label={bi(language, "Copier la réponse", "Copy response")} onClick={() => void navigator.clipboard.writeText(copyText)}><Copy size={14} /></IconButton>
            {!readOnly ? <IconButton label={bi(language, "Réutiliser le texte dans le composeur", "Reuse text in the composer")} onClick={() => void onRetryMessage(actionMessage.id)}><RefreshCw size={14} /></IconButton> : null}
            {!readOnly ? <IconButton label={bi(language, "Créer une branche depuis ce tour", "Branch from this turn")} onClick={() => void onForkMessage(actionMessage.id)}><GitBranch size={14} /></IconButton> : null}
            <span />
            {durationMs > 0 ? <small><Clock3 size={12} /> {formatDuration(durationMs)}</small> : null}
            {totalTokens > 0 ? <small>{compactNumber(totalTokens, locale)} tokens</small> : null}
          </footer>
        ) : null}
      </div>
    </article>
  );
}, areAssistantTurnPropsEqual);

export type TranscriptEntry =
  | { kind: "message"; message: ChatMessage }
  | { kind: "assistant-turn"; id: string; messages: ChatMessage[] };

/**
 * Prime Agent may emit several assistant messages while completing one user
 * turn. Preserve their source order but expose them as one visual transcript
 * entry until a user or system message creates an explicit boundary.
 */
export function buildTranscriptEntries(messages: ChatMessage[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (let index = 0; index < messages.length;) {
    const message = messages[index]!;
    if (message.role !== "assistant") {
      entries.push({ kind: "message", message });
      index += 1;
      continue;
    }

    const turnMessages: ChatMessage[] = [];
    let cursor = index;
    while (cursor < messages.length && messages[cursor]!.role === "assistant") {
      turnMessages.push(messages[cursor]!);
      cursor += 1;
    }

    entries.push({ kind: "assistant-turn", id: `assistant-turn:${turnMessages[0]!.id}`, messages: turnMessages });
    index = cursor;
  }
  return entries;
}

type AssistantTurnSegment =
  | { kind: "content"; id: string; message: ChatMessage }
  | { kind: "tools"; id: string; tools: ToolActivity[] };

export function buildAssistantTurnSegments(messages: ChatMessage[]): AssistantTurnSegment[] {
  const segments: AssistantTurnSegment[] = [];
  for (const message of messages) {
    if (message.content.trim() || (message.attachments?.length ?? 0) > 0 || message.status === "streaming") {
      segments.push({ kind: "content", id: `content:${message.id}`, message });
    }
    if (!message.tools?.length) continue;

    const tools = mergeToolCalls(message.tools);
    const previous = segments.at(-1);
    if (tools.every(isPythonTool) && previous?.kind === "tools" && previous.tools.every(isPythonTool)) {
      previous.tools = mergeToolCalls([...previous.tools, ...tools]);
      continue;
    }
    segments.push({ kind: "tools", id: `tools:${message.id}`, tools });
  }
  return segments;
}

export type ToolSequenceSegment =
  | { kind: "tool"; tool: ToolActivity }
  | { kind: "python"; tools: ToolActivity[] };

export function buildToolSequenceSegments(tools: ToolActivity[]): ToolSequenceSegment[] {
  const segments: ToolSequenceSegment[] = [];
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
    segments.push({ kind: "python", tools: pythonTools });
  }
  return segments;
}

function haveSameToolReferences(previous: readonly ToolActivity[], next: readonly ToolActivity[]) {
  return previous.length === next.length && previous.every((tool, index) => tool === next[index]);
}

const MessageToolSequence = memo(function MessageToolSequence({ tools, onOpenLink }: { tools: ToolActivity[]; onOpenLink: (href: string) => Promise<void> }) {
  const segments = buildToolSequenceSegments(tools);
  return <div className="message-tools">{segments.map((segment) => segment.kind === "tool"
    ? <ToolCard key={segment.tool.id} tool={segment.tool} onOpenLink={onOpenLink} />
    : <PythonExecutionGroup key={`python:${segment.tools[0]!.id}`} tools={segment.tools} onOpenLink={onOpenLink} />)}</div>;
}, (previous, next) => haveSameToolReferences(previous.tools, next.tools) && previous.onOpenLink === next.onOpenLink);

const AttachmentStrip = memo(function AttachmentStrip({ attachments }: { attachments: Attachment[] }) {
  const { language, locale } = useI18n();
  return (
    <div className="message-attachments">
      {attachments.map((attachment) => (
        attachment.isImage && attachment.previewDataUrl
          ? <figure key={attachment.id}><img src={attachment.previewDataUrl} alt={attachment.name} /><figcaption>{attachment.name} · {formatBytes(attachment.size, language, locale)}</figcaption></figure>
          : <div key={attachment.id} className="file-attachment"><AttachmentGlyph attachment={attachment} size={17} /><span><strong>{attachment.name}</strong><small>{attachmentMetaLabel(attachment, language, locale)}</small></span></div>
      ))}
    </div>
  );
});

function attachmentExtension(attachment: Pick<Attachment, "name" | "mimeType" | "isImage">) {
  const extension = attachment.name.match(/\.([a-z0-9]{1,10})$/i)?.[1];
  if (extension) return extension.toUpperCase();
  if (attachment.isImage) return "IMAGE";
  const subtype = attachment.mimeType.split("/", 2)[1]?.split(/[;+]/, 1)[0];
  return subtype && subtype.length <= 12 ? subtype.toUpperCase() : "FILE";
}

function attachmentVisualKind(attachment: Pick<Attachment, "name" | "mimeType" | "isImage">) {
  if (attachment.isImage) return "image";
  const extension = attachmentExtension(attachment).toLowerCase();
  const mimeType = attachment.mimeType.toLowerCase();
  if (["zip", "7z", "rar", "tar", "gz", "bz2", "xz"].includes(extension)) return "archive";
  if (/^(?:text\/|application\/(?:json|javascript|typescript|xml|toml|yaml))/.test(mimeType)
    || ["js", "jsx", "ts", "tsx", "py", "rs", "go", "java", "c", "cpp", "h", "cs", "vue", "svelte", "json", "toml", "yaml", "yml", "xml", "html", "css", "md"].includes(extension)) return "code";
  if (["pdf", "doc", "docx", "odt", "rtf", "txt"].includes(extension)) return "document";
  return "file";
}

function AttachmentGlyph({ attachment, size }: { attachment: Attachment; size: number }) {
  const kind = attachmentVisualKind(attachment);
  if (kind === "image") return <Image size={size} />;
  if (kind === "archive") return <FileArchive size={size} />;
  if (kind === "code") return <FileCode2 size={size} />;
  if (kind === "document") return <FileText size={size} />;
  return <File size={size} />;
}

function attachmentMetaLabel(attachment: Attachment, language: AppLanguage, locale: string) {
  return `${attachmentExtension(attachment)} · ${formatBytes(attachment.size, language, locale)}`;
}

export function initialPythonExecutionGroupExpanded() {
  return false;
}

function PythonExecutionGroup({ tools, onOpenLink }: { tools: ToolActivity[]; onOpenLink: (href: string) => Promise<void> }) {
  const { language } = useI18n();
  const executions = mergeToolCalls(tools);
  const summary = summarizePythonTools(executions);
  // Python output can grow very quickly. Keep the group quiet from its first
  // running event instead of opening live and collapsing only after completion.
  const [open, setOpen] = useState(initialPythonExecutionGroupExpanded);
  const previousFailures = useRef(summary.failed);
  useEffect(() => {
    if (summary.failed > previousFailures.current) setOpen(true);
    previousFailures.current = summary.failed;
  }, [summary.failed]);

  const status = summary.running > 0 ? "running" : summary.failed > 0 ? "failed" : summary.cancelled > 0 ? "cancelled" : summary.unresolved > 0 ? "unresolved" : "completed";
  const details = [
    summary.running ? `${summary.running} ${bi(language, "en cours", "running")}` : "",
    summary.completed ? `${summary.completed} ${bi(language, "terminée", "complete")}${summary.completed > 1 && language === "fr" ? "s" : ""}` : "",
    summary.failed ? `${summary.failed} ${summary.failed > 1 ? bi(language, "échecs", "failed") : bi(language, "échec", "failed")}` : "",
    summary.cancelled ? `${summary.cancelled} ${bi(language, "annulée", "cancelled")}${summary.cancelled > 1 && language === "fr" ? "s" : ""}` : "",
    summary.unresolved ? `${summary.unresolved} ${bi(language, "sans résultat", "awaiting result")}` : "",
  ].filter(Boolean).join(" · ");

  return (
    <section className={`python-execution-group is-${status}`}>
      <button type="button" className="python-group-summary" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="python-group-icon">{summary.running ? <LoaderCircle size={15} className="spin" /> : summary.failed ? <X size={15} /> : <Terminal size={15} />}</span>
        <span><strong>{bi(language, "Exécutions Python", "Python executions")} <em>{executions.length}</em></strong><small>{details}</small></span>
        <ChevronDown size={15} className={open ? "is-open" : ""} />
      </button>
      {open ? <div className="python-execution-list">{executions.map((tool, index) => (
        <ToolCard key={tool.id} tool={{ ...tool, title: `${bi(language, "Python", "Python")} #${index + 1}` }} compactByDefault onOpenLink={onOpenLink} />
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
    else if (tool.status === "unresolved") summary.unresolved += 1;
    else summary.completed += 1;
    return summary;
  }, { running: 0, completed: 0, failed: 0, cancelled: 0, unresolved: 0 });
}

export function initialToolCardExpanded(tool: Pick<ToolActivity, "status">, compactByDefault = false) {
  return !compactByDefault && tool.status === "running";
}

function ToolCard({ tool, compactByDefault = false, onOpenLink }: { tool: ToolActivity; compactByDefault?: boolean; onOpenLink: (href: string) => Promise<void> }) {
  const { language } = useI18n();
  const planInput = tool.name === "prime_orbit_plan_submit" && tool.input && typeof tool.input === "object"
    ? tool.input as Record<string, unknown>
    : undefined;
  const planDocument = planInput
    ? normalizePlanDocument({ name: planInput.title, markdown: planInput.document })
    : undefined;
  const [open, setOpen] = useState(() => Boolean(planDocument) || initialToolCardExpanded(tool, compactByDefault));
  const previousStatus = useRef(tool.status);
  useEffect(() => {
    if (planDocument) setOpen(true);
    else if (previousStatus.current === "running" && tool.status !== "running") setOpen(false);
    previousStatus.current = tool.status;
  }, [planDocument?.markdown, tool.status]);
  const statusIcon = tool.status === "running"
    ? <LoaderCircle size={15} className="spin" />
    : tool.status === "queued"
      ? <Clock3 size={15} />
      : tool.status === "failed"
        ? <X size={15} />
        : tool.status === "cancelled"
          ? <CircleStop size={15} />
          : tool.status === "unresolved" ? <Clock3 size={15} /> : <Check size={15} />;
  const statusText = tool.status === "running"
    ? bi(language, "En cours", "Running")
    : tool.status === "queued"
      ? bi(language, "En attente", "Queued")
      : tool.status === "failed"
        ? bi(language, "Échec", "Failed")
        : tool.status === "cancelled"
          ? bi(language, "Annulé", "Cancelled")
          : tool.status === "unresolved" ? bi(language, "Résultat en attente", "Awaiting result") : bi(language, "Terminé", "Complete");
  return (
    <section className={`tool-card tool-${tool.status}`}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="tool-icon">{statusIcon}</span>
        <span><strong>{tool.title}</strong><small>{statusText}</small></span>
        <ChevronDown size={15} className={open ? "is-open" : ""} />
      </button>
      {open ? planDocument ? (
        <div className="plan-tool-document">
          <header><FileText size={14} /><span><strong>{planDocument.name}</strong><small>.prime/plans · Markdown</small></span></header>
          <div className="assistant-message-body"><ConversationMarkdown content={planDocument.markdown} onOpenLink={onOpenLink} /></div>
          {tool.output !== undefined ? <details><summary>{bi(language, "Décision et sortie de l’outil", "Decision and tool output")}</summary><pre>{pretty(tool.output, language)}</pre></details> : null}
        </div>
      ) : <div className="tool-details">{tool.input !== undefined ? <div><label>{bi(language, "Entrée", "Input")}</label><pre>{pretty(tool.input, language)}</pre></div> : null}{tool.output !== undefined ? <div><label>{bi(language, "Sortie", "Output")}</label><pre>{pretty(tool.output, language)}</pre></div> : null}</div> : null}
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

function CompactionStatusBar() {
  const { language } = useI18n();
  return (
    <div className="compaction-status-bar" role="status" aria-live="polite">
      <span className="compaction-status-icon" aria-hidden="true"><LoaderCircle size={16} className="spin" /></span>
      <div>
        <strong>{bi(language, "Compactage du contexte en cours…", "Compacting context…")}</strong>
        <small>{bi(language, "La session reste active. Les nouveaux messages seront ajoutés à la file.", "The session stays active. New messages will be added to the queue.")}</small>
      </div>
    </div>
  );
}

function RefinementStatusBar() {
  const { language } = useI18n();
  return (
    <div className="refinement-status-bar" role="status" aria-live="polite">
      <span className="refinement-status-icon" aria-hidden="true"><WandSparkles size={16} /></span>
      <div>
        <strong>{bi(language, "Raffinement en cours…", "Refinement in progress…")}</strong>
        <small>{bi(language, "Prime Agent consolide les apprentissages de cette session. La navigation reste disponible.", "Prime Agent is consolidating what this session learned. Navigation remains available.")}</small>
      </div>
      <LoaderCircle size={15} className="spin" aria-hidden="true" />
    </div>
  );
}

/** Attachment handles are ephemeral native capabilities, so they are kept in
 * this renderer window only. This preserves an unsent composer when navigating
 * between conversations without ever serializing the handles to app state. */
const conversationAttachmentDrafts = new Map<string, Attachment[]>();
const discardedConversationAttachmentDrafts = new Set<string>();

export function getConversationAttachmentDraft(conversationId: string): Attachment[] {
  return [...(conversationAttachmentDrafts.get(conversationId) ?? [])];
}

export function rememberConversationAttachmentDraft(conversationId: string, attachments: Attachment[]) {
  if (discardedConversationAttachmentDrafts.has(conversationId)) {
    conversationAttachmentDrafts.delete(conversationId);
    const handles = attachmentHandles(attachments);
    if (handles.length) void releaseAttachmentHandles(handles).catch(() => undefined);
    return;
  }
  if (attachments.length) conversationAttachmentDrafts.set(conversationId, [...attachments]);
  else conversationAttachmentDrafts.delete(conversationId);
}

function activateConversationAttachmentDraft(conversationId: string): Attachment[] {
  discardedConversationAttachmentDrafts.delete(conversationId);
  return getConversationAttachmentDraft(conversationId);
}

export async function releaseConversationAttachmentDrafts(conversationIds: string | string[]) {
  const ids = Array.isArray(conversationIds) ? conversationIds : [conversationIds];
  const handles = new Set<string>();
  ids.forEach((conversationId) => {
    discardedConversationAttachmentDrafts.add(conversationId);
    const cached = conversationAttachmentDrafts.get(conversationId) ?? [];
    attachmentHandles(cached).forEach((handle) => handles.add(handle));
    conversationAttachmentDrafts.delete(conversationId);
  });
  if (handles.size) await releaseAttachmentHandles([...handles]);
}

export async function releaseAllConversationAttachmentDrafts() {
  await releaseConversationAttachmentDrafts([...conversationAttachmentDrafts.keys()]);
}

export type ContextUsageStatus = "available" | "warning" | "critical" | "compacting" | "unavailable";

export interface ContextUsageSnapshot {
  usedTokens: number | null;
  contextWindow: number | null;
  availableTokens: number | null;
  percent: number | null;
  ringPercent: number;
  status: ContextUsageStatus;
  autoCompactionEnabled?: boolean;
}

function finiteMetric(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Keep context display derived exclusively from metrics reported by Prime
 * Agent. Missing counters stay unavailable instead of being replaced by a
 * convincing-looking estimate.
 */
export function buildContextUsageSnapshot(
  stats?: SessionStats,
  sessionState?: AgentSessionState,
  runtimeCompacting = false,
): ContextUsageSnapshot {
  const rawTokens = finiteMetric(stats?.contextUsage?.tokens);
  const rawWindow = finiteMetric(stats?.contextUsage?.contextWindow);
  const usedTokens = rawTokens === null ? null : Math.max(0, rawTokens);
  const contextWindow = rawWindow === null || rawWindow <= 0 ? null : rawWindow;
  const reportedPercent = finiteMetric(stats?.contextUsage?.percent);
  const percent = reportedPercent === null
    ? usedTokens !== null && contextWindow !== null
      ? (usedTokens / contextWindow) * 100
      : null
    : Math.max(0, reportedPercent);
  const availableTokens = usedTokens === null || contextWindow === null
    ? null
    : Math.max(0, contextWindow - usedTokens);
  const compacting = runtimeCompacting || Boolean(sessionState?.isCompacting);
  const status: ContextUsageStatus = compacting
    ? "compacting"
    : percent === null
      ? "unavailable"
      : percent >= 85
        ? "critical"
        : percent >= 65
          ? "warning"
          : "available";
  return {
    usedTokens,
    contextWindow,
    availableTokens,
    percent,
    ringPercent: Math.min(100, Math.max(0, percent ?? 0)),
    status,
    autoCompactionEnabled: sessionState?.autoCompactionEnabled,
  };
}

function Composer({ project, conversation, models, favoriteModels, commands, stats, sessionState, resourceReloadSupported, isRunning, isCompacting, isRefining, onDraftChange, onSend, onAbort, onModel, onToggleFavoriteModel, onThinking, onRunCommand, onPlanMode, openPopover, onTogglePopover, onClosePopover }: {
  project: Project;
  conversation: Conversation;
  models: ModelInfo[];
  favoriteModels: string[];
  commands: SlashCommand[];
  stats?: SessionStats;
  sessionState?: AgentSessionState;
  resourceReloadSupported: boolean;
  isRunning: boolean;
  isCompacting: boolean;
  isRefining: boolean;
  onDraftChange: (draft: string) => void;
  onSend: (message: string, attachments: Attachment[], delivery?: "steer" | "follow_up") => Promise<void>;
  onAbort: () => Promise<void>;
  onModel: (model: ModelInfo) => Promise<void>;
  onToggleFavoriteModel: (ref: string) => void;
  onThinking: (level: ThinkingLevel) => Promise<void>;
  onRunCommand: (type: string, fields?: Record<string, unknown>) => Promise<void>;
  onPlanMode: (mode: "normal" | "plan") => Promise<void>;
  openPopover: ConversationPopover;
  onTogglePopover: (popover: Exclude<ConversationPopover, null>) => void;
  onClosePopover: () => void;
}) {
  const { language, locale } = useI18n();
  const [draft, setDraft] = useState(conversation.draft);
  const draftRef = useRef(conversation.draft);
  const reportedDraftRef = useRef(conversation.draft);
  const draftChangeRef = useRef(onDraftChange);
  const conversationIdRef = useRef(conversation.id);
  const pendingDraftReports = useRef(new Map<string, { timer: number; report: (value: string) => void; value: string }>());
  const [attachments, setAttachments] = useState<Attachment[]>(() => (
    activateConversationAttachmentDraft(conversation.id)
  ));
  const attachmentsRef = useRef<Attachment[]>(attachments);
  const submittingRef = useRef(false);
  const [adding, setAdding] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepthRef = useRef(0);
  const dropAdmissionBusyRef = useRef(false);
  const dropAdmissionGenerationRef = useRef(0);
  const [attachmentError, setAttachmentError] = useState<string>();
  const [slashSelection, setSlashSelection] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const [commandError, setCommandError] = useState<string>();
  const [toolActionBusy, setToolActionBusy] = useState<"compact" | "refine">();
  const [planModeBusy, setPlanModeBusy] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const slashList = useRef<HTMLDivElement>(null);
  const activeModel = models.find((model) => `${model.provider}/${model.id}` === conversation.model);
  const isBusy = isRunning || isCompacting;
  const isConnecting = conversation.status === "starting";
  const planModeState = resolvePlanState(conversation.planMode) ?? EMPTY_PLAN_MODE;
  const isPlanMode = planModeState.phase !== "idle";
  const goalBlocksPlan = !isPlanMode && sessionState?.goal?.status === "active";
  const waitingForSessionState = !isPlanMode && Boolean(conversation.sessionPath) && !sessionState;
  const planModeDisabledReason = waitingForSessionState
    ? bi(language, "Attendez la synchronisation de la session avant d’activer le mode Plan.", "Wait for the session to sync before enabling Plan mode.")
    : goalBlocksPlan
      ? bi(language, "Mettez l’objectif persistant en pause avant d’activer le mode Plan.", "Pause the persistent goal before enabling Plan mode.")
      : isBusy || isConnecting
      ? bi(language, "Attendez la fin du travail en cours avant de changer de mode.", "Wait for current work to finish before changing mode.")
      : undefined;
  const compactDisabledReason = isCompacting
    ? bi(language, "Un compactage du contexte est déjà en cours.", "Context compaction is already in progress.")
    : isConnecting
      ? bi(language, "Attendez que la conversation soit prête avant de compacter le contexte.", "Wait until the conversation is ready before compacting context.")
    : isRunning
      ? bi(language, "Attendez la fin du tour actif avant de compacter le contexte.", "Wait for the active run to finish before compacting context.")
      : undefined;
  const refineDisabledReason = isRefining
    ? bi(language, "Un raffinement est déjà en cours.", "Refinement is already in progress.")
    : isCompacting
      ? bi(language, "Attendez la fin du compactage avant de raffiner.", "Wait for compaction to finish before refining.")
      : isConnecting
        ? bi(language, "Attendez que la conversation soit prête avant de raffiner.", "Wait until the conversation is ready before refining.")
        : isRunning
          ? bi(language, "Attendez la fin du tour actif avant de raffiner.", "Wait for the active run to finish before refining.")
          : undefined;
  const slashCommands = useMemo(() => (
    buildComposerSlashCommands(commands, language, resourceReloadSupported).map((command) => (
      command.name === "compact" && compactDisabledReason
        ? { ...command, disabledReason: compactDisabledReason }
        : command.name === "refine" && refineDisabledReason
          ? { ...command, disabledReason: refineDisabledReason }
          : command
    ))
  ), [commands, compactDisabledReason, language, refineDisabledReason, resourceReloadSupported]);
  const activeSlashCommand = parseActiveComposerSlashCommand(draft, slashCommands);
  const editorValue = activeSlashCommand?.argument ?? draft;
  const slashQuery = !activeSlashCommand && editorValue.startsWith("/") && !/\s/.test(editorValue)
    ? editorValue.slice(1)
    : undefined;
  const filteredSlashCommands = useMemo(() => slashQuery === undefined
    ? []
    : filterComposerSlashCommands(slashCommands, slashQuery), [slashCommands, slashQuery]);
  const slashPaletteOpen = composerFocused && !slashDismissed && filteredSlashCommands.length > 0;
  const hasDraftContent = !slashDismissed && slashQuery !== undefined && filteredSlashCommands.length > 0
    ? false
    : activeSlashCommand?.command.requiresArgument
      ? activeSlashCommand.argument.trim().length > 0
      : draft.trim().length > 0;
  const hasComposerContent = activeSlashCommand?.command.requiresArgument
    ? hasDraftContent
    : hasDraftContent || attachments.length > 0;

  const cancelDraftReport = useCallback((conversationId: string) => {
    const pending = pendingDraftReports.current.get(conversationId);
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pendingDraftReports.current.delete(conversationId);
  }, []);
  const reportDraftNow = useCallback((value: string) => {
    const conversationId = conversationIdRef.current;
    cancelDraftReport(conversationId);
    reportedDraftRef.current = value;
    draftChangeRef.current(value);
  }, [cancelDraftReport]);
  const scheduleDraftReport = useCallback((value: string) => {
    const conversationId = conversationIdRef.current;
    cancelDraftReport(conversationId);
    // Capture the conversation-scoped callback. Even if the parent swaps its
    // selection before the timeout fires, draft A can never be written to B.
    const report = draftChangeRef.current;
    const pending = { timer: 0, report, value };
    pending.timer = scheduleComposerDraftReport((scheduledValue) => {
      if (pendingDraftReports.current.get(conversationId) === pending) {
        pendingDraftReports.current.delete(conversationId);
      }
      if (conversationIdRef.current === conversationId) reportedDraftRef.current = scheduledValue;
      report(scheduledValue);
    }, value, (callback, delay) => window.setTimeout(callback, delay));
    pendingDraftReports.current.set(conversationId, pending);
  }, [cancelDraftReport]);

  useEffect(() => { draftChangeRef.current = onDraftChange; }, [onDraftChange]);
  useEffect(() => {
    const previousConversationId = conversationIdRef.current;
    const nextDraft = resolveComposerDraftAfterSelection(
      previousConversationId,
      conversation.id,
      draftRef.current,
      reportedDraftRef.current,
      conversation.draft,
    );
    conversationIdRef.current = conversation.id;
    if (previousConversationId === conversation.id && nextDraft === draftRef.current) return;
    if (previousConversationId === conversation.id) cancelDraftReport(conversation.id);
    else {
      setSlashDismissed(false);
      setCommandError(undefined);
    }
    reportedDraftRef.current = conversation.draft;
    setDraft(nextDraft);
    draftRef.current = nextDraft;
  }, [cancelDraftReport, conversation.draft, conversation.id]);
  useEffect(() => {
    dropAdmissionGenerationRef.current += 1;
    dropAdmissionBusyRef.current = false;
    dragDepthRef.current = 0;
    setAdding(false);
    setDragging(false);
    setAttachmentError(undefined);
    return () => {
      rememberConversationAttachmentDraft(conversation.id, attachmentsRef.current);
      // Invalidate every raw attachment admission still awaiting native
      // validation. Its eventual handle is released by the guarded drop flow.
      dropAdmissionGenerationRef.current += 1;
      dropAdmissionBusyRef.current = false;
    };
  }, [conversation.id]);
  useEffect(() => {
    rememberConversationAttachmentDraft(conversation.id, attachments);
  }, [attachments, conversation.id]);
  useEffect(() => () => {
    for (const [conversationId, pending] of pendingDraftReports.current) {
      window.clearTimeout(pending.timer);
      pending.report(pending.value);
      if (conversationId === conversationIdRef.current) reportedDraftRef.current = pending.value;
    }
    pendingDraftReports.current.clear();
    if (draftRef.current !== reportedDraftRef.current) {
      reportedDraftRef.current = draftRef.current;
      draftChangeRef.current(draftRef.current);
    }
  }, []);
  useEffect(() => {
    const node = textarea.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 210)}px`;
  }, [editorValue]);
  useEffect(() => {
    setSlashSelection(0);
  }, [slashQuery, filteredSlashCommands.length]);
  useEffect(() => {
    if (!slashPaletteOpen) return;
    slashList.current?.querySelector<HTMLElement>(".is-selected")?.scrollIntoView({ block: "nearest" });
  }, [slashPaletteOpen, slashSelection]);

  const updateDraft = (value: string) => {
    setDraft(value);
    draftRef.current = value;
    setSlashDismissed(false);
    setCommandError(undefined);
    scheduleDraftReport(value);
  };

  const updateEditorValue = (value: string) => {
    updateDraft(activeSlashCommand ? `/${activeSlashCommand.command.name} ${value}` : value);
  };

  const clearActiveSlashCommand = () => {
    if (!activeSlashCommand) return;
    updateDraft(activeSlashCommand.argument);
    requestAnimationFrame(() => textarea.current?.focus());
  };

  const changePlanMode = async (mode: "normal" | "plan"): Promise<boolean> => {
    if ((mode === "plan") === isPlanMode) return true;
    if (planModeBusy || planModeDisabledReason) {
      if (planModeDisabledReason) setCommandError(planModeDisabledReason);
      return false;
    }
    if (mode === "plan" && attachmentsRef.current.length > 0) {
      setCommandError(bi(language, "Retirez les pièces jointes avant d’activer le mode Plan.", "Remove attachments before enabling Plan mode."));
      return false;
    }
    setPlanModeBusy(true);
    setCommandError(undefined);
    try {
      await onPlanMode(mode);
      return true;
    } catch (error) {
      setCommandError(planModeTransitionError(error, language));
      return false;
    } finally {
      setPlanModeBusy(false);
    }
  };

  const runToolAction = async (action: "compact" | "refine") => {
    if (toolActionBusy || (action === "refine" && isRefining)) return;
    setToolActionBusy(action);
    setCommandError(undefined);
    onClosePopover();
    try {
      await onRunCommand(action);
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error));
    } finally {
      setToolActionBusy(undefined);
    }
  };

  const chooseSlashCommand = async (command: ComposerSlashCommand) => {
    setSlashDismissed(true);
    setCommandError(undefined);
    if (command.disabledReason) {
      setCommandError(command.disabledReason);
      return;
    }
    if (command.behavior === "action" && command.action) {
      updateDraft("");
      reportDraftNow("");
      try {
        await onRunCommand(command.action);
      } catch (error) {
        setCommandError(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    updateDraft(`/${command.name} `);
    requestAnimationFrame(() => textarea.current?.focus());
  };

  const submit = async (delivery?: "steer" | "follow_up") => {
    if (activeSlashCommand?.command.disabledReason) {
      setCommandError(activeSlashCommand.command.disabledReason);
      return;
    }
    const actionSubmission = resolveComposerActionSubmission(draft, slashCommands);
    if (actionSubmission) {
      if (submittingRef.current) return;
      if (actionSubmission.error) {
        setCommandError(actionSubmission.error);
        return;
      }
      submittingRef.current = true;
      setCommandError(undefined);
      try {
        await onRunCommand(actionSubmission.command.action!);
        updateDraft("");
        reportDraftNow("");
      } catch (error) {
        setCommandError(error instanceof Error ? error.message : String(error));
      } finally {
        submittingRef.current = false;
      }
      return;
    }
    let outgoingDraft = draft;
    if (activeSlashCommand?.command.name === "plan") {
      if (!await changePlanMode("plan")) return;
      outgoingDraft = activeSlashCommand.argument.trim();
      if (!outgoingDraft) {
        updateDraft("");
        reportDraftNow("");
        return;
      }
    }
    if ((!outgoingDraft.trim() && attachments.length === 0) || adding || submittingRef.current) return;
    submittingRef.current = true;
    const submittedConversationId = conversationIdRef.current;
    const submittedGeneration = dropAdmissionGenerationRef.current;
    const sentDraft = outgoingDraft;
    const sentAttachments = attachments;
    setDraft("");
    draftRef.current = "";
    setAttachments([]);
    attachmentsRef.current = [];
    rememberConversationAttachmentDraft(submittedConversationId, []);
    setAttachmentError(undefined);
    reportDraftNow("");
    try {
      await onSend(sentDraft, sentAttachments, delivery);
    } catch (error) {
      if (!shouldRestoreAttachmentSubmission(
        submittedConversationId,
        submittedGeneration,
        conversationIdRef.current,
        dropAdmissionGenerationRef.current,
      )) {
        await releaseAttachmentHandles(attachmentHandles(sentAttachments)).catch(() => undefined);
        return;
      }
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
      rememberConversationAttachmentDraft(submittedConversationId, restored.attachments);
      setAttachmentError(
        restored.issue
          ? attachmentIssueLabel(restored.issue, language)
          : attachmentSubmitError(error, language),
      );
      reportDraftNow(restoredDraft);
    } finally {
      submittingRef.current = false;
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashPaletteOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashSelection((current) => moveSlashCommandSelection(current, filteredSlashCommands.length, 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashSelection((current) => moveSlashCommandSelection(current, filteredSlashCommands.length, -1));
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const command = filteredSlashCommands[slashSelection] ?? filteredSlashCommands[0];
        if (command) void chooseSlashCommand(command);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashDismissed(true);
        return;
      }
    }
    if (event.key === "Backspace" && activeSlashCommand && !editorValue && event.currentTarget.selectionStart === 0) {
      event.preventDefault();
      clearActiveSlashCommand();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      if (!event.ctrlKey && !event.metaKey && !event.altKey) {
        const edit = continueComposerMarkdownList(
          editorValue,
          event.currentTarget.selectionStart,
          event.currentTarget.selectionEnd,
        );
        if (edit) {
          event.preventDefault();
          updateEditorValue(edit.value);
          requestAnimationFrame(() => textarea.current?.setSelectionRange(edit.selectionStart, edit.selectionEnd));
          return;
        }
      }
      event.preventDefault();
      void submit(nativeComposerDelivery(isRunning, isCompacting, event.altKey));
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
    rememberConversationAttachmentDraft(conversation.id, result.attachments);
    setAttachments(result.attachments);
    setAttachmentError(result.issue ? attachmentIssueLabel(result.issue, language) : undefined);
  };

  const addFiles = async () => {
    if (dropAdmissionBusyRef.current) return;
    const admissionGeneration = dropAdmissionGenerationRef.current;
    const admissionIsCurrent = () => dropAdmissionGenerationRef.current === admissionGeneration;
    dropAdmissionBusyRef.current = true;
    setAdding(true);
    setAttachmentError(undefined);
    try {
      const current = attachmentsRef.current;
      const remainingCount = Math.max(0, MAX_ATTACHMENT_COUNT - current.length);
      const currentAttachmentBytes = totalAttachmentBytes(current);
      const currentImageBytes = totalImageAttachmentBytes(current);
      if (remainingCount === 0) {
        setAttachmentError(attachmentIssueLabel("count", language));
        return;
      }
      const results = await pickAttachments(
        remainingCount,
        Math.max(0, MAX_TOTAL_ATTACHMENT_BYTES - currentAttachmentBytes),
        Math.max(0, MAX_TOTAL_IMAGE_BYTES - currentImageBytes),
      );
      const admitted = results.map((result) => ({
        id: crypto.randomUUID(),
        name: result.name,
        mimeType: result.mimeType,
        size: result.size,
        attachmentHandle: result.attachmentHandle,
        previewDataUrl: result.previewDataUrl,
        isImage: result.isImage,
      }));
      if (!admissionIsCurrent()) {
        await releaseAttachmentHandles(attachmentHandles(admitted)).catch(() => undefined);
        return;
      }
      acceptAttachments(admitted);
    } catch (error) {
      if (admissionIsCurrent()) setAttachmentError(attachmentDropError(error, language));
    } finally {
      if (admissionIsCurrent()) {
        dropAdmissionBusyRef.current = false;
        setAdding(false);
      }
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (!files.length) return;
    event.preventDefault();
    void admitFiles(files);
  };

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragging(true);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (dragDepthRef.current === 0) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragging(false);
  };

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragging(false);
    const files = Array.from(event.dataTransfer.files);
    await admitFiles(files);
  };

  const admitFiles = async (files: File[]) => {
    if (!files.length || adding || dropAdmissionBusyRef.current) return;
    const current = attachmentsRef.current;
    if (current.length + files.length > MAX_ATTACHMENT_COUNT) {
      setAttachmentError(attachmentIssueLabel("count", language));
      return;
    }
    if (files.some((file) => isSupportedDroppedImage(file)
      ? file.size > MAX_IMAGE_ATTACHMENT_BYTES
      : file.size > MAX_DOCUMENT_ATTACHMENT_BYTES)) {
      const oversizedImage = files.some((file) => isSupportedDroppedImage(file) && file.size > MAX_IMAGE_ATTACHMENT_BYTES);
      setAttachmentError(attachmentIssueLabel(oversizedImage ? "image-size" : "document-size", language));
      return;
    }
    const currentAttachmentBytes = totalAttachmentBytes(current);
    const currentImageBytes = totalImageAttachmentBytes(current);
    const droppedAttachmentBytes = files.reduce((total, file) => total + file.size, 0);
    if (currentAttachmentBytes + droppedAttachmentBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      setAttachmentError(attachmentIssueLabel("attachment-total", language));
      return;
    }
    const droppedImageBytes = files.reduce(
      (total, file) => total + (isSupportedDroppedImage(file) ? file.size : 0),
      0,
    );
    if (currentImageBytes + droppedImageBytes > MAX_TOTAL_IMAGE_BYTES) {
      setAttachmentError(attachmentIssueLabel("image-total", language));
      return;
    }

    const admissionGeneration = dropAdmissionGenerationRef.current;
    const admissionIsCurrent = () => dropAdmissionGenerationRef.current === admissionGeneration;
    dropAdmissionBusyRef.current = true;
    setAdding(true);
    setAttachmentError(undefined);
    const admitted: Attachment[] = [];
    let remainingAttachmentBytes = MAX_TOTAL_ATTACHMENT_BYTES - currentAttachmentBytes;
    let remainingImageBytes = MAX_TOTAL_IMAGE_BYTES - currentImageBytes;
    try {
      for (const file of files) {
        const result = await admitDroppedAttachment(file, remainingAttachmentBytes, remainingImageBytes);
        admitted.push({
          id: crypto.randomUUID(),
          name: result.name,
          mimeType: result.mimeType,
          size: result.size,
          attachmentHandle: result.attachmentHandle,
          previewDataUrl: result.previewDataUrl,
          isImage: result.isImage,
        });
        if (!admissionIsCurrent()) {
          await releaseAttachmentHandles(attachmentHandles(admitted)).catch(() => undefined);
          return;
        }
        remainingAttachmentBytes = Math.max(0, remainingAttachmentBytes - result.size);
        if (result.isImage) remainingImageBytes = Math.max(0, remainingImageBytes - result.size);
      }
      if (!admissionIsCurrent()) {
        await releaseAttachmentHandles(attachmentHandles(admitted)).catch(() => undefined);
        return;
      }
      acceptAttachments(admitted);
    } catch (error) {
      await releaseAttachmentHandles(attachmentHandles(admitted)).catch(() => undefined);
      if (admissionIsCurrent()) setAttachmentError(attachmentDropError(error, language));
    } finally {
      if (admissionIsCurrent()) {
        dropAdmissionBusyRef.current = false;
        setAdding(false);
      }
    }
  };

  const contextUsage = buildContextUsageSnapshot(stats, sessionState, isCompacting);
  const queuedRows = buildQueuedRows(sessionState);
  return (
    <div className={`composer-shell ${dragging ? "is-dragging" : ""}`} onDragEnter={handleDragEnter} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={(event) => void handleDrop(event)}>
      {slashPaletteOpen ? (
        <div className="slash-command-palette">
          <div className="slash-command-palette-header">
            <span>{bi(language, "Commandes", "Commands")}</span>
            <small><kbd>↑</kbd><kbd>↓</kbd> {bi(language, "naviguer", "navigate")} · <kbd>↵</kbd> {bi(language, "appliquer", "apply")}</small>
          </div>
          <div className="slash-command-list" id="composer-slash-command-list" ref={slashList} role="listbox" aria-label={bi(language, "Commandes disponibles", "Available commands")}>
            {filteredSlashCommands.map((command, index) => (
              <button
                type="button"
                role="option"
                id={`composer-slash-command-${index}`}
                aria-selected={index === slashSelection}
                aria-disabled={Boolean(command.disabledReason)}
                className={`${index === slashSelection ? "is-selected" : ""}${command.disabledReason ? " is-disabled" : ""}`}
                key={`${command.source}:${command.name}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setSlashSelection(index)}
                onClick={() => void chooseSlashCommand(command)}
              >
                <span className="slash-command-icon">{slashCommandIcon(command)}</span>
                <span className="slash-command-copy"><strong>/{command.name}</strong><small>{command.description}</small></span>
                <span className="slash-command-source">{command.source === "session" ? bi(language, "Prime Agent · session", "Prime Agent · session") : command.source === "prime" ? "Prime Agent" : "Orbit"}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {dragging ? <div className="drop-overlay"><Paperclip size={24} /><strong>{bi(language, "Déposez pour joindre ces fichiers", "Drop to attach these files")}</strong></div> : null}
      {queuedRows.length ? (
        <div className="queued-message-tray" aria-label={bi(language, "Instructions en attente", "Queued instructions")}>
          {queuedRows.map((item) => (
            <div className="queued-message-row" key={item.id}>
              <span className="queued-message-icon"><Layers3 size={13} /></span>
              <span className="queued-message-copy"><strong>{item.text}</strong>{item.attachments?.length ? <small>{item.attachments.length} {item.attachments.length === 1 ? bi(language, "pièce jointe", "attachment") : bi(language, "pièces jointes", "attachments")}</small> : null}</span>
              <Badge tone={item.delivery === "steer" ? "accent" : "neutral"}>{item.delivery === "steer" ? bi(language, "Avant le prochain appel", "Before the next model call") : bi(language, "Après la fin", "After completion")}</Badge>
            </div>
          ))}
        </div>
      ) : null}
      {attachments.length ? <div className="composer-attachments">{attachments.map((attachment) => <div key={attachment.id}>{attachment.isImage && attachment.previewDataUrl ? <img src={attachment.previewDataUrl} alt="" /> : <AttachmentGlyph attachment={attachment} size={18} />}<span><strong>{attachment.name}</strong><small>{attachmentMetaLabel(attachment, language, locale)}</small></span><IconButton label={`${bi(language, "Retirer", "Remove")} ${attachment.name}`} onClick={() => { const removed = attachmentsRef.current.find((item) => item.id === attachment.id); const next = attachmentsRef.current.filter((item) => item.id !== attachment.id); attachmentsRef.current = next; rememberConversationAttachmentDraft(conversation.id, next); setAttachments(next); setAttachmentError(undefined); if (removed) void releaseAttachmentHandles(attachmentHandles([removed])).catch(() => undefined); }}><X size={14} /></IconButton></div>)}</div> : null}
      {attachmentError ? <p className="trust-note" role="alert"><Info size={14} />{attachmentError}</p> : null}
      {commandError ? <p className="trust-note composer-command-error" role="alert"><CircleAlert size={14} />{commandError}</p> : null}
      <div className="composer-editor">
        <textarea ref={textarea} value={editorValue} onChange={(event) => updateEditorValue(event.target.value)} onKeyDown={handleKeyDown} onPaste={handlePaste} onFocus={() => setComposerFocused(true)} onBlur={() => { setComposerFocused(false); if (draftRef.current !== reportedDraftRef.current) reportDraftNow(draftRef.current); }} placeholder={activeSlashCommand ? activeSlashCommand.command.description : isCompacting ? bi(language, "Ajoutez un message après le compactage…", "Add a message after compaction…") : isRunning ? bi(language, "Orientez le travail en cours…", "Steer the current work…") : isPlanMode ? bi(language, "Décrivez ce que vous voulez planifier…", "Describe what you want to plan…") : `${bi(language, "Demandez quelque chose sur", "Ask something about")} ${project.name}…`} rows={1} lang={typeof navigator === "undefined" ? language : navigator.language} spellCheck data-native-spellcheck-menu="true" aria-label={bi(language, "Message à Prime Agent", "Message Prime Agent")} aria-autocomplete="list" aria-expanded={slashPaletteOpen} aria-controls={slashPaletteOpen ? "composer-slash-command-list" : undefined} aria-activedescendant={slashPaletteOpen ? `composer-slash-command-${Math.min(slashSelection, filteredSlashCommands.length - 1)}` : undefined} />
      </div>
      <div className="composer-toolbar">
        <div className="composer-tools-left">
          <IconButton label={isPlanMode ? bi(language, "Les pièces jointes sont désactivées en mode Plan", "Attachments are disabled in Plan mode") : bi(language, "Joindre des fichiers", "Attach files")} onClick={() => void addFiles()} disabled={adding || isPlanMode}>{adding ? <LoaderCircle size={17} className="spin" /> : <Plus size={18} />}</IconButton>
          <div className={`plan-mode-selector ${isPlanMode ? "is-plan" : ""}`} role="group" aria-label={bi(language, "Mode de la conversation", "Conversation mode")} title={planModeDisabledReason}>
            <button type="button" className={!isPlanMode ? "is-active" : ""} aria-pressed={!isPlanMode} disabled={planModeBusy || Boolean(planModeDisabledReason)} onClick={() => void changePlanMode("normal")}>{bi(language, "Normal", "Normal")}</button>
            <button type="button" className={isPlanMode ? "is-active" : ""} aria-pressed={isPlanMode} disabled={planModeBusy || Boolean(planModeDisabledReason)} onClick={() => void changePlanMode("plan")}>{planModeBusy ? <LoaderCircle size={12} className="spin" /> : <ListTree size={12} />}{bi(language, "Plan", "Plan")}</button>
          </div>
          {activeSlashCommand ? <button type="button" className="active-slash-command" onClick={clearActiveSlashCommand} title={bi(language, `Retirer la commande /${activeSlashCommand.command.name}`, `Remove /${activeSlashCommand.command.name} command`)}>{slashCommandIcon(activeSlashCommand.command)}<span>{activeSlashCommand.command.label}</span><X size={12} /></button> : null}
          <div className="composer-popover-wrap" data-dismissable-layer="composer-tools">
            <button type="button" className="composer-chip" aria-haspopup="menu" aria-expanded={openPopover === "composer-tools"} onClick={() => onTogglePopover("composer-tools")}><Box size={14} />{bi(language, "Outils", "Tools")}<ChevronDown size={13} /></button>
            {openPopover === "composer-tools" ? <ToolsPopover commands={commands} busyAction={toolActionBusy} compactDisabledReason={compactDisabledReason} refineDisabledReason={refineDisabledReason} isRefining={isRefining} onChoose={(command) => { updateDraft(`/${command.name} `); onClosePopover(); textarea.current?.focus(); }} onCompact={() => void runToolAction("compact")} onRefine={() => void runToolAction("refine")} /> : null}
          </div>
          <div className="composer-popover-wrap" data-dismissable-layer="composer-queue">
            <button type="button" className="composer-chip permission-chip" aria-haspopup="menu" aria-expanded={openPopover === "composer-queue"} title={bi(language, "File d’instructions réellement gérée par Prime Agent", "Instruction queue managed by Prime Agent")} onClick={() => onTogglePopover("composer-queue")}><Layers3 size={14} />{queueLabel(sessionState, language)}<ChevronDown size={13} /></button>
            {openPopover === "composer-queue" ? <QueuePopover sessionState={sessionState} /> : null}
          </div>
        </div>
        <div className="composer-tools-right">
          {stats?.contextUsage ? <div className="composer-popover-wrap" data-dismissable-layer="composer-context"><button type="button" className={`context-meter is-${contextUsage.status}`} aria-haspopup="dialog" aria-expanded={openPopover === "composer-context"} aria-controls={openPopover === "composer-context" ? "context-usage-popover" : undefined} aria-label={contextUsage.percent === null ? bi(language, "Détails du contexte, utilisation indisponible", "Context details, usage unavailable") : `${Math.round(contextUsage.percent)} % ${bi(language, "du contexte utilisé. Afficher les détails", "of context used. Show details")}`} onClick={() => onTogglePopover("composer-context")}><i aria-hidden="true" style={{ "--context": `${contextUsage.ringPercent}%` } as React.CSSProperties} /><span>{contextUsage.percent === null ? "—" : `${Math.round(contextUsage.percent)}%`}</span></button>{openPopover === "composer-context" ? <ContextUsagePopover snapshot={contextUsage} /> : null}</div> : null}
          <div className="composer-popover-wrap" data-dismissable-layer="composer-model">
            <button type="button" className="model-compact-button" aria-haspopup="dialog" aria-expanded={openPopover === "composer-model"} aria-label={`${bi(language, "Modèle", "Model")}: ${activeModel?.name ?? activeModel?.id ?? shortModel(conversation.model) ?? bi(language, "non sélectionné", "not selected")}`} onClick={() => onTogglePopover("composer-model")}><Sparkles size={14} /><span>{activeModel?.name ?? activeModel?.id ?? shortModel(conversation.model) ?? bi(language, "Modèle", "Model")}</span><ChevronDown size={13} /></button>
            {openPopover === "composer-model" ? <ModelPickerPopover models={models} active={conversation.model} favorites={favoriteModels} align="right" onChoose={async (model) => { await onModel(model); onClosePopover(); }} onToggleFavorite={onToggleFavoriteModel} /> : null}
          </div>
          <div className="composer-popover-wrap" data-dismissable-layer="composer-thinking">
            <button type="button" className="thinking-button" aria-haspopup="menu" aria-expanded={openPopover === "composer-thinking"} onClick={() => onTogglePopover("composer-thinking")} title={bi(language, "Niveau de raisonnement", "Reasoning level")}><Brain size={15} /><span>{thinkingLabel(conversation.thinkingLevel, language)}</span><ChevronDown size={13} /></button>
            {openPopover === "composer-thinking" ? <ThinkingPopover active={conversation.thinkingLevel} onChoose={(level) => { void onThinking(level); onClosePopover(); }} /> : null}
          </div>
          {isRunning ? <IconButton label={bi(language, "Arrêter l’exécution", "Stop run")} className="composer-stop" onClick={() => void onAbort()}><CircleStop size={18} /></IconButton> : null}
          {isRunning && !isCompacting ? <button type="button" className="queued-force-send" disabled={!hasComposerContent || adding} onClick={() => void submit("follow_up")} title={bi(language, "Attendre la fin du travail puis démarrer un nouveau tour (Alt+Entrée)", "Wait for current work to finish, then start a new turn (Alt+Enter)")}><Clock3 size={15} />{bi(language, "Après la fin", "After completion")}</button> : null}
          <button type="button" className={`send-button ${hasComposerContent ? "is-ready" : ""}`} disabled={!hasComposerContent || adding} onClick={() => void submit(nativeComposerDelivery(isRunning, isCompacting, false))} aria-label={isCompacting ? bi(language, "Ajouter après le compactage", "Add after compaction") : isRunning ? bi(language, "Orienter le travail en cours", "Steer current work") : bi(language, "Envoyer", "Send")} title={isCompacting ? bi(language, "Attendre la fin du compactage puis démarrer un nouveau tour", "Wait for compaction to finish, then start a new turn") : isRunning ? bi(language, "Livrer après les outils en cours, avant le prochain appel au modèle (Entrée)", "Deliver after current tools, before the next model call (Enter)") : bi(language, "Envoyer (Entrée)", "Send (Enter)")}>{isCompacting ? <Layers3 size={18} /> : isRunning ? <Zap size={18} /> : <Send size={18} />}</button>
        </div>
      </div>
    </div>
  );
}

function contextStatusLabel(status: ContextUsageStatus, language: AppLanguage) {
  if (status === "compacting") return bi(language, "Compactage en cours", "Compacting");
  if (status === "critical") return bi(language, "Presque saturé", "Nearly full");
  if (status === "warning") return bi(language, "À surveiller", "Filling up");
  if (status === "available") return bi(language, "Disponible", "Available");
  return bi(language, "Indisponible", "Unavailable");
}

function contextStatusTone(status: ContextUsageStatus): "success" | "warning" | "danger" | "accent" | "neutral" {
  if (status === "compacting") return "accent";
  if (status === "critical") return "danger";
  if (status === "warning") return "warning";
  if (status === "available") return "success";
  return "neutral";
}

/** Mirrors Prime Agent's native composer contract: Enter steers an active
 * run, Alt+Enter schedules a follow-up, and compaction can only be followed by
 * a new turn after it releases the session. */
export function nativeComposerDelivery(
  isRunning: boolean,
  isCompacting: boolean,
  followUpRequested: boolean,
): "steer" | "follow_up" | undefined {
  if (!isRunning && !isCompacting) return undefined;
  return isCompacting || followUpRequested ? "follow_up" : "steer";
}

function ContextUsagePopover({ snapshot }: { snapshot: ContextUsageSnapshot }) {
  const { language, locale } = useI18n();
  const metric = (value: number | null) => value === null ? "—" : compactNumber(value, locale);
  const percent = snapshot.percent === null ? "—" : `${Math.round(snapshot.percent)}%`;
  const autoCompaction = snapshot.autoCompactionEnabled === undefined
    ? bi(language, "Non signalée", "Not reported")
    : snapshot.autoCompactionEnabled
      ? bi(language, "Activée", "Enabled")
      : bi(language, "Désactivée", "Disabled");
  return (
    <div id="context-usage-popover" className={`popover context-usage-popover is-${snapshot.status}`} role="dialog" aria-labelledby="context-usage-title">
      <header className="context-usage-header">
        <span className="context-usage-icon" aria-hidden="true">{snapshot.status === "compacting" ? <LoaderCircle size={16} className="spin" /> : <ArchiveRestore size={16} />}</span>
        <span><strong id="context-usage-title">{bi(language, "Contexte du modèle", "Model context")}</strong><small>{bi(language, "État remonté par Prime Agent", "State reported by Prime Agent")}</small></span>
        <Badge tone={contextStatusTone(snapshot.status)}>{contextStatusLabel(snapshot.status, language)}</Badge>
      </header>
      <div className="context-usage-progress">
        <div><strong>{percent}</strong><span>{bi(language, "utilisé", "used")}</span></div>
        <progress max={100} value={snapshot.ringPercent} aria-label={bi(language, "Pourcentage du contexte utilisé", "Context percentage used")} />
      </div>
      <dl className="context-usage-metrics">
        <div><dt>{bi(language, "Tokens utilisés", "Tokens used")}</dt><dd>{metric(snapshot.usedTokens)}</dd></div>
        <div><dt>{bi(language, "Disponibles", "Available")}</dt><dd>{metric(snapshot.availableTokens)}</dd></div>
        <div><dt>{bi(language, "Fenêtre", "Window")}</dt><dd>{metric(snapshot.contextWindow)}</dd></div>
        <div><dt>{bi(language, "Compactage auto", "Auto compaction")}</dt><dd>{autoCompaction}</dd></div>
      </dl>
      <p className="context-usage-note"><Info size={13} />{snapshot.status === "compacting"
        ? bi(language, "Les compteurs seront actualisés quand Prime Agent terminera le compactage.", "Counters will refresh when Prime Agent finishes compaction.")
        : bi(language, "Les valeurs et calculs utilisent uniquement les compteurs remontés par Prime Agent ; les données absentes restent indiquées par —.", "Values and calculations use only counters reported by Prime Agent; missing data remains marked with —.")}</p>
    </div>
  );
}

function RunInspector({ project, conversation, stats, sessionState, goalMutation, isCompacting, isRefining, refinements, harnessEntries, divergences = [], schedules, heartbeat, heartbeats, subagents, observedSubagent, changes, tab, onTab, onClose, onRunCommand, onObserveSubagent, onCloneSession, onDraftChange }: {
  project: Project;
  conversation: Conversation;
  stats?: SessionStats;
  sessionState?: AgentSessionState;
  goalMutation?: GoalMutationRuntimeState;
  isCompacting: boolean;
  isRefining: boolean;
  refinements?: SessionRefinementRecord[];
  harnessEntries?: SessionHarnessEntry[];
  divergences?: RuntimeDivergence[];
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
        {tab === "session" ? <SessionPanel project={project} conversation={conversation} sessionState={sessionState} goalMutation={goalMutation} isRefining={isRefining} refinements={refinements} harnessEntries={harnessEntries} divergences={divergences} schedules={schedules} heartbeat={heartbeat} heartbeats={heartbeats} subagents={subagents} observedSubagent={observedSubagent} onRunCommand={onRunCommand} onObserveSubagent={onObserveSubagent} /> : null}
        {tab === "changes" ? <ChangesPanel projectPath={project.path} changes={changes} draft={conversation.draft} onDraftChange={onDraftChange} /> : null}
        {tab === "details" ? <DetailsPanel project={project} conversation={conversation} stats={stats} sessionState={sessionState} isCompacting={isCompacting} isRefining={isRefining} onRunCommand={onRunCommand} onCloneSession={onCloneSession} /> : null}
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
    : reversed[0]?.title ?? activityOverviewDetail(conversation.status, language);
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

export function activityOverviewDetail(status: Conversation["status"], language: AppLanguage) {
  if (status === "starting") return bi(language, "Connexion à Prime Agent…", "Connecting to Prime Agent…");
  if (status === "streaming") return bi(language, "Prime Agent traite l’instruction active", "Prime Agent is processing the active instruction");
  if (status === "tool") return bi(language, "Un outil ou une demande interactive est en cours", "A tool or interactive request is active");
  if (status === "queued") return bi(language, "Des instructions attendent dans la file Prime Agent", "Instructions are waiting in Prime Agent's queue");
  return bi(language, "Prêt pour une nouvelle instruction", "Ready for a new instruction");
}

export type SessionPanelSection = "runtime" | "attachments" | "goal" | "agents" | "supervision";

export interface SessionPanelSummary {
  attachments: number;
  queued: number;
  hasActiveAction: boolean;
  goals: number;
  agents: number;
  supervision: number;
}

export function buildSessionPanelSummary(
  conversation: Pick<Conversation, "messages">,
  sessionState: AgentSessionState | undefined,
  schedules: AgentSchedule[],
  heartbeat: AgentSchedule | null | undefined,
  heartbeats: AgentHeartbeatSummary[],
  subagents: AgentRlmChild[],
): SessionPanelSummary {
  const actions = sessionState?.sessionActions;
  const remoteHeartbeats = heartbeats.filter((item) => (
    item.job.id !== heartbeat?.id && ["active", "paused"].includes(item.job.status)
  ));
  const activeSchedules = schedules.filter((job) => (
    job.source !== "heartbeat" && job.source !== "rlm_heartbeat" && job.status === "active"
  ));
  return {
    attachments: conversation.messages.reduce((count, message) => count + (message.attachments?.length ?? 0), 0),
    queued: (actions?.steering.length ?? 0) + (actions?.followUps.length ?? 0),
    hasActiveAction: Boolean(actions?.active),
    goals: sessionGoalCount(sessionState?.goal),
    agents: subagents.length,
    supervision: (heartbeat ? 1 : 0) + activeSchedules.length + remoteHeartbeats.length,
  };
}

function SessionPanel({ project, conversation, sessionState, goalMutation, isRefining, refinements, harnessEntries, divergences, schedules, heartbeat, heartbeats, subagents, observedSubagent, onRunCommand, onObserveSubagent }: { project: Project; conversation: Conversation; sessionState?: AgentSessionState; goalMutation?: GoalMutationRuntimeState; isRefining: boolean; refinements?: SessionRefinementRecord[]; harnessEntries?: SessionHarnessEntry[]; divergences?: RuntimeDivergence[]; schedules: AgentSchedule[]; heartbeat?: AgentSchedule | null; heartbeats: AgentHeartbeatSummary[]; subagents: AgentRlmChild[]; observedSubagent?: { activeSessionId: string; messages: ChatMessage[]; closed?: boolean; error?: string }; onRunCommand: (type: string, fields?: Record<string, unknown>) => Promise<void>; onObserveSubagent: (activeSessionId?: string) => Promise<void> }) {
  const { language, locale } = useI18n();
  const [section, setSection] = useState<SessionPanelSection>("runtime");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string>();
  useEffect(() => {
    setRefreshing(false);
    setRefreshError(undefined);
  }, [conversation.id]);
  const attachments = conversation.messages.flatMap((message) => message.attachments ?? []);
  const sessionActions = sessionState?.sessionActions;
  const queued = [
    ...(sessionActions?.steering ?? []).map((text) => ({ lane: bi(language, "Immédiate", "Immediate"), text })),
    ...(sessionActions?.followUps ?? []).map((text) => ({ lane: bi(language, "Suivi", "Follow-up"), text })),
  ];
  const summary = buildSessionPanelSummary(conversation, sessionState, schedules, heartbeat, heartbeats, subagents);
  const sections: Array<{ id: SessionPanelSection; label: string; icon: React.ReactNode; count: number }> = [
    { id: "runtime", label: "Session", icon: <ListTree size={14} />, count: summary.queued + Number(summary.hasActiveAction) },
    { id: "attachments", label: bi(language, "Fichiers", "Files"), icon: <Paperclip size={14} />, count: summary.attachments },
    { id: "goal", label: "Goal", icon: <Target size={14} />, count: summary.goals },
    { id: "agents", label: bi(language, "Agents", "Agents"), icon: <Bot size={14} />, count: summary.agents },
    { id: "supervision", label: bi(language, "Suivi", "Monitor"), icon: <HeartPulse size={14} />, count: summary.supervision },
  ];
  const refreshSession = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(undefined);
    try {
      await onRunCommand("get_state");
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : String(error));
    } finally {
      setRefreshing(false);
    }
  };
  const handleSectionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex = index;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % sections.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + sections.length) % sections.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = sections.length - 1;
    else return;
    event.preventDefault();
    setSection(sections[nextIndex]!.id);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=tab]")[nextIndex]?.focus();
  };
  return (
    <div className="inspector-section session-panel">
      <nav className="session-section-tabs" role="tablist" aria-label={bi(language, "Sections de la session", "Session sections")}>
        {sections.map((item, index) => <button id={`session-tab-${item.id}`} key={item.id} type="button" role="tab" aria-selected={section === item.id} aria-controls={`session-panel-${item.id}`} tabIndex={section === item.id ? 0 : -1} className={section === item.id ? "is-active" : ""} onClick={() => setSection(item.id)} onKeyDown={(event) => handleSectionKeyDown(event, index)}>{item.icon}<span className="session-tab-label">{item.label}</span><span className="session-tab-count">{item.count}</span></button>)}
      </nav>
      <div id={`session-panel-${section}`} className="session-area-content" role="tabpanel" aria-labelledby={`session-tab-${section}`}>
        {section === "runtime" ? <>
          <header className="session-area-heading"><div><h3>{bi(language, "État de la session", "Session state")}</h3><p>{bi(language, "Processus actif, espace de travail et file d’instructions remontés par Prime Agent.", "Live process, workspace, and instruction queue reported by Prime Agent.")}</p></div><Badge tone={sessionState ? "success" : "neutral"}>{sessionState ? bi(language, "État disponible", "State available") : bi(language, "En attente", "Pending")}</Badge></header>
          <div className="detail-card"><div><FolderIcon /><span><strong>{project.name}</strong><small>{project.path}</small></span></div><Badge tone="success">{bi(language, "Local", "Local")}</Badge></div>
          <div className="section-title"><span>{bi(language, "File d’instructions", "Instruction queue")}</span><Badge tone={queued.length ? "accent" : "neutral"}>{queued.length}</Badge></div>
          {sessionActions?.active ? <div className="detail-card session-active-action"><div><LoaderCircle size={16} className="spin" /><span><strong>{bi(language, "Action active", "Active action")}</strong><small>{sessionActions.active.label ?? (sessionActions.active.kind === "turn" ? bi(language, "Tour de l’agent", "Agent turn") : bi(language, "Commande de session", "Session command"))} · {sessionActions.active.phase}</small></span></div><Badge tone="accent">Live</Badge></div> : null}
          {queued.length ? <div className="context-files queue-items">{queued.map((item, index) => <div key={`${item.lane}:${index}:${item.text.slice(0, 32)}`}><Layers3 size={16} /><span><strong>{item.lane}</strong><small>{item.text}</small></span></div>)}</div> : <InspectorEmpty icon={<Layers3 size={22} />} text={bi(language, "Aucune instruction en attente dans Prime Agent.", "No instruction is queued in Prime Agent.")} />}
          <Button variant="ghost" className="full-button" loading={refreshing} disabled={refreshing} onClick={() => void refreshSession()}>{refreshing ? null : <RefreshCw size={14} />}{bi(language, "Actualiser l’état", "Refresh state")}</Button>
          {refreshError ? <p className="trust-note" role="alert"><CircleAlert size={14} />{refreshError}</p> : null}
        </> : null}
        {section === "attachments" ? <>
          <header className="session-area-heading"><div><h3>{bi(language, "Pièces jointes", "Attachments")}</h3><p>{bi(language, "Fichiers et images explicitement associés aux messages de cette conversation.", "Files and images explicitly associated with messages in this conversation.")}</p></div><Badge tone={attachments.length ? "accent" : "neutral"}>{attachments.length}</Badge></header>
          {attachments.length ? <div className="context-files session-attachment-list">{attachments.map((attachment, index) => <div key={`${attachment.id}:${index}`}>{attachment.isImage && attachment.previewDataUrl ? <img className="context-file-preview" src={attachment.previewDataUrl} alt={attachment.name} /> : <AttachmentGlyph attachment={attachment} size={16} />}<span><strong>{attachment.name}</strong><small>{attachmentMetaLabel(attachment, language, locale)}</small></span></div>)}</div> : <InspectorEmpty icon={<Paperclip size={22} />} text={bi(language, "Aucune pièce jointe dans les messages de cette conversation.", "No attachment is present in this conversation's messages.")} />}
        </> : null}
        {section === "goal" ? <GoalPanel key={`goal:${conversation.id}`} conversation={conversation} goal={sessionState?.goal} goalMutation={goalMutation} onRunCommand={onRunCommand} /> : null}
        {section === "agents" ? <SubagentsPanel key={`agents:${conversation.id}`} subagents={subagents} observed={observedSubagent} onObserve={onObserveSubagent} /> : null}
        {section === "supervision" ? <SupervisionPanel key={`supervision:${conversation.id}`} projectPath={project.path} conversation={conversation} isRefining={isRefining} refinements={refinements} harnessEntries={harnessEntries} divergences={divergences} schedules={schedules} heartbeat={heartbeat} heartbeats={heartbeats} onRunCommand={onRunCommand} /> : null}
      </div>
    </div>
  );
}

export function isGoalPanelBusy(localBusy: boolean, goalMutation?: GoalMutationRuntimeState): boolean {
  return localBusy || Boolean(goalMutation && goalMutation.phase !== "error");
}

function GoalPanel({ conversation, goal, goalMutation, onRunCommand }: { conversation: Conversation; goal?: AgentSessionState["goal"]; goalMutation?: GoalMutationRuntimeState; onRunCommand: (type: string, fields?: Record<string, unknown>) => Promise<void> }) {
  const { language, locale } = useI18n();
  const [editing, setEditing] = useState(false);
  const [objective, setObjective] = useState("");
  const [budget, setBudget] = useState("");
  const [localBusy, setLocalBusy] = useState(false);
  const [error, setError] = useState<string>();
  const busy = isGoalPanelBusy(localBusy, goalMutation);
  const displayError = error ?? (goalMutation?.phase === "error" ? goalMutation.error : undefined);
  const runGoal = async (command: string) => {
    setLocalBusy(true);
    setError(undefined);
    try {
      await onRunCommand("prompt", {
        message: command,
        ...(isConversationTurnActive(conversation.status) ? { streamingBehavior: "steer" } : {}),
      });
      setEditing(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLocalBusy(false);
    }
  };
  const submit = () => {
    const trimmed = objective.trim();
    if (!trimmed) return;
    const parsedBudget = Number.parseInt(budget, 10);
    void runGoal(`/goal${Number.isFinite(parsedBudget) && parsedBudget > 0 ? ` --budget ${parsedBudget}` : ""} ${trimmed}`);
  };
  const tokens = goal?.tokensUsed ? compactNumber(goal.tokensUsed, locale) : "0";
  const statusLabel = goal?.status === "active"
    ? bi(language, "actif", "active")
    : goal?.status === "paused"
      ? bi(language, "en pause", "paused")
      : goal?.status === "budget_limited"
        ? bi(language, "budget atteint", "budget reached")
        : goal?.status === "complete"
          ? bi(language, "terminé", "complete")
          : goal?.status === "error"
            ? bi(language, "en erreur", "error")
            : bi(language, "inactif", "inactive");
  const terminal = goal?.status === "complete" || goal?.status === "error";
  const badgeTone = goal?.status === "active"
    ? "accent"
    : goal?.status === "complete"
      ? "success"
      : goal?.status === "error"
        ? "danger"
        : "neutral";
  return (
    <section className="goal-panel" aria-busy={busy}>
      <div className="section-title">
        <span>{bi(language, "Objectif persistant", "Persistent goal")}</span>
        <Badge tone={badgeTone}>{statusLabel}</Badge>
      </div>
      <p className="supervision-explainer">
        {goal?.status === "complete"
          ? bi(language, "Prime Agent conserve le dernier objectif terminé comme historique. Vous pouvez l’effacer ou démarrer directement un nouvel objectif.", "Prime Agent retains the last completed goal as history. You can clear it or start a new goal directly.")
          : bi(language, "Le mode Goal poursuit un objectif entre plusieurs tours et peut continuer jusqu’à son achèvement ou sa limite de tokens.", "Goal mode pursues an objective across turns and can continue until completion or its token limit.")}
      </p>
      {goal?.objective ? (
        <div className="goal-card">
          <Target size={17} />
          <div>
            <strong>{goal.objective}</strong>
            <small>{tokens} {bi(language, "tokens utilisés", "tokens used")}{goal.tokenBudget ? ` / ${compactNumber(goal.tokenBudget, locale)}` : ""}{goal.lastReason ? ` · ${goal.lastReason}` : ""}</small>
          </div>
        </div>
      ) : <InspectorEmpty icon={<Target size={21} />} text={bi(language, "Aucun objectif persistant pour cette session.", "No persistent goal for this session.")} />}
      {goal?.objective ? (
        <div className="goal-actions">
          {goal.status === "active" ? <Button variant="ghost" disabled={busy} onClick={() => void runGoal("/goal pause")}><Pause size={14} />{bi(language, "Pause", "Pause")}</Button> : null}
          {goal.status === "paused" ? <Button variant="ghost" disabled={busy} onClick={() => void runGoal("/goal resume")}><Play size={14} />{bi(language, "Reprendre", "Resume")}</Button> : null}
          {terminal ? <Button variant="ghost" disabled={busy} onClick={() => setEditing((current) => !current)}><Plus size={14} />{bi(language, "Nouvel objectif", "New goal")}</Button> : null}
          <Button variant="ghost" disabled={busy} onClick={() => void runGoal("/goal clear")}>
            {busy ? <LoaderCircle size={14} className="spin" /> : <X size={14} />}
            {busy ? bi(language, "En attente…", "Waiting…") : bi(language, "Effacer", "Clear")}
          </Button>
        </div>
      ) : <Button variant="ghost" disabled={busy} onClick={() => setEditing((current) => !current)}><Plus size={14} />{bi(language, "Nouvel objectif", "New goal")}</Button>}
      {busy ? <p className="trust-note" role="status" aria-live="polite"><LoaderCircle size={14} className="spin" />{bi(language, "Prime Agent applique la modification. Elle peut attendre la fin du tour en cours.", "Prime Agent is applying the change. It may wait for the current turn to finish.")}</p> : null}
      {editing ? <div className="supervision-editor"><label><span>{bi(language, "Objectif", "Objective")}</span><textarea rows={3} value={objective} onChange={(event) => setObjective(event.target.value)} autoFocus /></label><label><span>{bi(language, "Budget de tokens (optionnel)", "Token budget (optional)")}</span><input inputMode="numeric" value={budget} onChange={(event) => setBudget(event.target.value.replace(/[^0-9]/g, ""))} placeholder="50000" /></label><Button disabled={!objective.trim() || busy} onClick={submit}>{busy ? <LoaderCircle size={14} className="spin" /> : <Target size={14} />}{bi(language, "Démarrer", "Start")}</Button></div> : null}
      {displayError ? <p className="trust-note" role="alert"><CircleAlert size={14} />{displayError}</p> : null}
    </section>
  );
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
  return (
    <section className="subagents-panel">
      <div className="section-title"><span>{bi(language, "Sous-agents", "Subagents")}</span><Badge tone={ordered.some((child) => child.status === "running") ? "accent" : "neutral"}>{ordered.length}</Badge></div>
      <p className="supervision-explainer">{bi(language, "Consultez les sous-sessions RLM réellement créées par Prime Agent. Le modèle affiché est celui choisi lors de leur création.", "Inspect the RLM child sessions actually created by Prime Agent. The displayed model is the one chosen when they were spawned.")}</p>
      {ordered.length ? (
        <div className="subagent-list">
          {ordered.map((child) => {
            const observing = Boolean(child.activeSessionId && observed?.activeSessionId === child.activeSessionId);
            const presentation = subagentStatusPresentation(child, language);
            return (
              <div className={`subagent-row is-${presentation.visualStatus}`} key={child.id}>
                <Bot size={16} />
                <span><strong>{child.label || child.sessionName || child.id}</strong><small>{child.model ?? bi(language, "Modèle hérité", "Inherited model")}{child.toolUseCount ? ` · ${child.toolUseCount} ${bi(language, "outils", "tools")}` : ""}{child.durationMs ? ` · ${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(child.durationMs / 1000)} s` : ""}</small></span>
                <Badge tone={presentation.tone}>{presentation.label}</Badge>
                {child.activeSessionId && presentation.visualStatus !== "closed" ? <IconButton label={observing ? bi(language, "Fermer la sous-session", "Close child session") : bi(language, "Consulter la sous-session", "Inspect child session")} onClick={() => void toggle(child)}>{observing ? <EyeOff size={14} /> : <Eye size={14} />}</IconButton> : null}
              </div>
            );
          })}
        </div>
      ) : <InspectorEmpty icon={<Bot size={21} />} text={bi(language, "Aucun sous-agent signalé dans cette session.", "No subagent has been reported in this session.")} />}
      {observed ? <div className="observed-subagent"><header><strong>{bi(language, "Sous-session observée", "Observed child session")}</strong><Badge tone={observed.closed ? "neutral" : "accent"}>{observed.closed ? bi(language, "fermée", "closed") : "Live"}</Badge></header>{observed.messages.length ? <div>{observed.messages.slice(-12).map((message) => <article key={message.id} className={`observed-message is-${message.role}`}><strong>{message.role === "assistant" ? "Agent" : bi(language, "Tâche", "Task")}</strong><p>{message.content.slice(0, 900)}</p></article>)}</div> : <p>{bi(language, "En attente d’un message de la sous-session…", "Waiting for a child-session message…")}</p>}{observed.error ? <p className="trust-note" role="alert"><CircleAlert size={14} />{observed.error}</p> : null}</div> : null}
      <p className="trust-note"><Info size={14} />{bi(language, "Prime Agent ne permet pas de changer le modèle d’un sous-agent déjà lancé via son RPC classique. Les préférences de futurs sous-agents nécessitent le catalogue de modèles scoped du daemon.", "Prime Agent's classic RPC cannot change the model of an already running child. Future-subagent preferences require the daemon's scoped-model catalog.")}</p>
      {error ? <p className="trust-note" role="alert"><CircleAlert size={14} />{error}</p> : null}
    </section>
  );
}

function SupervisionPanel({ projectPath, conversation, isRefining, refinements, harnessEntries, divergences = [], schedules, heartbeat, heartbeats, onRunCommand }: { projectPath: string; conversation: Conversation; isRefining: boolean; refinements?: SessionRefinementRecord[]; harnessEntries?: SessionHarnessEntry[]; divergences?: RuntimeDivergence[]; schedules: AgentSchedule[]; heartbeat?: AgentSchedule | null; heartbeats: AgentHeartbeatSummary[]; onRunCommand: (type: string, fields?: Record<string, unknown>) => Promise<void> }) {
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
  const remoteHeartbeats = heartbeats.filter((item) => (
    item.job.id !== heartbeat?.id && ["active", "paused"].includes(item.job.status)
  ));
  const supervisionCount = (heartbeat ? 1 : 0) + activeSchedules.length + remoteHeartbeats.length;
  return (
    <section className="supervision-panel">
      <div className="section-title"><span>{bi(language, "Supervision Prime Agent", "Prime Agent supervision")}</span><Badge tone={supervisionCount ? "accent" : "neutral"}>{supervisionCount}</Badge></div>
      <p className="supervision-explainer">{bi(language, "Surveille et relance le travail en arrière-plan avec les heartbeats et les tâches planifiées réelles de Prime Agent.", "Monitor and resume background work with Prime Agent's real heartbeats and scheduled jobs.")}</p>
      {heartbeat ? <div className="supervision-job"><HeartPulse size={16} /><span><strong>{bi(language, "Heartbeat de cette session", "This session heartbeat")}</strong><small>{heartbeat.schedule.expression} · {heartbeat.deliveryMode === "follow_up" ? bi(language, "nouveau tour", "new turn") : bi(language, "oriente le tour", "steers turn")}{heartbeat.nextRunAt ? ` · ${new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(heartbeat.nextRunAt))}` : ""}</small></span><IconButton label={heartbeat.status === "paused" ? bi(language, "Reprendre", "Resume") : bi(language, "Mettre en pause", "Pause")} onClick={() => void runAction("update_heartbeat", { action: heartbeat.status === "paused" ? "resume" : "pause" })}>{heartbeat.status === "paused" ? <Play size={14} /> : <Pause size={14} />}</IconButton><IconButton label={bi(language, "Supprimer le heartbeat", "Clear heartbeat")} onClick={() => void runAction("update_heartbeat", { action: "clear" })}><X size={14} /></IconButton></div> : null}
      {activeSchedules.map((job) => <div className="supervision-job" key={job.id}><CalendarClock size={16} /><span><strong>{job.label || job.prompt}</strong><small>{job.schedule.expression}{job.nextRunAt ? ` · ${new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(new Date(job.nextRunAt))}` : ""}</small></span><IconButton label={bi(language, "Annuler la tâche", "Cancel job")} onClick={() => void runAction("cancel_schedule", { jobId: job.id })}><X size={14} /></IconButton></div>)}
      {remoteHeartbeats.slice(0, 8).map((item) => <div className="supervision-job is-remote" key={item.job.id}><HeartPulse size={16} /><span><strong>{item.sessionName || item.firstMessage || item.job.label || item.job.sessionId}</strong><small>{item.job.schedule.expression} · {item.job.status}</small></span><IconButton label={item.job.status === "paused" ? bi(language, "Reprendre", "Resume") : bi(language, "Mettre en pause", "Pause")} onClick={() => void runAction("manage_heartbeat", { activeSessionId: item.job.activeSessionId, jobId: item.job.id, action: item.job.status === "paused" ? "resume" : "pause" })}>{item.job.status === "paused" ? <Play size={14} /> : <Pause size={14} />}</IconButton><IconButton label={bi(language, "Arrêter", "Stop")} onClick={() => void runAction("manage_heartbeat", { activeSessionId: item.job.activeSessionId, jobId: item.job.id, action: "stop" })}><X size={14} /></IconButton></div>)}
      {!heartbeat && activeSchedules.length === 0 && remoteHeartbeats.length === 0 ? <InspectorEmpty icon={<HeartPulse size={21} />} text={bi(language, "Aucune supervision planifiée pour cette session.", "No scheduled supervision for this session.")} /> : null}
      <div className="supervision-actions"><Button variant="ghost" onClick={() => setEditor((current) => current === "heartbeat" ? undefined : "heartbeat")}><HeartPulse size={14} />{bi(language, "Heartbeat", "Heartbeat")}</Button><Button variant="ghost" onClick={() => setEditor((current) => current === "schedule" ? undefined : "schedule")}><CalendarClock size={14} />{bi(language, "Planifier", "Schedule")}</Button></div>
      {error && !editor ? <p className="trust-note" role="alert"><CircleAlert size={14} />{error}</p> : null}
      {editor ? <div className="supervision-editor"><label><span>{bi(language, "Fréquence ou date", "Frequency or date")}</span><input value={schedule} onChange={(event) => setSchedule(event.target.value)} placeholder="every 30m" /></label><label><span>{bi(language, "Instruction à exécuter", "Instruction to run")}</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={3} /></label>{editor === "heartbeat" ? <label><span>{bi(language, "Si l’agent travaille déjà", "If the agent is already working")}</span><select value={deliveryMode} onChange={(event) => setDeliveryMode(event.target.value as "steer" | "follow_up")}><option value="steer">{bi(language, "Orienter le travail en cours", "Steer current work")}</option><option value="follow_up">{bi(language, "Attendre puis ouvrir un nouveau tour", "Wait, then start a new turn")}</option></select></label> : null}{error ? <p className="trust-note" role="alert"><CircleAlert size={14} />{error}</p> : null}<Button disabled={!prompt.trim() || !schedule.trim() || submitting} onClick={() => void submit()}>{submitting ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}{bi(language, "Activer", "Enable")}</Button></div> : null}
      <DivergenceMonitor divergences={divergences} />
      <RefinementMonitor projectPath={projectPath} conversation={conversation} isRefining={isRefining} refinements={refinements} harnessEntries={harnessEntries} onRunCommand={onRunCommand} />
    </section>
  );
}

/** Surfaces every correction Orbit had to apply because Prime Agent's event
 * stream and the rendered state disagreed. Without this trail a lost event is
 * indistinguishable from a slow agent, and the cause can never be narrowed
 * down to the transport, the parser, or Prime Agent itself. */
function DivergenceMonitor({ divergences }: { divergences: RuntimeDivergence[] }) {
  const { language, locale } = useI18n();
  if (divergences.length === 0) return null;
  const statusLabel = (status: RuntimeDivergence["observedStatus"]) => {
    if (status === "streaming") return bi(language, "génération", "streaming");
    if (status === "tool") return bi(language, "outil", "tool");
    if (status === "queued") return bi(language, "file d’attente", "queued");
    return status;
  };
  return (
    <div className="divergence-monitor">
      <div className="section-title">
        <span>{bi(language, "Écarts de synchronisation", "Synchronization drift")}</span>
        <Badge tone="warning">{divergences.length}</Badge>
      </div>
      <p className="supervision-explainer">{bi(language, "Corrections appliquées après relecture de l’état réel de Prime Agent. Un écart signale un événement perdu entre l’agent et cette fenêtre.", "Corrections applied after re-reading Prime Agent's real state. Drift means an event was lost between the agent and this window.")}</p>
      {divergences.slice(-8).reverse().map((item) => (
        <div className="supervision-job" key={item.id}>
          <CircleAlert size={16} />
          <span>
            <strong>{item.source === "resync" ? bi(language, "Resynchronisation manuelle", "Manual resynchronization") : bi(language, "Réconciliation automatique", "Automatic reconciliation")}</strong>
            <small>
              {bi(language, `Affiché « ${statusLabel(item.observedStatus)} » alors que Prime Agent était inactif`, `Displayed "${statusLabel(item.observedStatus)}" while Prime Agent was idle`)}
              {item.stalledActivities > 0 ? ` · ${item.stalledActivities} ${bi(language, "ligne(s) close(s)", "row(s) closed")}` : ""}
              {` · ${new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(item.detectedAt))}`}
            </small>
          </span>
        </div>
      ))}
    </div>
  );
}

function refinementKindLabel(kind: SessionRefinementKind, language: AppLanguage) {
  if (kind === "memory") return bi(language, "Mémoire", "Memory");
  if (kind === "prompt") return bi(language, "Note de prompt", "Prompt note");
  if (kind === "skill") return "Skill";
  return bi(language, "Spécification de sous-agent", "Subagent specification");
}

function refinementKindIcon(kind: SessionRefinementKind) {
  if (kind === "memory") return <Brain size={14} />;
  if (kind === "prompt") return <FileText size={14} />;
  if (kind === "skill") return <Sparkles size={14} />;
  return <Bot size={14} />;
}

function refinementActionLabel(action: "create" | "update" | "delete", language: AppLanguage) {
  if (action === "create") return bi(language, "Création", "Created");
  if (action === "update") return bi(language, "Mise à jour", "Updated");
  return bi(language, "Suppression", "Deleted");
}

function safeRefinementTime(value: string, locale: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(timestamp)
    : "—";
}

type RefinementMenuTarget =
  | { type: "entry"; entry: SessionHarnessEntry }
  | { type: "refinement"; record: SessionRefinementRecord };

type RefinementConfirmation =
  | { type: "delete-entry"; entry: SessionHarnessEntry }
  | { type: "rollback-refinement"; record: SessionRefinementRecord };

interface RefinementContextMenuState {
  target: RefinementMenuTarget;
  trigger: HTMLElement;
  x: number;
  y: number;
}

const REFINEMENT_CONTEXT_MENU_MARGIN = 8;

export function clampRefinementContextMenuPosition(x: number, y: number, width: number, height: number, viewportWidth: number, viewportHeight: number) {
  return {
    x: Math.max(REFINEMENT_CONTEXT_MENU_MARGIN, Math.min(x, viewportWidth - width - REFINEMENT_CONTEXT_MENU_MARGIN)),
    y: Math.max(REFINEMENT_CONTEXT_MENU_MARGIN, Math.min(y, viewportHeight - height - REFINEMENT_CONTEXT_MENU_MARGIN)),
  };
}

export function harnessConfirmationPhrase(entry: Pick<SessionHarnessEntry, "id" | "title" | "scope">) {
  if (entry.scope !== "global") return "";
  const title = entry.title?.trim();
  return title && title.length <= 80 ? title : entry.id;
}

function refinementTargetKey(target: RefinementMenuTarget) {
  return target.type === "entry" ? `entry:${target.entry.key}` : `refinement:${target.record.id}`;
}

function refinementTargetScope(target: RefinementMenuTarget) {
  return target.type === "entry" ? target.entry.scope : target.record.scope;
}

export function refinementReaderAdjacentIndex(currentIndex: number, direction: -1 | 1, itemCount: number) {
  if (itemCount <= 0 || currentIndex < 0) return -1;
  return Math.max(0, Math.min(itemCount - 1, currentIndex + direction));
}

export function refinementReaderCopyText(target: RefinementMenuTarget, language: AppLanguage) {
  if (target.type === "entry") {
    const title = target.entry.title?.trim() || target.entry.id;
    return [title, target.entry.content?.trim()].filter(Boolean).join("\n\n");
  }
  const record = target.record;
  const sections = [record.summary?.trim() || bi(language, "Raffinement sans résumé", "Refinement without summary")];
  if (record.rationale?.trim()) sections.push(`${bi(language, "Raison", "Rationale")}\n${record.rationale.trim()}`);
  if (record.expectedOutcome?.trim()) sections.push(`${bi(language, "Résultat attendu", "Expected outcome")}\n${record.expectedOutcome.trim()}`);
  if (record.appliedEdits.length) {
    sections.push([
      bi(language, "Modifications", "Changes"),
      ...record.appliedEdits.map((edit) => {
        const status = edit.applied ? refinementActionLabel(edit.action, language) : bi(language, "Échec", "Failed");
        const heading = `- ${status} · ${refinementKindLabel(edit.kind, language)} · ${edit.title?.trim() || edit.id}`;
        const details = [edit.content?.trim(), !edit.applied ? edit.error?.trim() : undefined].filter(Boolean);
        return details.length ? `${heading}\n  ${details.join("\n  ")}` : heading;
      }),
    ].join("\n"));
  }
  return sections.join("\n\n");
}

function RefinementMonitor({ projectPath, conversation, isRefining, refinements, harnessEntries, onRunCommand }: { projectPath: string; conversation: Conversation; isRefining: boolean; refinements?: SessionRefinementRecord[]; harnessEntries?: SessionHarnessEntry[]; onRunCommand: (type: string, fields?: Record<string, unknown>) => Promise<void> }) {
  const { language, locale } = useI18n();
  const [requesting, setRequesting] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(refinements === undefined || harnessEntries === undefined);
  const [visibleEntries, setVisibleEntries] = useState(12);
  const [error, setError] = useState<string>();
  const [contextMenu, setContextMenu] = useState<RefinementContextMenuState>();
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 });
  const [pendingConfirmation, setPendingConfirmation] = useState<RefinementConfirmation>();
  const [confirmationText, setConfirmationText] = useState("");
  const [mutationBusy, setMutationBusy] = useState(false);
  const [readerTargetKey, setReaderTargetKey] = useState<string>();
  const [readerCopied, setReaderCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const refreshHistory = useLatestCallback(onRunCommand);
  const localHistory = refinementHistory(conversation.activities)
    .filter((activity) => activity.status !== "success");
  const persistedHistory = persistedRefinementHistory(refinements ?? []);
  const knownEntries = harnessEntries ?? [];
  const shownEntries = knownEntries.slice(0, visibleEntries);
  const readerTargets = useMemo<RefinementMenuTarget[]>(() => [
    ...knownEntries.map((entry) => ({ type: "entry", entry }) as const),
    ...persistedHistory.map((record) => ({ type: "refinement", record }) as const),
  ], [knownEntries, persistedHistory]);
  const activeReaderTarget = readerTargetKey
    ? readerTargets.find((target) => refinementTargetKey(target) === readerTargetKey)
    : undefined;
  const readerIndex = activeReaderTarget
    ? readerTargets.findIndex((target) => refinementTargetKey(target) === readerTargetKey)
    : -1;
  const conversationBusy = isConversationMaintenanceBlocked(conversation.status);
  const refineBusy = requesting || isRefining;
  const sectionBusy = refineBusy || mutationBusy;
  const mutationDisabled = refineBusy || mutationBusy || conversationBusy;

  useEffect(() => {
    setReaderTargetKey(undefined);
    setReaderCopied(false);
  }, [conversation.id]);

  useEffect(() => {
    setReaderCopied(false);
  }, [readerTargetKey]);

  useEffect(() => {
    if (!readerCopied) return;
    const timeout = window.setTimeout(() => setReaderCopied(false), 1800);
    return () => window.clearTimeout(timeout);
  }, [readerCopied]);

  useEffect(() => {
    if (!activeReaderTarget) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const element = event.target instanceof HTMLElement ? event.target : undefined;
      if (element?.matches("input, textarea, select, [contenteditable='true']")) return;
      const nextIndex = refinementReaderAdjacentIndex(readerIndex, event.key === "ArrowLeft" ? -1 : 1, readerTargets.length);
      if (nextIndex < 0 || nextIndex === readerIndex) return;
      event.preventDefault();
      setReaderTargetKey(refinementTargetKey(readerTargets[nextIndex]));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeReaderTarget, readerIndex, readerTargets]);

  useEffect(() => {
    let cancelled = false;
    setVisibleEntries(12);
    setLoadingHistory(true);
    setError(undefined);
    void refreshHistory("get_refinements")
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoadingHistory(false);
      });
    return () => { cancelled = true; };
  }, [conversation.id, refreshHistory]);

  useLayoutEffect(() => {
    if (!contextMenu || !menuRef.current) return;
    const bounds = menuRef.current.getBoundingClientRect();
    setMenuPosition(clampRefinementContextMenuPosition(contextMenu.x, contextMenu.y, bounds.width, bounds.height, window.innerWidth, window.innerHeight));
    (menuRef.current.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? menuRef.current).focus({ preventScroll: true });
  }, [contextMenu]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = (restoreFocus = false) => {
      const trigger = contextMenu.trigger;
      setContextMenu(undefined);
      if (restoreFocus) requestAnimationFrame(() => trigger.isConnected && trigger.focus({ preventScroll: true }));
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && (menuRef.current?.contains(event.target) || contextMenu.trigger.contains(event.target))) return;
      close();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    const dismiss = () => close();
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [contextMenu]);

  const openContextMenu = (target: RefinementMenuTarget, x: number, y: number, trigger: HTMLElement) => {
    setError(undefined);
    setMenuPosition({ x, y });
    setContextMenu({ target, trigger, x, y });
  };

  const openContextMenuFromCard = (event: ReactMouseEvent<HTMLElement>, target: RefinementMenuTarget) => {
    event.preventDefault();
    event.stopPropagation();
    const trigger = event.currentTarget.querySelector<HTMLElement>(".refinement-reader-trigger") ?? event.currentTarget;
    openContextMenu(target, event.clientX, event.clientY, trigger);
  };

  const openContextMenuFromButton = (event: ReactMouseEvent<HTMLButtonElement>, target: RefinementMenuTarget) => {
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    openContextMenu(target, bounds.right, bounds.bottom, event.currentTarget);
  };

  const closeContextMenu = (restoreFocus = false) => {
    const trigger = contextMenu?.trigger;
    setContextMenu(undefined);
    if (restoreFocus && trigger) requestAnimationFrame(() => trigger.isConnected && trigger.focus({ preventScroll: true }));
  };

  const openReader = (target: RefinementMenuTarget) => {
    closeContextMenu();
    setError(undefined);
    setReaderTargetKey(refinementTargetKey(target));
  };

  const navigateReader = (direction: -1 | 1) => {
    const nextIndex = refinementReaderAdjacentIndex(readerIndex, direction, readerTargets.length);
    if (nextIndex < 0 || nextIndex === readerIndex) return;
    setReaderTargetKey(refinementTargetKey(readerTargets[nextIndex]));
  };

  const copyReaderContent = async () => {
    if (!activeReaderTarget) return;
    setError(undefined);
    try {
      await navigator.clipboard.writeText(refinementReaderCopyText(activeReaderTarget, language));
      setReaderCopied(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const openReaderLink = async (href: string) => {
    const target = classifyConversationLink(href);
    if (target.kind !== "external") return;
    setError(undefined);
    try {
      await openUrl(target.url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const runOpenAction = async (target: RefinementMenuTarget, destination: "file" | "folder") => {
    const scope = refinementTargetScope(target);
    const sessionPath = conversation.sessionPath;
    const expectedSessionId = conversation.sessionId;
    if (!sessionPath || !expectedSessionId || (scope !== "local" && scope !== "global")) return;
    const restoreFocus = contextMenu?.trigger;
    closeContextMenu();
    setError(undefined);
    try {
      const input = {
        sessionPath,
        expectedSessionId,
        projectPath,
        scope,
        target: destination,
      } as const;
      if (target.type === "entry") await openHarnessState(input);
      else await openRefinementJournal(input);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      requestAnimationFrame(() => restoreFocus?.isConnected && restoreFocus.focus({ preventScroll: true }));
    }
  };

  const askForConfirmation = (confirmation: RefinementConfirmation) => {
    closeContextMenu();
    setReaderTargetKey(undefined);
    setError(undefined);
    setConfirmationText("");
    setPendingConfirmation(confirmation);
  };

  const runConfirmedMutation = async () => {
    if (!pendingConfirmation || mutationDisabled || !conversation.sessionPath) return;
    setMutationBusy(true);
    setError(undefined);
    try {
      if (pendingConfirmation.type === "delete-entry") {
        const entry = pendingConfirmation.entry;
        const expectedSessionId = conversation.sessionId;
        if (!expectedSessionId || (entry.scope !== "local" && entry.scope !== "global")) return;
        await deleteHarnessEntry({
          sessionPath: conversation.sessionPath,
          expectedSessionId,
          projectPath,
          scope: entry.scope,
          kind: entry.kind,
          id: entry.id,
        });
      } else {
        await onRunCommand("refine", {
          rollbackId: pendingConfirmation.record.id,
          global: pendingConfirmation.record.scope === "global",
        });
      }
      setPendingConfirmation(undefined);
      setConfirmationText("");
      try {
        await refreshHistory("get_refinements");
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setMutationBusy(false);
    }
  };

  const requestRefinement = async () => {
    if (sectionBusy || conversationBusy || !SESSION_MEMORY_CAPABILITIES.canRequestRefinement) return;
    setRequesting(true);
    setError(undefined);
    try {
      await onRunCommand("refine");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRequesting(false);
    }
  };

  const title = (activity: ActivityItem) => {
    if (activity.type === "refine_complete") return bi(language, "Raffinement terminé", "Refinement completed");
    if (activity.type === "refine_failed") return bi(language, "Échec du raffinement", "Refinement failed");
    if (activity.status === "warning") return bi(language, "État du raffinement incertain", "Refinement status uncertain");
    return bi(language, "Raffinement en cours", "Refinement in progress");
  };

  const contextTarget = contextMenu?.target;
  const contextScope = contextTarget ? refinementTargetScope(contextTarget) : undefined;
  const targetUnavailable = !conversation.sessionPath || !conversation.sessionId || (contextScope !== "local" && contextScope !== "global");
  const unavailableReason = !conversation.sessionPath
    ? bi(language, "Cette session n’a pas encore de journal persistant.", "This session does not have a persistent journal yet.")
    : !conversation.sessionId
      ? bi(language, "L’identifiant vérifiable de cette session est absent.", "This session's verifiable identifier is missing.")
      : bi(language, "La portée de cet élément n’est pas connue : Prime Orbit refuse de cibler un fichier au hasard.", "This item's scope is unknown, so Prime Orbit will not guess which file to target.");
  const readerScope = activeReaderTarget ? refinementTargetScope(activeReaderTarget) : undefined;
  const readerTargetUnavailable = !conversation.sessionPath || !conversation.sessionId || (readerScope !== "local" && readerScope !== "global");
  const confirmationIsGlobal = pendingConfirmation?.type === "delete-entry"
    ? pendingConfirmation.entry.scope === "global"
    : pendingConfirmation?.record.scope === "global";
  const requiredConfirmation = pendingConfirmation?.type === "delete-entry"
    ? harnessConfirmationPhrase(pendingConfirmation.entry)
    : confirmationIsGlobal ? pendingConfirmation?.record.id ?? "" : "";
  const confirmationValid = !requiredConfirmation || confirmationText === requiredConfirmation;
  const readerTitle = activeReaderTarget?.type === "entry"
    ? activeReaderTarget.entry.title ?? activeReaderTarget.entry.id
    : activeReaderTarget?.record.summary ?? bi(language, "Raffinement sans résumé", "Refinement without summary");
  const readerScopeLabel = readerScope === "global"
    ? bi(language, "globale", "global")
    : readerScope === "local" ? bi(language, "session", "session") : bi(language, "portée non signalée", "scope not reported");
  const readerTypeLabel = activeReaderTarget?.type === "entry"
    ? refinementKindLabel(activeReaderTarget.entry.kind, language)
    : bi(language, "Raffinement", "Refinement");
  const readerTimestamp = activeReaderTarget?.type === "entry"
    ? safeRefinementTime(activeReaderTarget.entry.updatedAt, locale)
    : activeReaderTarget ? safeRefinementTime(activeReaderTarget.record.timestamp, locale) : "—";
  const readerDescription = activeReaderTarget ? <span className="harness-reader-header-meta"><span>{readerTypeLabel}</span><span>{readerScopeLabel}</span><span>{activeReaderTarget.type === "entry" ? bi(language, "Mis à jour", "Updated") : bi(language, "Créé", "Created")} {readerTimestamp}</span></span> : undefined;

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
        : event.key === "ArrowUp" ? (current <= 0 ? items.length - 1 : current - 1)
          : (current < 0 || current >= items.length - 1 ? 0 : current + 1);
    items[next]?.focus({ preventScroll: true });
  };

  return (
    <section className="refinement-monitor" aria-busy={sectionBusy}>
      <div className="section-title"><span>{bi(language, "Mémoire et raffinement", "Memory and refinement")}</span><Badge tone={sectionBusy ? "accent" : localHistory.some((activity) => activity.status === "error") ? "danger" : "neutral"}>{sectionBusy ? bi(language, "En cours", "Running") : knownEntries.length}</Badge></div>
      <p className="supervision-explainer">{bi(language, "Prime Orbit affiche l’inventaire réel et sanitisé du harness local et global, ainsi que l’historique des raffinements persistés de cette session.", "Prime Orbit shows the real, sanitized local and global harness inventory alongside this session's persisted refinement history.")}</p>
      {refineBusy ? <div className="refinement-live" role="status"><LoaderCircle size={15} className="spin" /><span><strong>{bi(language, "Raffinement en cours", "Refinement in progress")}</strong><small>{bi(language, "L’opération continue même si vous changez de conversation.", "The operation continues if you switch conversations.")}</small></span></div> : null}
      <div className="refinement-subsection-title"><span>{bi(language, "Inventaire du harness", "Harness inventory")}</span><small>{knownEntries.length}</small></div>
      {loadingHistory && refinements === undefined ? <p className="refinement-empty" role="status"><LoaderCircle size={15} className="spin" />{bi(language, "Lecture du harness persistant…", "Reading persistent harness…")}</p> : shownEntries.length ? <div className="harness-entry-list">{shownEntries.map((entry) => {
        const target: RefinementMenuTarget = { type: "entry", entry };
        const active = contextTarget ? refinementTargetKey(contextTarget) === refinementTargetKey(target) : false;
        return <div className="harness-entry" key={entry.key} onContextMenu={(event) => openContextMenuFromCard(event, target)}><button type="button" className="refinement-reader-trigger" aria-haspopup="dialog" onClick={() => openReader(target)}><span className={`harness-kind is-${entry.kind}`}>{refinementKindIcon(entry.kind)}</span><span><strong>{entry.title ?? entry.id}</strong><small>{refinementKindLabel(entry.kind, language)} · {entry.scope === "global" ? bi(language, "globale", "global") : entry.scope === "local" ? bi(language, "session", "session") : bi(language, "portée non signalée", "scope not reported")}</small></span><ChevronRight size={14} /></button><IconButton className="refinement-overflow" label={bi(language, `Actions pour ${entry.title ?? entry.id}`, `Actions for ${entry.title ?? entry.id}`)} aria-haspopup="menu" aria-expanded={active} onClick={(event) => openContextMenuFromButton(event, target)}><MoreHorizontal size={14} /></IconButton></div>;
      })}</div> : <p className="refinement-empty"><Brain size={15} />{bi(language, "Aucune entrée active n’a été trouvée dans le harness local ou global.", "No active entry was found in the local or global harness.")}</p>}
      {visibleEntries < knownEntries.length ? <Button variant="ghost" className="full-button refinement-show-more" onClick={() => setVisibleEntries((value) => Math.min(value + 12, knownEntries.length))}>{bi(language, `Afficher ${Math.min(12, knownEntries.length - visibleEntries)} entrées de plus`, `Show ${Math.min(12, knownEntries.length - visibleEntries)} more entries`)}</Button> : null}
      <div className="refinement-subsection-title"><span>{bi(language, "Historique des raffinements", "Refinement history")}</span><small>{refinements?.length ?? 0}</small></div>
      {persistedHistory.length ? <div className="persisted-refinement-list">{persistedHistory.map((record) => {
        const applied = record.appliedEdits.filter((edit) => edit.applied);
        const scope = record.scope === "global" ? bi(language, "globale", "global") : record.scope === "local" ? bi(language, "session", "session") : bi(language, "portée non signalée", "scope not reported");
        const target: RefinementMenuTarget = { type: "refinement", record };
        const active = contextTarget ? refinementTargetKey(contextTarget) === refinementTargetKey(target) : false;
        return <div className="persisted-refinement" key={record.id} onContextMenu={(event) => openContextMenuFromCard(event, target)}><button type="button" className="refinement-reader-trigger" aria-haspopup="dialog" onClick={() => openReader(target)}><span className="refinement-history-icon"><WandSparkles size={14} /></span><span><strong>{record.summary ?? bi(language, "Raffinement sans résumé", "Refinement without summary")}</strong><small>{applied.length} {applied.length === 1 ? bi(language, "modification appliquée", "applied edit") : bi(language, "modifications appliquées", "applied edits")} · {scope}</small></span><span className="refinement-reader-meta"><time dateTime={record.timestamp}>{safeRefinementTime(record.timestamp, locale)}</time><ChevronRight size={14} /></span></button><IconButton className="refinement-overflow" label={bi(language, "Actions pour ce raffinement", "Actions for this refinement")} aria-haspopup="menu" aria-expanded={active} onClick={(event) => openContextMenuFromButton(event, target)}><MoreHorizontal size={14} /></IconButton></div>;
      })}</div> : !loadingHistory ? <p className="refinement-empty"><WandSparkles size={15} />{bi(language, "Aucun raffinement persisté dans cette session.", "No refinement is persisted in this session.")}</p> : null}
      {localHistory.length ? <div className="refinement-history local-refinement-history">{localHistory.map((activity) => <div className={`refinement-history-row is-${activity.status}`} key={activity.id}><span className="refinement-history-icon">{activity.status === "error" ? <CircleAlert size={14} /> : activity.status === "running" ? <LoaderCircle size={14} className="spin" /> : <WandSparkles size={14} />}</span><span><strong>{title(activity)}</strong><small>{activity.detail ?? bi(language, "Aucun détail supplémentaire fourni par Prime Agent.", "Prime Agent provided no additional detail.")}</small></span><time dateTime={activity.updatedAt ?? activity.createdAt}>{formatTime(activity.updatedAt ?? activity.createdAt, locale)}</time></div>)}</div> : null}
      <Button variant="ghost" className="full-button" loading={refineBusy} disabled={sectionBusy || conversationBusy || !SESSION_MEMORY_CAPABILITIES.canRequestRefinement} title={conversationBusy ? bi(language, "Attendez la fin du tour actif avant de lancer un raffinement.", "Wait for the active turn to finish before starting refinement.") : undefined} onClick={() => void requestRefinement()}>{refineBusy ? null : <WandSparkles size={14} />}{bi(language, "Lancer un raffinement", "Run refinement")}</Button>
      <p className="trust-note"><Info size={14} />{bi(language, "Les métadonnées privées restent masquées. Un clic droit ou le bouton d’actions permet d’ouvrir l’emplacement réel, de supprimer une entrée avec sauvegarde, ou d’annuler un raffinement en ajoutant une opération inverse au journal d’audit.", "Private metadata stays hidden. Right-click or use the actions button to open the real location, delete an entry with a backup, or roll back a refinement by appending a reverse operation to the audit journal.")}</p>
      {error ? <p className="trust-note" role="alert"><CircleAlert size={14} />{error}</p> : null}

      {contextMenu && contextTarget ? <div ref={menuRef} className="app-context-menu refinement-item-context-menu" role="menu" aria-label={contextTarget.type === "entry" ? bi(language, "Actions de l’entrée mémoire", "Memory entry actions") : bi(language, "Actions du raffinement", "Refinement actions")} tabIndex={-1} style={{ left: menuPosition.x, top: menuPosition.y }} onKeyDown={handleMenuKeyDown}>
        <button className="app-context-item" type="button" role="menuitem" disabled={targetUnavailable} title={targetUnavailable ? unavailableReason : undefined} onClick={() => void runOpenAction(contextTarget, "file")}><FileText size={14} /><span>{contextTarget.type === "entry" ? bi(language, "Ouvrir le fichier", "Open file") : bi(language, "Ouvrir le journal", "Open journal")}</span></button>
        <button className="app-context-item" type="button" role="menuitem" disabled={targetUnavailable} title={targetUnavailable ? unavailableReason : undefined} onClick={() => void runOpenAction(contextTarget, "folder")}><FolderOpen size={14} /><span>{bi(language, "Ouvrir le dossier", "Open folder")}</span></button>
        <div className="app-context-separator" role="separator" />
        <button className="app-context-item is-danger" type="button" role="menuitem" disabled={targetUnavailable || mutationDisabled} title={targetUnavailable ? unavailableReason : mutationDisabled ? bi(language, "Attendez la fin de l’opération active.", "Wait for the active operation to finish.") : undefined} onClick={() => askForConfirmation(contextTarget.type === "entry" ? { type: "delete-entry", entry: contextTarget.entry } : { type: "rollback-refinement", record: contextTarget.record })}>{contextTarget.type === "entry" ? <Trash2 size={14} /> : <Undo2 size={14} />}<span>{contextTarget.type === "entry" ? bi(language, "Supprimer…", "Delete…") : bi(language, "Annuler ce raffinement…", "Roll back this refinement…")}</span></button>
        {targetUnavailable ? <p className="refinement-context-note">{unavailableReason}</p> : null}
      </div> : null}

      {activeReaderTarget ? <Modal
        title={readerTitle}
        description={readerDescription}
        icon={activeReaderTarget.type === "entry" ? <span className={`harness-kind is-${activeReaderTarget.entry.kind}`}>{refinementKindIcon(activeReaderTarget.entry.kind)}</span> : <span className="refinement-history-icon"><WandSparkles size={14} /></span>}
        width="960px"
        className={`harness-reader-modal ${activeReaderTarget.type === "entry" ? `is-${activeReaderTarget.entry.kind}` : "is-refinement"}`}
        bodyClassName="harness-reader-modal-body"
        onClose={() => setReaderTargetKey(undefined)}
      >
        <div className="harness-reader">
          <div className="harness-reader-toolbar">
            <div className="harness-reader-navigation" aria-label={bi(language, "Navigation entre les éléments", "Navigate between items")}>
              <IconButton label={bi(language, "Élément précédent", "Previous item")} disabled={readerIndex <= 0} onClick={() => navigateReader(-1)}><ArrowLeft size={15} /></IconButton>
              <span>{readerIndex + 1} / {readerTargets.length}</span>
              <IconButton label={bi(language, "Élément suivant", "Next item")} disabled={readerIndex >= readerTargets.length - 1} onClick={() => navigateReader(1)}><ArrowRight size={15} /></IconButton>
            </div>
            <div className="harness-reader-actions">
              <Button variant="ghost" onClick={() => void copyReaderContent()}>{readerCopied ? <Check size={14} /> : <Copy size={14} />}{readerCopied ? bi(language, "Copié", "Copied") : bi(language, "Copier", "Copy")}</Button>
              <Button variant="ghost" disabled={readerTargetUnavailable} title={readerTargetUnavailable ? unavailableReason : undefined} onClick={() => void runOpenAction(activeReaderTarget, "file")}><FileText size={14} />{activeReaderTarget.type === "entry" ? bi(language, "Ouvrir le fichier", "Open file") : bi(language, "Ouvrir le journal", "Open journal")}</Button>
              <Button variant="ghost" disabled={readerTargetUnavailable} title={readerTargetUnavailable ? unavailableReason : undefined} onClick={() => void runOpenAction(activeReaderTarget, "folder")}><FolderOpen size={14} />{bi(language, "Ouvrir le dossier", "Open folder")}</Button>
            </div>
          </div>
          <div className="harness-reader-scroll">
            {activeReaderTarget.type === "entry" ? <article className="assistant-message-body harness-reader-document">
              {activeReaderTarget.entry.content ? <ConversationMarkdown content={activeReaderTarget.entry.content} onOpenLink={openReaderLink} /> : <p className="harness-reader-empty"><Brain size={18} />{bi(language, "Prime Agent n’a pas inclus de contenu public pour cette entrée.", "Prime Agent did not include public content for this entry.")}</p>}
            </article> : <article className="harness-reader-document harness-refinement-document">
              {activeReaderTarget.record.rationale ? <section><h3>{bi(language, "Pourquoi ce raffinement", "Why this refinement")}</h3><div className="assistant-message-body"><ConversationMarkdown content={activeReaderTarget.record.rationale} onOpenLink={openReaderLink} /></div></section> : null}
              {activeReaderTarget.record.expectedOutcome ? <section><h3>{bi(language, "Résultat attendu", "Expected outcome")}</h3><div className="assistant-message-body"><ConversationMarkdown content={activeReaderTarget.record.expectedOutcome} onOpenLink={openReaderLink} /></div></section> : null}
              <section><h3>{bi(language, "Modifications appliquées", "Applied changes")}</h3>{activeReaderTarget.record.appliedEdits.length ? <ol className="harness-reader-edit-list">{activeReaderTarget.record.appliedEdits.map((edit, index) => <li className={edit.applied ? "" : "is-error"} key={`${activeReaderTarget.record.id}:${edit.kind}:${edit.id}:${index}`}><header><Badge tone={!edit.applied || edit.action === "delete" ? "danger" : edit.action === "create" ? "success" : "accent"}>{edit.applied ? refinementActionLabel(edit.action, language) : bi(language, "Échec", "Failed")}</Badge><span><strong>{edit.title ?? edit.id}</strong><small>{refinementKindLabel(edit.kind, language)}</small></span></header>{edit.content ? <div className="assistant-message-body"><ConversationMarkdown content={edit.content} onOpenLink={openReaderLink} /></div> : null}{!edit.applied && edit.error ? <p className="harness-reader-edit-error"><CircleAlert size={14} />{edit.error}</p> : null}</li>)}</ol> : <p className="harness-reader-empty"><Info size={18} />{bi(language, "Aucune modification publique n’est associée à ce raffinement.", "No public change is associated with this refinement.")}</p>}</section>
            </article>}
            {error ? <p className="trust-note harness-reader-error" role="alert"><CircleAlert size={14} />{error}</p> : null}
          </div>
          <div className="harness-reader-footer">
            <p><Info size={14} />{bi(language, "Seuls les champs publics fournis par Prime Agent sont affichés.", "Only public fields supplied by Prime Agent are shown.")}</p>
            <Button variant="ghost" className="harness-reader-destructive" disabled={readerTargetUnavailable || mutationDisabled} title={readerTargetUnavailable ? unavailableReason : mutationDisabled ? bi(language, "Attendez la fin de l’opération active.", "Wait for the active operation to finish.") : undefined} onClick={() => askForConfirmation(activeReaderTarget.type === "entry" ? { type: "delete-entry", entry: activeReaderTarget.entry } : { type: "rollback-refinement", record: activeReaderTarget.record })}>{activeReaderTarget.type === "entry" ? <Trash2 size={14} /> : <Undo2 size={14} />}{activeReaderTarget.type === "entry" ? bi(language, "Supprimer…", "Delete…") : bi(language, "Annuler ce raffinement…", "Roll back this refinement…")}</Button>
          </div>
        </div>
      </Modal> : null}

      {pendingConfirmation ? <Modal
        title={pendingConfirmation.type === "delete-entry" ? bi(language, "Supprimer cette entrée ?", "Delete this entry?") : bi(language, "Annuler ce raffinement ?", "Roll back this refinement?")}
        description={pendingConfirmation.type === "delete-entry"
          ? bi(language, "Prime Orbit modifiera le harness réel de Prime Agent après votre confirmation.", "Prime Orbit will modify Prime Agent's real harness after you confirm.")
          : bi(language, "Prime Agent créera un raffinement inverse ; le journal d’origine restera intact.", "Prime Agent will create a reverse refinement; the original journal will remain intact.")}
        width="500px"
        onClose={() => { if (!mutationBusy) { setPendingConfirmation(undefined); setConfirmationText(""); } }}
        footer={<><Button variant="secondary" disabled={mutationBusy} onClick={() => { setPendingConfirmation(undefined); setConfirmationText(""); }}>{bi(language, "Annuler", "Cancel")}</Button><Button variant="danger" loading={mutationBusy} disabled={!confirmationValid || conversationBusy || isRefining} onClick={() => void runConfirmedMutation()}>{pendingConfirmation.type === "delete-entry" ? <Trash2 size={14} /> : <Undo2 size={14} />}{pendingConfirmation.type === "delete-entry" ? bi(language, "Supprimer l’entrée", "Delete entry") : bi(language, "Créer le raffinement inverse", "Create reverse refinement")}</Button></>}
      >
        <div className="delete-project-warning refinement-mutation-warning"><CircleAlert size={20} /><div><strong>{pendingConfirmation.type === "delete-entry"
          ? confirmationIsGlobal ? bi(language, "Cette entrée est globale et peut affecter tous vos projets.", "This entry is global and may affect every project.") : bi(language, "Cette entrée sera retirée du harness de cette session.", "This entry will be removed from this session's harness.")
          : confirmationIsGlobal ? bi(language, "Le raffinement inverse modifiera le harness global.", "The reverse refinement will modify the global harness.") : bi(language, "Le raffinement inverse peut restaurer, écraser ou retirer plusieurs entrées.", "The reverse refinement may restore, overwrite, or remove multiple entries.")}</strong><p>{pendingConfirmation.type === "delete-entry"
            ? bi(language, "Une sauvegarde du fichier sera créée avant l’écriture. L’entrée restera visible si l’opération échoue.", "A file backup will be created before writing. The entry will remain visible if the operation fails.")
            : bi(language, "Le journal de session est append-only : cette action ajoute une nouvelle opération d’audit et ne supprime jamais l’ancien enregistrement.", "The session journal is append-only: this adds a new audited operation and never deletes the original record.")}</p></div></div>
        {requiredConfirmation ? <label className="confirmation-field"><span>{language === "en" ? <>Type <strong>{requiredConfirmation}</strong> to confirm</> : <>Saisissez <strong>{requiredConfirmation}</strong> pour confirmer</>}</span><input data-modal-autofocus value={confirmationText} onChange={(event) => setConfirmationText(event.target.value)} autoComplete="off" spellCheck={false} /></label> : null}
        {error ? <p className="trust-note refinement-mutation-error" role="alert"><CircleAlert size={14} />{error}</p> : null}
      </Modal> : null}
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

export function isRefineControlBusy(isRefining: boolean, localAction?: string) {
  return isRefining || localAction === "refine";
}

function DetailsPanel({ project, conversation, stats, sessionState, isCompacting, isRefining, onRunCommand, onCloneSession }: { project: Project; conversation: Conversation; stats?: SessionStats; sessionState?: AgentSessionState; isCompacting: boolean; isRefining: boolean; onRunCommand: (type: string, fields?: Record<string, unknown>) => Promise<void>; onCloneSession: () => Promise<void> }) {
  const { language, locale } = useI18n();
  const [busyAction, setBusyAction] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const conversationBusy = isConversationMaintenanceBlocked(conversation.status);
  const refineBusy = isRefineControlBusy(isRefining, busyAction);
  const runAction = async (key: string, action: () => Promise<void>) => {
    if (busyAction) return;
    setBusyAction(key);
    setActionError(undefined);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(undefined);
    }
  };
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
      {isCompacting ? <p className="maintenance-status" role="status"><LoaderCircle size={14} className="spin" />{bi(language, "Compactage en cours. Les statistiques seront actualisées à la fin.", "Compaction in progress. Statistics will refresh when it finishes.")}</p> : null}
      {isRefining ? <p className="maintenance-status" role="status"><LoaderCircle size={14} className="spin" />{bi(language, "Raffinement en cours. Prime Agent consolide les apprentissages de cette session.", "Refinement in progress. Prime Agent is consolidating what this session learned.")}</p> : null}
      <div className="maintenance-actions"><Button variant="secondary" loading={isCompacting || busyAction === "compact"} disabled={Boolean(busyAction) || conversationBusy || isCompacting} onClick={() => void runAction("compact", () => onRunCommand("compact"))}><ArchiveRestore size={15} />{bi(language, "Compacter", "Compact")}</Button><Button variant="secondary" loading={refineBusy} disabled={Boolean(busyAction) || conversationBusy || isCompacting || refineBusy} title={conversationBusy ? bi(language, "Attendez la fin du tour actif avant de raffiner.", "Wait for the active turn to finish before refining.") : undefined} onClick={() => void runAction("refine", () => onRunCommand("refine"))}>{refineBusy ? null : <WandSparkles size={15} />}{bi(language, "Raffiner", "Refine")}</Button><Button variant="secondary" loading={busyAction === "clone"} disabled={Boolean(busyAction)} onClick={() => void runAction("clone", onCloneSession)}><Copy size={15} />{bi(language, "Dupliquer", "Duplicate")}</Button><Button variant="secondary" loading={busyAction === "export_html"} disabled={Boolean(busyAction)} onClick={() => void runAction("export_html", () => onRunCommand("export_html"))}><ArrowDown size={15} />{bi(language, "Exporter", "Export")}</Button></div>
      {actionError ? <p className="popover-inline-error" role="alert"><CircleAlert size={14} />{actionError}</p> : null}
    </div>
  );
}

function ToolsPopover({ commands, busyAction, compactDisabledReason, refineDisabledReason, isRefining, onChoose, onCompact, onRefine }: { commands: SlashCommand[]; busyAction?: "compact" | "refine"; compactDisabledReason?: string; refineDisabledReason?: string; isRefining: boolean; onChoose: (command: SlashCommand) => void; onCompact: () => void; onRefine: () => void }) {
  const { language } = useI18n();
  const refineBusy = isRefineControlBusy(isRefining, busyAction);
  return (
    <div className="popover tools-popover">
      <div className="popover-label">{bi(language, "Actions rapides", "Quick actions")}</div>
      <button type="button" onClick={onCompact} disabled={Boolean(compactDisabledReason || busyAction)} title={compactDisabledReason}>{busyAction === "compact" ? <LoaderCircle size={15} className="spin" /> : <ArchiveRestore size={15} />}<span><strong>{bi(language, "Compacter le contexte", "Compact context")}</strong><small>{compactDisabledReason ?? bi(language, "Résumer la session pour libérer de la place", "Summarize the session to free up context")}</small></span></button>
      <button type="button" onClick={onRefine} disabled={Boolean(refineDisabledReason || busyAction) || refineBusy} title={refineDisabledReason} aria-busy={refineBusy}>{refineBusy ? <LoaderCircle size={15} className="spin" /> : <WandSparkles size={15} />}<span><strong>{refineBusy ? bi(language, "Raffinement en cours…", "Refinement in progress…") : bi(language, "Raffiner le harness", "Refine the harness")}</strong><small>{refineDisabledReason ?? (refineBusy ? bi(language, "Prime Agent consolide cette session", "Prime Agent is consolidating this session") : bi(language, "Capitaliser les apprentissages de la session", "Capture what the session learned"))}</small></span></button>
      {commands.length ? <><div className="popover-separator" /><div className="popover-label">{bi(language, "Skills et commandes", "Skills and commands")}</div>{commands.slice(0, 8).map((command) => <button key={command.name} type="button" onClick={() => onChoose(command)}><Zap size={15} /><span><strong>/{command.name}</strong><small>{command.description ?? command.source}</small></span></button>)}</> : null}
    </div>
  );
}

function slashCommandIcon(command: ComposerSlashCommand) {
  if (command.name === "goal") return <Target size={15} />;
  if (command.name === "compact") return <ArchiveRestore size={15} />;
  if (command.name === "refine") return <WandSparkles size={15} />;
  if (command.name === "autonomous") return <Bot size={15} />;
  if (command.name === "reload") return <RefreshCw size={15} />;
  return <Zap size={15} />;
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

function QueuePopover({ sessionState }: { sessionState?: AgentSessionState }) {
  const { language } = useI18n();
  const actions = sessionState?.sessionActions;
  const steeringCount = actions?.steering.length ?? 0;
  const followUpCount = actions?.followUps.length ?? 0;
  return (
    <div className="popover thinking-popover permission-popover">
      <div className="popover-label">{bi(language, "File Prime Agent", "Prime Agent queue")}</div>
      <p className="trust-note"><Zap size={14} />{bi(language, `${steeringCount} instruction(s) avant le prochain appel au modèle.`, `${steeringCount} instruction(s) before the next model call.`)}</p>
      <p className="trust-note"><Clock3 size={14} />{bi(language, `${followUpCount} instruction(s) après la fin du travail.`, `${followUpCount} instruction(s) after completion.`)}</p>
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
  attachments?: Attachment[];
}

export function buildQueuedRows(sessionState?: AgentSessionState): QueuedMessageRow[] {
  const actions = sessionState?.sessionActions;
  return (["steer", "follow_up"] as const).flatMap((delivery) => {
    const previews = delivery === "steer" ? actions?.steering ?? [] : actions?.followUps ?? [];
    const attachmentPreviews = delivery === "steer"
      ? actions?.queueAttachments?.steering ?? []
      : actions?.queueAttachments?.followUps ?? [];
    return previews.map((text, index): QueuedMessageRow => {
      const attachments = attachmentPreviews[index]?.length ? attachmentPreviews[index] : undefined;
      return {
        id: `prime-agent-queue:${delivery}:${index}`,
        text: text || attachments?.map((attachment) => attachment.name).join(", ") || "Fichier joint",
        delivery,
        attachments,
      };
    });
  });
}

function AutoCompactionModeRow({ enabled, disabled, language, onEnabled }: {
  enabled: boolean;
  disabled: boolean;
  language: "fr" | "en";
  onEnabled: (enabled: boolean) => void;
}) {
  const title = bi(language, "Compactage automatique", "Automatic compaction");
  return (
    <div className="queue-mode-row">
      <span className="queue-mode-icon"><ArchiveRestore size={15} /></span>
      <span className="queue-mode-copy"><strong>{title}</strong><small>{bi(language, "Compacte le contexte au seuil défini par Prime Agent.", "Compacts context at Prime Agent's configured threshold.")}</small></span>
      <span className="queue-mode-toggle" role="group" aria-label={`${title} · ${bi(language, "activation", "activation")}`}>
        <button type="button" disabled={disabled} className={enabled ? "is-selected" : ""} aria-pressed={enabled} onClick={() => { if (!enabled) onEnabled(true); }}>{bi(language, "Activé", "On")}</button>
        <button type="button" disabled={disabled} className={!enabled ? "is-selected" : ""} aria-pressed={!enabled} onClick={() => { if (enabled) onEnabled(false); }}>{bi(language, "Désactivé", "Off")}</button>
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
const MAX_DOCUMENT_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 40 * 1024 * 1024;
const MAX_ATTACHMENT_COUNT = 20;

export function shouldRestoreAttachmentSubmission(
  submittedConversationId: string,
  submittedGeneration: number,
  currentConversationId: string,
  currentGeneration: number,
) {
  return submittedConversationId === currentConversationId
    && submittedGeneration === currentGeneration;
}

function isSupportedInlineImageMime(mimeType: string) {
  return ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mimeType.toLowerCase());
}

export type AttachmentSelectionIssue = "count" | "image-size" | "document-size" | "image-total" | "attachment-total" | "missing-handle" | "unsupported-image";

function attachmentHandles(attachments: Attachment[]) {
  return attachments.flatMap((attachment) => attachment.attachmentHandle ? [attachment.attachmentHandle] : []);
}

export function isSupportedDroppedImage(file: Pick<File, "name" | "type">) {
  if (isSupportedInlineImageMime(file.type)) return true;
  return !file.type && /\.(?:png|jpe?g|webp|gif)$/i.test(file.name);
}

function totalAttachmentBytes(attachments: Attachment[]) {
  return attachments.reduce((total, attachment) => total + attachment.size, 0);
}

function totalImageAttachmentBytes(attachments: Attachment[]) {
  return attachments.reduce(
    (total, attachment) => total + (attachment.isImage ? attachment.size : 0),
    0,
  );
}

export function mergeAttachmentSelection(
  current: Attachment[],
  incoming: Attachment[],
): { attachments: Attachment[]; issue?: AttachmentSelectionIssue } {
  const accepted = [...current];
  let attachmentBytes = totalAttachmentBytes(current);
  let imageBytes = totalImageAttachmentBytes(current);
  let issue: AttachmentSelectionIssue | undefined;
  for (const attachment of incoming) {
    if (accepted.length >= MAX_ATTACHMENT_COUNT) {
      issue ??= "count";
      continue;
    }
    if (!attachment.attachmentHandle) {
      issue ??= "missing-handle";
      continue;
    }
    if (attachment.isImage && attachment.size > MAX_IMAGE_ATTACHMENT_BYTES) {
      issue ??= "image-size";
      continue;
    }
    if (!attachment.isImage && attachment.size > MAX_DOCUMENT_ATTACHMENT_BYTES) {
      issue ??= "document-size";
      continue;
    }
    if (attachment.isImage && !isSupportedInlineImageMime(attachment.mimeType)) {
      issue ??= "unsupported-image";
      continue;
    }
    if (attachmentBytes + attachment.size > MAX_TOTAL_ATTACHMENT_BYTES) {
      issue ??= "attachment-total";
      continue;
    }
    if (attachment.isImage && imageBytes + attachment.size > MAX_TOTAL_IMAGE_BYTES) {
      issue ??= "image-total";
      continue;
    }
    accepted.push(attachment);
    attachmentBytes += attachment.size;
    if (attachment.isImage) imageBytes += attachment.size;
  }
  return { attachments: accepted, issue };
}

function attachmentIssueLabel(issue: AttachmentSelectionIssue, language: AppLanguage) {
  if (issue === "count") return bi(language, "Vous pouvez joindre au maximum 20 fichiers.", "You can attach up to 20 files.");
  if (issue === "image-size") return bi(language, "Une image dépasse la limite de 8 Mio.", "An image exceeds the 8 MiB limit.");
  if (issue === "document-size") return bi(language, "Un document dépasse la limite de 20 Mio.", "A document exceeds the 20 MiB limit.");
  if (issue === "image-total") return bi(language, "Le total des images jointes ne peut pas dépasser 10 Mio.", "Attached images cannot exceed 10 MiB in total.");
  if (issue === "attachment-total") return bi(language, "Le total des pièces jointes ne peut pas dépasser 40 Mio.", "Attachments cannot exceed 40 MiB in total.");
  if (issue === "missing-handle") return bi(language, "Une pièce jointe a expiré. Sélectionnez-la de nouveau.", "An attachment has expired. Select it again.");
  if (issue === "unsupported-image") return bi(language, "Seules les images PNG, JPEG, WebP et GIF sont prises en charge.", "Only PNG, JPEG, WebP, and GIF images are supported.");
  return bi(language, "Impossible de joindre ce fichier.", "This file could not be attached.");
}

export function attachmentDropError(error: unknown, language: AppLanguage) {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes("expir") || normalized.includes("autorisation") || normalized.includes("grant")) {
    return bi(language, "Le dépôt a expiré. Déposez de nouveau les fichiers.", "The drop expired. Drop the files again.");
  }
  if (normalized.includes("fichier(s)") || normalized.includes("maximum") || normalized.includes("count")) {
    return attachmentIssueLabel("count", language);
  }
  if (normalized.includes("budget") || normalized.includes("10 mio") || normalized.includes("8 mio")) {
    return bi(language, "Les pièces jointes dépassent les limites autorisées (8 Mio par image, 20 Mio par document, 10 Mio d’images et 40 Mio au total).", "The attachments exceed the limits (8 MiB per image, 20 MiB per document, 10 MiB of images and 40 MiB total).");
  }
  return bi(
    language,
    `Impossible de joindre les fichiers : ${message}`,
    "One or more files could not be attached. Check that they are readable regular files and try again.",
  );
}

export function attachmentSubmitError(error: unknown, language: AppLanguage) {
  const detail = error instanceof Error ? error.message : String(error);
  if (/expir|handle|disponible|available/i.test(detail)) {
    return bi(
      language,
      "La pièce jointe n’est plus disponible. Sélectionnez-la de nouveau.",
      "The attachment is no longer available. Select it again.",
    );
  }
  if (/^(La conversation n’est plus active\.|The conversation is no longer active\.)$/.test(detail)) {
    return bi(
      language,
      "Envoi impossible : la conversation n’est plus active.",
      "Could not send: the conversation is no longer active.",
    );
  }
  if (/^(Le chargement a été remplacé par une autre conversation\.|The conversation load was replaced by another conversation\.)$/.test(detail)) {
    return bi(
      language,
      "Envoi annulé : une autre conversation a été ouverte.",
      "Send cancelled: another conversation was opened.",
    );
  }
  return `${bi(language, "Envoi impossible.", "Could not send.")} ${detail}`.trim();
}

export function planModeTransitionError(error: unknown, language: AppLanguage) {
  const detail = error instanceof Error ? error.message : String(error);
  if (
    detail.includes("Le mode de cette conversation ne peut changer que lorsque Prime Agent est au repos.")
    || detail.includes("The conversation mode can only be changed while Prime Agent is idle.")
  ) {
    return bi(
      language,
      "Le mode de cette conversation ne peut changer que lorsque Prime Agent est au repos.",
      "The conversation mode can only be changed while Prime Agent is idle.",
    );
  }
  return detail;
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

export function normalizeLegacyActivity(activity: ActivityItem, language: AppLanguage): ActivityItem {
  if (activity.type !== "rlm_child_update") return activity;
  const raw = activity.raw && typeof activity.raw === "object" ? activity.raw as Record<string, unknown> : undefined;
  const child = raw?.child && typeof raw.child === "object" ? raw.child as Record<string, unknown> : undefined;
  if (!child) return activity;
  const label = typeof child.label === "string" ? child.label : typeof child.sessionName === "string" ? child.sessionName : bi(language, "sans nom", "unnamed");
  const rawStatus = typeof child.status === "string" ? child.status : "running";
  const status: AgentRlmChild["status"] = ["queued", "running", "done", "error", "cancelled"].includes(rawStatus)
    ? rawStatus as AgentRlmChild["status"]
    : "running";
  const presentation = subagentStatusPresentation({ status, error: typeof child.error === "string" ? child.error : undefined }, language);
  const childActivity = child.activity && typeof child.activity === "object" ? child.activity as Record<string, unknown> : undefined;
  const activityDetail = childActivity?.kind === "executing"
    ? `${bi(language, "Exécute", "Running")} ${typeof childActivity.toolName === "string" ? childActivity.toolName.replaceAll("_", " ") : bi(language, "un outil", "a tool")}`
    : childActivity?.kind === "writing" ? bi(language, "Rédige sa réponse", "Writing its response") : childActivity?.kind === "waiting" ? bi(language, "Attend une nouvelle étape", "Waiting for the next step") : undefined;
  const detail = presentation.visualStatus !== "closed" && typeof child.error === "string"
    ? child.error
    : typeof child.recap === "string"
      ? child.recap
      : activityDetail ?? (typeof child.answerPreview === "string" ? child.answerPreview : activity.detail);
  if (status === "done") return { ...activity, title: language === "en" ? `Sub-agent “${label}” complete` : `Sous-agent « ${label} » terminé`, detail, status: "success" };
  if (status === "error") return { ...activity, title: language === "en" ? `Sub-agent “${label}” failed` : `Échec du sous-agent « ${label} »`, detail, status: "error" };
  if (presentation.visualStatus === "closed") return { ...activity, title: language === "en" ? `Sub-agent “${label}” closed by the main agent` : `Sous-agent « ${label} » fermé par l’agent principal`, detail, status: "info" };
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
    "Prépare et publie une nouvelle release GitHub à partir de l’état actuel du projet. Analyse les changements depuis la dernière release, choisis la prochaine version SemVer appropriée, mets à jour toutes les versions et les notes nécessaires, exécute les validations, puis commit et pousse uniquement les fichiers du projet prévus. Crée ensuite un nouveau tag stable sans jamais écraser un tag existant : le workflow GitHub Signed Windows release doit construire les installateurs, leurs signatures et latest.json dans une release brouillon. Attends sa fin, vérifie le brouillon, les artefacts signés et le manifeste de mise à jour, complète les notes, puis publie ce brouillon. Ne fabrique ni ne téléverse d’artefact updater non signé localement. Vérifie qu’aucun secret ni fichier hors périmètre n’est inclus ; si une étape est bloquée, explique précisément pourquoi.",
    "Prepare and publish a new GitHub release from the project’s current state. Analyze changes since the previous release, choose the appropriate next SemVer version, update every required version and release note, run validation, then commit and push only the intended project files. Create a new stable tag without ever overwriting an existing tag: the GitHub Signed Windows release workflow must build the installers, their signatures, and latest.json in a draft release. Wait for it to finish, verify the draft, signed assets, and updater manifest, complete the notes, then publish that draft. Do not build or upload unsigned updater artifacts locally. Verify that no secret or out-of-scope file is included; if any step is blocked, explain exactly why.",
  );
}
