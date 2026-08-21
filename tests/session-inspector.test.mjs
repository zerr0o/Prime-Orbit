import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

const buildResult = await build({
  entryPoints: ["src/lib/session-inspector.ts"],
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
  automaticCompactionAction,
  isParentManagedSubagentClosure,
  observedHarnessEntries,
  persistedRefinementHistory,
  refinementHistory,
  SESSION_MEMORY_CAPABILITIES,
  subagentStatusPresentation,
} = compiledModule.exports;

test("keeps automatic-compaction selections inside the open session menu", () => {
  assert.deepEqual(automaticCompactionAction(true), {
    type: "set_auto_compaction",
    fields: { enabled: true },
    keepOpen: true,
  });
  assert.deepEqual(automaticCompactionAction(false), {
    type: "set_auto_compaction",
    fields: { enabled: false },
    keepOpen: true,
  });
});

test("presents a parent-managed subagent deletion as a neutral closure only for the exact runtime reason", () => {
  const parentClosed = { status: "cancelled", error: "Deleted by parent orchestrator" };
  assert.equal(isParentManagedSubagentClosure(parentClosed), true);
  assert.deepEqual(subagentStatusPresentation(parentClosed, "fr"), {
    label: "Fermé",
    tone: "neutral",
    visualStatus: "closed",
  });

  const userCancelled = { status: "cancelled", error: "Cancelled by user" };
  assert.equal(isParentManagedSubagentClosure(userCancelled), false);
  assert.deepEqual(subagentStatusPresentation(userCancelled, "en"), {
    label: "Cancelled",
    tone: "warning",
    visualStatus: "cancelled",
  });

  assert.deepEqual(subagentStatusPresentation({ status: "error", error: "Provider unavailable" }, "fr"), {
    label: "Erreur",
    tone: "danger",
    visualStatus: "error",
  });
});

test("shows only bounded refinement events and states the current memory API boundary", () => {
  const activities = [
    { id: "agent", type: "agent_end" },
    { id: "refine-1", type: "refine_complete" },
    { id: "tool", type: "tool_execution_end" },
    { id: "refine-2", type: "refine_failed" },
    { id: "refine-3", type: "refine_start" },
  ];
  assert.deepEqual(refinementHistory(activities, 2).map((activity) => activity.id), ["refine-3", "refine-2"]);
  assert.deepEqual(refinementHistory(activities, 0), []);
  assert.deepEqual(SESSION_MEMORY_CAPABILITIES, {
    canRequestRefinement: true,
    canInspectPersistedRefinements: true,
    canInspectEntries: true,
    canEditEntries: false,
    canDeleteEntries: false,
  });
});

test("reconstructs only currently observed harness entries across create, update and delete", () => {
  const records = [
    {
      id: "create",
      timestamp: "2026-08-21T10:00:00Z",
      scope: "local",
      appliedEdits: [
        { action: "create", kind: "memory", id: "decision", title: "Draft", content: "old", applied: true },
        { action: "create", kind: "skill", id: "validator", title: "Validator", content: "safe", applied: true },
      ],
    },
    {
      id: "update",
      timestamp: "2026-08-21T10:01:00Z",
      scope: "local",
      appliedEdits: [
        { action: "update", kind: "memory", id: "decision", title: "Final", content: "new", applied: true },
        { action: "delete", kind: "skill", id: "validator", applied: false, error: "rejected" },
      ],
    },
    {
      id: "delete",
      timestamp: "2026-08-21T10:02:00Z",
      scope: "local",
      appliedEdits: [{ action: "delete", kind: "memory", id: "decision", applied: true }],
    },
  ];

  assert.deepEqual(observedHarnessEntries(records, 12), [{
    key: "local:skill:validator",
    id: "validator",
    kind: "skill",
    scope: "local",
    title: "Validator",
    content: "safe",
    refinementId: "create",
    updatedAt: "2026-08-21T10:00:00Z",
  }]);
  assert.deepEqual(observedHarnessEntries(records, 0), []);
  assert.deepEqual(persistedRefinementHistory(records, 2).map((record) => record.id), ["delete", "update"]);
});
