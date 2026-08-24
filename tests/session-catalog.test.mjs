import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

const buildResult = await build({
  entryPoints: ["src/components/DashboardViews.tsx"],
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

const { filterSessionCatalogRows, sessionCatalogRows } = compiledModule.exports;

const workspaceBuild = await build({
  entryPoints: ["src/hooks/useWorkspace.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  logLevel: "silent",
});
const compiledWorkspace = { exports: {} };
new Function("module", "exports", "require", workspaceBuild.outputFiles[0].text)(
  compiledWorkspace,
  compiledWorkspace.exports,
  require,
);
const { attachCatalogSession } = compiledWorkspace.exports;

const project = {
  id: "project-known",
  name: "Known",
  path: "C:\\work\\known",
  color: "#7c6cff",
};

function conversation(overrides = {}) {
  return {
    id: "conversation-known",
    projectId: project.id,
    title: "Orbit session",
    createdAt: "2026-08-24T10:00:00.000Z",
    updatedAt: "2026-08-24T12:00:00.000Z",
    pinned: false,
    archived: false,
    status: "offline",
    sessionPath: "C:\\prime\\known.jsonl",
    sessionId: "known-session",
    thinkingLevel: "balanced",
    hasContent: true,
    draft: "",
    messages: [],
    activities: [],
    ...overrides,
  };
}

function session(overrides = {}) {
  return {
    catalogKey: crypto.randomUUID(),
    sessionPath: "C:\\prime\\external.jsonl",
    sessionId: "external-session",
    cwd: "C:\\external\\terminal-project",
    messageCount: 3,
    rlmDepth: 0,
    updatedAtMs: Date.parse("2026-08-24T13:00:00.000Z"),
    sessionState: "active",
    catalogStatus: "saved",
    folderAvailable: true,
    firstMessage: "Inspect terminal project",
    ...overrides,
  };
}

test("merges Orbit conversations with the native catalog without duplicating a session", () => {
  const known = conversation();
  const rows = sessionCatalogRows([project], [known], [
    session({
      catalogKey: "11111111-1111-4111-8111-111111111111",
      sessionPath: known.sessionPath,
      sessionId: known.sessionId,
      cwd: project.path,
      updatedAtMs: Date.parse(known.updatedAt),
    }),
    session(),
    session({
      catalogKey: "22222222-2222-4222-8222-222222222222",
      sessionPath: "C:\\prime\\duplicate.jsonl",
      updatedAtMs: Date.parse("2026-08-24T11:00:00.000Z"),
    }),
  ]);

  assert.equal(rows.length, 2);
  const linked = rows.find((row) => row.session?.sessionId === known.sessionId);
  assert.equal(linked.conversation.id, known.id);
  assert.equal(linked.external, false);
  assert.equal(rows.find((row) => row.session?.sessionId === "external-session").external, true);
});

test("searches title, first message, folder and id while exposing every catalog filter", () => {
  const rows = sessionCatalogRows([project], [], [
    session({ sessionName: "Terminal audit", agentTaskState: "needs_input", catalogStatus: "needs_input" }),
    session({
      catalogKey: "33333333-3333-4333-8333-333333333333",
      sessionPath: "C:\\prime\\archived.jsonl",
      sessionId: "archived-id",
      cwd: "D:\\moved\\archive",
      sessionName: "Old investigation",
      firstMessage: "Historical prompt",
      sessionState: "archived",
      catalogStatus: "archived",
      folderAvailable: false,
      updatedAtMs: Date.parse("2026-08-23T10:00:00.000Z"),
    }),
  ]);

  assert.equal(filterSessionCatalogRows(rows, "all", "terminal audit").length, 1);
  assert.equal(filterSessionCatalogRows(rows, "all", "Historical prompt").length, 1);
  assert.equal(filterSessionCatalogRows(rows, "all", "D:\\moved").length, 1);
  assert.equal(filterSessionCatalogRows(rows, "all", "archived-id").length, 1);
  assert.equal(filterSessionCatalogRows(rows, "active", "").length, 1);
  assert.equal(filterSessionCatalogRows(rows, "attention", "").length, 1);
  assert.equal(filterSessionCatalogRows(rows, "external", "").length, 2);
  assert.equal(filterSessionCatalogRows(rows, "archived", "").length, 1);
});

test("keeps Orbit-only conversations visible when no native file remains", () => {
  const orphaned = conversation({ sessionPath: "C:\\prime\\missing.jsonl", sessionId: "missing" });
  const rows = sessionCatalogRows([project], [orphaned], []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].conversation.id, orphaned.id);
  assert.equal(rows[0].external, false);
});

test("adds an external folder only through the explicit attachment transition", () => {
  const external = session();
  const initial = {
    projects: [],
    conversations: [],
    preferences: {
      defaultPermissionPreset: "standard",
      defaultThinking: "balanced",
    },
  };
  assert.equal(initial.projects.length, 0, "catalog browsing starts without mutating workspace state");
  const attached = attachCatalogSession(initial, external);
  assert.equal(attached.state.projects.length, 1);
  assert.equal(attached.state.projects[0].path, external.cwd);
  assert.equal(attached.state.conversations.length, 1);
  assert.equal(attached.state.conversations[0].sessionId, external.sessionId);
  assert.equal(attached.state.selectedConversationId, attached.conversationId);

  assert.throws(
    () => attachCatalogSession(initial, { ...external, folderAvailable: false }),
    /folder is unavailable/,
  );
});
