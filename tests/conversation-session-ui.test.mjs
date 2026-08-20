import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

const buildResult = await build({
  entryPoints: ["src/components/ConversationView.tsx"],
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
  buildToolSequenceSegments,
  buildContextUsageSnapshot,
  buildSessionPanelSummary,
  initialPythonExecutionGroupExpanded,
  initialToolCardExpanded,
  isGoalPanelBusy,
  isRefineControlBusy,
} = compiledModule.exports;

test("keeps Python tool details collapsed while a live execution is running", () => {
  assert.equal(initialPythonExecutionGroupExpanded(), false);
  assert.equal(initialToolCardExpanded({ status: "running" }, true), false);
  assert.equal(initialToolCardExpanded({ status: "completed" }, true), false);
  assert.equal(initialToolCardExpanded({ status: "running" }, false), true, "non-Python live tools preserve their current behavior");
});

test("routes even one Python execution through the collapsed Python group", () => {
  const python = { id: "python-1", name: "ipython", title: "Python", status: "running", input: "print(1)" };
  const shell = { id: "shell-1", name: "bash", title: "Shell", status: "running", input: "echo 1" };
  assert.deepEqual(buildToolSequenceSegments([python]), [{ kind: "python", tools: [python] }]);
  assert.deepEqual(buildToolSequenceSegments([shell]), [{ kind: "tool", tool: shell }]);
});

test("builds context details only from real counters and clamps the visual meter", () => {
  assert.deepEqual(buildContextUsageSnapshot({
    contextUsage: { tokens: 75_000, contextWindow: 100_000, percent: 75 },
  }, { autoCompactionEnabled: true }), {
    usedTokens: 75_000,
    contextWindow: 100_000,
    availableTokens: 25_000,
    percent: 75,
    ringPercent: 75,
    status: "warning",
    autoCompactionEnabled: true,
  });

  const overflow = buildContextUsageSnapshot({
    contextUsage: { tokens: 104_000, contextWindow: 100_000, percent: 104 },
  });
  assert.equal(overflow.availableTokens, 0);
  assert.equal(overflow.percent, 104, "the reported percentage stays visible instead of being falsified");
  assert.equal(overflow.ringPercent, 100, "only the circular visualization is clamped");
  assert.equal(overflow.status, "critical");
});

test("derives a percentage from reported token counters but preserves unavailable metrics", () => {
  const derived = buildContextUsageSnapshot({
    contextUsage: { tokens: 32_000, contextWindow: 128_000, percent: null },
  });
  assert.equal(derived.percent, 25);
  assert.equal(derived.availableTokens, 96_000);

  assert.deepEqual(buildContextUsageSnapshot(), {
    usedTokens: null,
    contextWindow: null,
    availableTokens: null,
    percent: null,
    ringPercent: 0,
    status: "unavailable",
    autoCompactionEnabled: undefined,
  });
});

test("compaction is surfaced as the authoritative context state", () => {
  const snapshot = buildContextUsageSnapshot({
    contextUsage: { tokens: 20_000, contextWindow: 100_000, percent: 20 },
  }, undefined, true);
  assert.equal(snapshot.status, "compacting");
});

test("runtime refinement keeps a second Refine action disabled after local acknowledgement", () => {
  assert.equal(isRefineControlBusy(false), false);
  assert.equal(isRefineControlBusy(false, "refine"), true);
  assert.equal(isRefineControlBusy(true), true);
  assert.equal(isRefineControlBusy(true, "export_html"), true);
});

test("goal actions remain disabled after navigation while their runtime mutation is pending", () => {
  assert.equal(isGoalPanelBusy(false), false);
  assert.equal(isGoalPanelBusy(false, { command: "/goal Ship", kind: "start", phase: "sending" }), true);
  assert.equal(isGoalPanelBusy(false, { command: "/goal Ship", kind: "start", phase: "waiting" }), true);
  assert.equal(isGoalPanelBusy(false, { command: "/goal Ship", kind: "start", phase: "reconciling" }), true);
  assert.equal(isGoalPanelBusy(false, { command: "/goal Ship", kind: "start", phase: "error", error: "Failed" }), false);
  assert.equal(isGoalPanelBusy(true), true);
});

test("session navigation counts each real capability without mixing completed supervision jobs", () => {
  const summary = buildSessionPanelSummary({
    messages: [
      { attachments: [{ id: "image" }, { id: "document" }] },
      { attachments: [{ id: "archive" }] },
    ],
  }, {
    goal: { objective: "Ship the release" },
    sessionActions: {
      steering: ["check tests"],
      followUps: ["publish", "verify"],
      active: { kind: "turn", phase: "running" },
    },
  }, [
    { id: "schedule-active", status: "active", source: "cron" },
    { id: "schedule-complete", status: "completed", source: "cron" },
    { id: "schedule-heartbeat", status: "active", source: "heartbeat" },
  ], { id: "heartbeat-current" }, [
    { job: { id: "heartbeat-current", status: "active" } },
    { job: { id: "heartbeat-remote", status: "paused" } },
    { job: { id: "heartbeat-complete", status: "completed" } },
  ], [{ id: "child-a" }, { id: "child-b" }]);

  assert.deepEqual(summary, {
    attachments: 3,
    queued: 3,
    hasActiveAction: true,
    goals: 1,
    agents: 2,
    supervision: 3,
  });
});

test("session navigation does not present Prime Agent's retained completion record as active work", () => {
  const base = {
    sessionActions: { steering: [], followUps: [] },
  };
  const summary = (goal) => buildSessionPanelSummary(
    { messages: [] },
    { ...base, goal },
    [],
    undefined,
    [],
    [],
  );

  assert.equal(summary({ status: "active", objective: "Ship" }).goals, 1);
  assert.equal(summary({ status: "complete", objective: "Ship" }).goals, 0);
  assert.equal(summary({ status: "idle" }).goals, 0);
});
