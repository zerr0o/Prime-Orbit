import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

const buildResult = await build({
  entryPoints: ["src/lib/goal-control.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  logLevel: "silent",
});
const compiledModule = { exports: {} };
const require = createRequire(import.meta.url);
new Function("module", "exports", "require", buildResult.outputFiles[0].text)(
  compiledModule,
  compiledModule.exports,
  require,
);
const {
  goalAcknowledgementDisposition,
  goalForSessionSnapshot,
  goalMutationDescriptor,
  goalMutationEventMatches,
  goalMutationReached,
  sessionGoalCount,
} = compiledModule.exports;

test("a late prompt failure cannot override an authoritative Goal event", () => {
  assert.equal(goalAcknowledgementDisposition({ isCurrent: true, settled: false, success: true }), "wait");
  assert.equal(goalAcknowledgementDisposition({ isCurrent: true, settled: false, success: false }), "reject");
  assert.equal(goalAcknowledgementDisposition({ isCurrent: true, settled: true, success: false }), "ignore");
  assert.equal(goalAcknowledgementDisposition({ isCurrent: false, settled: false, success: false }), "ignore");
});

test("recognizes the official goal mutations without hijacking status requests", () => {
  assert.deepEqual(goalMutationDescriptor("/goal clear"), { command: "/goal clear", kind: "clear" });
  assert.deepEqual(goalMutationDescriptor(" /goal stop "), { command: "/goal stop", kind: "clear" });
  assert.deepEqual(goalMutationDescriptor("/goal pause"), { command: "/goal pause", kind: "pause" });
  assert.deepEqual(goalMutationDescriptor("/goal resume"), { command: "/goal resume", kind: "resume" });
  assert.deepEqual(goalMutationDescriptor("/goal --budget 50000 Ship it"), {
    command: "/goal --budget 50000 Ship it",
    kind: "start",
    objective: "Ship it",
  });
  assert.deepEqual(goalMutationDescriptor("/goal --token-budget 50000 Ship it"), {
    command: "/goal --token-budget 50000 Ship it",
    kind: "start",
    objective: "Ship it",
  });
  assert.deepEqual(goalMutationDescriptor("/goal --budget=50000 Ship it"), {
    command: "/goal --budget=50000 Ship it",
    kind: "start",
    objective: "Ship it",
  });
  assert.deepEqual(goalMutationDescriptor("/goal --token-budget=50000 Ship it"), {
    command: "/goal --token-budget=50000 Ship it",
    kind: "start",
    objective: "Ship it",
  });
  assert.deepEqual(goalMutationDescriptor("/goal Ship --budget 50000"), {
    command: "/goal Ship --budget 50000",
    kind: "start",
    objective: "Ship --budget 50000",
  }, "budget flags only have special meaning in the first position");
  assert.equal(goalMutationDescriptor("/goal status"), undefined);
  assert.equal(goalMutationDescriptor("/goal"), undefined);
  assert.equal(goalMutationDescriptor("Explain /goal clear"), undefined);
});

test("settles each mutation only on its authoritative target state", () => {
  assert.equal(goalMutationReached({ command: "/goal clear", kind: "clear" }, { status: "idle" }), true);
  assert.equal(goalMutationReached({ command: "/goal clear", kind: "clear" }, { status: "complete", objective: "Done" }), false);
  assert.equal(goalMutationReached({ command: "/goal pause", kind: "pause" }, { status: "paused", objective: "Wait" }), true);
  assert.equal(goalMutationReached({ command: "/goal resume", kind: "resume" }, { status: "active", objective: "Continue" }), true);
  assert.equal(goalMutationReached({ command: "/goal New work", kind: "start", objective: "New work" }, { status: "active", objective: "New work" }), true);
});

test("a goal waiter survives navigation and only follows its originating conversation", () => {
  const pending = { conversationId: "conversation-a", descriptor: { command: "/goal clear", kind: "clear" } };
  const selectedConversationId = "conversation-b";

  assert.notEqual(selectedConversationId, pending.conversationId, "the user navigated away");
  assert.equal(goalMutationEventMatches(pending, "conversation-a", { status: "idle" }), true);
  assert.equal(goalMutationEventMatches(pending, "conversation-b", { status: "idle" }), false);
});

test("concurrent goal starts settle only for their exact objective", () => {
  const alpha = {
    conversationId: "conversation-a",
    descriptor: { command: "/goal --budget 50000 Alpha", kind: "start", objective: "Alpha" },
  };
  const beta = {
    conversationId: "conversation-a",
    descriptor: { command: "/goal Beta", kind: "start", objective: "Beta" },
  };

  assert.equal(goalMutationEventMatches(alpha, "conversation-a", { status: "active", objective: "Beta" }), false);
  assert.equal(goalMutationEventMatches(beta, "conversation-a", { status: "active", objective: "Alpha" }), false);
  assert.equal(goalMutationEventMatches(alpha, "conversation-a", { status: "active", objective: "Alpha" }), true);
  assert.equal(goalMutationEventMatches(beta, "conversation-a", { status: "active", objective: "Beta" }), true);
});

test("a newer goal event wins over an older get_state snapshot", () => {
  const staleComplete = { status: "complete", objective: "Already done" };
  const cleared = { status: "idle" };

  assert.deepEqual(goalForSessionSnapshot({
    snapshot: staleComplete,
    latestEvent: cleared,
    requestedEventEpoch: 4,
    currentEventEpoch: 5,
  }), cleared);
  assert.deepEqual(goalForSessionSnapshot({
    snapshot: staleComplete,
    latestEvent: cleared,
    requestedEventEpoch: 5,
    currentEventEpoch: 5,
  }), staleComplete);
});

test("completed goals stay inspectable without claiming an active Session goal", () => {
  assert.equal(sessionGoalCount({ status: "active", objective: "Ship" }), 1);
  assert.equal(sessionGoalCount({ status: "paused", objective: "Ship" }), 1);
  assert.equal(sessionGoalCount({ status: "budget_limited", objective: "Ship" }), 1);
  assert.equal(sessionGoalCount({ status: "error", objective: "Ship" }), 1);
  assert.equal(sessionGoalCount({ status: "complete", objective: "Ship" }), 0);
  assert.equal(sessionGoalCount({ status: "idle" }), 0);
});
