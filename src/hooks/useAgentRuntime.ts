import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isNative,
  listenToAgentEvents,
  loadSessionHistory,
  mutateAgentQueue,
  sendRpc,
  startAgent,
  stopAgent,
  type QueueMutation,
  type StartAgentOptions,
} from "../lib/bridge";
import { redactText, redactValue } from "../lib/redaction";
import type {
  ActivityItem,
  AgentRlmChild,
  AgentSessionState,
  AgentSchedule,
  AgentHeartbeatSummary,
  Attachment,
  ChatMessage,
  Conversation,
  ExtensionUiRequest,
  ModelInfo,
  PendingExtensionUiRequest,
  Project,
  RpcEnvelope,
  RuntimeDetection,
  SessionStats,
  SessionActionSnapshot,
  SlashCommand,
  ThinkingLevel,
  ToolActivity,
} from "../types";

interface ConversationRuntime {
  state?: AgentSessionState;
  models: ModelInfo[];
  commands: SlashCommand[];
  stats?: SessionStats;
  schedules?: AgentSchedule[];
  heartbeat?: AgentSchedule | null;
  heartbeats?: AgentHeartbeatSummary[];
  subagents?: AgentRlmChild[];
  observedSubagent?: {
    activeSessionId: string;
    messages: ChatMessage[];
    closed?: boolean;
    error?: string;
  };
  logs: Array<{ id: string; stream: "rpc" | "stderr"; text: string; createdAt: string }>;
}

interface RuntimeMap {
  [conversationId: string]: ConversationRuntime | undefined;
}

interface SelectionToken {
  conversationId?: string;
  generation: number;
}

interface PendingSelectionRequest {
  conversationId: string;
  generation: number;
  timeout: number;
  resolve?: (message: RpcEnvelope) => void;
  reject?: (error: Error) => void;
}

const HISTORY_RESPONSE_TIMEOUT_MS = 30_000;
const HISTORY_REQUEST_ATTEMPTS = 1;
const PASSIVE_RESPONSE_TIMEOUT_MS = 30_000;
const SELECTION_SCOPED_COMMANDS = new Set([
  "get_state",
  "get_messages",
  "get_available_models",
  "get_commands",
  "get_session_stats",
]);
const ACKNOWLEDGED_COMMANDS = new Set([
  "add_schedule",
  "cancel_schedule",
  "set_heartbeat",
  "update_heartbeat",
  "manage_heartbeat",
  "observe",
  "unobserve",
]);

const now = () => new Date().toISOString();
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const localHistoryIdentity = (conversation: Pick<Conversation, "id" | "sessionPath" | "sessionId">) => (
  `${conversation.id}\0${conversation.sessionPath ?? ""}\0${conversation.sessionId ?? ""}`
);
const localHistoryConversationPrefix = (conversationId: string) => `${conversationId}\0`;

const cleanDiagnostic = (value: unknown) => (
  typeof value === "string" && value.trim() ? redactText(value.trim()) : undefined
);

/** Only durable display metadata is allowed into app state. Native image
 * handles are short-lived capabilities. The optional preview is a bounded
 * thumbnail generated natively, never the original image bytes. */
export function durableAttachmentMetadata(attachment: Attachment): Attachment {
  return {
    id: attachment.id,
    name: attachment.name,
    ...(attachment.path ? { path: attachment.path } : {}),
    mimeType: attachment.mimeType,
    size: attachment.size,
    isImage: attachment.isImage,
    ...(attachment.previewDataUrl ? { previewDataUrl: attachment.previewDataUrl } : {}),
  };
}

export interface PromptTransaction {
  conversationId: string;
  messageId: string;
  previous: Pick<Conversation, "draft" | "hasContent" | "status" | "title" | "updatedAt">;
  optimisticStatus: Conversation["status"];
  optimisticTitle: string;
  optimisticUpdatedAt: string;
  previousMessageCount: number;
  previousActivityCount: number;
}

export function beginPromptTransaction(
  conversation: Conversation,
  input: { message: string; attachments: Attachment[]; messageId: string; createdAt: string; queuedPayload?: string; forceQueued?: boolean; queuedDelivery?: "steer" | "follow_up" },
): { conversation: Conversation; transaction: PromptTransaction } {
  const isFirst = conversation.messages.every((item) => item.role !== "user");
  const title = isFirst && conversation.title === "Nouvelle conversation"
    ? makeTitle(input.message.trim() || input.attachments[0]?.name || "Nouvelle conversation")
    : conversation.title;
  const queued = input.forceQueued === true
    || conversation.status === "streaming"
    || conversation.status === "tool"
    || conversation.status === "queued";
  const status = queued
    ? "queued"
    : "streaming";
  const localMessage: ChatMessage = {
    id: input.messageId,
    role: "user",
    content: input.message.trim() || "Analyse les pièces jointes.",
    createdAt: input.createdAt,
    status: "pending",
    attachments: input.attachments.map(durableAttachmentMetadata),
    ...(queued ? {
      queueDelivery: input.queuedDelivery ?? "follow_up",
      queueObserved: false,
      queueText: input.queuedPayload ?? input.message.trim(),
    } : {}),
  };
  return {
    conversation: {
      ...conversation,
      title,
      hasContent: true,
      status,
      messages: [...conversation.messages, localMessage],
      updatedAt: input.createdAt,
    },
    transaction: {
      conversationId: conversation.id,
      messageId: input.messageId,
      previous: {
        draft: conversation.draft,
        hasContent: conversation.hasContent,
        status: conversation.status,
        title: conversation.title,
        updatedAt: conversation.updatedAt,
      },
      optimisticStatus: status,
      optimisticTitle: title,
      optimisticUpdatedAt: input.createdAt,
      previousMessageCount: conversation.messages.length,
      previousActivityCount: conversation.activities.length,
    },
  };
}

/** Reconciles optimistic queue rows with Prime Agent's authoritative lanes.
 * A row stays out of the transcript while queued, then becomes a normal user
 * turn only after Prime Agent has exposed it in the queue and later removes it,
 * or explicitly marks it as the active action. Merely accepting the prompt is
 * not delivery evidence: the queue snapshot can lag just after the RPC reply. */
export function reconcileQueuedMessages(
  conversation: Conversation,
  actions: AgentSessionState["sessionActions"] | undefined,
): Conversation {
  if (!actions || !conversation.messages.some((message) => message.queueDelivery)) return conversation;
  const available = {
    steer: [...(actions.steering ?? [])],
    follow_up: [...(actions.followUps ?? [])],
  };
  let changed = false;
  let activeConsumed = false;
  const activeLabel = actions.active?.kind === "turn" ? normalizeQueuedText(actions.active.label ?? "") : "";
  const messages: ChatMessage[] = [];
  const delivered: ChatMessage[] = [];
  for (const message of conversation.messages) {
    const lane = message.queueDelivery;
    if (!lane) {
      messages.push(message);
      continue;
    }
    const payload = message.queueText ?? message.content;
    const index = available[lane].findIndex((text) => text === payload);
    if (index >= 0) {
      available[lane].splice(index, 1);
      if (message.queueObserved) messages.push(message);
      else {
        changed = true;
        messages.push({ ...message, queueObserved: true });
      }
      continue;
    }
    const isActive: boolean = !activeConsumed
      && activeLabel.length > 0
      && activeLabel === normalizeQueuedText(payload);
    if (!message.queueObserved && !isActive) {
      messages.push(message);
      continue;
    }
    if (isActive) activeConsumed = true;
    changed = true;
    delivered.push(withoutQueueMetadata(message));
  }
  return changed ? { ...conversation, messages: [...messages, ...delivered] } : conversation;
}

function normalizeQueuedText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function withoutQueueMetadata(message: ChatMessage): ChatMessage {
  const {
    queueDelivery: _delivery,
    queueObserved: _observed,
    queueAccepted: _accepted,
    queueText: _queueText,
    ...delivered
  } = message;
  return { ...delivered, status: "complete" };
}

/** Places a queued user turn at its authoritative delivery position.
 * Prime Agent emits a user message_start immediately before the assistant turn;
 * using that event avoids exposing accepted prompts before they are consumed. */
export function applyAuthoritativeUserMessageStart(
  conversation: Conversation,
  text: string,
  createdAt: string,
): Conversation {
  const normalized = normalizeQueuedText(text);
  if (!normalized) return conversation;
  const queuedIndex = conversation.messages.findIndex((message) => message.queueDelivery
    && normalizeQueuedText(message.queueText ?? message.content) === normalized);
  if (queuedIndex >= 0) {
    const messages = [...conversation.messages];
    const [queued] = messages.splice(queuedIndex, 1);
    if (!queued) return conversation;
    messages.push(withoutQueueMetadata(queued));
    return { ...conversation, hasContent: true, messages };
  }

  let pendingIndex = -1;
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    const message = conversation.messages[index]!;
    if (message.role === "user"
      && message.status === "pending"
      && normalizeQueuedText(message.content) === normalized) {
      pendingIndex = index;
      break;
    }
  }
  if (pendingIndex >= 0) {
    const messages = [...conversation.messages];
    messages[pendingIndex] = { ...messages[pendingIndex]!, status: "complete" };
    return { ...conversation, hasContent: true, messages };
  }

  const lastVisible = [...conversation.messages].reverse().find((message) => !message.queueDelivery);
  if (lastVisible?.role === "user" && normalizeQueuedText(lastVisible.content) === normalized) {
    return conversation;
  }

  return {
    ...conversation,
    hasContent: true,
    messages: [...conversation.messages, {
      id: uid("user"),
      role: "user",
      content: text,
      createdAt,
      status: "complete",
    }],
  };
}

export function commitPromptTransaction(conversation: Conversation, transaction: PromptTransaction): Conversation {
  if (conversation.id !== transaction.conversationId) return conversation;
  let changed = false;
  const messages = conversation.messages.map((message) => {
    if (message.id !== transaction.messageId || message.status !== "pending") return message;
    changed = true;
    return {
      ...message,
      status: "complete" as const,
      ...(message.queueDelivery ? { queueAccepted: true } : {}),
    };
  });
  return changed ? { ...conversation, messages } : conversation;
}

export function applyQueueMutationSnapshot(
  actions: SessionActionSnapshot,
  lane: "steering" | "followUp",
  index: number,
  expectedText: string,
  mutation: QueueMutation,
): SessionActionSnapshot {
  const steering = [...(actions.steering ?? [])];
  const followUps = [...(actions.followUps ?? [])];
  const source = lane === "steering" ? steering : followUps;
  const actualIndex = source[index] === expectedText ? index : source.indexOf(expectedText);
  if (actualIndex < 0) return actions;

  if (mutation.type === "delete") {
    source.splice(actualIndex, 1);
  } else if (mutation.type === "move") {
    const destination = actualIndex + mutation.direction;
    if (destination < 0 || destination >= source.length) return actions;
    [source[actualIndex], source[destination]] = [source[destination]!, source[actualIndex]!];
  } else {
    const destination = mutation.lane === "steering" ? steering : followUps;
    if (destination === source) {
      source.splice(actualIndex, 1, mutation.text);
    } else {
      source.splice(actualIndex, 1);
      destination.push(mutation.text);
    }
  }
  return {
    ...actions,
    steering,
    followUps,
    queuedCount: steering.length + followUps.length,
  };
}

export function rollbackPromptTransaction(conversation: Conversation, transaction: PromptTransaction): Conversation {
  if (conversation.id !== transaction.conversationId) return conversation;
  const messages = conversation.messages.filter((message) => message.id !== transaction.messageId);
  if (messages.length === conversation.messages.length) return conversation;
  const hasConcurrentContent = messages.length !== transaction.previousMessageCount
    || conversation.activities.length !== transaction.previousActivityCount;
  return {
    ...conversation,
    messages,
    status: conversation.status === transaction.optimisticStatus ? transaction.previous.status : conversation.status,
    title: conversation.title === transaction.optimisticTitle ? transaction.previous.title : conversation.title,
    hasContent: !hasConcurrentContent && conversation.hasContent === true
      ? transaction.previous.hasContent
      : conversation.hasContent,
    draft: conversation.draft === "" ? transaction.previous.draft : conversation.draft,
    updatedAt: conversation.updatedAt === transaction.optimisticUpdatedAt
      ? transaction.previous.updatedAt
      : conversation.updatedAt,
  };
}

export function extensionRequestKey(conversationId: string, requestId: string) {
  return `${conversationId}\0${requestId}`;
}

export function enqueueExtensionRequest(
  requests: PendingExtensionUiRequest[],
  request: PendingExtensionUiRequest,
): PendingExtensionUiRequest[] {
  const existing = requests.findIndex((item) => item.requestKey === request.requestKey);
  if (existing < 0) return [...requests, request];
  const next = [...requests];
  next[existing] = request;
  return next;
}

/**
 * Builds the authoritative diagnostic for a process exit. stderr usually
 * contains the actionable Node/Python error, while the bridge error explains
 * the lifecycle failure. Keep both when they differ instead of hiding either
 * behind the generic history-request cancellation.
 */
export function agentExitErrorMessage(input: {
  code?: number;
  success: boolean;
  error?: string;
  stderr?: string;
}): string {
  const bridgeError = cleanDiagnostic(input.error);
  const stderr = cleanDiagnostic(input.stderr);
  if (bridgeError && stderr) {
    if (bridgeError.includes(stderr)) return bridgeError;
    if (stderr.includes(bridgeError)) return stderr;
    return `${bridgeError}\n\n${stderr}`;
  }
  if (stderr) return stderr;
  if (bridgeError) return bridgeError;
  return input.success
    ? "Prime Agent s’est fermé avant la fin du chargement."
    : `Prime Agent s’est arrêté (code ${input.code ?? "inconnu"}).`;
}

/** Prefer an exit diagnostic over the secondary error caused by cancelling a
 * pending get_messages request. This is deliberately pure so the race remains
 * covered without mounting the React hook. */
export function startupErrorMessage(error: unknown, exitDiagnostic?: string): string {
  return cleanDiagnostic(exitDiagnostic)
    ?? (error instanceof Error ? error.message : String(error));
}

export function useAgentRuntime(options: {
  active?: boolean;
  detection?: RuntimeDetection;
  selectedProject?: Project;
  selectedConversation?: Conversation;
  getProject: (projectId: string) => Project | undefined;
  getConversation: (conversationId: string) => Conversation | undefined;
  preserveSessionReference: (conversationId: string, title: string) => string | undefined;
  discardSessionReference: (conversationId: string) => void;
  updateConversation: (id: string, updater: Partial<Conversation> | ((current: Conversation) => Conversation)) => void;
  onInstallProgress: (phase: string, message: string) => void;
  onInstallComplete: (detection: RuntimeDetection) => void;
}) {
  const {
    active = true,
    detection,
    selectedProject,
    selectedConversation,
    getConversation,
    preserveSessionReference,
    discardSessionReference,
    updateConversation,
    onInstallProgress,
    onInstallComplete,
  } = options;
  const [runtimes, setRuntimes] = useState<RuntimeMap>({});
  const [extensionRequests, setExtensionRequests] = useState<PendingExtensionUiRequest[]>([]);
  const [eventsReady, setEventsReady] = useState(!isNative());
  const started = useRef(new Set<string>());
  const startInFlight = useRef(new Map<string, Promise<void>>());
  const historyInFlight = useRef(new Map<string, Promise<void>>());
  const historyLoaded = useRef(new Set<string>());
  const localHistoryInFlight = useRef(new Map<string, Promise<void>>());
  const localHistoryLoaded = useRef(new Set<string>());
  const localHistoryApplied = useRef(new Map<string, string>());
  const bootstrapGeneration = useRef(new Map<string, number>());
  const pendingSelectionRequests = useRef(new Map<string, PendingSelectionRequest>());
  const activeSelection = useRef<SelectionToken>({ generation: 0 });
  const selectedConversationId = useRef(active ? selectedConversation?.id : undefined);
  const intentionallyStopped = useRef(new Set<string>());
  const activeBashActivities = useRef(new Map<string, string>());
  const lastStderr = useRef(new Map<string, string>());
  const processExitErrors = useRef(new Map<string, string>());
  // React state can lag by one render between two very fast submissions. This
  // process-local marker closes that gap so the second prompt is represented
  // as queued even when both handlers crossed ensureStarted concurrently.
  const activePromptRuns = useRef(new Set<string>());
  const extensionResponsesInFlight = useRef(new Set<string>());
  const getConversationRef = useRef(getConversation);

  // Event callbacks can run between React's render and effect phases. Keeping
  // this ref current prevents a late history response from the previous
  // conversation from ever replacing the newly selected transcript.
  selectedConversationId.current = active ? selectedConversation?.id : undefined;
  getConversationRef.current = getConversation;

  const isCurrentSelection = useCallback((conversationId: string, generation: number) => (
    selectedConversationId.current === conversationId
      && activeSelection.current.conversationId === conversationId
      && activeSelection.current.generation === generation
  ), []);

  const clearPendingRequest = useCallback((requestId: string, error?: Error) => {
    const pending = pendingSelectionRequests.current.get(requestId);
    if (!pending) return;
    pendingSelectionRequests.current.delete(requestId);
    window.clearTimeout(pending.timeout);
    if (error) pending.reject?.(error);
  }, []);

  const cancelConversationRequests = useCallback((conversationId: string, reason: string) => {
    for (const [requestId, pending] of pendingSelectionRequests.current) {
      if (pending.conversationId !== conversationId) continue;
      clearPendingRequest(requestId, new Error(reason));
    }
    historyInFlight.current.delete(conversationId);
    historyLoaded.current.delete(conversationId);
    const localPrefix = localHistoryConversationPrefix(conversationId);
    for (const key of localHistoryInFlight.current.keys()) {
      if (key.startsWith(localPrefix)) localHistoryInFlight.current.delete(key);
    }
    bootstrapGeneration.current.delete(conversationId);
  }, [clearPendingRequest]);

  const sendSelectionRequest = useCallback((
    conversationId: string,
    generation: number,
    type: string,
    waitForResponse = false,
    fields: Record<string, unknown> = {},
  ): Promise<RpcEnvelope | void> => {
    if (!isCurrentSelection(conversationId, generation)) return Promise.resolve();
    const requestId = uid(type);
    let resolveResponse: ((message: RpcEnvelope) => void) | undefined;
    let rejectResponse: ((error: Error) => void) | undefined;
    const response = waitForResponse
      ? new Promise<RpcEnvelope>((resolve, reject) => {
          resolveResponse = resolve;
          rejectResponse = reject;
        })
      : Promise.resolve();
    const timeoutMs = waitForResponse ? HISTORY_RESPONSE_TIMEOUT_MS : PASSIVE_RESPONSE_TIMEOUT_MS;
    const timeout = window.setTimeout(() => {
      clearPendingRequest(requestId, waitForResponse
        ? new Error(`Prime Agent n’a pas répondu à ${type}.`)
        : undefined);
    }, timeoutMs);
    pendingSelectionRequests.current.set(requestId, {
      conversationId,
      generation,
      timeout,
      resolve: resolveResponse,
      reject: rejectResponse,
    });
    return sendRpc(conversationId, { id: requestId, type, ...fields })
      .then(() => response as Promise<RpcEnvelope | void>)
      .catch((error) => {
        clearPendingRequest(requestId);
        throw error;
      });
  }, [clearPendingRequest, isCurrentSelection]);

  const loadConversationHistory = useCallback((conversationId: string, generation: number) => {
    if (historyLoaded.current.has(conversationId)) return Promise.resolve();
    const existing = historyInFlight.current.get(conversationId);
    if (existing) return existing;

    const load = (async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < HISTORY_REQUEST_ATTEMPTS; attempt += 1) {
        if (!isCurrentSelection(conversationId, generation)) return;
        try {
          const response = await sendSelectionRequest(conversationId, generation, "get_messages", true);
          if (!response || !isCurrentSelection(conversationId, generation)) return;
          if (response.success === false) throw new Error(response.error ?? "Le chargement de la conversation a échoué.");
          const data = asRecord(response.data);
          if (!Array.isArray(data?.messages)) throw new Error("Prime Agent a renvoyé un historique invalide.");
          historyLoaded.current.add(conversationId);
          return;
        } catch (error) {
          lastError = error;
        }
      }
      if (isCurrentSelection(conversationId, generation)) {
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
      }
    })().finally(() => {
      if (historyInFlight.current.get(conversationId) === load) {
        historyInFlight.current.delete(conversationId);
      }
    });
    historyInFlight.current.set(conversationId, load);
    return load;
  }, [isCurrentSelection, sendSelectionRequest]);

  const loadLocalConversationHistory = useCallback((
    conversation: Conversation,
    project: Project,
    generation: number,
  ) => {
    if (!isNative() || !conversation.sessionPath) return Promise.resolve();
    const identity = localHistoryIdentity(conversation);
    if (
      localHistoryLoaded.current.has(identity)
      && localHistoryApplied.current.get(conversation.id) === identity
      && conversation.messages.length > 0
    ) {
      return Promise.resolve();
    }
    localHistoryLoaded.current.delete(identity);
    const existing = localHistoryInFlight.current.get(identity);
    if (existing) return existing;

    const load = loadSessionHistory(
      conversation.sessionPath,
      conversation.sessionId,
      project.path,
    )
      .then((history) => {
        if (!isCurrentSelection(conversation.id, generation)) return;
        const currentMetadata = getConversationRef.current(conversation.id);
        if (!currentMetadata || localHistoryIdentity(currentMetadata) !== identity) return;
        localHistoryLoaded.current.add(identity);
        const mapped = mapAgentMessages(history.messages);
        updateConversation(conversation.id, (current) => {
          // RPC text remains authoritative, but the bounded local-history
          // reader is the only source of safe historical image thumbnails.
          // Merge those previews regardless of which asynchronous load wins.
          if (historyLoaded.current.has(conversation.id)) {
            return {
              ...current,
              messages: mergeHistoricalAttachmentPreviews(current.messages, mapped),
            };
          }
          const previousLocalIdentity = localHistoryApplied.current.get(conversation.id);
          // Preserve live/user messages, while allowing a newly selected local
          // session to replace a transcript known to come from an older path.
          if (current.messages.length > 0 && !previousLocalIdentity) return current;
          localHistoryApplied.current.set(conversation.id, identity);
          return {
            ...current,
            messages: mapped,
            hasContent: history.messages.length > 0 ? true : current.hasContent,
          };
        });
      })
      .finally(() => {
        if (localHistoryInFlight.current.get(identity) === load) {
          localHistoryInFlight.current.delete(identity);
        }
      });
    localHistoryInFlight.current.set(identity, load);
    return load;
  }, [isCurrentSelection, updateConversation]);

  const ensureRuntime = useCallback((conversationId: string) => {
    setRuntimes((current) => {
      if (current[conversationId]) return current;
      return { ...current, [conversationId]: { models: [], commands: [], logs: [] } };
    });
  }, []);

  const addActivity = useCallback(
    (conversationId: string, activity: Omit<ActivityItem, "id" | "createdAt"> & { id?: string; createdAt?: string }) => {
      updateConversation(conversationId, (conversation) => {
        const id = activity.id ?? uid("activity");
        const index = conversation.activities.findIndex((item) => item.id === id);
        const previous = index >= 0 ? conversation.activities[index] : undefined;
        const eventTime = activity.updatedAt ?? activity.createdAt ?? now();
        const next: ActivityItem = {
          ...previous,
          id,
          createdAt: previous?.createdAt ?? activity.createdAt ?? eventTime,
          updatedAt: eventTime,
          updateCount: previous ? (previous.updateCount ?? 1) + (activity.updateCount ?? 1) : activity.updateCount ?? 1,
          type: activity.type,
          title: redactText(activity.title),
          detail: activity.detail ? redactText(activity.detail) : previous?.detail,
          status: activity.status,
          raw: activity.raw === undefined ? undefined : redactValue(activity.raw),
        };
        const activities = [...conversation.activities];
        if (index >= 0) activities[index] = next;
        else activities.push(next);
        return { ...conversation, activities: activities.slice(-240) };
      });
    },
    [updateConversation],
  );

  const addLog = useCallback((conversationId: string, stream: "rpc" | "stderr", text: string) => {
    setRuntimes((current) => {
      const runtime = current[conversationId] ?? { models: [], commands: [], logs: [] };
      return {
        ...current,
        [conversationId]: {
          ...runtime,
          logs: [...runtime.logs, { id: uid("log"), stream, text: redactText(text), createdAt: now() }].slice(-500),
        },
      };
    });
  }, []);

  const handleResponse = useCallback(
    (conversationId: string, message: RpcEnvelope) => {
      const requestId = textValue(message.id);
      const scopedCommand = SELECTION_SCOPED_COMMANDS.has(message.command ?? "");
      const pending = requestId ? pendingSelectionRequests.current.get(requestId) : undefined;
      if (pending) {
        pendingSelectionRequests.current.delete(requestId!);
        window.clearTimeout(pending.timeout);
        if (
          pending.conversationId !== conversationId
          || !isCurrentSelection(conversationId, pending.generation)
        ) {
          pending.reject?.(new Error("La conversation active a changé avant la réponse de Prime Agent."));
          return;
        }
        pending.resolve?.(message);
      } else if (scopedCommand) {
        // Bootstrap responses are accepted only when issued for the current
        // selection. This also drops late responses after rapid navigation.
        return;
      }

      if (message.success === false) {
        const error = cleanDiagnostic(message.error) ?? `La commande ${message.command ?? "RPC"} a échoué.`;
        updateConversation(conversationId, { status: "error", lastError: error });
        addActivity(conversationId, { type: "error", title: "Prime Agent a signalé une erreur", detail: error, status: "error", raw: message });
        return;
      }

      const data = message.data as Record<string, unknown> | undefined;
      if (message.command === "get_state" && data) {
        const sessionState = data as unknown as AgentSessionState;
        setRuntimes((current) => ({
          ...current,
          [conversationId]: { ...(current[conversationId] ?? { models: [], commands: [], logs: [] }), state: sessionState },
        }));
        updateConversation(conversationId, (conversation) => reconcileQueuedMessages({
          ...conversation,
          title: !conversation.sessionNameSyncPending && sessionState.sessionName?.trim()
            ? sessionState.sessionName.trim()
            : conversation.title,
          sessionPath: sessionState.sessionFile ?? conversation.sessionPath,
          sessionId: sessionState.sessionId ?? conversation.sessionId,
          model: sessionState.model ? `${sessionState.model.provider}/${sessionState.model.id}` : conversation.model,
          thinkingLevel: sessionState.thinkingLevel ?? conversation.thinkingLevel,
          // Keep the central loading state visible until get_messages has
          // actually populated the transcript.
          status: sessionState.isStreaming ? "streaming" : conversation.status === "starting" ? "starting" : "idle",
          lastError: undefined,
        }, sessionState.sessionActions));
        return;
      }

      if (message.command === "get_messages" && data && Array.isArray(data.messages)) {
        historyLoaded.current.add(conversationId);
        localHistoryApplied.current.delete(conversationId);
        const mapped = mapAgentMessages(data.messages);
        const sourceMessageCount = data.messages.length;
        updateConversation(conversationId, (conversation) => ({
          ...conversation,
          messages: mergeHistoricalAttachmentPreviews(mapped, conversation.messages),
          hasContent: sourceMessageCount > 0 ? true : conversation.hasContent,
          status: conversation.status === "starting" || conversation.status === "offline" || conversation.status === "error"
            ? "idle"
            : conversation.status,
          lastError: undefined,
        }));
        return;
      }

      if (message.command === "get_available_models" && data && Array.isArray(data.models)) {
        setRuntimes((current) => ({
          ...current,
          [conversationId]: {
            ...(current[conversationId] ?? { models: [], commands: [], logs: [] }),
            models: data.models as ModelInfo[],
          },
        }));
        return;
      }

      if (message.command === "get_commands" && data && Array.isArray(data.commands)) {
        setRuntimes((current) => ({
          ...current,
          [conversationId]: {
            ...(current[conversationId] ?? { models: [], commands: [], logs: [] }),
            commands: data.commands as SlashCommand[],
          },
        }));
        return;
      }

      if (message.command === "get_session_stats" && data) {
        setRuntimes((current) => ({
          ...current,
          [conversationId]: {
            ...(current[conversationId] ?? { models: [], commands: [], logs: [] }),
            stats: data as unknown as SessionStats,
          },
        }));
        return;
      }

      if (message.command === "list_schedules" && data && Array.isArray(data.jobs)) {
        setRuntimes((current) => ({
          ...current,
          [conversationId]: {
            ...(current[conversationId] ?? { models: [], commands: [], logs: [] }),
            schedules: data.jobs as AgentSchedule[],
          },
        }));
        return;
      }

      if (message.command === "list_heartbeats" && data && Array.isArray(data.heartbeats)) {
        setRuntimes((current) => ({
          ...current,
          [conversationId]: {
            ...(current[conversationId] ?? { models: [], commands: [], logs: [] }),
            heartbeats: data.heartbeats as AgentHeartbeatSummary[],
          },
        }));
        return;
      }

      if (message.command === "get_heartbeat" && data && "heartbeat" in data) {
        setRuntimes((current) => ({
          ...current,
          [conversationId]: {
            ...(current[conversationId] ?? { models: [], commands: [], logs: [] }),
            heartbeat: (data.heartbeat ?? null) as AgentSchedule | null,
          },
        }));
        return;
      }

      if (["add_schedule", "cancel_schedule", "set_heartbeat", "update_heartbeat", "manage_heartbeat"].includes(String(message.command))) {
        window.setTimeout(() => {
          const token = activeSelection.current;
          if (token.conversationId !== conversationId) return;
          void sendSelectionRequest(conversationId, token.generation, "list_schedules", true, { includeInactive: false }).catch(() => undefined);
          void sendSelectionRequest(conversationId, token.generation, "get_heartbeat").catch(() => undefined);
          void sendSelectionRequest(conversationId, token.generation, "list_heartbeats").catch(() => undefined);
        }, 100);
        return;
      }

      if (message.command === "set_session_name") {
        const current = getConversationRef.current(conversationId);
        if (current) {
          updateConversation(conversationId, { sessionNameSyncPending: false });
          setRuntimes((runtimes) => {
            const runtime = runtimes[conversationId];
            if (!runtime?.state) return runtimes;
            return {
              ...runtimes,
              [conversationId]: { ...runtime, state: { ...runtime.state, sessionName: current.title } },
            };
          });
        }
        return;
      }

      if (message.command === "export_html" && data && typeof data.path === "string") {
        addActivity(conversationId, {
          type: "export",
          title: "Session exportée",
          detail: data.path,
          status: "success",
        });
        return;
      }

      if (["new_session", "fork", "clone", "switch_session"].includes(String(message.command)) && data?.cancelled !== true) {
        updateConversation(conversationId, {
          messages: [],
          activities: [],
          hasContent: message.command === "new_session" ? false : true,
          status: "idle",
          sessionPath: undefined,
          sessionId: undefined,
        });
        historyLoaded.current.delete(conversationId);
        localHistoryApplied.current.delete(conversationId);
        const localPrefix = localHistoryConversationPrefix(conversationId);
        for (const key of localHistoryLoaded.current) {
          if (key.startsWith(localPrefix)) localHistoryLoaded.current.delete(key);
        }
        for (const key of localHistoryInFlight.current.keys()) {
          if (key.startsWith(localPrefix)) localHistoryInFlight.current.delete(key);
        }
        window.setTimeout(() => {
          const token = activeSelection.current;
          if (token.conversationId !== conversationId) return;
          void sendSelectionRequest(conversationId, token.generation, "get_state").catch(() => undefined);
          void loadConversationHistory(conversationId, token.generation).catch(() => undefined);
        }, 120);
        return;
      }

      if (["set_steering_mode", "set_follow_up_mode", "set_auto_compaction", "set_auto_retry"].includes(message.command ?? "")) {
        window.setTimeout(() => {
          const token = activeSelection.current;
          if (token.conversationId !== conversationId) return;
          void sendSelectionRequest(conversationId, token.generation, "get_state").catch(() => undefined);
        }, 80);
        return;
      }

      if (message.command === "set_model" && data) {
        const model = data as unknown as ModelInfo;
        updateConversation(conversationId, { model: `${model.provider}/${model.id}` });
      }
    },
    [addActivity, isCurrentSelection, loadConversationHistory, sendSelectionRequest, updateConversation],
  );

  const handleAgentEvent = useCallback(
    (conversationId: string, event: RpcEnvelope) => {
      const eventType = event.type;
      if (eventType === "response") {
        handleResponse(conversationId, event);
        return;
      }
      if (eventType === "extension_ui_request") {
        const request = event as ExtensionUiRequest;
        if (request.method === "notify") {
          addActivity(conversationId, {
            id: `notification:${request.id}`,
            type: "notification",
            title: request.message ?? "Notification Prime Agent",
            status: request.notifyType === "error" ? "error" : request.notifyType === "warning" ? "warning" : "info",
          });
          void sendRpc(conversationId, { type: "extension_ui_response", id: request.id, cancelled: true }).catch(() => undefined);
        } else if (request.method !== "setStatus" && request.method !== "setWidget" && request.method !== "setTitle" && request.method !== "set_editor_text") {
          const pendingRequest: PendingExtensionUiRequest = {
            ...request,
            conversationId,
            requestKey: extensionRequestKey(conversationId, request.id),
          };
          setExtensionRequests((current) => enqueueExtensionRequest(current, pendingRequest));
        }
        return;
      }
      if (eventType === "agent_start") {
        activePromptRuns.current.add(conversationId);
        updateConversation(conversationId, { status: "streaming", lastError: undefined });
        addActivity(conversationId, { type: eventType, title: "Prime Agent réfléchit", status: "running", raw: event });
        return;
      }
      if (eventType === "agent_end") {
        activePromptRuns.current.delete(conversationId);
        const boundaryTime = now();
        updateConversation(conversationId, (conversation) => {
          const finalized = finalizeConversationTools(conversation, "completed", boundaryTime);
          return {
          ...finalized,
          status: "idle",
          messages: finalized.messages
            .filter((item) => item.role !== "assistant" || item.content.trim() || (item.tools?.length ?? 0) > 0)
            .map((item) => (item.status === "streaming" ? { ...item, status: "complete" } : item)),
          };
        });
        addActivity(conversationId, { type: eventType, title: "Exécution terminée", status: "success", raw: event });
        window.setTimeout(() => {
          const token = activeSelection.current;
          if (token.conversationId !== conversationId) return;
          void sendSelectionRequest(conversationId, token.generation, "get_session_stats").catch(() => undefined);
        }, 150);
        return;
      }
      if (eventType === "turn_end") {
        const boundaryTime = now();
        updateConversation(conversationId, (conversation) => finalizeTurnTools(conversation, event, boundaryTime));
        addActivity(conversationId, { type: eventType, title: "Tour de l’agent terminé", status: "success", raw: event });
        return;
      }
      if (eventType === "message_start" || eventType === "message_update" || eventType === "message_end") {
        handleMessageEvent(conversationId, event, updateConversation);
        return;
      }
      if (eventType === "tool_execution_start" || eventType === "tool_execution_update" || eventType === "tool_execution_end") {
        handleToolEvent(conversationId, event, updateConversation);
        return;
      }
      if (eventType === "rlm_child_update") {
        const child = asRecord(event.child);
        const childId = textValue(child?.id) ?? textValue(child?.sessionName) ?? textValue(child?.label) ?? "unknown";
        const childStatus = textValue(child?.status) ?? "running";
        const presentation = rlmChildPresentation(child, childStatus);
        addActivity(conversationId, {
          id: `rlm-child:${childId}`,
          type: eventType,
          title: presentation.title,
          detail: presentation.detail,
          status: presentation.status,
          raw: event,
        });
        if (child && textValue(child.id)) {
          const snapshot = redactValue(child) as unknown as AgentRlmChild;
          setRuntimes((current) => {
            const runtime = current[conversationId] ?? { models: [], commands: [], logs: [] };
            const children = runtime.subagents ?? [];
            const index = children.findIndex((item) => item.id === snapshot.id);
            const subagents = [...children];
            if (index >= 0) subagents[index] = { ...subagents[index], ...snapshot };
            else subagents.push(snapshot);
            return { ...current, [conversationId]: { ...runtime, subagents } };
          });
        }
        return;
      }
      if (eventType === "session_action_update") {
        const actions = event.actions as AgentSessionState["sessionActions"];
        setRuntimes((current) => {
          const runtime = current[conversationId];
          if (!runtime?.state) return current;
          return {
            ...current,
            [conversationId]: {
              ...runtime,
              state: { ...runtime.state, sessionActions: actions },
            },
          };
        });
        updateConversation(conversationId, (conversation) => reconcileQueuedMessages(conversation, actions));
        addActivity(conversationId, {
          id: "session-actions",
          type: eventType,
          title: "File d’actions mise à jour",
          detail: summarizeSessionActions(event.actions),
          status: "info",
          raw: event,
        });
        return;
      }
      if (eventType === "session_info_changed") {
        const sessionName = textValue(event.name)?.trim();
        if (sessionName) {
          updateConversation(conversationId, { title: sessionName, sessionNameSyncPending: false });
          setRuntimes((current) => {
            const runtime = current[conversationId];
            if (!runtime?.state) return current;
            return {
              ...current,
              [conversationId]: { ...runtime, state: { ...runtime.state, sessionName } },
            };
          });
        }
        addActivity(conversationId, {
          id: "session-info",
          type: eventType,
          title: sessionName ? "Nom de session synchronisé" : "Informations de session mises à jour",
          detail: sessionName,
          status: "info",
          raw: event,
        });
        return;
      }
      if (eventType === "recap_update") {
        addActivity(conversationId, {
          id: "session-recap",
          type: eventType,
          title: event.recap ? "Synthèse de progression mise à jour" : "Synthèse de progression effacée",
          detail: typeof event.recap === "string" ? event.recap.slice(0, 220) : undefined,
          status: "info",
          raw: event,
        });
        return;
      }
      if (eventType === "observed_session_event") {
        const observed = observedSessionActivity(event);
        if (observed) addActivity(conversationId, observed);
        const activeSessionId = textValue(event.activeSessionId);
        const nested = asRecord(event.event);
        if (activeSessionId && nested?.type === "message_end" && nested.message) {
          const mapped = mapAgentMessages([nested.message]);
          if (mapped.length) {
            setRuntimes((current) => {
              const runtime = current[conversationId];
              if (!runtime?.observedSubagent || runtime.observedSubagent.activeSessionId !== activeSessionId) return current;
              return {
                ...current,
                [conversationId]: {
                  ...runtime,
                  observedSubagent: {
                    ...runtime.observedSubagent,
                    messages: [...runtime.observedSubagent.messages, ...mapped].slice(-160),
                  },
                },
              };
            });
          }
        }
        return;
      }
      if (eventType === "observed_session_closed") {
        const activeSessionId = textValue(event.activeSessionId) ?? "unknown";
        setRuntimes((current) => {
          const runtime = current[conversationId];
          if (!runtime?.observedSubagent || runtime.observedSubagent.activeSessionId !== activeSessionId) return current;
          return {
            ...current,
            [conversationId]: {
              ...runtime,
              observedSubagent: {
                ...runtime.observedSubagent,
                closed: true,
                error: cleanDiagnostic(event.error),
              },
            },
          };
        });
        addActivity(conversationId, {
          id: `observed-session:${activeSessionId}:closed`,
          type: eventType,
          title: "Sous-session observée terminée",
          detail: textValue(event.error),
          status: event.error ? "error" : "success",
          raw: event,
        });
        return;
      }
      if (eventType === "bash_start") {
        const explicitRunId = textValue(event.runId);
        const activityId = explicitRunId ? `bash:${explicitRunId}` : uid("bash-activity");
        activeBashActivities.current.set(conversationId, activityId);
        addActivity(conversationId, {
          id: activityId,
          type: eventType,
          title: "Commande système en cours",
          detail: typeof event.command === "string" ? event.command.slice(0, 180) : undefined,
          status: "running",
          raw: event,
        });
        return;
      }
      if (eventType === "bash_output") {
        // Output chunks remain available in the raw event log. Rendering one
        // timeline row per chunk makes the inspector unusable on long commands.
        return;
      }
      if (eventType === "bash_end") {
        const explicitRunId = textValue(event.runId);
        const activityId = explicitRunId
          ? `bash:${explicitRunId}`
          : activeBashActivities.current.get(conversationId) ?? uid("bash-activity");
        activeBashActivities.current.delete(conversationId);
        const cancelled = event.cancelled === true;
        const exitCode = typeof event.exitCode === "number" ? event.exitCode : undefined;
        const failed = Boolean(event.errorMessage) || (!cancelled && exitCode !== undefined && exitCode !== 0);
        addActivity(conversationId, {
          id: activityId,
          type: eventType,
          title: cancelled ? "Commande système annulée" : failed ? "Commande système échouée" : "Commande système terminée",
          detail: textValue(event.errorMessage) ?? (exitCode === undefined ? undefined : `Code de sortie ${exitCode}`),
          status: cancelled ? "warning" : failed ? "error" : "success",
          raw: event,
        });
        return;
      }
      if (eventType === "goal_update") {
        setRuntimes((current) => {
          const runtime = current[conversationId] ?? { models: [], commands: [], logs: [] };
          return {
            ...current,
            [conversationId]: {
              ...runtime,
              state: runtime.state ? { ...runtime.state, goal: event.goal as AgentSessionState["goal"] } : runtime.state,
            },
          };
        });
        const goal = asRecord(event.goal);
        const goalStatus = textValue(goal?.status) ?? "idle";
        addActivity(conversationId, {
          id: `goal:${textValue(goal?.goalId) ?? stableToken(goal?.objective)}`,
          type: eventType,
          title: goalActivityTitle(goalStatus),
          detail: summarizeGoal(event.goal),
          status: goalStatus === "complete" ? "success" : goalStatus === "error" ? "error" : goalStatus === "paused" || goalStatus === "budget_limited" ? "warning" : goalStatus === "active" ? "running" : "info",
          raw: event,
        });
        return;
      }
      if (eventType.includes("error") || eventType === "turn_error") {
        const error = redactText(String(event.error ?? event.message ?? "Erreur inconnue"));
        const boundaryTime = now();
        updateConversation(conversationId, (conversation) => ({
          ...finalizeConversationTools(conversation, "failed", boundaryTime),
          status: "error",
          lastError: error,
        }));
        addActivity(conversationId, { type: eventType, title: "Exécution interrompue", detail: error, status: "error", raw: event });
        return;
      }
      if (eventType !== "response") {
        addActivity(conversationId, { type: eventType, title: humanizeEvent(eventType), status: "info", raw: event });
      }
    },
    [addActivity, handleResponse, sendSelectionRequest, updateConversation],
  );

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listenToAgentEvents({
      onEvent: ({ conversationId, line }) => {
        try {
          const event = JSON.parse(line) as RpcEnvelope;
          addLog(conversationId, "rpc", summarizeRpcLog(line, event));
          handleAgentEvent(conversationId, event);
        } catch {
          addLog(conversationId, "rpc", truncateRuntimeLog(line));
          addActivity(conversationId, { type: "protocol", title: "Événement RPC illisible", detail: line.slice(0, 220), status: "warning" });
        }
      },
      onStderr: ({ conversationId, line }) => {
        const detail = redactText(line.trim());
        if (detail) {
          const previous = lastStderr.current.get(conversationId);
          lastStderr.current.set(conversationId, `${previous ? `${previous}\n` : ""}${detail}`.slice(-1_200));
        }
        addLog(conversationId, "stderr", truncateRuntimeLog(line));
      },
      onExit: ({ conversationId, code, success, error }) => {
        activePromptRuns.current.delete(conversationId);
        setExtensionRequests((current) => current.filter((request) => request.conversationId !== conversationId));
        started.current.delete(conversationId);
        startInFlight.current.delete(conversationId);
        const expected = intentionallyStopped.current.delete(conversationId);
        const stderr = lastStderr.current.get(conversationId);
        lastStderr.current.delete(conversationId);
        const exitDiagnostic = expected
          ? undefined
          : agentExitErrorMessage({ code, success, error, stderr });
        if (exitDiagnostic) processExitErrors.current.set(conversationId, exitDiagnostic);
        else processExitErrors.current.delete(conversationId);
        cancelConversationRequests(
          conversationId,
          exitDiagnostic ?? "Prime Agent s’est arrêté pendant le chargement.",
        );
        const terminalToolStatus: ToolActivity["status"] = expected ? "cancelled" : "failed";
        const boundaryTime = now();
        updateConversation(conversationId, (conversation) => ({
          ...finalizeConversationTools(conversation, terminalToolStatus, boundaryTime),
          status: expected ? "idle" : "error",
          lastError: exitDiagnostic,
        }));
      },
      onInstallProgress: ({ phase, message }) => onInstallProgress(phase, redactText(message)),
      onInstallComplete: (result) => onInstallComplete(redactValue(result)),
    }).then((fn) => {
      if (cancelled) fn();
      else {
        unlisten = fn;
        setEventsReady(true);
      }
    });
    return () => {
      cancelled = true;
      if (isNative()) setEventsReady(false);
      unlisten?.();
    };
  }, [addActivity, addLog, cancelConversationRequests, handleAgentEvent, onInstallComplete, onInstallProgress, updateConversation]);

  const ensureProcessStarted = useCallback(
    async (conversation: Conversation, project: Project) => {
      ensureRuntime(conversation.id);
      if (!isNative()) return;
      if (!detection?.installed) {
        throw new Error(detection?.error ?? "Prime Agent n’est pas installé.");
      }
      if (started.current.has(conversation.id)) return;
      const existing = startInFlight.current.get(conversation.id);
      if (existing) return existing;

      const modelRef = conversation.model ?? project.defaultModel;
      const slash = modelRef?.indexOf("/") ?? -1;
      const startOptions: StartAgentOptions = {
        conversationId: conversation.id,
        cwd: project.path,
        sessionPath: conversation.sessionPath,
        provider: slash > 0 ? modelRef?.slice(0, slash) : undefined,
        model: slash > 0 ? modelRef?.slice(slash + 1) : modelRef,
        thinking: conversation.thinkingLevel,
      };
      // A retry starts a new process attempt. Discard the previous terminal
      // diagnostic only here (not in ensureStarted, which can join an existing
      // attempt) so concurrent callers cannot erase a fresh exit error.
      processExitErrors.current.delete(conversation.id);
      lastStderr.current.delete(conversation.id);
      const start = startAgent(startOptions)
        .then(() => {
          const earlyExit = processExitErrors.current.get(conversation.id);
          if (earlyExit) throw new Error(earlyExit);
          intentionallyStopped.current.delete(conversation.id);
          started.current.add(conversation.id);
        })
        .finally(() => {
          if (startInFlight.current.get(conversation.id) === start) {
            startInFlight.current.delete(conversation.id);
          }
        });
      startInFlight.current.set(conversation.id, start);
      return start;
    },
    [detection?.error, detection?.installed, ensureRuntime],
  );

  const ensureStarted = useCallback(
    async (conversation: Conversation, project: Project) => {
      const token = activeSelection.current;
      if (
        !active
        || !eventsReady
        || token.conversationId !== conversation.id
        || selectedConversationId.current !== conversation.id
      ) throw new DOMException("La conversation n’est plus active.", "AbortError");

      if (!isNative()) {
        ensureRuntime(conversation.id);
        updateConversation(conversation.id, { status: "idle" });
        return;
      }

      if (!historyLoaded.current.has(conversation.id)) {
        updateConversation(conversation.id, { status: "starting", lastError: undefined });
      }
      try {
        await ensureProcessStarted(conversation, project);
        if (!isCurrentSelection(conversation.id, token.generation)) {
          throw new DOMException("Le chargement a été remplacé par une autre conversation.", "AbortError");
        }

        // State and history are the only critical-path requests. Large model
        // catalogs and stats are deliberately deferred until the transcript is
        // visible.
        if (bootstrapGeneration.current.get(conversation.id) !== token.generation) {
          bootstrapGeneration.current.set(conversation.id, token.generation);
          await sendSelectionRequest(conversation.id, token.generation, "get_state");
        }
        await loadConversationHistory(conversation.id, token.generation);
        const currentConversation = getConversationRef.current(conversation.id);
        if (currentConversation?.sessionNameSyncPending && currentConversation.title.trim()) {
          try {
            const response = await sendSelectionRequest(
              conversation.id,
              token.generation,
              "set_session_name",
              true,
              { name: currentConversation.title.trim() },
            );
            if (response?.success === false) throw new Error(response.error ?? "Le nom de session a été refusé.");
          } catch (error) {
            addActivity(conversation.id, {
              type: "session_name_sync",
              title: "Nom local non synchronisé",
              detail: error instanceof Error ? error.message : String(error),
              status: "warning",
            });
          }
        }
        if (isCurrentSelection(conversation.id, token.generation)) {
          void sendSelectionRequest(conversation.id, token.generation, "get_available_models").catch(() => undefined);
          void sendSelectionRequest(conversation.id, token.generation, "get_commands").catch(() => undefined);
          void sendSelectionRequest(conversation.id, token.generation, "get_session_stats").catch(() => undefined);
          void sendSelectionRequest(conversation.id, token.generation, "list_schedules", true, { includeInactive: false }).catch(() => undefined);
          void sendSelectionRequest(conversation.id, token.generation, "get_heartbeat").catch(() => undefined);
          void sendSelectionRequest(conversation.id, token.generation, "list_heartbeats").catch(() => undefined);
        }
      } catch (error) {
        if (isCurrentSelection(conversation.id, token.generation)) {
          // onExit rejects the pending get_messages request synchronously. Its
          // precise stderr diagnostic is authoritative over that derived
          // cancellation error, irrespective of React update ordering.
          const message = redactText(startupErrorMessage(
            error,
            processExitErrors.current.get(conversation.id),
          ));
          updateConversation(conversation.id, { status: "error", lastError: message });
        }
        throw error;
      }
    },
    [active, addActivity, ensureProcessStarted, ensureRuntime, eventsReady, isCurrentSelection, loadConversationHistory, sendSelectionRequest, updateConversation],
  );

  // Selection ownership is intentionally keyed only by IDs. Session metadata
  // is populated by get_state and must never invalidate an in-flight bootstrap.
  useEffect(() => {
    const nextConversationId = active ? selectedConversation?.id : undefined;
    const previous = activeSelection.current;
    const generation = previous.generation + 1;
    selectedConversationId.current = nextConversationId;
    activeSelection.current = { conversationId: nextConversationId, generation };

    if (previous.conversationId && previous.conversationId !== nextConversationId) {
      // Keep the native lease: Prime Orbit is a multi-session client and an
      // agent must continue working when its transcript is no longer visible.
      // Only selection-scoped bootstrap requests are cancelled here. Native
      // leases are released safely when the window is destroyed, or explicitly
      // by closeRuntime/stop_agent.
      cancelConversationRequests(previous.conversationId, "La conversation active a changé.");
    }
  }, [active, cancelConversationRequests, selectedConversation?.id, selectedProject?.id]);

  // Local history is deliberately independent from runtime health. A
  // broken/missing Prime Agent must not make a valid saved transcript
  // disappear, and changing session metadata must not advance the selection
  // generation above.
  useEffect(() => {
    if (!active || !selectedConversation || !selectedProject) return;
    const token = activeSelection.current;
    if (token.conversationId !== selectedConversation.id) return;
    if (selectedConversation.sessionPath && selectedConversation.messages.length === 0) {
      updateConversation(selectedConversation.id, (conversation) => ({
        ...conversation,
        status: conversation.status === "error" ? "error" : "starting",
      }));
    }
    void loadLocalConversationHistory(selectedConversation, selectedProject, token.generation).catch(() => undefined);
  }, [active, loadLocalConversationHistory, selectedConversation?.id, selectedConversation?.sessionId, selectedConversation?.sessionPath, selectedProject?.id, selectedProject?.path, updateConversation]);

  useEffect(() => {
    if (!active || !selectedConversation || !selectedProject || !detection) return;
    if (!detection.installed) {
      const token = activeSelection.current;
      void loadLocalConversationHistory(selectedConversation, selectedProject, token.generation)
        .then(() => ({ localError: undefined as string | undefined }))
        .catch((error) => ({ localError: error instanceof Error ? error.message : String(error) }))
        .then(({ localError }) => {
          if (!isCurrentSelection(selectedConversation.id, token.generation)) return;
          const runtimeError = detection.error ?? "Prime Agent est indisponible. L’historique local reste consultable.";
          const diagnostic = redactText(localError
            ? `${runtimeError}\n\nHistorique local : ${localError}`
            : runtimeError);
          updateConversation(selectedConversation.id, (current) => {
            if (current.status === "error" && current.lastError === diagnostic) return current;
            return { ...current, status: "error", lastError: diagnostic };
          });
        });
      return;
    }
    if (!eventsReady || activeSelection.current.conversationId !== selectedConversation.id) return;
    void ensureStarted(selectedConversation, selectedProject).catch(() => undefined);
  }, [active, detection, ensureStarted, eventsReady, isCurrentSelection, loadLocalConversationHistory, selectedConversation?.id, selectedConversation?.sessionId, selectedConversation?.sessionPath, selectedProject?.id, selectedProject?.path, updateConversation]);

  useEffect(() => () => {
    const conversationId = activeSelection.current.conversationId;
    selectedConversationId.current = undefined;
    activeSelection.current = { generation: activeSelection.current.generation + 1 };
    if (conversationId) cancelConversationRequests(conversationId, "La fenêtre se ferme.");
  }, [cancelConversationRequests]);

  const sendPrompt = useCallback(
    async (message: string, attachments: Attachment[], requestedDelivery?: "steer" | "follow_up") => {
      if (!selectedConversation || !selectedProject) return;
      const conversationId = selectedConversation.id;
      const trimmed = message.trim();
      if (!trimmed && attachments.length === 0) return;
      if (attachments.some((item) => item.isImage && !item.attachmentHandle)) {
        throw new Error("Image attachment handle unavailable; select the image again.");
      }
      const beforeStart = getConversationRef.current(conversationId) ?? selectedConversation;
      const forceQueued = requestedDelivery !== undefined
        || activePromptRuns.current.has(conversationId)
        || beforeStart.status === "streaming"
        || beforeStart.status === "tool"
        || beforeStart.status === "queued";
      activePromptRuns.current.add(conversationId);
      try {
        await ensureStarted(selectedConversation, selectedProject);
      } catch (error) {
        if (!forceQueued) activePromptRuns.current.delete(conversationId);
        throw error;
      }
      const textAttachments = attachments.filter((item) => !item.isImage && item.path);
      const attachmentContext = textAttachments.length
        ? `\n\nFichiers joints explicitement sélectionnés (chemins locaux) :\n${textAttachments.map((item) => `- ${JSON.stringify(item.path)}`).join("\n")}`
        : "";
      const content = `${trimmed}${attachmentContext}`.trim();
      const preparation: { value?: ReturnType<typeof beginPromptTransaction> } = {};
      const messageId = uid("user");
      const createdAt = now();
      // useWorkspace evaluates this functional updater against its synchronous
      // authoritative ref. Building the transaction inside it prevents a
      // render-stale snapshot from restoring an old draft or dropping a
      // concurrent runtime event.
      updateConversation(conversationId, (current) => {
        const prepared = beginPromptTransaction(current, {
          message: trimmed,
          attachments,
          messageId,
          createdAt,
          queuedPayload: content,
          forceQueued,
          queuedDelivery: requestedDelivery,
        });
        preparation.value = prepared;
        return prepared.conversation;
      });
      const prepared = preparation.value;
      if (!prepared) {
        throw new Error("La conversation n’est plus disponible.");
      }
      if (!isNative()) {
        updateConversation(conversationId, (conversation) => commitPromptTransaction(conversation, prepared.transaction));
        window.setTimeout(() => {
          activePromptRuns.current.delete(conversationId);
          updateConversation(conversationId, (conversation) => {
            const delivered = forceQueued
              ? applyAuthoritativeUserMessageStart(conversation, content, now())
              : conversation;
            return {
              ...delivered,
              status: "idle",
              messages: [
                ...delivered.messages,
                {
                  id: uid("assistant"),
                  role: "assistant",
                  content: "Mode aperçu actif. Dans l’application Tauri, ce message est envoyé au processus RPC de Prime Agent et sa réponse apparaît ici en streaming.",
                  createdAt: now(),
                  status: "complete",
                },
              ],
            };
          });
        }, 700);
        return;
      }
      const images = attachments
        .filter((item) => item.isImage && item.attachmentHandle)
        .map((item) => ({ type: "image", attachmentHandle: item.attachmentHandle }));
      try {
        await sendRpc(conversationId, {
          id: uid("prompt"),
          type: "prompt",
          message: content,
          ...(images.length ? { images } : {}),
          ...(forceQueued
            ? { streamingBehavior: requestedDelivery === "steer" ? "steer" : "followUp" }
            : {}),
        });
        updateConversation(conversationId, (conversation) => commitPromptTransaction(conversation, prepared.transaction));
        if (forceQueued) {
          const token = activeSelection.current;
          window.setTimeout(() => {
            if (!isCurrentSelection(conversationId, token.generation)) return;
            void sendSelectionRequest(conversationId, token.generation, "get_state").catch(() => undefined);
          }, 50);
        }
      } catch (error) {
        if (!forceQueued) activePromptRuns.current.delete(conversationId);
        updateConversation(conversationId, (conversation) => rollbackPromptTransaction(conversation, prepared.transaction));
        throw error;
      }
    },
    [ensureStarted, isCurrentSelection, selectedConversation, selectedProject, sendSelectionRequest, updateConversation],
  );

  const mutateQueuedMessage = useCallback(async (input: {
    messageId: string;
    lane: "steering" | "followUp";
    index: number;
    expectedText: string;
    mutation: QueueMutation;
  }) => {
    if (!selectedConversation || !selectedProject) return;
    const conversationId = selectedConversation.id;
    await ensureStarted(selectedConversation, selectedProject);
    const status = await mutateAgentQueue({ conversationId, ...input });
    const token = activeSelection.current;
    const refresh = () => {
      if (!isCurrentSelection(conversationId, token.generation)) return;
      void sendSelectionRequest(conversationId, token.generation, "get_state").catch(() => undefined);
    };
    if (status !== "applied") {
      refresh();
      if (status === "unsupported") {
        throw new Error("Ce runtime Prime Agent ne permet pas encore de modifier sa file d’attente.");
      }
      throw new Error(status === "rejected"
        ? "La file a changé entre-temps. Elle vient d’être resynchronisée."
        : "Prime Agent a refusé cette modification de la file.");
    }

    const previousActions = runtimes[conversationId]?.state?.sessionActions;
    const nextActions = previousActions
      ? applyQueueMutationSnapshot(previousActions, input.lane, input.index, input.expectedText, input.mutation)
      : undefined;
    setRuntimes((current) => {
      const runtime = current[conversationId];
      if (!runtime?.state) return current;
      const sessionActions = applyQueueMutationSnapshot(
        runtime.state.sessionActions,
        input.lane,
        input.index,
        input.expectedText,
        input.mutation,
      );
      if (sessionActions === runtime.state.sessionActions) return current;
      return {
        ...current,
        [conversationId]: {
          ...runtime,
          state: { ...runtime.state, sessionActions },
        },
      };
    });
    updateConversation(conversationId, (conversation) => {
      let messages = conversation.messages;
      if (input.mutation.type === "delete") {
        messages = messages.filter((message) => message.id !== input.messageId);
      } else if (input.mutation.type === "replace") {
        const replacement = input.mutation;
        messages = messages.map((message) => message.id === input.messageId ? {
          ...message,
          content: replacement.text,
          queueText: replacement.text,
          queueDelivery: replacement.lane === "steering" ? "steer" as const : "follow_up" as const,
          queueAccepted: true,
          queueObserved: true,
        } : message);
      }
      const updated = messages === conversation.messages ? conversation : { ...conversation, messages };
      return nextActions ? reconcileQueuedMessages(updated, nextActions) : updated;
    });
    window.setTimeout(refresh, 50);
  }, [ensureStarted, isCurrentSelection, runtimes, selectedConversation, selectedProject, sendSelectionRequest, updateConversation]);

  const retryMessage = useCallback(async (assistantMessageId: string) => {
    if (!selectedConversation) return;
    const conversation = getConversationRef.current(selectedConversation.id) ?? selectedConversation;
    const assistantIndex = conversation.messages.findIndex((message) => message.id === assistantMessageId);
    if (assistantIndex < 0) return;
    for (let index = assistantIndex - 1; index >= 0; index -= 1) {
      const source = conversation.messages[index];
      if (source?.role !== "user") continue;
      // A sent image handle is deliberately consumed natively after a
      // successful write and cannot be replayed. Reuse only the source text
      // in the composer so the user can review it and explicitly reselect any
      // attachments, rather than pretending to regenerate a historical turn.
      updateConversation(conversation.id, (current) => ({ ...current, draft: source.content }));
      return;
    }
  }, [selectedConversation, updateConversation]);

  const abort = useCallback(async () => {
    if (!selectedConversation) return;
    try {
      await sendRpc(selectedConversation.id, { id: uid("abort"), type: "abort" });
    } finally {
      activePromptRuns.current.delete(selectedConversation.id);
      updateConversation(selectedConversation.id, (conversation) => ({
        ...finalizeConversationTools(conversation, "cancelled", now()),
        status: "idle",
      }));
    }
  }, [selectedConversation, updateConversation]);

  const closeRuntime = useCallback(async () => {
    if (!selectedConversation) return;
    intentionallyStopped.current.add(selectedConversation.id);
    try {
      await stopAgent(selectedConversation.id);
    } finally {
      activePromptRuns.current.delete(selectedConversation.id);
      updateConversation(selectedConversation.id, (conversation) => ({
        ...finalizeConversationTools(conversation, "cancelled", now()),
        status: "idle",
      }));
    }
  }, [selectedConversation, updateConversation]);

  const chooseModel = useCallback(
    async (model: ModelInfo) => {
      if (!selectedConversation || !selectedProject) return;
      await ensureStarted(selectedConversation, selectedProject);
      await sendRpc(selectedConversation.id, { id: uid("model"), type: "set_model", provider: model.provider, modelId: model.id });
      updateConversation(selectedConversation.id, { model: `${model.provider}/${model.id}` });
    },
    [ensureStarted, selectedConversation, selectedProject, updateConversation],
  );

  const setThinking = useCallback(
    async (level: ThinkingLevel) => {
      if (!selectedConversation || !selectedProject) return;
      await ensureStarted(selectedConversation, selectedProject);
      await sendRpc(selectedConversation.id, { id: uid("thinking"), type: "set_thinking_level", level });
      updateConversation(selectedConversation.id, { thinkingLevel: level });
    },
    [ensureStarted, selectedConversation, selectedProject, updateConversation],
  );

  const runCommand = useCallback(
    async (type: string, fields: Record<string, unknown> = {}) => {
      if (!selectedConversation || !selectedProject) return;
      await ensureStarted(selectedConversation, selectedProject);
      const token = activeSelection.current;
      if (SELECTION_SCOPED_COMMANDS.has(type) && Object.keys(fields).length === 0) {
        if (type === "get_messages") {
          historyLoaded.current.delete(selectedConversation.id);
          await loadConversationHistory(selectedConversation.id, token.generation);
        } else {
          await sendSelectionRequest(selectedConversation.id, token.generation, type);
        }
        return;
      }
      if (ACKNOWLEDGED_COMMANDS.has(type)) {
        const response = await sendSelectionRequest(selectedConversation.id, token.generation, type, true, fields);
        if (response?.success === false) throw new Error(response.error ?? `La commande ${type} a échoué.`);
        return;
      }
      await sendRpc(selectedConversation.id, { id: uid(type), type, ...fields });
    },
    [ensureStarted, loadConversationHistory, selectedConversation, selectedProject, sendSelectionRequest],
  );

  const observeSubagent = useCallback(async (activeSessionId?: string) => {
    if (!selectedConversation || !selectedProject) return;
    await ensureStarted(selectedConversation, selectedProject);
    const conversationId = selectedConversation.id;
    const currentRuntime = runtimes[conversationId];
    const currentId = currentRuntime?.observedSubagent?.activeSessionId;
    const token = activeSelection.current;
    if (currentId && currentId !== activeSessionId) {
      const response = await sendSelectionRequest(
        conversationId,
        token.generation,
        "unobserve",
        true,
        { activeSessionId: currentId },
      );
      if (response?.success === false) throw new Error(response.error ?? "Impossible d’arrêter l’observation du sous-agent.");
    }
    if (!activeSessionId || activeSessionId === currentId) {
      setRuntimes((current) => {
        const runtime = current[conversationId];
        if (!runtime) return current;
        return { ...current, [conversationId]: { ...runtime, observedSubagent: undefined } };
      });
      return;
    }
    const response = await sendSelectionRequest(
      conversationId,
      token.generation,
      "observe",
      true,
      { activeSessionId },
    );
    if (response?.success === false) throw new Error(response.error ?? "Impossible d’observer ce sous-agent.");
    const messages = asRecord(response?.data)?.messages;
    const mapped = Array.isArray(messages) ? mapAgentMessages(messages) : [];
    setRuntimes((current) => {
      const runtime = current[conversationId] ?? { models: [], commands: [], logs: [] };
      return {
        ...current,
        [conversationId]: {
          ...runtime,
          observedSubagent: { activeSessionId, messages: mapped },
        },
      };
    });
  }, [ensureStarted, runtimes, selectedConversation, selectedProject, sendSelectionRequest]);

  const renameSession = useCallback(async (name: string) => {
    if (!selectedConversation || !selectedProject) return;
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Le nom de session ne peut pas être vide.");
    updateConversation(selectedConversation.id, { title: trimmed, sessionNameSyncPending: true });
    await ensureStarted(selectedConversation, selectedProject);
    const token = activeSelection.current;
    const response = await sendSelectionRequest(
      selectedConversation.id,
      token.generation,
      "set_session_name",
      true,
      { name: trimmed },
    );
    if (response?.success === false) throw new Error(response.error ?? "Prime Agent a refusé le nom de session.");
  }, [ensureStarted, selectedConversation, selectedProject, sendSelectionRequest, updateConversation]);

  const forkFromMessage = useCallback(async (assistantMessageId: string) => {
    if (!selectedConversation || !selectedProject) return;
    await ensureStarted(selectedConversation, selectedProject);
    const conversation = getConversationRef.current(selectedConversation.id) ?? selectedConversation;
    const token = activeSelection.current;
    const response = await sendSelectionRequest(
      conversation.id,
      token.generation,
      "get_fork_messages",
      true,
    );
    if (response?.success === false) throw new Error(response.error ?? "Impossible de lire les points de branchement.");
    const records = asRecord(response?.data)?.messages;
    const candidates = Array.isArray(records)
      ? records.flatMap((value) => {
          const record = asRecord(value);
          const entryId = textValue(record?.entryId);
          const text = textValue(record?.text);
          return entryId && text ? [{ entryId, text }] : [];
        })
      : [];
    const entryId = selectForkEntryId(conversation.messages, assistantMessageId, candidates);
    if (!entryId) throw new Error("Prime Agent n’a pas trouvé le tour correspondant dans l’arbre de session.");
    const preservedId = preserveSessionReference(conversation.id, `${conversation.title} · origine`);
    if (!preservedId) throw new Error("La session source n’est pas encore persistée ; réessayez après son chargement.");
    try {
      const fork = await sendSelectionRequest(
        conversation.id,
        token.generation,
        "fork",
        true,
        { entryId },
      );
      if (fork?.success === false) throw new Error(fork.error ?? "La création de la branche a échoué.");
      if (asRecord(fork?.data)?.cancelled === true) discardSessionReference(preservedId);
    } catch (error) {
      discardSessionReference(preservedId);
      throw error;
    }
  }, [discardSessionReference, ensureStarted, preserveSessionReference, selectedConversation, selectedProject, sendSelectionRequest]);

  const cloneSession = useCallback(async () => {
    if (!selectedConversation || !selectedProject) return;
    await ensureStarted(selectedConversation, selectedProject);
    const conversation = getConversationRef.current(selectedConversation.id) ?? selectedConversation;
    const token = activeSelection.current;
    const preservedId = preserveSessionReference(conversation.id, `${conversation.title} · origine`);
    if (!preservedId) throw new Error("La session source n’est pas encore persistée ; réessayez après son chargement.");
    try {
      const clone = await sendSelectionRequest(conversation.id, token.generation, "clone", true);
      if (clone?.success === false) throw new Error(clone.error ?? "La duplication de la session a échoué.");
      if (asRecord(clone?.data)?.cancelled === true) discardSessionReference(preservedId);
    } catch (error) {
      discardSessionReference(preservedId);
      throw error;
    }
  }, [discardSessionReference, ensureStarted, preserveSessionReference, selectedConversation, selectedProject, sendSelectionRequest]);

  const answerExtensionRequest = useCallback(async (
    request: PendingExtensionUiRequest,
    response: Record<string, unknown>,
  ) => {
    if (extensionResponsesInFlight.current.has(request.requestKey)) return;
    extensionResponsesInFlight.current.add(request.requestKey);
    // Close/dequeue first. A failed cancellation must never leave a stale modal
    // blocking subsequent requests or accidentally target a newer request.
    setExtensionRequests((current) => current.filter((item) => item.requestKey !== request.requestKey));
    try {
      await sendRpc(request.conversationId, {
        type: "extension_ui_response",
        id: request.id,
        ...response,
      });
    } catch (error) {
      addActivity(request.conversationId, {
        id: `extension-response:${request.id}`,
        type: "extension_ui_response_error",
        title: "Réponse à l’extension non transmise",
        detail: error instanceof Error ? error.message : String(error),
        status: "warning",
      });
    } finally {
      extensionResponsesInFlight.current.delete(request.requestKey);
    }
  }, [addActivity]);

  const runtime = selectedConversation ? runtimes[selectedConversation.id] : undefined;
  const groupedModels = useMemo(() => {
    const groups = new Map<string, ModelInfo[]>();
    for (const model of runtime?.models ?? []) {
      groups.set(model.provider, [...(groups.get(model.provider) ?? []), model]);
    }
    return groups;
  }, [runtime?.models]);

  return {
    runtime,
    runtimes,
    models: runtime?.models ?? [],
    groupedModels,
    commands: runtime?.commands ?? [],
    stats: runtime?.stats,
    sessionState: runtime?.state,
    schedules: runtime?.schedules ?? [],
    heartbeat: runtime?.heartbeat,
    heartbeats: runtime?.heartbeats ?? [],
    subagents: runtime?.subagents ?? [],
    observedSubagent: runtime?.observedSubagent,
    logs: runtime?.logs ?? [],
    extensionRequest: extensionRequests[0],
    extensionRequestCount: extensionRequests.length,
    ensureStarted,
    sendPrompt,
    mutateQueuedMessage,
    retryMessage,
    abort,
    closeRuntime,
    chooseModel,
    setThinking,
    runCommand,
    observeSubagent,
    renameSession,
    forkFromMessage,
    cloneSession,
    answerExtensionRequest,
  };
}

export function selectForkEntryId(
  messages: ChatMessage[],
  assistantMessageId: string,
  candidates: Array<{ entryId: string; text: string }>,
): string | undefined {
  const assistantIndex = messages.findIndex((message) => message.id === assistantMessageId);
  if (assistantIndex < 0) return undefined;
  const users = messages.slice(0, assistantIndex).filter((message) => message.role === "user");
  const source = users.at(-1);
  if (!source) return undefined;
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const sourceText = normalize(source.content);
  const occurrence = users.filter((message) => normalize(message.content) === sourceText).length - 1;
  const exact = candidates.filter((candidate) => normalize(candidate.text) === sourceText);
  return exact[occurrence]?.entryId ?? candidates[users.length - 1]?.entryId;
}

function handleMessageEvent(
  conversationId: string,
  event: RpcEnvelope,
  updateConversation: (id: string, updater: Partial<Conversation> | ((current: Conversation) => Conversation)) => void,
) {
  const rawMessage = event.message as Record<string, unknown> | undefined;
  const role = String(rawMessage?.role ?? "assistant");
  const extracted = extractMessageText(rawMessage);
  if (role === "user") {
    if (event.type !== "message_start" || !extracted) return;
    const timestamp = typeof rawMessage?.timestamp === "number" ? rawMessage.timestamp : undefined;
    const createdAt = timestamp && Number.isFinite(timestamp)
      ? new Date(timestamp).toISOString()
      : now();
    updateConversation(conversationId, (conversation) => applyAuthoritativeUserMessageStart(
      conversation,
      extracted,
      createdAt,
    ));
    return;
  }
  if (role !== "assistant") return;
  const eventId = String(rawMessage?.id ?? event.messageId ?? "");
  const assistantEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
  const isTextDelta = assistantEvent?.type === "text_delta";
  const delta = isTextDelta && typeof assistantEvent.delta === "string" ? assistantEvent.delta : "";
  if (event.type === "message_update" && !isTextDelta) return;
  updateConversation(conversationId, (conversation) => {
    const streamingIndex = [...conversation.messages].reverse().findIndex((item) => item.role === "assistant" && item.status === "streaming");
    let actualIndex = streamingIndex < 0 ? -1 : conversation.messages.length - 1 - streamingIndex;
    const lastIndex = conversation.messages.length - 1;
    const last = conversation.messages[lastIndex];
    if (actualIndex < 0 && last?.role === "assistant" && !last.content.trim() && (last.tools?.length ?? 0) > 0) actualIndex = lastIndex;

    if (event.type === "message_end") {
      if (actualIndex < 0) {
        if (!extracted) return conversation;
        return { ...conversation, hasContent: true, messages: [...conversation.messages, { id: eventId || uid("assistant"), role: "assistant", content: extracted, createdAt: now(), status: "complete" }] };
      }
      const messages = [...conversation.messages];
      const current = messages[actualIndex]!;
      if (!extracted && (current.tools?.length ?? 0) === 0) {
        messages.splice(actualIndex, 1);
        return { ...conversation, messages };
      }
      messages[actualIndex] = {
        ...current,
        id: eventId || current.id,
        content: extracted || current.content,
        status: "complete",
      };
      return { ...conversation, hasContent: true, messages };
    }

    if (event.type === "message_start") {
      if (!extracted) return conversation;
      if (actualIndex >= 0) {
        const messages = [...conversation.messages];
        messages[actualIndex] = { ...messages[actualIndex]!, id: eventId || messages[actualIndex]!.id, content: extracted, status: "streaming" };
        return { ...conversation, hasContent: true, messages };
      }
      const message: ChatMessage = {
        id: eventId || uid("assistant"),
        role: "assistant",
        content: extracted,
        createdAt: now(),
        status: "streaming",
      };
      return { ...conversation, hasContent: true, messages: [...conversation.messages, message] };
    }

    if (actualIndex < 0 && !extracted && !delta) return conversation;
    if (actualIndex < 0) {
      return { ...conversation, hasContent: true, messages: [...conversation.messages, { id: eventId || uid("assistant"), role: "assistant", content: extracted || delta, createdAt: now(), status: "streaming" }] };
    }
    const messages = [...conversation.messages];
    const current = messages[actualIndex]!;
    messages[actualIndex] = {
      ...current,
      id: eventId || current.id,
      content: extracted || `${current.content}${delta}`,
      status: "streaming",
    };
    return { ...conversation, hasContent: true, messages };
  });
}

function handleToolEvent(
  conversationId: string,
  event: RpcEnvelope,
  updateConversation: (id: string, updater: Partial<Conversation> | ((current: Conversation) => Conversation)) => void,
) {
  const eventTime = now();
  updateConversation(conversationId, (conversation) => applyToolEventToConversation(conversation, event, eventTime));
}

type TerminalToolStatus = Extract<ToolActivity["status"], "completed" | "failed" | "cancelled">;

interface ToolLocation {
  messageIndex: number;
  toolIndex: number;
  tool: ToolActivity;
}

interface ReconciledToolEvent {
  messages: ChatMessage[];
  tool: ToolActivity;
}

const isPendingTool = (tool: ToolActivity) => tool.status === "queued" || tool.status === "running";
const isTerminalTool = (tool: ToolActivity) => !isPendingTool(tool);
const normalizedToolName = (value: unknown) => textValue(value)?.toLocaleLowerCase();

function comparableToolInput(value: unknown): string {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function allToolLocations(messages: ChatMessage[]): ToolLocation[] {
  const locations: ToolLocation[] = [];
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const tools = messages[messageIndex]?.tools ?? [];
    for (let toolIndex = tools.length - 1; toolIndex >= 0; toolIndex -= 1) {
      const tool = tools[toolIndex];
      if (tool) locations.push({ messageIndex, toolIndex, tool });
    }
  }
  return locations;
}

function findToolForEvent(messages: ChatMessage[], event: RpcEnvelope): ToolLocation | undefined {
  const locations = allToolLocations(messages);
  const incomingId = textValue(event.toolCallId);
  if (incomingId) {
    const exact = locations.find(({ tool }) => tool.id === incomingId);
    if (exact) return exact;
  }

  const pending = locations.filter(({ tool }) => isPendingTool(tool));
  const incomingName = normalizedToolName(event.toolName);
  if (!incomingName) {
    if (event.type === "tool_execution_start" && incomingId) return undefined;
    return pending.length === 1 ? pending[0] : undefined;
  }
  let candidates = pending.filter(({ tool }) => normalizedToolName(tool.name) === incomingName);

  if (event.args !== undefined && candidates.length > 1) {
    const inputKey = comparableToolInput(event.args);
    const sameInput = candidates.filter(({ tool }) => comparableToolInput(tool.input) === inputKey);
    if (sameInput.length > 0) candidates = sameInput;
  }

  if (event.type === "tool_execution_start") {
    // A distinct upstream id means a distinct call, even for parallel calls to
    // the same tool. Id-less duplicate starts can safely reuse one unambiguous
    // pending card and will subsequently be found by name/input.
    if (incomingId) return undefined;
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  // Updates and ends occasionally arrive without an id (or through adapters
  // that rewrite it). The event stream is ordered, so the latest pending call
  // with the same name/input is the safest deterministic fallback.
  return candidates[0];
}

/**
 * Applies one tool lifecycle event to its original assistant message. This is
 * exported so association and terminal-state rules can be unit-tested without
 * mounting the React hook.
 */
export function reconcileToolEventMessages(
  sourceMessages: ChatMessage[],
  event: RpcEnvelope,
  eventTime = now(),
): ReconciledToolEvent {
  const location = findToolForEvent(sourceMessages, event);
  const previous = location?.tool;
  const incomingId = textValue(event.toolCallId);
  const name = textValue(event.toolName) ?? previous?.name ?? "tool";
  const previousIsTerminal = previous ? isTerminalTool(previous) : false;

  let status: ToolActivity["status"] = previous?.status ?? "running";
  let endedAt = previous?.endedAt;
  let output = previous?.output;
  if (event.type === "tool_execution_end") {
    status = previous?.status === "cancelled"
      ? "cancelled"
      : event.isError === true || previous?.status === "failed" ? "failed" : "completed";
    endedAt = eventTime;
    output = event.result ?? event.partialResult ?? previous?.output;
  } else if (!previousIsTerminal) {
    status = "running";
    endedAt = undefined;
    if (event.type === "tool_execution_update") output = event.partialResult ?? previous?.output;
  }

  const tool: ToolActivity = {
    id: previous?.id ?? incomingId ?? uid("tool"),
    name,
    title: humanizeToolName(name),
    status,
    input: event.args ?? previous?.input,
    output,
    startedAt: previous?.startedAt ?? eventTime,
    endedAt,
  };

  const messages = [...sourceMessages];
  let messageIndex = location?.messageIndex ?? -1;
  let toolIndex = location?.toolIndex ?? -1;
  if (messageIndex < 0) {
    const lastIndex = messages.length - 1;
    if (messages[lastIndex]?.role === "assistant") {
      messageIndex = lastIndex;
    } else {
      messages.push({
        id: uid("assistant"),
        role: "assistant",
        content: "",
        createdAt: eventTime,
        status: event.type === "tool_execution_end" ? "complete" : "streaming",
        tools: [],
      });
      messageIndex = messages.length - 1;
    }
  }

  const assistant = messages[messageIndex]!;
  const tools = [...(assistant.tools ?? [])];
  if (toolIndex >= 0) tools[toolIndex] = tool;
  else tools.push(tool);
  messages[messageIndex] = { ...assistant, tools };
  return { messages, tool };
}

function toolActivityStatus(status: ToolActivity["status"]): ActivityItem["status"] {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "cancelled") return "warning";
  return "running";
}

function toolActivityTitle(tool: ToolActivity): string {
  if (tool.status === "completed") return `${tool.title} terminé`;
  if (tool.status === "failed") return `Échec · ${tool.title}`;
  if (tool.status === "cancelled") return `${tool.title} annulé`;
  return `${tool.title} en cours`;
}

function toolActivityDetail(tool: ToolActivity): string | undefined {
  if (isPendingTool(tool)) return summarizeToolInvocation(tool.name, tool.input);
  return summarizeUnknown(tool.output) ?? summarizeToolInvocation(tool.name, tool.input);
}

function applyToolEventToConversation(conversation: Conversation, event: RpcEnvelope, eventTime: string): Conversation {
  const reconciled = reconcileToolEventMessages(conversation.messages, event, eventTime);
  const rawId = textValue(event.toolCallId);
  const activityId = `tool:${reconciled.tool.id}`;
  let activityIndex = conversation.activities.findIndex((item) => item.id === activityId);
  if (activityIndex < 0 && rawId) {
    activityIndex = conversation.activities.findIndex((item) => item.id === rawId || item.id === `tool:${rawId}`);
  }
  if (activityIndex < 0) {
    for (let index = conversation.activities.length - 1; index >= 0; index -= 1) {
      const activity = conversation.activities[index];
      const raw = asRecord(activity?.raw);
      if (
        activity?.status === "running"
        && activity.type.startsWith("tool_execution")
        && normalizedToolName(raw?.toolName) === normalizedToolName(reconciled.tool.name)
      ) {
        activityIndex = index;
        break;
      }
    }
  }

  const previousActivity = activityIndex >= 0 ? conversation.activities[activityIndex] : undefined;
  const activity: ActivityItem = {
    ...previousActivity,
    id: activityId,
    type: event.type,
    title: toolActivityTitle(reconciled.tool),
    detail: (() => {
      const detail = toolActivityDetail(reconciled.tool);
      return detail ? redactText(detail) : previousActivity?.detail;
    })(),
    status: toolActivityStatus(reconciled.tool.status),
    createdAt: previousActivity?.createdAt ?? reconciled.tool.startedAt,
    updatedAt: eventTime,
    updateCount: (previousActivity?.updateCount ?? 0) + 1,
    raw: redactValue(event),
  };
  const activities = [...conversation.activities];
  if (activityIndex >= 0) activities[activityIndex] = activity;
  else activities.push(activity);

  const hasPendingTools = reconciled.messages.some((message) => message.tools?.some(isPendingTool));
  const status = hasPendingTools
    ? "tool"
    : conversation.status === "tool" ? "streaming" : conversation.status;
  return {
    ...conversation,
    hasContent: true,
    status,
    messages: reconciled.messages,
    activities: activities.slice(-240),
  };
}

/** Finalizes only still-pending tool cards at a confirmed lifecycle boundary. */
export function finalizePendingTools(
  messages: ChatMessage[],
  status: TerminalToolStatus,
  eventTime = now(),
): ChatMessage[] {
  let changed = false;
  const finalized = messages.map((message) => {
    if (!message.tools?.some(isPendingTool)) return message;
    changed = true;
    return {
      ...message,
      tools: message.tools.map((tool) => isPendingTool(tool) ? { ...tool, status, endedAt: eventTime } : tool),
    };
  });
  return changed ? finalized : messages;
}

function finalizeConversationTools(
  conversation: Conversation,
  status: TerminalToolStatus,
  eventTime: string,
): Conversation {
  const messages = finalizePendingTools(conversation.messages, status, eventTime);
  const activityStatus = toolActivityStatus(status);
  const activities = conversation.activities.map((activity) => {
    if (activity.status !== "running" || !activity.type.startsWith("tool_execution")) return activity;
    const raw = asRecord(activity.raw);
    const title = humanizeToolName(textValue(raw?.toolName) ?? activity.title.replace(/ en cours$/u, ""));
    return {
      ...activity,
      title: status === "completed" ? `${title} terminé` : status === "failed" ? `Échec · ${title}` : `${title} annulé`,
      status: activityStatus,
      updatedAt: eventTime,
      updateCount: (activity.updateCount ?? 1) + 1,
    };
  });
  if (messages === conversation.messages && activities.every((activity, index) => activity === conversation.activities[index])) {
    return conversation;
  }
  return { ...conversation, messages, activities };
}

function finalizeTurnTools(conversation: Conversation, event: RpcEnvelope, eventTime: string): Conversation {
  let next = conversation;
  if (Array.isArray(event.toolResults)) {
    for (const value of event.toolResults) {
      const result = asRecord(value);
      if (!result) continue;
      next = applyToolEventToConversation(next, {
        type: "tool_execution_end",
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        result: result.result ?? result.content ?? result,
        isError: result.isError === true,
      }, eventTime);
    }
  }
  const finalized = finalizeConversationTools(next, "completed", eventTime);
  return finalized.status === "tool" ? { ...finalized, status: "streaming" } : finalized;
}

export function mapAgentMessages(messages: unknown[]): ChatMessage[] {
  const mapped: ChatMessage[] = [];
  const toolLocations = new Map<string, { messageIndex: number; toolIndex: number }>();

  for (let index = 0; index < messages.length; index += 1) {
    const message = asRecord(messages[index]);
    if (!message) continue;
    const role = String(message.role ?? "");
    const createdAt = historyTimestamp(message.timestamp);

    if (role === "toolResult") {
      const toolCallId = textValue(message.toolCallId);
      const location = toolCallId ? toolLocations.get(toolCallId) : undefined;
      if (!location) continue;
      const owner = mapped[location.messageIndex];
      const previous = owner?.tools?.[location.toolIndex];
      if (!owner || !previous) continue;
      const tools = [...(owner.tools ?? [])];
      tools[location.toolIndex] = {
        ...previous,
        status: message.isError === true ? "failed" : "completed",
        output: truncateHistoricalPayload(extractMessageText(message) || message.details),
        endedAt: createdAt,
      };
      mapped[location.messageIndex] = { ...owner, tools };
      continue;
    }

    if (role === "assistant") {
      const blocks = Array.isArray(message.content)
        ? message.content.filter((block): block is Record<string, unknown> => Boolean(block && typeof block === "object"))
        : [];
      const tools = blocks.flatMap((block): ToolActivity[] => {
        if (block.type !== "toolCall") return [];
        const id = textValue(block.id) ?? `history-tool-${index}-${crypto.randomUUID()}`;
        const name = textValue(block.name) ?? "tool";
        return [{
          id,
          name,
          title: humanizeToolName(name),
          // A saved assistant toolCall without its matching toolResult has no
          // proof of success; represent it as terminal but cancelled.
          status: "cancelled",
          input: truncateHistoricalPayload(block.arguments),
          startedAt: createdAt,
          endedAt: createdAt,
        }];
      });
      const content = extractMessageText(message);
      if (!content && tools.length === 0) continue;
      const usage = asRecord(message.usage);
      const chatMessage: ChatMessage = {
        id: String(message.id ?? `history-${index}`),
        role: "assistant",
        content,
        createdAt,
        status: "complete",
        model: textValue(message.model),
        usage: usage ? {
          input: numberValue(usage.input),
          output: numberValue(usage.output),
          cacheRead: numberValue(usage.cacheRead),
          total: numberValue(usage.totalTokens) ?? numberValue(usage.total),
        } : undefined,
        tools: tools.length ? tools : undefined,
      };
      const messageIndex = mapped.push(chatMessage) - 1;
      tools.forEach((tool, toolIndex) => toolLocations.set(tool.id, { messageIndex, toolIndex }));
      continue;
    }

    if (role === "user" || role === "system") {
      const content = extractMessageText(message) || (containsImageContent(message.content) ? "Image jointe" : "");
      if (!content) continue;
      const attachments = historicalImageAttachments(message.content, index);
      mapped.push({
        id: String(message.id ?? `history-${index}`),
        role,
        content,
        createdAt,
        status: "complete",
        attachments: attachments.length ? attachments : undefined,
      });
      continue;
    }

    // Prime Agent keeps summaries and selected displayable custom messages in
    // the saved session. Keeping them avoids showing an apparently empty
    // transcript after compaction.
    if (role === "compactionSummary" || role === "branchSummary") {
      const content = textValue(message.summary);
      if (content) mapped.push({ id: `history-${index}`, role: "system", content, createdAt, status: "complete" });
      continue;
    }
    if (role === "custom" && message.display === true) {
      const content = extractMessageText(message);
      if (content) mapped.push({ id: `history-${index}`, role: "system", content, createdAt, status: "complete" });
      continue;
    }
    if (role === "bashExecution") {
      const output = textValue(message.output);
      const cancelled = message.cancelled === true;
      const exitCode = numberValue(message.exitCode);
      const failed = !cancelled && exitCode !== undefined && exitCode !== 0;
      mapped.push({
        id: `history-${index}`,
        role: "assistant",
        content: "",
        createdAt,
        status: "complete",
        tools: [{
          id: `history-bash-${index}`,
          name: "bash",
          title: humanizeToolName("bash"),
          status: cancelled ? "cancelled" : failed ? "failed" : "completed",
          input: truncateHistoricalPayload(message.command),
          output: truncateHistoricalPayload(output),
          startedAt: createdAt,
          endedAt: createdAt,
        }],
      });
    }
  }
  return mapped;
}

function historicalImageAttachments(value: unknown, messageIndex: number): Attachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((block, blockIndex): Attachment[] => {
    const record = asRecord(block);
    if (!record || !["image", "image_url"].includes(String(record.type))) return [];
    const mimeType = textValue(record.mimeType) ?? "image/png";
    const previewDataUrl = textValue(record.previewDataUrl);
    const size = numberValue(record.size) ?? 0;
    return [{
      id: `history-image-${messageIndex}-${blockIndex}`,
      name: `image-${blockIndex + 1}.${mimeType.split("/")[1] ?? "png"}`,
      mimeType,
      size,
      isImage: true,
      ...(previewDataUrl ? { previewDataUrl } : {}),
    }];
  });
}

export function mergeHistoricalAttachmentPreviews(next: ChatMessage[], previous: ChatMessage[]): ChatMessage[] {
  const previousUsers = previous.filter((message) => message.role === "user");
  let userIndex = 0;
  return next.map((message) => {
    if (message.role !== "user") return message;
    const old = previousUsers[userIndex++];
    if (message.attachments?.some((attachment) => attachment.previewDataUrl) || !old?.attachments?.length) return message;
    const oldImages = old.attachments.filter((attachment) => attachment.isImage);
    if (!oldImages.length) return message;
    const attachments = (message.attachments ?? oldImages).map((attachment, index) => ({
      ...attachment,
      ...(oldImages[index]?.name ? { name: oldImages[index]!.name } : {}),
      ...(oldImages[index]?.size ? { size: oldImages[index]!.size } : {}),
      ...(oldImages[index]?.previewDataUrl ? { previewDataUrl: oldImages[index]!.previewDataUrl } : {}),
    }));
    return { ...message, attachments };
  });
}

function historyTimestamp(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return now();
}

function containsImageContent(value: unknown) {
  return Array.isArray(value) && value.some((block) => asRecord(block)?.type === "image");
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const MAX_HISTORICAL_PAYLOAD_CHARS = 16_000;

function truncateHistoricalPayload(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    return value.length <= MAX_HISTORICAL_PAYLOAD_CHARS
      ? value
      : `${value.slice(0, MAX_HISTORICAL_PAYLOAD_CHARS)}\n… [historique tronqué]`;
  }
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || serialized.length <= MAX_HISTORICAL_PAYLOAD_CHARS) return value;
    return `${serialized.slice(0, MAX_HISTORICAL_PAYLOAD_CHARS)}\n… [historique tronqué]`;
  } catch {
    const text = String(value);
    return text.length <= MAX_HISTORICAL_PAYLOAD_CHARS
      ? text
      : `${text.slice(0, MAX_HISTORICAL_PAYLOAD_CHARS)}\n… [historique tronqué]`;
  }
}

function extractMessageText(message?: Record<string, unknown>): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block): block is Record<string, unknown> => Boolean(block && typeof block === "object"))
    .filter((block) => block.type === "text" || block.type === "output_text")
    .map((block) => String(block.text ?? block.content ?? ""))
    .join("");
}

type ActivityDraft = Omit<ActivityItem, "id" | "createdAt"> & { id?: string; createdAt?: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stableToken(value: unknown): string {
  const text = typeof value === "string" ? value : value === undefined ? "current" : JSON.stringify(value);
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

function rlmChildPresentation(child: Record<string, unknown> | undefined, status: string): {
  title: string;
  detail?: string;
  status: ActivityItem["status"];
} {
  const label = (textValue(child?.label) ?? textValue(child?.sessionName) ?? "sans nom").slice(0, 64);
  const activity = asRecord(child?.activity);
  const activityKind = textValue(activity?.kind);
  const toolName = textValue(activity?.toolName);
  const activityDetail = activityKind === "executing"
    ? `Exécute ${toolName ? humanizeToolName(toolName) : "un outil"}`
    : activityKind === "writing"
      ? "Rédige sa réponse"
      : activityKind === "waiting"
        ? "Attend une nouvelle étape"
        : undefined;
  const primaryDetail = textValue(child?.error)
    ?? textValue(child?.recap)
    ?? activityDetail
    ?? textValue(child?.answerPreview);
  const metrics: string[] = [];
  if (typeof child?.toolUseCount === "number" && child.toolUseCount > 0) {
    metrics.push(`${child.toolUseCount} outil${child.toolUseCount === 1 ? "" : "s"}`);
  }
  if (typeof child?.tokenCount === "number" && child.tokenCount > 0) {
    metrics.push(`${Math.round(child.tokenCount).toLocaleString("fr-FR")} tokens`);
  }
  if (typeof child?.durationMs === "number" && child.durationMs >= 1_000 && status !== "running") {
    metrics.push(`${Math.round(child.durationMs / 1_000)} s`);
  }
  const detail = [primaryDetail?.slice(0, 190), metrics.join(" · ")].filter(Boolean).join(" — ") || undefined;

  if (status === "done") return { title: `Sous-agent « ${label} » terminé`, detail, status: "success" };
  if (status === "error") return { title: `Échec du sous-agent « ${label} »`, detail, status: "error" };
  if (status === "cancelled") return { title: `Sous-agent « ${label} » annulé`, detail, status: "warning" };
  if (status === "queued") return { title: `Sous-agent « ${label} » en attente`, detail, status: "info" };
  return { title: `Sous-agent « ${label} » travaille`, detail, status: "running" };
}

function summarizeSessionActions(value: unknown): string | undefined {
  const actions = asRecord(value);
  if (!actions) return undefined;
  const detail: string[] = [];
  const active = asRecord(actions.active);
  const activeLabel = textValue(active?.label);
  const activePhase = textValue(active?.phase);
  if (activeLabel) detail.push(activeLabel.slice(0, 120));
  else if (activePhase === "preparing") detail.push("Préparation de l’action active");
  else if (activePhase === "committing") detail.push("Enregistrement de l’action active");
  else if (activePhase === "running") detail.push("Action en cours");
  const queuedCount = typeof actions.queuedCount === "number" ? actions.queuedCount : 0;
  if (queuedCount > 0) detail.push(`${queuedCount} instruction${queuedCount === 1 ? "" : "s"} en attente`);
  if (detail.length === 0) detail.push("Aucune instruction en attente");
  return detail.join(" · ");
}

function observedSessionActivity(event: RpcEnvelope): ActivityDraft | undefined {
  const activeSessionId = textValue(event.activeSessionId) ?? "unknown";
  const nested = asRecord(event.event);
  const nestedType = textValue(nested?.type);
  if (!nestedType || ["message_start", "message_update", "message_end", "turn_start", "turn_end", "tool_execution_update"].includes(nestedType)) {
    return undefined;
  }

  if (nestedType === "agent_start" || nestedType === "agent_end") {
    return {
      id: `observed-session:${activeSessionId}:agent`,
      type: event.type,
      title: nestedType === "agent_start" ? "Sous-session observée en cours" : "Sous-session observée terminée",
      status: nestedType === "agent_start" ? "running" : "success",
      raw: event,
    };
  }

  if (nestedType === "tool_execution_start" || nestedType === "tool_execution_end") {
    const toolCallId = textValue(nested?.toolCallId) ?? stableToken(nested?.toolName);
    const toolName = humanizeToolName(textValue(nested?.toolName) ?? "Outil");
    const failed = nestedType === "tool_execution_end" && nested?.isError === true;
    return {
      id: `observed-session:${activeSessionId}:tool:${toolCallId}`,
      type: event.type,
      title: nestedType === "tool_execution_start" ? `Sous-agent · ${toolName}` : failed ? `Sous-agent · ${toolName} échoué` : `Sous-agent · ${toolName} terminé`,
      detail: nestedType === "tool_execution_start" ? summarizeToolInvocation(textValue(nested?.toolName) ?? "Outil", nested?.args) : undefined,
      status: nestedType === "tool_execution_start" ? "running" : failed ? "error" : "success",
      raw: event,
    };
  }

  return {
    id: `observed-session:${activeSessionId}:${nestedType}`,
    type: event.type,
    title: `Sous-session · ${humanizeEvent(nestedType)}`,
    status: nestedType.includes("error") ? "error" : "info",
    raw: event,
  };
}

function goalActivityTitle(status: string) {
  if (status === "active") return "Objectif en cours";
  if (status === "complete") return "Objectif terminé";
  if (status === "paused") return "Objectif en pause";
  if (status === "budget_limited") return "Budget de l’objectif atteint";
  if (status === "error") return "Objectif interrompu";
  return "Objectif mis à jour";
}

function humanizeToolName(name: string) {
  if (name === "ipython") return "Exécution Python";
  if (name === "bash") return "Commande système";
  return name.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function humanizeEvent(type: string) {
  const labels: Record<string, string> = {
    agent_start: "Prime Agent a démarré",
    agent_end: "Exécution terminée",
    turn_start: "Nouveau tour de l’agent",
    turn_end: "Tour de l’agent terminé",
    compaction_start: "Compactage du contexte",
    compaction_end: "Contexte compacté",
    retry_start: "Nouvelle tentative",
    retry_end: "Nouvelle tentative terminée",
    session_action_update: "File d’attente mise à jour",
    observed_session_event: "Activité d’un sous-agent",
    observed_session_closed: "Sous-session observée terminée",
    ipython_sent_agent_message: "Message envoyé à un sous-agent",
    session_info_changed: "Informations de session mises à jour",
    thinking_level_changed: "Niveau de raisonnement modifié",
    service_tier_changed: "Priorité du service modifiée",
    auth_stale: "Authentification à renouveler",
    refine_complete: "Raffinement terminé",
    refine_failed: "Échec du raffinement",
  };
  return labels[type] ?? type.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function summarizeUnknown(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value.slice(0, 180);
  try {
    return JSON.stringify(value).slice(0, 180);
  } catch {
    return String(value).slice(0, 180);
  }
}

const MAX_RUNTIME_LOG_CHARS = 12_000;

function truncateRuntimeLog(line: string): string {
  if (line.length <= MAX_RUNTIME_LOG_CHARS) return line;
  return `${line.slice(0, MAX_RUNTIME_LOG_CHARS)}\n… [${Math.ceil(line.length / 1_024).toLocaleString("fr-FR")} Ko tronqués]`;
}

function summarizeRpcLog(line: string, event: RpcEnvelope): string {
  if (event.type === "response" && event.command === "get_messages") {
    const data = asRecord(event.data);
    const count = Array.isArray(data?.messages) ? data.messages.length : 0;
    return `Réponse get_messages · ${count.toLocaleString("fr-FR")} message${count === 1 ? "" : "s"} · ${Math.ceil(line.length / 1_024).toLocaleString("fr-FR")} Ko`;
  }
  return truncateRuntimeLog(line);
}

function summarizeToolInvocation(name: string, value: unknown): string | undefined {
  if (value && typeof value === "object") {
    const fields = value as Record<string, unknown>;
    const candidate = name === "ipython" ? fields.code : fields.command ?? fields.path ?? fields.query;
    if (typeof candidate === "string") return candidate.replace(/\s+/g, " ").trim().slice(0, 110);
  }
  return summarizeUnknown(value)?.replace(/\s+/g, " ").slice(0, 110);
}

function summarizeGoal(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const goal = value as Record<string, unknown>;
  return [goal.objective, goal.status].filter(Boolean).join(" · ").slice(0, 220);
}

function makeTitle(input: string) {
  const words = input.replace(/\s+/g, " ").trim().split(" ").slice(0, 7).join(" ");
  return words.length > 52 ? `${words.slice(0, 49)}…` : words || "Nouvelle conversation";
}
