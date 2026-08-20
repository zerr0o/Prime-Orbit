import type { Conversation } from "../types";

/**
 * Finds the most recently updated conversation that can still be opened for a
 * project. Manual sidebar order and pinning intentionally do not affect this
 * choice: catalog project tiles are a "resume work" action.
 */
export function latestProjectConversation(
  conversations: readonly Conversation[],
  projectId: string,
): Conversation | undefined {
  let latest: Conversation | undefined;
  for (const conversation of conversations) {
    if (conversation.projectId !== projectId || conversation.archived) continue;
    if (!latest || compareConversationRecency(conversation, latest) > 0) latest = conversation;
  }
  return latest;
}

function compareConversationRecency(left: Conversation, right: Conversation) {
  const updatedDifference = conversationTimestamp(left.updatedAt, left.createdAt)
    - conversationTimestamp(right.updatedAt, right.createdAt);
  if (updatedDifference !== 0) return updatedDifference;

  const createdDifference = conversationTimestamp(left.createdAt)
    - conversationTimestamp(right.createdAt);
  return createdDifference || left.id.localeCompare(right.id);
}

function conversationTimestamp(value: string, fallback?: string) {
  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp)) return timestamp;
  const fallbackTimestamp = fallback ? Date.parse(fallback) : Number.NaN;
  return Number.isFinite(fallbackTimestamp) ? fallbackTimestamp : Number.MIN_SAFE_INTEGER;
}
