import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

const buildResult = await build({
  entryPoints: ["src/hooks/useAgentRuntime.ts"],
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
const { agentExitErrorMessage, startupErrorMessage } = compiledModule.exports;

test("keeps actionable stderr when an agent exits while history is loading", () => {
  const stderr = "Error [ERR_MODULE_NOT_FOUND]: Cannot find package pi-agent-core/dist/index.js";
  const diagnostic = agentExitErrorMessage({ code: 1, success: false, stderr });

  assert.equal(diagnostic, stderr);
  assert.equal(
    startupErrorMessage(
      new Error("Prime Agent s’est arrêté pendant le chargement."),
      diagnostic,
    ),
    stderr,
  );
});

test("keeps bridge context and stderr details when both are available", () => {
  const diagnostic = agentExitErrorMessage({
    code: 1,
    success: false,
    error: "Prime Agent exited before RPC was ready.",
    stderr: "Cannot find module '@earendil-works/pi-agent-core'.",
  });

  assert.match(diagnostic, /exited before RPC was ready/u);
  assert.match(diagnostic, /pi-agent-core/u);
});

test("does not repeat a stderr tail already included in the native diagnostic", () => {
  const stderr = "Cannot find module '@earendil-works/pi-agent-core'.";
  const diagnostic = agentExitErrorMessage({
    code: 1,
    success: false,
    error: `Prime Agent failed during startup.\n${stderr}`,
    stderr,
  });

  assert.equal(diagnostic.match(/Cannot find module/gu)?.length, 1);
});

test("uses the caught startup error when no exit diagnostic exists", () => {
  assert.equal(
    startupErrorMessage(new Error("Prime Agent n’est pas installé.")),
    "Prime Agent n’est pas installé.",
  );
});
