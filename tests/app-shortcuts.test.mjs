import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

const buildResult = await build({
  entryPoints: ["src/lib/app-shortcuts.ts"],
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
const { printShortcutDisposition } = compiledModule.exports;

test("blocks Ctrl/Cmd+P even while the key is repeating", () => {
  assert.deepEqual(printShortcutDisposition({ key: "p", ctrlKey: true, metaKey: false, repeat: false }), { block: true, notify: true });
  assert.deepEqual(printShortcutDisposition({ key: "P", ctrlKey: true, metaKey: false, repeat: true }), { block: true, notify: false });
  assert.deepEqual(printShortcutDisposition({ key: "p", ctrlKey: false, metaKey: true, repeat: true }), { block: true, notify: false });
});

test("does not consume plain P or unrelated shortcuts", () => {
  assert.deepEqual(printShortcutDisposition({ key: "p", ctrlKey: false, metaKey: false, repeat: false }), { block: false, notify: false });
  assert.deepEqual(printShortcutDisposition({ key: "k", ctrlKey: true, metaKey: false, repeat: false }), { block: false, notify: false });
});
