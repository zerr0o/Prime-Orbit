import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

const buildResult = await build({
  entryPoints: ["src/lib/project-navigation.ts"],
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
const { latestProjectConversation } = compiledModule.exports;

function conversation(id, updatedAt, overrides = {}) {
  return {
    id,
    projectId: "project-a",
    manualOrder: 0,
    title: id,
    createdAt: "2026-08-19T10:00:00.000Z",
    updatedAt,
    pinned: false,
    archived: false,
    status: "offline",
    thinkingLevel: "high",
    hasContent: true,
    draft: "",
    messages: [],
    activities: [],
    ...overrides,
  };
}

test("project tiles resume the most recently updated conversation, not sidebar order", () => {
  const olderFirstInSidebar = conversation("older", "2026-08-19T10:05:00.000Z", { manualOrder: -10 });
  const latest = conversation("latest", "2026-08-19T11:00:00.000Z", { manualOrder: 20 });

  assert.equal(latestProjectConversation([olderFirstInSidebar, latest], "project-a")?.id, "latest");
});

test("archived and other-project conversations are never resumed", () => {
  const visible = conversation("visible", "2026-08-19T10:05:00.000Z");
  const archived = conversation("archived", "2026-08-19T12:00:00.000Z", { archived: true });
  const otherProject = conversation("other", "2026-08-19T13:00:00.000Z", { projectId: "project-b" });

  assert.equal(latestProjectConversation([archived, otherProject, visible], "project-a")?.id, "visible");
  assert.equal(latestProjectConversation([archived, otherProject], "project-a"), undefined);
});

test("an existing local draft is resumed instead of creating another conversation", () => {
  const draft = conversation("draft", "2026-08-19T11:00:00.000Z", {
    hasContent: false,
    draft: "Une consigne encore non envoyée",
  });

  assert.equal(latestProjectConversation([draft], "project-a")?.id, "draft");
});

test("invalid update timestamps fall back to creation time deterministically", () => {
  const older = conversation("older", "invalid", { createdAt: "2026-08-19T09:00:00.000Z" });
  const newer = conversation("newer", "invalid", { createdAt: "2026-08-19T10:00:00.000Z" });

  assert.equal(latestProjectConversation([newer, older], "project-a")?.id, "newer");
});
