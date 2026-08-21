import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
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

const bridgeBuildResult = await build({
  entryPoints: ["src/lib/bridge.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  logLevel: "silent",
});
const compiledBridge = { exports: {} };
new Function("module", "exports", "require", bridgeBuildResult.outputFiles[0].text)(
  compiledBridge,
  compiledBridge.exports,
  require,
);

const { extractSpellingWord, shouldUseNativeSpellcheckMenu } = compiledModule.exports;
const { getSpellingSuggestions } = compiledBridge.exports;

test("delegates only opted-in spellcheck controls to WebView2's native menu", () => {
  const nativeComposerTarget = { closest: (selector) => selector.includes("data-native-spellcheck-menu") ? {} : null };
  const regularInputTarget = { closest: () => null };
  assert.equal(shouldUseNativeSpellcheckMenu(nativeComposerTarget), true);
  assert.equal(shouldUseNativeSpellcheckMenu(regularInputTarget), false);
});

test("extracts Unicode spelling words with exact UTF-16 ranges", () => {
  const french = "Une fonctoin cassée";
  const frenchStart = french.indexOf("fonctoin");
  assert.deepEqual(extractSpellingWord(french, frenchStart + 3), {
    word: "fonctoin",
    start: frenchStart,
    end: frenchStart + "fonctoin".length,
  });

  const atEnd = "salut fonctionnemet";
  assert.deepEqual(extractSpellingWord(atEnd, atEnd.length), {
    word: "fonctionnemet",
    start: atEnd.indexOf("fonctionnemet"),
    end: atEnd.length,
  });

  const selected = "une écolle ouverte";
  const selectedStart = selected.indexOf("écolle");
  assert.deepEqual(extractSpellingWord(selected, selectedStart, selectedStart + "écolle".length), {
    word: "écolle",
    start: selectedStart,
    end: selectedStart + "écolle".length,
  });

  const apostrophe = "aujourd’hui porte-monaie";
  assert.deepEqual(extractSpellingWord(apostrophe, apostrophe.indexOf("hui")), {
    word: "aujourd’hui",
    start: 0,
    end: "aujourd’hui".length,
  });
  const hyphenStart = apostrophe.indexOf("porte-monaie");
  assert.deepEqual(extractSpellingWord(apostrophe, hyphenStart + 7), {
    word: "porte-monaie",
    start: hyphenStart,
    end: hyphenStart + "porte-monaie".length,
  });
});

test("does not invent spelling suggestions outside the native Tauri app", async () => {
  assert.deepEqual(await getSpellingSuggestions("fonctoin", "fr"), []);
});

test("bridges WebView2 spelling commands into the themed app menu", async () => {
  const [bridgeSource, menuSource, composerSource, nativeSource, libSource] = await Promise.all([
    readFile("src/lib/bridge.ts", "utf8"),
    readFile("src/components/AppContextMenu.tsx", "utf8"),
    readFile("src/components/ConversationView.tsx", "utf8"),
    readFile("src-tauri/src/webview_context_menu.rs", "utf8"),
    readFile("src-tauri/src/lib.rs", "utf8"),
  ]);
  assert.match(bridgeSource, /invoke<void>\("install_webview_context_menu"\)/);
  assert.match(bridgeSource, /prime-orbit:\/\/webview-context-menu/);
  assert.match(bridgeSource, /invoke<void>\("resolve_webview_context_menu"/);
  assert.match(bridgeSource, /invoke<\{ suggestions: string\[\] \}>\("get_spelling_suggestions"/);
  assert.match(bridgeSource, /input: \{ word, language \}/);
  assert.match(menuSource, /listenToWebviewContextMenus/);
  assert.match(menuSource, /resolveWebviewContextMenu\(native\.requestId, item\.commandId\)\.catch/);
  assert.match(menuSource, /NATIVE_CONTEXT_MENU_UI_TIMEOUT_MS/);
  assert.match(menuSource, /insertReplacementText/);
  assert.match(menuSource, /return \[\.\.\.spellingActions, \.\.\.nativeActions\]/);
  assert.match(menuSource, /const spellingLanguage = control\.lang \|\| navigator\.language \|\| language/);
  assert.match(menuSource, /getSpellingSuggestions\(range\.word, spellingLanguage\)/);
  assert.match(composerSource, /lang=\{typeof navigator === "undefined" \? language : navigator\.language\} spellCheck/);
  assert.match(nativeSource, /name\.eq_ignore_ascii_case\("spellcheck"\)/);
  assert.match(nativeSource, /if label\.trim\(\)\.is_empty\(\)/);
  assert.match(nativeSource, /EventTarget::webview_window\(label\.clone\(\)\)/);
  assert.match(nativeSource, /args\.SetHandled\(true\)/);
  assert.match(nativeSource, /self\.args\.SetSelectedCommandId\(command_id\)/);
  assert.match(nativeSource, /self\.deferral\.Complete\(\)/);
  assert.match(nativeSource, /tokio::time::sleep\(CONTEXT_MENU_WATCHDOG\)/);
  assert.match(nativeSource, /registry\.release\(&label\)/);
  assert.match(libSource, /discard_window\(&label, context_menus\.inner\(\)\)/);
});
