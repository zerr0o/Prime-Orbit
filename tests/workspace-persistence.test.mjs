import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

const buildResult = await build({
  entryPoints: ["src/hooks/useWorkspace.ts"],
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
  applyConversationPatch,
  jsonValuesEqual,
  rebaseWorkspaceState,
  workspaceStatesEqual,
} = compiledModule.exports;

function conversation(overrides = {}) {
  return {
    id: "conversation-a",
    projectId: "project-a",
    manualOrder: 0,
    title: "Nouvelle conversation",
    createdAt: "2026-08-19T10:00:00.000Z",
    updatedAt: "2026-08-19T10:00:00.000Z",
    pinned: false,
    archived: false,
    status: "offline",
    thinkingLevel: "high",
    hasContent: false,
    draft: "",
    messages: [],
    activities: [],
    ...overrides,
  };
}

function project() {
  return {
    id: "project-a",
    manualOrder: 0,
    name: "Project A",
    path: "C:\\Projects\\A",
    color: "#7c6cff",
    createdAt: "2026-08-19T10:00:00.000Z",
    lastOpenedAt: "2026-08-19T10:00:00.000Z",
    pinned: false,
    permissionPreset: "standard",
  };
}

function state(overrides = {}) {
  return {
    version: 2,
    projects: [project()],
    conversations: [conversation()],
    selectedProjectId: "project-a",
    selectedConversationId: "conversation-a",
    preferences: {
      theme: "dark",
      language: "fr",
      restoreLastWorkspace: false,
      compactSidebar: false,
      inspectorOpen: true,
      bottomDockOpen: false,
      telemetry: false,
      defaultThinking: "high",
      defaultPermissionPreset: "standard",
      reduceMotion: false,
    },
    ...overrides,
  };
}

function sortObjectKeys(value) {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObjectKeys(value[key])]));
}

test("treats serde-sorted snapshots and frontend insertion order as the same workspace", () => {
  const frontendState = state();
  const nativeSnapshot = sortObjectKeys(frontendState);

  assert.notEqual(JSON.stringify(frontendState), JSON.stringify(nativeSnapshot));
  assert.equal(workspaceStatesEqual(frontendState, nativeSnapshot), true);
  assert.equal(jsonValuesEqual({ present: 1, omitted: undefined }, { present: 1 }), true);
});

test("a self-save rebase of a newly-created entity settles instead of writing forever", () => {
  const base = state({ projects: [], conversations: [], selectedProjectId: undefined, selectedConversationId: undefined });
  const local = state();
  const nativeSnapshot = sortObjectKeys(local);
  const rebased = rebaseWorkspaceState(base, local, nativeSnapshot);

  // The rebase deliberately keeps the local object for a local addition. Its
  // key order differs from serde_json, but it is not a new durable mutation.
  assert.notEqual(JSON.stringify(rebased), JSON.stringify(nativeSnapshot));
  assert.equal(workspaceStatesEqual(rebased, nativeSnapshot), true);
});

test("still detects real durable workspace changes while ignoring window selection", () => {
  const original = state();
  assert.equal(workspaceStatesEqual(original, {
    ...original,
    selectedProjectId: "project-in-another-window",
    selectedConversationId: undefined,
  }), true);
  assert.equal(workspaceStatesEqual(original, {
    ...original,
    projects: [{ ...original.projects[0], pinned: true }],
  }), false);
});

test("runtime-only conversation patches do not advance the durable timestamp", () => {
  const original = conversation();
  const runtimeUpdate = applyConversationPatch(original, {
    status: "streaming",
    lastError: undefined,
  }, "2026-08-19T10:05:00.000Z");
  assert.equal(runtimeUpdate.updatedAt, original.updatedAt);

  const unchangedDurableUpdate = applyConversationPatch(original, {
    title: original.title,
  }, "2026-08-19T10:05:00.000Z");
  assert.equal(unchangedDurableUpdate.updatedAt, original.updatedAt);

  const durableUpdate = applyConversationPatch(original, {
    title: "Renamed",
  }, "2026-08-19T10:05:00.000Z");
  assert.equal(durableUpdate.updatedAt, "2026-08-19T10:05:00.000Z");
});
