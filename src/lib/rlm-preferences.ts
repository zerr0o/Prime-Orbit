import type { ThinkingLevel } from "../types";

export const RLM_PREFERENCES_STORAGE_KEY = "prime-orbit.rlm-preferences.v1";

export type RlmThinkingPreference = "inherit" | ThinkingLevel;

export interface RlmPreferences {
  /** Fully-qualified Prime Agent model reference (`provider/model`). */
  preferredModel?: string;
  thinking: RlmThinkingPreference;
}

export interface RlmDelegationSnapshot {
  preferredModel?: string;
  thinkingLevel?: ThinkingLevel;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const defaultRlmPreferences: RlmPreferences = {
  preferredModel: undefined,
  thinking: "inherit",
};

const thinkingLevels = new Set<RlmThinkingPreference>([
  "inherit",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function normalizeModelReferenceInput(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim();
  if (
    candidate.length === 0
    || candidate.length > 512
    || !/^[A-Za-z0-9._:@/-]+$/.test(candidate)
    || candidate.startsWith("/")
    || candidate.includes("//")
  ) return undefined;
  return candidate;
}

export function isCompleteModelReference(value: unknown): value is string {
  const candidate = normalizeModelReferenceInput(value);
  return Boolean(candidate && candidate.includes("/") && !candidate.endsWith("/"));
}

export function normalizeRlmPreferences(value: unknown): RlmPreferences {
  if (!value || typeof value !== "object") return { ...defaultRlmPreferences };
  const candidate = value as Partial<RlmPreferences>;
  const preferredModel = normalizeModelReferenceInput(candidate.preferredModel);
  const thinking = typeof candidate.thinking === "string" && thinkingLevels.has(candidate.thinking as RlmThinkingPreference)
    ? candidate.thinking as RlmThinkingPreference
    : "inherit";
  return { preferredModel, thinking };
}

export function loadRlmPreferences(storage?: StorageLike): RlmPreferences {
  const target = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!target) return { ...defaultRlmPreferences };
  try {
    const raw = target.getItem(RLM_PREFERENCES_STORAGE_KEY);
    return raw ? normalizeRlmPreferences(JSON.parse(raw)) : { ...defaultRlmPreferences };
  } catch {
    return { ...defaultRlmPreferences };
  }
}

export function saveRlmPreferences(preferences: RlmPreferences, storage?: StorageLike): RlmPreferences {
  const normalized = normalizeRlmPreferences(preferences);
  const target = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  if (target) {
    try {
      target.setItem(RLM_PREFERENCES_STORAGE_KEY, JSON.stringify(normalized));
    } catch {
      // The in-memory preference remains useful when storage is unavailable.
    }
  }
  return normalized;
}

/** Merges one editor change with the latest persisted value across windows. */
export function patchRlmPreferences(
  patch: Partial<RlmPreferences>,
  storage?: StorageLike,
): RlmPreferences {
  return saveRlmPreferences({ ...loadRlmPreferences(storage), ...patch }, storage);
}

export function snapshotRlmPreferences(preferences: RlmPreferences, runtimeVersion?: string): RlmDelegationSnapshot {
  const normalized = normalizeRlmPreferences(preferences);
  return {
    preferredModel: isCompleteModelReference(normalized.preferredModel) ? normalized.preferredModel : undefined,
    thinkingLevel: normalized.thinking !== "inherit" && supportsRlmThinking(runtimeVersion)
      ? normalized.thinking
      : undefined,
  };
}

/** Produces a bounded, one-line, best-effort delegation instruction. */
export function buildRlmDelegationPrompt(snapshot: RlmDelegationSnapshot): string | undefined {
  const clauses: string[] = [];
  const normalizedModel = normalizeRlmPreferences({ preferredModel: snapshot.preferredModel, thinking: "inherit" }).preferredModel;
  const preferredModel = isCompleteModelReference(normalizedModel) ? normalizedModel : undefined;
  if (preferredModel) clauses.push(`prefer model ${preferredModel}`);
  if (snapshot.thinkingLevel && thinkingLevels.has(snapshot.thinkingLevel)) clauses.push(`prefer thinking level ${snapshot.thinkingLevel}`);
  if (clauses.length === 0) return undefined;
  return `Prime Orbit delegation preference: when using rlm.run, ${clauses.join(" and ")}. This is advisory; use an available compatible model and report any fallback.`.slice(0, 4_096);
}

/** @deprecated Use a per-conversation snapshot with buildRlmDelegationPrompt. */
export function buildRlmPreferenceAdvisory(preferences: RlmPreferences, runtimeVersion?: string) {
  return buildRlmDelegationPrompt(snapshotRlmPreferences(preferences, runtimeVersion));
}

export function supportsRlmThinking(version?: string): boolean {
  if (!version) return false;
  const match = version.trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const current = match.slice(1).map(Number);
  const minimum = [0, 7, 4];
  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index] !== minimum[index]) return current[index] > minimum[index];
  }
  return true;
}
