import type {
  ChatMessage,
  RefinementOutcomeAction,
  RefinementOutcomeEditNotice,
  RefinementOutcomeKind,
  RefinementOutcomeNotice,
  RefinementOutcomeScope,
} from "../types";

export const REFINEMENT_SUMMARY_MAX_CHARS = 480;
export const REFINEMENT_DETAIL_MAX_CHARS = 1_200;
export const REFINEMENT_ID_MAX_CHARS = 200;
export const REFINEMENT_EDIT_MAX_COUNT = 64;

export interface ParsedRefinementOutcomeNotice {
  content: string;
  notice: RefinementOutcomeNotice;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function scopeValue(value: unknown): RefinementOutcomeScope | undefined {
  return value === "local" || value === "global" ? value : undefined;
}

function actionValue(value: unknown): RefinementOutcomeAction | undefined {
  return value === "create" || value === "update" || value === "delete" ? value : undefined;
}

function kindValue(value: unknown): RefinementOutcomeKind | undefined {
  return value === "prompt" || value === "memory" || value === "skill" || value === "subagent" ? value : undefined;
}

function editValue(value: unknown): RefinementOutcomeEditNotice | undefined {
  const edit = asRecord(value);
  if (!edit) return undefined;
  const action = actionValue(edit.action);
  const kind = kindValue(edit.kind);
  const id = boundedText(edit.id, REFINEMENT_ID_MAX_CHARS);
  if (!action || !kind || !id || typeof edit.applied !== "boolean") return undefined;
  const title = boundedText(edit.title, REFINEMENT_SUMMARY_MAX_CHARS);
  const error = boundedText(edit.error, REFINEMENT_DETAIL_MAX_CHARS);
  return {
    action,
    kind,
    id,
    ...(title ? { title } : {}),
    applied: edit.applied,
    ...(error ? { error } : {}),
  };
}

/** Accepts only Prime Agent 0.8's typed, displayable custom-message envelope. */
export function parseRefinementOutcomeNotice(value: unknown): ParsedRefinementOutcomeNotice | undefined {
  const message = asRecord(value);
  if (!message || message.role !== "custom" || message.customType !== "refinement_outcome" || message.display !== true) return undefined;
  const details = asRecord(message.details);
  if (!details) return undefined;
  const refinementId = boundedText(details.refinementId, REFINEMENT_ID_MAX_CHARS);
  const summary = boundedText(details.summary, REFINEMENT_SUMMARY_MAX_CHARS);
  const scope = scopeValue(details.scope);
  if (!refinementId || !summary || !scope || !Array.isArray(details.edits)) return undefined;
  const edits = details.edits.slice(0, REFINEMENT_EDIT_MAX_COUNT).map(editValue).filter((edit): edit is RefinementOutcomeEditNotice => Boolean(edit));
  if (edits.length !== Math.min(details.edits.length, REFINEMENT_EDIT_MAX_COUNT)) return undefined;
  const rollbackOf = boundedText(details.rollbackOf, REFINEMENT_ID_MAX_CHARS);
  return {
    content: summary,
    notice: {
      kind: "refinement_outcome",
      refinementId,
      summary,
      scope,
      ...(rollbackOf ? { rollbackOf } : {}),
      edits,
    },
  };
}

/** Appends the live refinement once even though Prime Agent emits start and end. */
export function appendUniqueRefinementOutcome(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const notice = message.notice?.kind === "refinement_outcome" ? message.notice : undefined;
  if (!notice) return [...messages, message];
  if (messages.some((candidate) => (
    candidate.notice?.kind === "refinement_outcome"
    && candidate.notice.refinementId === notice.refinementId
  ))) return messages;
  return [...messages, message];
}
