import type { AppUpdateState } from "../types";

const UPDATE_PHASES = new Set<AppUpdateState["phase"]>([
  "idle",
  "checking",
  "upToDate",
  "available",
  "downloading",
  "ready",
  "installing",
  "error",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finiteBytes(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function finiteRevision(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

/**
 * Treat updater IPC as untrusted input. In particular, never surface a
 * restart-ready state unless a concrete release version accompanied it.
 */
export function normalizeAppUpdateState(value: unknown, fallbackVersion: string): AppUpdateState {
  const source = record(value);
  const revision = finiteRevision(source?.revision);
  const currentVersion = typeof source?.currentVersion === "string" && source.currentVersion.trim()
    ? source.currentVersion.trim()
    : fallbackVersion;
  const rawPhase = source?.phase;
  const phase = typeof rawPhase === "string" && UPDATE_PHASES.has(rawPhase as AppUpdateState["phase"])
    ? rawPhase as AppUpdateState["phase"]
    : "idle";
  const rawUpdate = record(source?.update);
  const updateVersion = typeof rawUpdate?.version === "string" ? rawUpdate.version.trim() : "";
  const update = updateVersion
    ? {
        version: updateVersion,
        notes: typeof rawUpdate?.notes === "string" && rawUpdate.notes.trim() ? rawUpdate.notes : undefined,
        publishedAt: typeof rawUpdate?.publishedAt === "string" && rawUpdate.publishedAt.trim() ? rawUpdate.publishedAt : undefined,
      }
    : undefined;
  const requiresUpdate = phase === "available" || phase === "downloading" || phase === "ready" || phase === "installing";
  if (requiresUpdate && !update) {
    return { revision, phase: "error", currentVersion, operation: "check" };
  }

  const totalBytes = finiteBytes(source?.totalBytes);
  const rawDownloadedBytes = finiteBytes(source?.downloadedBytes);
  const downloadedBytes = rawDownloadedBytes === undefined
    ? undefined
    : totalBytes && totalBytes > 0
      ? Math.min(rawDownloadedBytes, totalBytes)
      : rawDownloadedBytes;
  const operation = source?.operation === "check" || source?.operation === "download" || source?.operation === "install"
    ? source.operation
    : undefined;
  const trigger = source?.trigger === "automatic" || source?.trigger === "manual"
    ? source.trigger
    : undefined;

  return {
    revision,
    phase,
    currentVersion,
    update,
    downloadedBytes,
    totalBytes: totalBytes && totalBytes > 0 ? totalBytes : undefined,
    lastCheckedAt: typeof source?.lastCheckedAt === "string" && source.lastCheckedAt.trim() ? source.lastCheckedAt : undefined,
    error: typeof source?.error === "string" && source.error.trim() ? source.error : undefined,
    operation,
    trigger,
  };
}

export function resolveInitialAppUpdateState(snapshot: unknown, queuedEvent: unknown, fallbackVersion: string) {
  const normalizedSnapshot = normalizeAppUpdateState(snapshot, fallbackVersion);
  if (queuedEvent === undefined) return normalizedSnapshot;
  const normalizedEvent = normalizeAppUpdateState(queuedEvent, fallbackVersion);
  return preferNewestAppUpdateState(normalizedSnapshot, normalizedEvent);
}

/**
 * Native updater events and invoke responses share one process-wide sequence.
 * Equal revisions represent the same native transition, so the last delivered
 * payload wins; an older response can never roll a window back.
 */
export function preferNewestAppUpdateState(current: AppUpdateState, incoming: AppUpdateState) {
  return incoming.revision >= current.revision ? incoming : current;
}

export function beginAppUpdateCheck(state: AppUpdateState, trigger: "automatic" | "manual"): AppUpdateState {
  return {
    revision: state.revision,
    phase: "checking",
    currentVersion: state.currentVersion,
    lastCheckedAt: state.lastCheckedAt,
    trigger,
  };
}

export function beginAppUpdateDownload(state: AppUpdateState): AppUpdateState {
  if (!state.update) return state;
  return {
    revision: state.revision,
    phase: "downloading",
    currentVersion: state.currentVersion,
    update: state.update,
    downloadedBytes: 0,
    totalBytes: state.totalBytes,
    lastCheckedAt: state.lastCheckedAt,
  };
}

export function beginAppUpdateInstall(state: AppUpdateState): AppUpdateState {
  if (!state.update) return state;
  return {
    revision: state.revision,
    phase: "installing",
    currentVersion: state.currentVersion,
    update: state.update,
    lastCheckedAt: state.lastCheckedAt,
  };
}

export function failAppUpdateOperation(
  state: AppUpdateState,
  operation: "check" | "download" | "install",
  error: string,
): AppUpdateState {
  return {
    revision: state.revision,
    phase: "error",
    currentVersion: state.currentVersion,
    update: state.update,
    lastCheckedAt: state.lastCheckedAt,
    operation,
    error,
  };
}

export function appUpdateProgressPercent(state: AppUpdateState) {
  if (state.phase !== "downloading" || !state.totalBytes || state.downloadedBytes === undefined) return undefined;
  return Math.max(0, Math.min(100, Math.floor((state.downloadedBytes / state.totalBytes) * 100)));
}

export function shouldRunAutomaticUpdateCheck(options: {
  enabled: boolean;
  initialized: boolean;
  attempted: boolean;
  native: boolean;
}) {
  return options.enabled && options.initialized && !options.attempted && options.native;
}
