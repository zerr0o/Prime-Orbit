import type {
  AgentMessageNotice,
  AgentMessageRelationship,
  ChatMessage,
} from "../types";

export const AGENT_MESSAGE_BODY_MAX_CHARS = 16_384;
export const AGENT_MESSAGE_PREVIEW_MAX_CHARS = 240;

const AGENT_MESSAGE_WIRE_MAX_CHARS = AGENT_MESSAGE_BODY_MAX_CHARS + 4_096;
const AGENT_MESSAGE_PARTICIPANT_MAX_CHARS = 160;
const AGENT_MESSAGE_ID = /^agentmsg_[A-Za-z0-9-]{1,200}$/u;
const LEGACY_RELATIONSHIP = /^\[from (parent|sibling|child)(?::([^\]\r\n]{1,160}))?\]$/u;

export interface ParsedAgentMessageNotice {
  content: string;
  notice: AgentMessageNotice;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function boundedBody(value: unknown): string | undefined {
  const body = stringValue(value)?.trim();
  if (!body) return undefined;
  if (body.length <= AGENT_MESSAGE_BODY_MAX_CHARS) return body;
  return `${body.slice(0, AGENT_MESSAGE_BODY_MAX_CHARS - 1)}…`;
}

function boundedParticipant(value: unknown): string | undefined {
  const participant = stringValue(value)?.replace(/\s+/gu, " ").trim();
  if (!participant) return undefined;
  return participant.slice(0, AGENT_MESSAGE_PARTICIPANT_MAX_CHARS);
}

function relationshipValue(value: unknown): AgentMessageRelationship | undefined {
  return value === "parent" || value === "sibling" || value === "child"
    ? value
    : undefined;
}

/** Only a human-readable session name may cross into presentation metadata.
 * Runtime, client, and session ids intentionally have no UI fallback. */
function structuredParticipant(value: unknown): string | undefined {
  const sender = asRecord(value);
  if (!sender) return undefined;
  return boundedParticipant(sender.sessionName);
}

function structuredAgentMessage(message: Record<string, unknown>): ParsedAgentMessageNotice | undefined {
  if (message.customType !== "agent_message") return undefined;
  const details = asRecord(message.details);
  const messageId = stringValue(details?.id);
  const content = boundedBody(details?.message);
  if (!messageId || !AGENT_MESSAGE_ID.test(messageId) || !content) return undefined;
  const relationship = relationshipValue(details?.fromRelationship);
  const participant = structuredParticipant(details?.from);
  return {
    content,
    notice: {
      kind: "agent_message",
      messageId,
      ...(participant ? { participant } : {}),
      ...(relationship ? { relationship } : {}),
    },
  };
}

function legacySenderParticipant(value: string | undefined): string | undefined {
  if (!value?.startsWith("From: ")) return undefined;
  const parts = value.slice("From: ".length).split(",").map((part) => part.trim()).filter(Boolean);
  const sessionName = parts.find((part) => !/^(?:active|session|client)\s/u.test(part));
  return boundedParticipant(sessionName);
}

/** Strict compatibility parser for histories sanitized by older Orbit builds.
 * It accepts only Prime Agent's canonical custom-message channel and header
 * order, so ordinary user/assistant/system text can never impersonate a notice. */
function legacyAgentMessage(message: Record<string, unknown>): ParsedAgentMessageNotice | undefined {
  if ("customType" in message && message.customType !== "agent_message") return undefined;
  const raw = stringValue(message.content);
  if (!raw || raw.length > AGENT_MESSAGE_WIRE_MAX_CHARS) return undefined;
  const lines = raw.replace(/\r\n?/gu, "\n").split("\n");
  let cursor = 0;
  let relationship: AgentMessageRelationship | undefined;
  let relationshipParticipant: string | undefined;
  if (lines[cursor]?.startsWith("[from ")) {
    const match = LEGACY_RELATIONSHIP.exec(lines[cursor]!);
    if (!match) return undefined;
    relationship = relationshipValue(match[1]);
    relationshipParticipant = boundedParticipant(match[2]);
    cursor += 1;
  }
  if (lines[cursor++] !== "Agent-to-agent message received.") return undefined;
  if (lines[cursor++] !== "Source: agent_message") return undefined;
  const fromLine = lines[cursor]?.startsWith("From: ") ? lines[cursor++] : undefined;
  if (!/^To: .+$/u.test(lines[cursor] ?? "")) return undefined;
  cursor += 1;
  const idMatch = /^Message id: (agentmsg_[A-Za-z0-9-]{1,200})$/u.exec(lines[cursor++] ?? "");
  if (!idMatch || lines[cursor++] !== "") return undefined;
  const content = boundedBody(lines.slice(cursor).join("\n"));
  if (!content) return undefined;
  const participant = relationshipParticipant ?? legacySenderParticipant(fromLine);
  return {
    content,
    notice: {
      kind: "agent_message",
      messageId: idMatch[1]!,
      ...(participant ? { participant } : {}),
      ...(relationship ? { relationship } : {}),
    },
  };
}

/** Converts only a displayable Prime Agent custom record into safe UI data. */
export function parseAgentMessageNotice(value: unknown): ParsedAgentMessageNotice | undefined {
  const message = asRecord(value);
  if (!message || message.role !== "custom" || message.display !== true) return undefined;
  return structuredAgentMessage(message) ?? legacyAgentMessage(message);
}

export function agentMessagePreview(
  content: string,
  maxChars = AGENT_MESSAGE_PREVIEW_MAX_CHARS,
): string {
  const normalized = content.replace(/\s+/gu, " ").trim();
  const requestedMax = Number.isFinite(maxChars)
    ? Math.floor(maxChars)
    : AGENT_MESSAGE_PREVIEW_MAX_CHARS;
  const boundedMax = Math.max(1, Math.min(requestedMax, AGENT_MESSAGE_BODY_MAX_CHARS));
  if (normalized.length <= boundedMax) return normalized;
  if (boundedMax === 1) return "…";
  return `${normalized.slice(0, boundedMax - 1).trimEnd()}…`;
}

/** Appends a live notice once even though Prime Agent emits start and end events. */
export function appendUniqueAgentMessage(
  messages: ChatMessage[],
  message: ChatMessage,
): ChatMessage[] {
  const notice = message.notice?.kind === "agent_message" ? message.notice : undefined;
  if (!notice) return [...messages, message];
  if (messages.some((candidate) => (
    candidate.notice?.kind === "agent_message"
    && candidate.notice.messageId === notice.messageId
  ))) return messages;
  return [...messages, message];
}
