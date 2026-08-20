import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

const buildResult = await build({
  entryPoints: ["src/lib/app-updater.ts"],
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
  appUpdateProgressPercent,
  beginAppUpdateCheck,
  beginAppUpdateDownload,
  beginAppUpdateInstall,
  failAppUpdateOperation,
  normalizeAppUpdateState,
  preferNewestAppUpdateState,
  resolveInitialAppUpdateState,
  shouldRunAutomaticUpdateCheck,
} = compiledModule.exports;

test("normalizes malformed updater snapshots without inventing an available update", () => {
  assert.deepEqual(normalizeAppUpdateState(undefined, "0.1.13"), {
    revision: 0,
    phase: "idle",
    currentVersion: "0.1.13",
    update: undefined,
    downloadedBytes: undefined,
    totalBytes: undefined,
    lastCheckedAt: undefined,
    error: undefined,
    operation: undefined,
    trigger: undefined,
  });
  assert.deepEqual(normalizeAppUpdateState({ phase: "ready", currentVersion: "0.1.13" }, "fallback"), {
    revision: 0,
    phase: "error",
    currentVersion: "0.1.13",
    operation: "check",
  });
});

test("sanitizes download counters and clamps impossible progress", () => {
  const state = normalizeAppUpdateState({
    phase: "downloading",
    currentVersion: "0.1.13",
    update: { version: "0.1.14", notes: "  Signed release  " },
    downloadedBytes: 2_000,
    totalBytes: 1_000,
  }, "fallback");
  assert.equal(state.downloadedBytes, 1_000);
  assert.equal(state.totalBytes, 1_000);
  assert.equal(state.update.notes, "  Signed release  ");
  assert.equal(appUpdateProgressPercent(state), 100);
});

test("initial subscription and later IPC responses keep the highest native revision", () => {
  const snapshot = { revision: 4, phase: "checking", currentVersion: "0.1.13", trigger: "automatic" };
  const olderQueued = { revision: 3, phase: "available", currentVersion: "0.1.13", update: { version: "0.1.14" } };
  const newerQueued = { revision: 5, phase: "available", currentVersion: "0.1.13", update: { version: "0.1.14" } };
  assert.equal(resolveInitialAppUpdateState(snapshot, olderQueued, "fallback").phase, "checking");
  assert.equal(resolveInitialAppUpdateState(snapshot, newerQueued, "fallback").phase, "available");
  assert.equal(resolveInitialAppUpdateState(snapshot, undefined, "fallback").phase, "checking");

  const current = normalizeAppUpdateState(newerQueued, "fallback");
  const staleResponse = normalizeAppUpdateState(snapshot, "fallback");
  assert.equal(preferNewestAppUpdateState(current, staleResponse), current);
});

test("optimistic action states retain only the metadata needed for the current operation", () => {
  const available = {
    revision: 7,
    phase: "available",
    currentVersion: "0.1.13",
    update: { version: "0.1.14", notes: "Release notes" },
    lastCheckedAt: "2026-08-20T10:00:00.000Z",
  };
  assert.deepEqual(beginAppUpdateCheck(available, "manual"), {
    revision: available.revision,
    phase: "checking",
    currentVersion: "0.1.13",
    lastCheckedAt: available.lastCheckedAt,
    trigger: "manual",
  });
  const downloading = beginAppUpdateDownload(available);
  assert.equal(downloading.phase, "downloading");
  assert.equal(downloading.revision, available.revision);
  assert.equal(downloading.downloadedBytes, 0);
  assert.deepEqual(downloading.update, available.update);
  const installing = beginAppUpdateInstall({ ...available, phase: "ready" });
  assert.equal(installing.phase, "installing");
  assert.equal(installing.revision, available.revision);
  assert.deepEqual(installing.update, available.update);
});

test("a failed download preserves release metadata so retry remains a real action", () => {
  const downloading = {
    revision: 9,
    phase: "downloading",
    currentVersion: "0.1.13",
    update: { version: "0.1.14" },
  };
  assert.deepEqual(failAppUpdateOperation(downloading, "download", "offline"), {
    revision: downloading.revision,
    phase: "error",
    currentVersion: "0.1.13",
    update: downloading.update,
    lastCheckedAt: undefined,
    operation: "download",
    error: "offline",
  });
});

test("automatic checks require native initialization and run once per window", () => {
  assert.equal(shouldRunAutomaticUpdateCheck({ enabled: true, initialized: true, attempted: false, native: true }), true);
  assert.equal(shouldRunAutomaticUpdateCheck({ enabled: false, initialized: true, attempted: false, native: true }), false);
  assert.equal(shouldRunAutomaticUpdateCheck({ enabled: true, initialized: false, attempted: false, native: true }), false);
  assert.equal(shouldRunAutomaticUpdateCheck({ enabled: true, initialized: true, attempted: true, native: true }), false);
  assert.equal(shouldRunAutomaticUpdateCheck({ enabled: true, initialized: true, attempted: false, native: false }), false);
});
