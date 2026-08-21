import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

const buildResult = await build({
  entryPoints: ["src/components/AppContextMenu.tsx"],
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

const { shouldUseNativeSpellcheckMenu } = compiledModule.exports;

test("delegates only opted-in spellcheck controls to WebView2's native menu", () => {
  const nativeComposerTarget = { closest: (selector) => selector.includes("data-native-spellcheck-menu") ? {} : null };
  const regularInputTarget = { closest: () => null };
  assert.equal(shouldUseNativeSpellcheckMenu(nativeComposerTarget), true);
  assert.equal(shouldUseNativeSpellcheckMenu(regularInputTarget), false);
});
