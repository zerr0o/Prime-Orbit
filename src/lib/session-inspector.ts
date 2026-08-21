import type {
  ActivityItem,
  AgentRlmChild,
  SessionRefinementKind,
  SessionRefinementRecord,
} from "../types";

export interface SessionPopoverAction {
  type: "set_auto_compaction";
  fields: { enabled: boolean };
  keepOpen: true;
}

/** Behavior settings are edited in place; selecting either radio option must
 * not dismiss the parent popover before the refreshed state is rendered. */
export function automaticCompactionAction(enabled: boolean): SessionPopoverAction {
  return {
    type: "set_auto_compaction",
    fields: { enabled },
    keepOpen: true,
  };
}

/** Prime Agent 0.7.x emits this exact reason when rlm.delete_subagent() is
 * intentionally called by the parent. Other cancellation reasons remain real
 * cancellations and must keep their warning presentation. */
export function isParentManagedSubagentClosure(child: Pick<AgentRlmChild, "status" | "error">): boolean {
  return child.status === "cancelled" && child.error?.trim() === "Deleted by parent orchestrator";
}

export interface SubagentStatusPresentation {
  label: string;
  tone: "neutral" | "accent" | "success" | "warning" | "danger";
  visualStatus: "queued" | "running" | "done" | "error" | "cancelled" | "closed";
}

export function subagentStatusPresentation(
  child: Pick<AgentRlmChild, "status" | "error">,
  language: "fr" | "en",
): SubagentStatusPresentation {
  if (isParentManagedSubagentClosure(child)) {
    return {
      label: language === "en" ? "Closed" : "Fermé",
      tone: "neutral",
      visualStatus: "closed",
    };
  }
  if (child.status === "running") {
    return { label: language === "en" ? "Running" : "En cours", tone: "accent", visualStatus: "running" };
  }
  if (child.status === "done") {
    return { label: language === "en" ? "Complete" : "Terminé", tone: "success", visualStatus: "done" };
  }
  if (child.status === "error") {
    return { label: language === "en" ? "Error" : "Erreur", tone: "danger", visualStatus: "error" };
  }
  if (child.status === "cancelled") {
    return { label: language === "en" ? "Cancelled" : "Annulé", tone: "warning", visualStatus: "cancelled" };
  }
  return { label: language === "en" ? "Queued" : "En attente", tone: "neutral", visualStatus: "queued" };
}

const REFINEMENT_ACTIVITY_TYPES = new Set(["refine_start", "refine_complete", "refine_failed"]);

/** Keep only observable, already-redacted live lifecycle records and bound
 * inspector work on long conversations. Persisted records are hydrated by the
 * separate validated JSONL projection. */
export function refinementHistory(
  activities: readonly ActivityItem[],
  limit = 4,
): ActivityItem[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  return activities
    .filter((activity) => REFINEMENT_ACTIVITY_TYPES.has(activity.type))
    .slice(-Math.floor(limit))
    .reverse();
}

export interface ObservedHarnessEntry {
  key: string;
  id: string;
  kind: SessionRefinementKind;
  scope: "local" | "global" | "unknown";
  title?: string;
  content?: string;
  refinementId: string;
  updatedAt: string;
}

/** Reconstructs only the latest state proven by the records explicitly passed
 * to this helper. The native history reader performs the authoritative fold
 * over the full validated session file before bounding its returned snapshot. */
export function observedHarnessEntries(
  records: readonly SessionRefinementRecord[],
  limit = 12,
): ObservedHarnessEntry[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const entries = new Map<string, ObservedHarnessEntry>();
  for (const record of records) {
    const scope = record.scope ?? "unknown";
    for (const edit of record.appliedEdits) {
      if (!edit.applied) continue;
      const key = `${scope}:${edit.kind}:${edit.id}`;
      if (edit.action === "delete") {
        entries.delete(key);
        continue;
      }
      const previous = entries.get(key);
      entries.set(key, {
        key,
        id: edit.id,
        kind: edit.kind,
        scope,
        title: edit.title ?? previous?.title,
        content: edit.content ?? previous?.content,
        refinementId: record.id,
        updatedAt: record.timestamp,
      });
    }
  }
  return [...entries.values()]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, Math.floor(limit));
}

export function persistedRefinementHistory(
  records: readonly SessionRefinementRecord[],
  limit = 6,
): SessionRefinementRecord[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  return records.slice(-Math.floor(limit)).reverse();
}

export const SESSION_MEMORY_CAPABILITIES = Object.freeze({
  canRequestRefinement: true,
  canInspectPersistedRefinements: true,
  canInspectEntries: true,
  canEditEntries: false,
  canDeleteEntries: false,
});
