import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { defaultAppState } from "../lib/demo";
import { latestProjectConversation } from "../lib/project-navigation";
import type { RlmDelegationSnapshot } from "../lib/rlm-preferences";
import {
  durableState,
  listenToStateChanges,
  loadAppState,
  saveAppState,
  type AppStateSnapshot,
} from "../lib/bridge";
import type { AppView, Conversation, PersistedAppState, PrimeAgentSessionSummary, Project } from "../types";

const PROJECT_COLORS = ["#7c6cff", "#45c6d8", "#2ecf8f", "#f3b65b", "#f56b79", "#b26cff"];
const SAVE_DEBOUNCE_MS = 260;
const MAX_SAVE_ATTEMPTS = 8;
const SAVE_RETRY_BASE_MS = 500;
const SAVE_RETRY_MAX_MS = 30_000;
const MAX_AUTOMATIC_SAVE_ATTEMPTS = 8;

const newId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

function pathName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "Nouveau projet";
}

function pathIdentity(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
}

function saveRetryDelay(attempt: number) {
  return Math.min(SAVE_RETRY_BASE_MS * 2 ** Math.min(attempt, 16), SAVE_RETRY_MAX_MS);
}

function persistenceRetryMessage(language: PersistedAppState["preferences"]["language"]) {
  return language === "fr"
    ? "Les modifications restent ouvertes, mais l’espace de travail n’a pas pu être enregistré. Prime Orbit réessaiera avec un délai progressif."
    : "Your changes remain open, but the workspace could not be saved. Prime Orbit will retry with a progressive delay.";
}

function persistenceSuspendedMessage(language: PersistedAppState["preferences"]["language"]) {
  return language === "fr"
    ? "L’enregistrement automatique est suspendu après plusieurs échecs. Vos modifications restent ouvertes ; utilisez Réessayer pour relancer l’enregistrement."
    : "Automatic saving is paused after repeated failures. Your changes remain open; use Retry to resume saving.";
}

export function useWorkspace() {
  const [state, setReactState] = useState<PersistedAppState>(defaultAppState);
  const [view, setView] = useState<AppView>("home");
  const [loaded, setLoaded] = useState(false);
  const [workspaceSaveError, setWorkspaceSaveError] = useState<string>();
  const stateRef = useRef<PersistedAppState>(defaultAppState);
  const baseSnapshot = useRef<AppStateSnapshot>({ state: durableState(defaultAppState), revision: 0 });
  const lastObservedDurableState = useRef<PersistedAppState>(durableState(defaultAppState));
  const saveTimer = useRef<number | undefined>(undefined);
  const saveInFlight = useRef(false);
  const automaticSaveFailures = useRef(0);
  const mounted = useRef(true);

  // Keeping the current state in a ref makes a remote event arriving between
  // two React renders rebase against the actual latest local mutation.
  const setState = useCallback((action: SetStateAction<PersistedAppState>) => {
    const current = stateRef.current;
    const next = typeof action === "function"
      ? (action as (value: PersistedAppState) => PersistedAppState)(current)
      : action;
    stateRef.current = next;
    setReactState(next);
  }, []);

  const applyRemoteSnapshot = useCallback((snapshot: AppStateSnapshot) => {
    const base = baseSnapshot.current;
    if (snapshot.revision <= base.revision) return;
    const runtimeState = stateRef.current;
    const rebased = rebaseWorkspaceState(base.state, durableState(runtimeState), snapshot.state);
    baseSnapshot.current = { state: durableState(snapshot.state), revision: snapshot.revision };
    setState(restoreRuntimeState(runtimeState, normalizeWorkspaceState(rebased)));
  }, [setState]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(saveTimer.current);
    };
  }, []);

  useEffect(() => {
    let active = true;
    let initialized = false;
    let queuedSnapshot: AppStateSnapshot | undefined;
    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        unlisten = await listenToStateChanges((snapshot) => {
          if (!initialized) {
            if (!queuedSnapshot || snapshot.revision > queuedSnapshot.revision) queuedSnapshot = snapshot;
            return;
          }
          applyRemoteSnapshot(snapshot);
        });
      } catch {
        // Loading the local snapshot remains useful even if event
        // subscription is temporarily unavailable.
      }
      if (!active) {
        unlisten?.();
        return;
      }

      try {
        const snapshot = await loadAppState();
        if (!active) return;
        baseSnapshot.current = { state: durableState(snapshot.state), revision: snapshot.revision };
        const params = new URLSearchParams(window.location.search);
        const explicitConversationId = params.get("conversation");
        const hasExplicitConversation = explicitConversationId !== null;
        const normalized = normalizeWorkspaceState(snapshot.state);
        const requestedProjectId = params.get("project") ?? normalized.selectedProjectId;
        const selectedProjectId = normalized.projects.some((project) => project.id === requestedProjectId)
          ? requestedProjectId
          : normalized.projects[0]?.id;
        const requestedConversationId = explicitConversationId ?? normalized.selectedConversationId;
        const requestedConversation = normalized.conversations.find(
          (conversation) => conversation.id === requestedConversationId
            && conversation.projectId === selectedProjectId
            && !conversation.archived,
        );
        const selectedConversationId = requestedConversation?.id
          ?? (!hasExplicitConversation && (requestedConversationId || params.has("project"))
            ? firstVisibleConversation(normalized.conversations, selectedProjectId)?.id
            : undefined);
        const shouldRestoreConversation = Boolean(requestedConversation)
          && (hasExplicitConversation || normalized.preferences.restoreLastWorkspace);
        setState({ ...normalized, selectedProjectId, selectedConversationId });
        setView(
          selectedConversationId && shouldRestoreConversation
            ? "chat"
            : snapshot.state.projects.length > 0
              ? "home"
              : "projects",
        );
        setLoaded(true);
        initialized = true;
        if (queuedSnapshot && queuedSnapshot.revision > snapshot.revision) {
          applyRemoteSnapshot(queuedSnapshot);
        }
      } catch {
        if (!active) return;
        initialized = true;
        setLoaded(true);
        if (queuedSnapshot) applyRemoteSnapshot(queuedSnapshot);
      }
    })();

    return () => {
      active = false;
      unlisten?.();
    };
  }, [applyRemoteSnapshot, setState]);

  const persistLatestState = useCallback(async () => {
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    let shouldBackOff = false;
    try {
      for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt += 1) {
        const base = baseSnapshot.current;
        const localRuntimeState = stateRef.current;
        const localState = durableState(localRuntimeState);
        if (statesEqual(localState, base.state)) {
          automaticSaveFailures.current = 0;
          if (mounted.current) setWorkspaceSaveError(undefined);
          return;
        }

        const result = await saveAppState(localState, base.revision);
        if (result.saved) {
          automaticSaveFailures.current = 0;
          if (mounted.current) setWorkspaceSaveError(undefined);
          if (result.snapshot.revision >= baseSnapshot.current.revision) {
            baseSnapshot.current = {
              state: durableState(result.snapshot.state),
              revision: result.snapshot.revision,
            };
          }
          continue;
        }

        // An event for an even newer revision may already have been handled
        // while this command was in flight. Never rebase backwards.
        if (result.snapshot.revision <= baseSnapshot.current.revision) continue;
        const latestRuntimeState = stateRef.current;
        const rebased = rebaseWorkspaceState(
          base.state,
          durableState(latestRuntimeState),
          result.snapshot.state,
        );
        baseSnapshot.current = {
          state: durableState(result.snapshot.state),
          revision: result.snapshot.revision,
        };
        setState(restoreRuntimeState(latestRuntimeState, normalizeWorkspaceState(rebased)));
      }
      shouldBackOff = true;
    } catch {
      shouldBackOff = true;
    } finally {
      saveInFlight.current = false;
      const stillDirty = !statesEqual(durableState(stateRef.current), baseSnapshot.current.state);
      if (stillDirty && mounted.current) {
        window.clearTimeout(saveTimer.current);
        if (shouldBackOff) {
          automaticSaveFailures.current += 1;
          const suspended = automaticSaveFailures.current >= MAX_AUTOMATIC_SAVE_ATTEMPTS;
          if (mounted.current) {
            setWorkspaceSaveError((suspended ? persistenceSuspendedMessage : persistenceRetryMessage)(
              stateRef.current.preferences.language,
            ));
          }
          if (!suspended) {
            const delay = saveRetryDelay(automaticSaveFailures.current - 1);
            saveTimer.current = window.setTimeout(() => void persistLatestState(), delay);
          }
        } else {
          saveTimer.current = window.setTimeout(() => void persistLatestState(), SAVE_DEBOUNCE_MS);
        }
      } else if (!stillDirty) {
        automaticSaveFailures.current = 0;
        window.clearTimeout(saveTimer.current);
        if (mounted.current) setWorkspaceSaveError(undefined);
      }
    }
  }, [setState]);

  const retryWorkspaceSave = useCallback(() => {
    automaticSaveFailures.current = 0;
    setWorkspaceSaveError(persistenceRetryMessage(stateRef.current.preferences.language));
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void persistLatestState(), 0);
  }, [persistLatestState]);

  useEffect(() => {
    if (!loaded) return;
    const currentDurableState = durableState(state);
    if (statesEqual(currentDurableState, baseSnapshot.current.state)) {
      lastObservedDurableState.current = currentDurableState;
      automaticSaveFailures.current = 0;
      window.clearTimeout(saveTimer.current);
      setWorkspaceSaveError(undefined);
      return;
    }
    // Runtime-only updates can re-render this hook many times per second.
    // Do not let them continually postpone a persistence retry when the
    // durable workspace itself has not changed.
    if (statesEqual(currentDurableState, lastObservedDurableState.current)) return;
    lastObservedDurableState.current = currentDurableState;
    automaticSaveFailures.current = 0;
    setWorkspaceSaveError((current) => current
      ? persistenceRetryMessage(state.preferences.language)
      : undefined);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void persistLatestState(), SAVE_DEBOUNCE_MS);
  }, [loaded, persistLatestState, state]);

  useEffect(() => {
    const root = document.documentElement;
    const requested = state.preferences.theme;
    const resolved = requested === "system" ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : requested;
    root.dataset.theme = resolved;
    root.dataset.motion = state.preferences.reduceMotion ? "reduced" : "full";
  }, [state.preferences.reduceMotion, state.preferences.theme]);

  const selectedProject = useMemo(
    () => state.projects.find((project) => project.id === state.selectedProjectId),
    [state.projects, state.selectedProjectId],
  );
  const selectedConversation = useMemo(
    () => state.conversations.find((conversation) => conversation.id === state.selectedConversationId),
    [state.conversations, state.selectedConversationId],
  );
  const projectConversations = useMemo(
    () => state.conversations.filter(
      (conversation) => conversation.projectId === state.selectedProjectId
        && !conversation.archived
        && (conversation.hasContent !== false || conversation.id === state.selectedConversationId),
    ),
    [state.conversations, state.selectedConversationId, state.selectedProjectId],
  );

  const updateState = useCallback((updater: (current: PersistedAppState) => PersistedAppState) => {
    setState((current) => updater(current));
  }, []);

  const addProject = useCallback(
    (path: string, globalDefaultModel?: string, rlmSnapshot?: RlmDelegationSnapshot) => {
      const existing = state.projects.find((project) => project.path.toLowerCase() === path.toLowerCase());
      if (existing) {
        setState((current) => ({
          ...current,
          selectedProjectId: existing.id,
          selectedConversationId: firstVisibleConversation(current.conversations, existing.id)?.id,
        }));
        setView("chat");
        return existing.id;
      }
      const project: Project = {
        id: newId("project"),
        manualOrder: 0,
        name: pathName(path),
        path,
        color: PROJECT_COLORS[state.projects.length % PROJECT_COLORS.length]!,
        createdAt: new Date().toISOString(),
        lastOpenedAt: new Date().toISOString(),
        pinned: false,
        permissionPreset: state.preferences.defaultPermissionPreset,
      };
      const conversation = createConversationRecord(
        project.id,
        state.preferences.defaultThinking,
        undefined,
        0,
        resolveNewConversationModel(undefined, project.defaultModel, globalDefaultModel),
        rlmSnapshot,
      );
      setState((current) => ({
        ...current,
        projects: [{ ...project, manualOrder: nextHeadOrder(current.projects) }, ...current.projects],
        conversations: [conversation, ...current.conversations],
        selectedProjectId: project.id,
        selectedConversationId: conversation.id,
      }));
      setView("chat");
      return project.id;
    },
    [state.preferences.defaultPermissionPreset, state.preferences.defaultThinking, state.projects],
  );

  const selectProject = useCallback((projectId: string) => {
    setState((current) => {
      const conversation = current.conversations
        .filter((item) => item.projectId === projectId && !item.archived)
        .sort(compareManualOrder)[0];
      return {
        ...current,
        selectedProjectId: projectId,
        selectedConversationId: conversation?.id,
        projects: current.projects.map((project) =>
          project.id === projectId ? { ...project, lastOpenedAt: new Date().toISOString() } : project,
        ),
      };
    });
    setView("chat");
  }, []);

  const openProjectConversation = useCallback(
    (projectId: string, globalDefaultModel?: string, rlmSnapshot?: RlmDelegationSnapshot) => {
      setState((current) => {
        const project = current.projects.find((item) => item.id === projectId);
        if (!project) return current;

        const existing = latestProjectConversation(current.conversations, projectId);
        const conversation = existing ?? createConversationRecord(
          projectId,
          current.preferences.defaultThinking,
          undefined,
          nextHeadOrder(current.conversations.filter((item) => item.projectId === projectId)),
          resolveNewConversationModel(undefined, project.defaultModel, globalDefaultModel),
          rlmSnapshot,
        );
        const timestamp = new Date().toISOString();
        return {
          ...current,
          conversations: existing ? current.conversations : [conversation, ...current.conversations],
          selectedProjectId: projectId,
          selectedConversationId: conversation.id,
          projects: current.projects.map((item) =>
            item.id === projectId ? { ...item, lastOpenedAt: timestamp } : item,
          ),
        };
      });
      setView("chat");
    },
    [setState],
  );

  const createConversation = useCallback(
    (projectId = state.selectedProjectId, title?: string, globalDefaultModel?: string, rlmSnapshot?: RlmDelegationSnapshot) => {
      if (!projectId) return undefined;
      setState((current) => {
        const canReuseDraft = !title?.trim() || title.trim() === "Nouvelle conversation";
        const existingDraft = canReuseDraft
          ? current.conversations
              .filter((conversation) => conversation.projectId === projectId && isReusableDraft(conversation))
              .sort(compareManualOrder)[0]
          : undefined;
        const conversation = existingDraft
          ? {
              ...existingDraft,
              model: resolveNewConversationModel(
                undefined,
                current.projects.find((project) => project.id === projectId)?.defaultModel,
                globalDefaultModel,
              ),
              thinkingLevel: current.preferences.defaultThinking,
              rlmPreferredModel: rlmSnapshot?.preferredModel,
              rlmThinkingLevel: rlmSnapshot?.thinkingLevel,
            }
          : createConversationRecord(
            projectId,
            current.preferences.defaultThinking,
            title,
            nextHeadOrder(current.conversations.filter((item) => item.projectId === projectId)),
            resolveNewConversationModel(
              undefined,
              current.projects.find((project) => project.id === projectId)?.defaultModel,
              globalDefaultModel,
            ),
            rlmSnapshot,
          );
        return {
          ...current,
          conversations: existingDraft
            ? current.conversations.map((item) => item.id === existingDraft.id ? conversation : item)
            : [conversation, ...current.conversations],
          selectedProjectId: projectId,
          selectedConversationId: conversation.id,
        };
      });
      setView("chat");
    },
    [state.selectedProjectId],
  );

  const importPrimeAgentSessions = useCallback((sessions: PrimeAgentSessionSummary[]) => {
    setState((current) => {
      const knownPaths = new Set(current.conversations.flatMap((conversation) =>
        conversation.sessionPath ? [pathIdentity(conversation.sessionPath)] : []));
      const knownSessionIds = new Set(current.conversations.flatMap((conversation) =>
        conversation.sessionId ? [conversation.sessionId] : []));
      const projectsByPath = new Map(current.projects.map((project) => [pathIdentity(project.path), project]));
      const additions: Conversation[] = [];
      const nextOrderByProject = new Map<string, number>();
      for (const session of sessions) {
        // Child/RLM sessions belong in supervision, not as top-level chats.
        if (session.rlmDepth > 0 || session.parentSessionPath) continue;
        const project = projectsByPath.get(pathIdentity(session.cwd));
        const sessionPath = pathIdentity(session.sessionPath);
        if (!project || knownPaths.has(sessionPath) || knownSessionIds.has(session.sessionId)) continue;
        const timestamp = session.updatedAtMs > 0
          ? new Date(session.updatedAtMs).toISOString()
          : session.createdAt && !Number.isNaN(Date.parse(session.createdAt))
            ? new Date(session.createdAt).toISOString()
            : new Date().toISOString();
        const currentHead = nextOrderByProject.get(project.id)
          ?? nextHeadOrder(current.conversations.filter((item) => item.projectId === project.id));
        nextOrderByProject.set(project.id, currentHead - 1);
        const title = session.sessionName?.trim()
          || session.firstMessage?.trim()
          || `Session Prime Agent ${session.sessionId.slice(-8)}`;
        additions.push({
          id: newId("conversation"),
          projectId: project.id,
          manualOrder: currentHead,
          title: title.slice(0, 120),
          createdAt: session.createdAt && !Number.isNaN(Date.parse(session.createdAt))
            ? new Date(session.createdAt).toISOString()
            : timestamp,
          updatedAt: timestamp,
          pinned: false,
          archived: false,
          status: "offline",
          sessionPath: session.sessionPath,
          sessionId: session.sessionId,
          thinkingLevel: current.preferences.defaultThinking,
          hasContent: session.messageCount > 0,
          draft: "",
          messages: [],
          activities: [],
        });
        knownPaths.add(sessionPath);
        knownSessionIds.add(session.sessionId);
      }
      return additions.length ? { ...current, conversations: [...additions, ...current.conversations] } : current;
    });
  }, []);

  const preserveConversationReference = useCallback((conversationId: string, title: string) => {
    const preservedId = newId("conversation");
    let created = false;
    setState((current) => {
      const source = current.conversations.find((conversation) => conversation.id === conversationId);
      if (!source?.sessionPath) return current;
      const timestamp = new Date().toISOString();
      const preserved = createPreservedConversationReference(
        source,
        preservedId,
        title,
        nextHeadOrder(current.conversations.filter((item) => item.projectId === source.projectId)),
        timestamp,
      );
      created = true;
      return { ...current, conversations: [preserved, ...current.conversations] };
    });
    return created ? preservedId : undefined;
  }, [setState]);

  const discardConversationReference = useCallback((conversationId: string) => {
    setState((current) => ({
      ...current,
      conversations: current.conversations.filter((conversation) => conversation.id !== conversationId),
    }));
  }, [setState]);

  const selectConversation = useCallback((conversationId: string) => {
    setState((current) => {
      const conversation = current.conversations.find((item) => item.id === conversationId && !item.archived);
      if (!conversation) return current;
      return {
        ...current,
        selectedConversationId: conversationId,
        selectedProjectId: conversation.projectId,
      };
    });
    setView("chat");
  }, []);

  const updateConversation = useCallback(
    (conversationId: string, updater: Partial<Conversation> | ((current: Conversation) => Conversation)) => {
      setState((current) => ({
        ...current,
        conversations: current.conversations.map((conversation) => {
          if (conversation.id !== conversationId) return conversation;
          if (typeof updater === "function") return updater(conversation);
          return applyConversationPatch(conversation, updater);
        }),
      }));
    },
    [],
  );

  const updateProject = useCallback((projectId: string, patch: Partial<Project>) => {
    setState((current) => ({
      ...current,
      projects: current.projects.map((project) => (project.id === projectId ? { ...project, ...patch } : project)),
    }));
  }, []);

  const reorderProject = useCallback((sourceId: string, targetId: string, placement: ReorderPlacement) => {
    setState((current) => ({
      ...current,
      projects: reorderManualGroup(current.projects, sourceId, targetId, placement),
    }));
  }, []);

  const reorderConversation = useCallback((sourceId: string, targetId: string, placement: ReorderPlacement) => {
    setState((current) => {
      const source = current.conversations.find((conversation) => conversation.id === sourceId);
      const target = current.conversations.find((conversation) => conversation.id === targetId);
      if (!source || !target || source.projectId !== target.projectId) return current;
      const reordered = reorderManualGroup(
        current.conversations.filter((conversation) => conversation.projectId === source.projectId),
        sourceId,
        targetId,
        placement,
      );
      let groupIndex = 0;
      return {
        ...current,
        conversations: current.conversations.map((conversation) => conversation.projectId === source.projectId
          ? reordered[groupIndex++]!
          : conversation),
      };
    });
  }, []);

  const deleteProject = useCallback((projectId: string) => {
    setState((current) => {
      const projects = current.projects.filter((project) => project.id !== projectId);
      const conversations = current.conversations.filter((conversation) => conversation.projectId !== projectId);
      const selectedProjectId = current.selectedProjectId === projectId
        ? [...projects].sort(compareManualOrder)[0]?.id
        : current.selectedProjectId;
      const selectedConversationId = conversations.some((conversation) => conversation.id === current.selectedConversationId)
        ? current.selectedConversationId
        : conversations
            .filter((conversation) => conversation.projectId === selectedProjectId && !conversation.archived)
            .sort(compareManualOrder)[0]?.id;
      return {
        ...current,
        projects,
        conversations,
        selectedProjectId,
        selectedConversationId,
      };
    });
  }, []);

  const archiveConversation = useCallback(
    (conversationId: string) => {
      setState((current) => {
        const target = current.conversations.find((conversation) => conversation.id === conversationId);
        if (!target) return current;
        const replacement = current.conversations
          .filter(
            (conversation) => conversation.projectId === target.projectId && conversation.id !== conversationId && !conversation.archived,
          )
          .sort(compareManualOrder)[0];
        const conversations = isDisposableEmptyConversation(target)
          ? current.conversations.filter((conversation) => conversation.id !== conversationId)
          : current.conversations.map((conversation) =>
              conversation.id === conversationId ? { ...conversation, archived: true } : conversation,
            );
        return {
          ...current,
          conversations,
          selectedConversationId: current.selectedConversationId === conversationId ? replacement?.id : current.selectedConversationId,
        };
      });
    },
    [],
  );

  return {
    state,
    setState,
    updateState,
    view,
    setView,
    loaded,
    workspaceSaveError,
    retryWorkspaceSave,
    selectedProject,
    selectedConversation,
    projectConversations,
    addProject,
    selectProject,
    openProjectConversation,
    createConversation,
    importPrimeAgentSessions,
    preserveConversationReference,
    discardConversationReference,
    selectConversation,
    updateConversation,
    updateProject,
    reorderProject,
    reorderConversation,
    deleteProject,
    archiveConversation,
  };
}

export function createPreservedConversationReference(
  source: Conversation,
  id: string,
  title: string,
  manualOrder: number,
  timestamp: string,
): Conversation {
  return {
    ...source,
    id,
    manualOrder,
    title,
    createdAt: timestamp,
    updatedAt: timestamp,
    pinned: false,
    archived: false,
    status: "offline",
    sessionNameSyncPending: true,
    draft: "",
    messages: [],
    activities: [],
    lastError: undefined,
  };
}

/**
 * Applies changes made since `base` on top of `remote`.
 *
 * Arrays are merged by stable id instead of replacing a whole snapshot. An
 * entity removed on either side stays removed, which is the tombstone rule
 * that prevents deleted projects and conversations from being resurrected by
 * a stale window. Fields changed only locally are replayed; fields changed
 * only remotely are retained.
 */
export function rebaseWorkspaceState(
  base: PersistedAppState,
  local: PersistedAppState,
  remote: PersistedAppState,
): PersistedAppState {
  const projects = mergeEntityCollection(base.projects, local.projects, remote.projects, mergeProject);
  const projectIds = new Set(projects.map((project) => project.id));
  const conversations = mergeEntityCollection(
    base.conversations,
    local.conversations,
    remote.conversations,
    mergeConversation,
  ).filter((conversation) => projectIds.has(conversation.projectId));

  return {
    version: Math.max(base.version, local.version, remote.version),
    projects,
    conversations,
    // Selection is window-local UI state. It may be persisted opportunistically
    // for the next launch, but a save from another window must never navigate
    // the current one or trigger a selection-only save ping-pong.
    selectedProjectId: local.selectedProjectId,
    selectedConversationId: local.selectedConversationId,
    preferences: mergeChangedFields(base.preferences, local.preferences, remote.preferences),
  };
}

function mergeEntityCollection<T extends { id: string }>(
  base: T[],
  local: T[],
  remote: T[],
  merge: (baseValue: T, localValue: T, remoteValue: T) => T,
): T[] {
  const baseById = new Map(base.map((value) => [value.id, value]));
  const localById = new Map(local.map((value) => [value.id, value]));
  const remoteById = new Map(remote.map((value) => [value.id, value]));

  // Local additions have not yet appeared in the durable ordering, so retain
  // their local order before the current remote collection.
  const localAdditions = local.filter((value) => !baseById.has(value.id) && !remoteById.has(value.id));
  const mergedRemote = remote.flatMap((remoteValue) => {
    const baseValue = baseById.get(remoteValue.id);
    const localValue = localById.get(remoteValue.id);
    if (baseValue && !localValue) return []; // local tombstone
    if (!localValue || !baseValue) return [localValue ?? remoteValue];
    return [merge(baseValue, localValue, remoteValue)];
  });
  return [...localAdditions, ...mergedRemote];
}

function mergeProject(base: Project, local: Project, remote: Project): Project {
  return mergeChangedFields(base, local, remote);
}

function mergeConversation(base: Conversation, local: Conversation, remote: Conversation): Conversation {
  const merged = mergeChangedFields(base, local, remote);
  return {
    ...merged,
    // Neither value has an inverse mutation in the application today. Treat
    // them as monotone so a stale window can never unarchive a conversation or
    // turn a real session back into a disposable draft.
    archived: base.archived || local.archived || remote.archived,
    hasContent: base.hasContent === true || local.hasContent === true || remote.hasContent === true
      ? true
      : merged.hasContent,
    updatedAt: local.updatedAt > remote.updatedAt ? local.updatedAt : remote.updatedAt,
  };
}

function mergeChangedFields<T extends object>(base: T, local: T, remote: T): T {
  const merged = { ...remote } as T;
  for (const key of Object.keys(local) as Array<keyof T>) {
    if (!valuesEqual(local[key], base[key])) merged[key] = local[key];
  }
  return merged;
}

function restoreRuntimeState(runtime: PersistedAppState, durable: PersistedAppState): PersistedAppState {
  const runtimeById = new Map(runtime.conversations.map((conversation) => [conversation.id, conversation]));
  return {
    ...durable,
    conversations: durable.conversations.map((conversation) => {
      const current = runtimeById.get(conversation.id);
      if (!current) return conversation;
      return {
        ...conversation,
        status: current.status,
        messages: current.messages,
        activities: current.activities,
        lastError: current.lastError,
      };
    }),
  };
}

/**
 * Compares JSON-compatible values without depending on object insertion order.
 *
 * Native state crosses serde_json, whose map representation sorts keys. A
 * newly-created frontend entity retains its construction order, so comparing
 * JSON.stringify output directly made the same state look dirty forever after
 * the first save. Undefined object members are ignored to match JSON
 * serialization at the IPC boundary.
 */
export function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => jsonValuesEqual(value, right[index]));
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key)
    && rightRecord[key] !== undefined
    && jsonValuesEqual(leftRecord[key], rightRecord[key]));
}

function valuesEqual(left: unknown, right: unknown) {
  return jsonValuesEqual(left, right);
}

export function workspaceStatesEqual(left: PersistedAppState, right: PersistedAppState) {
  return jsonValuesEqual(
    { ...left, selectedProjectId: undefined, selectedConversationId: undefined },
    { ...right, selectedProjectId: undefined, selectedConversationId: undefined },
  );
}

function statesEqual(left: PersistedAppState, right: PersistedAppState) {
  return workspaceStatesEqual(left, right);
}

const RUNTIME_ONLY_CONVERSATION_FIELDS = new Set<keyof Conversation>([
  "status",
  "messages",
  "activities",
  "lastError",
]);

/** Applies a partial conversation update without turning runtime-only events into durable writes. */
export function applyConversationPatch(
  conversation: Conversation,
  patch: Partial<Conversation>,
  timestamp = new Date().toISOString(),
): Conversation {
  const durableFieldChanged = (Object.keys(patch) as Array<keyof Conversation>).some((key) =>
    key !== "updatedAt"
      && !RUNTIME_ONLY_CONVERSATION_FIELDS.has(key)
      && !jsonValuesEqual(conversation[key], patch[key]),
  );
  return {
    ...conversation,
    ...patch,
    updatedAt: patch.updatedAt ?? (durableFieldChanged ? timestamp : conversation.updatedAt),
  };
}

function normalizeWorkspaceState(state: PersistedAppState): PersistedAppState {
  // Migration from v0.1.3 and earlier: existing array order becomes the
  // initial manual order. Once every item has a rank, timestamps and pinning
  // never influence position again.
  const projects = normalizeManualOrderGroup(state.projects);
  const orderedConversations = projects.flatMap((project) => normalizeManualOrderGroup(
    state.conversations.filter((conversation) => conversation.projectId === project.id),
  ));
  const withoutArchivedGhosts = orderedConversations.filter(
    (conversation) => !conversation.archived || !isDisposableEmptyConversation(conversation),
  );
  const reusableDraftsByProject = new Map<string, Conversation>();
  for (const conversation of withoutArchivedGhosts) {
    if (!isReusableDraft(conversation)) continue;
    const existing = reusableDraftsByProject.get(conversation.projectId);
    if (!existing || compareManualOrder(conversation, existing) < 0) {
      reusableDraftsByProject.set(conversation.projectId, conversation);
    }
  }
  const conversations = withoutArchivedGhosts.filter(
    (conversation) => !isReusableDraft(conversation) || reusableDraftsByProject.get(conversation.projectId)?.id === conversation.id,
  );
  const selectedProjectId = projects.some((project) => project.id === state.selectedProjectId)
    ? state.selectedProjectId
    : projects[0]?.id;
  const selectedConversation = conversations.find(
    (conversation) => conversation.id === state.selectedConversationId
      && conversation.projectId === selectedProjectId
      && !conversation.archived,
  );
  const selectedConversationId = selectedConversation?.id
    ?? (state.selectedConversationId ? firstVisibleConversation(conversations, selectedProjectId)?.id : undefined);
  return {
    ...state,
    version: Math.max(state.version, defaultAppState.version),
    projects,
    conversations,
    selectedProjectId,
    selectedConversationId,
    preferences: { ...defaultAppState.preferences, ...state.preferences },
  };
}

function firstVisibleConversation(conversations: Conversation[], projectId?: string) {
  return conversations
    .filter((conversation) => conversation.projectId === projectId && !conversation.archived)
    .sort(compareManualOrder)[0];
}

function isReusableDraft(conversation: Conversation) {
  return !conversation.archived && isDisposableEmptyConversation(conversation);
}

function isDisposableEmptyConversation(conversation: Conversation) {
  return conversation.title.trim() === "Nouvelle conversation"
    && conversation.hasContent === false
    && !conversation.pinned
    && conversation.messages.length === 0
    && conversation.draft.trim().length === 0;
}

function createConversationRecord(
  projectId: string,
  thinkingLevel: Conversation["thinkingLevel"],
  title = "Nouvelle conversation",
  manualOrder = 0,
  model?: string,
  rlmSnapshot?: RlmDelegationSnapshot,
): Conversation {
  const timestamp = new Date().toISOString();
  return {
    id: newId("conversation"),
    projectId,
    manualOrder,
    title,
    createdAt: timestamp,
    updatedAt: timestamp,
    pinned: false,
    archived: false,
    status: "offline",
    model,
    thinkingLevel,
    rlmPreferredModel: rlmSnapshot?.preferredModel,
    rlmThinkingLevel: rlmSnapshot?.thinkingLevel,
    hasContent: false,
    draft: "",
    messages: [],
    activities: [],
  };
}

/** Resolves the immutable model snapshot for a newly-created conversation. */
export function resolveNewConversationModel(
  conversationModel?: string,
  projectDefaultModel?: string,
  globalDefaultModel?: string,
) {
  return [conversationModel, projectDefaultModel, globalDefaultModel]
    .map((value) => value?.trim())
    .find((value): value is string => Boolean(value));
}

type ReorderPlacement = "before" | "after";

type ManuallyOrdered = { id: string; manualOrder?: number };

function compareManualOrder<T extends ManuallyOrdered>(left: T, right: T) {
  const leftOrder = Number.isFinite(left.manualOrder) ? left.manualOrder! : Number.MAX_SAFE_INTEGER;
  const rightOrder = Number.isFinite(right.manualOrder) ? right.manualOrder! : Number.MAX_SAFE_INTEGER;
  return leftOrder - rightOrder || left.id.localeCompare(right.id);
}

function normalizeManualOrderGroup<T extends ManuallyOrdered>(items: T[]): T[] {
  if (items.some((item) => !Number.isFinite(item.manualOrder))) {
    return items.map((item, index) => ({ ...item, manualOrder: index }));
  }
  return [...items].sort(compareManualOrder);
}

function nextHeadOrder<T extends ManuallyOrdered>(items: T[]) {
  if (items.length === 0) return 0;
  return Math.min(...items.map((item, index) => Number.isFinite(item.manualOrder) ? item.manualOrder! : index)) - 1;
}

function reorderManualGroup<T extends ManuallyOrdered>(
  items: T[],
  sourceId: string,
  targetId: string,
  placement: ReorderPlacement,
): T[] {
  if (sourceId === targetId) return items;
  const ordered = normalizeManualOrderGroup(items);
  const source = ordered.find((item) => item.id === sourceId);
  const target = ordered.find((item) => item.id === targetId);
  if (!source || !target) return items;

  const withoutSource = ordered.filter((item) => item.id !== sourceId);
  const targetIndex = withoutSource.findIndex((item) => item.id === targetId);
  const insertionIndex = targetIndex + (placement === "after" ? 1 : 0);
  const desired = [...withoutSource];
  desired.splice(insertionIndex, 0, source);
  const sourceIndex = desired.findIndex((item) => item.id === sourceId);
  const previous = desired[sourceIndex - 1];
  const next = desired[sourceIndex + 1];
  const previousOrder = previous?.manualOrder;
  const nextOrder = next?.manualOrder;

  let manualOrder: number;
  if (previousOrder === undefined && nextOrder === undefined) manualOrder = 0;
  else if (previousOrder === undefined) manualOrder = nextOrder! - 1;
  else if (nextOrder === undefined) manualOrder = previousOrder + 1;
  else manualOrder = previousOrder + (nextOrder - previousOrder) / 2;

  if (!Number.isFinite(manualOrder)
    || (previousOrder !== undefined && nextOrder !== undefined && Math.abs(nextOrder - previousOrder) < 1e-9)) {
    return desired.map((item, index) => ({ ...item, manualOrder: index }));
  }
  return desired.map((item) => item.id === sourceId ? { ...item, manualOrder } : item);
}
