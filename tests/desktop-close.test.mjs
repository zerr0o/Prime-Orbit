import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [app, bridge, defaults, settings, nativeDesktop, nativeRoot] = await Promise.all([
  readFile("src/App.tsx", "utf8"),
  readFile("src/lib/bridge.ts", "utf8"),
  readFile("src/lib/demo.ts", "utf8"),
  readFile("src/components/DashboardViews.tsx", "utf8"),
  readFile("src-tauri/src/desktop.rs", "utf8"),
  readFile("src-tauri/src/lib.rs", "utf8"),
]);

test("desktop close is intercepted and defaults to an explicit minimize-or-quit decision", () => {
  assert.match(defaults, /askBeforeClose:\s*true/);
  assert.match(defaults, /closeAction:\s*"minimize"/);
  assert.match(app, /onCloseRequested\(\(event\) => \{\s*event\.preventDefault\(\)/s);
  assert.match(app, /preferences\.askBeforeClose[\s\S]*setClosePromptOpen\(true\)/);
  assert.match(app, /performDesktopCloseAction\(preferences\.closeAction, false\)/);
});

test("remembering a close decision is persisted before the native action", () => {
  assert.match(app, /askBeforeClose:\s*false,[\s\S]*closeAction:\s*action/);
  assert.match(app, /if \(rememberChoice \|\| action === "quit"\) \{\s*const saved = await flushWorkspaceState\(\)/s);
  assert.match(app, /hideCurrentWindowToTray\(\)/);
  assert.match(app, /quitPrimeOrbit\(\)/);
  assert.match(settings, /settings\.askBeforeClose[\s\S]*checked=\{prefs\.askBeforeClose\}/);
});

test("the integrated close modal exposes both actions and the requested checkbox", () => {
  const modalSource = app.slice(app.indexOf("function CloseDecisionModal"), app.indexOf("function RenameProjectModal"));
  assert.match(app, /function CloseDecisionModal/);
  assert.match(modalSource, /type="checkbox"[\s\S]*checked=\{dontAskAgain\}/);
  assert.match(modalSource, /className="close-decision-option is-primary"[\s\S]*onAction\("minimize"\)/);
  assert.match(modalSource, /className="close-decision-option is-quit"[\s\S]*onAction\("quit"\)/);
  assert.match(modalSource, /app\.closeDontAskAgain/);
  assert.doesNotMatch(modalSource, /footer=/);
});

test("the native tray can reopen or quit Prime Orbit and bridge calls remain native-only", () => {
  assert.match(nativeDesktop, /TrayIconBuilder::with_id\(TRAY_ID\)/);
  assert.match(nativeDesktop, /window\.show\(\)/);
  assert.match(nativeDesktop, /TRAY_QUIT_ID => app\.exit\(0\)/);
  assert.match(nativeDesktop, /pub\(crate\) fn hide_window_to_tray/);
  assert.match(nativeRoot, /desktop::setup_tray/);
  assert.match(nativeRoot, /desktop::quit_prime_orbit/);
  assert.match(bridge, /export async function hideCurrentWindowToTray[\s\S]*if \(!isNative\(\)\) return/);
  assert.match(bridge, /export async function quitPrimeOrbit[\s\S]*if \(!isNative\(\)\) return/);
});
