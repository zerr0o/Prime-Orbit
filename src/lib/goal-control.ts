import type { GoalState } from "../types";

export type GoalMutationKind = "start" | "pause" | "resume" | "clear";

export interface GoalMutationDescriptor {
  command: string;
  kind: GoalMutationKind;
  /** Exact validated objective expected from the first active update. */
  objective?: string;
}

export interface PendingGoalMutationIdentity {
  conversationId: string;
  descriptor: GoalMutationDescriptor;
}

export interface GoalMutationRuntimeState {
  command: string;
  kind: GoalMutationKind;
  phase: "sending" | "waiting" | "reconciling" | "error";
  error?: string;
}

export type GoalAcknowledgementDisposition = "ignore" | "reject" | "wait";

/** A matching lifecycle event is authoritative. Any prompt acknowledgement
 * arriving after it must not turn a completed mutation back into an error. */
export function goalAcknowledgementDisposition(input: {
  isCurrent: boolean;
  settled: boolean;
  success: boolean | undefined;
}): GoalAcknowledgementDisposition {
  if (!input.isCurrent || input.settled) return "ignore";
  return input.success === false ? "reject" : "wait";
}

/**
 * Recognize only Prime Agent's real goal-mutating slash commands. Status and
 * bare `/goal` requests remain ordinary prompts because they do not mutate the
 * durable goal state.
 */
export function goalMutationDescriptor(message: unknown): GoalMutationDescriptor | undefined {
  if (typeof message !== "string") return undefined;
  const command = message.trim();
  if (!/^\/goal(?:\s|$)/i.test(command)) return undefined;
  const argument = command.slice("/goal".length).trim();
  if (!argument || /^status$/i.test(argument)) return undefined;
  if (/^(?:clear|stop)$/i.test(argument)) return { command, kind: "clear" };
  if (/^pause$/i.test(argument)) return { command, kind: "pause" };
  if (/^resume$/i.test(argument)) return { command, kind: "resume" };
  let objective = argument;
  const firstToken = argument.split(/\s+/, 1)[0] ?? "";
  if (firstToken === "--budget" || firstToken === "--token-budget") {
    const withoutFlag = argument.slice(firstToken.length).trimStart();
    const nextSpace = withoutFlag.search(/\s/);
    objective = nextSpace < 0 ? "" : withoutFlag.slice(nextSpace + 1).trim();
  } else if (firstToken.startsWith("--budget=") || firstToken.startsWith("--token-budget=")) {
    objective = argument.slice(firstToken.length).trim();
  }
  return { command, kind: "start", objective: objective || undefined };
}

export function goalMutationReached(descriptor: GoalMutationDescriptor, goal: GoalState | undefined): boolean {
  if (!goal) return false;
  if (descriptor.kind === "clear") return goal.status === "idle" && !goal.objective;
  if (descriptor.kind === "pause") return goal.status === "paused";
  if (descriptor.kind === "resume") return goal.status === "active";
  return goal.status === "active"
    && descriptor.objective !== undefined
    && goal.objective === descriptor.objective;
}

/** Goal events are broadcast for every open conversation. Never let the
 * currently selected conversation decide which pending mutation settles. */
export function goalMutationEventMatches(
  pending: PendingGoalMutationIdentity,
  eventConversationId: string,
  goal: GoalState | undefined,
): boolean {
  return pending.conversationId === eventConversationId
    && goalMutationReached(pending.descriptor, goal);
}

/** A snapshot requested before a goal event must not overwrite that newer
 * event when its response arrives later. */
export function goalForSessionSnapshot(input: {
  snapshot?: GoalState;
  latestEvent?: GoalState;
  requestedEventEpoch: number;
  currentEventEpoch: number;
}): GoalState | undefined {
  return input.currentEventEpoch !== input.requestedEventEpoch && input.latestEvent
    ? input.latestEvent
    : input.snapshot;
}

/** The Session navigation badge represents a current goal requiring action,
 * not Prime Agent's intentionally retained completion record. */
export function sessionGoalCount(goal: GoalState | undefined): 0 | 1 {
  if (!goal?.objective || goal.status === "idle" || goal.status === "complete") return 0;
  return 1;
}
