import type { Conversation } from "../types";

export function orderedConversationSiblings(conversations: Conversation[], conversation: Conversation) {
  return conversations
    .filter((item) => item.projectId === conversation.projectId && !item.archived && item.hasContent !== false)
    .sort((left, right) => {
      const leftOrder = Number.isFinite(left.manualOrder) ? left.manualOrder! : Number.MAX_SAFE_INTEGER;
      const rightOrder = Number.isFinite(right.manualOrder) ? right.manualOrder! : Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || left.id.localeCompare(right.id);
    });
}

export function conversationMoveTarget(
  conversations: Conversation[],
  conversation: Conversation,
  direction: -1 | 1,
) {
  const siblings = orderedConversationSiblings(conversations, conversation);
  const index = siblings.findIndex((item) => item.id === conversation.id);
  return index < 0 ? undefined : siblings[index + direction];
}
