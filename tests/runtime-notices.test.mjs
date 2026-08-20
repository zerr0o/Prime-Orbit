import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

const buildResult = await build({
  entryPoints: ["src/lib/runtime-notices.ts"],
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
const { runtimeNoticeToast } = compiledModule.exports;

test("formats a persistent bilingual HTML export success independently of selection", () => {
  const notice = {
    kind: "html_export",
    status: "success",
    conversationId: "conversation-a",
    conversationTitle: "Audit",
    path: "D:\\Exports\\audit.html",
  };
  assert.deepEqual(runtimeNoticeToast("fr", notice), {
    tone: "success",
    message: "Export HTML de « Audit » enregistré : D:\\Exports\\audit.html",
    persistent: true,
  });
  assert.equal(
    runtimeNoticeToast("en", notice).message,
    "HTML export for “Audit” saved: D:\\Exports\\audit.html",
  );
});

test("formats a persistent HTML export error with its originating conversation", () => {
  assert.deepEqual(runtimeNoticeToast("en", {
    kind: "html_export",
    status: "error",
    conversationId: "conversation-a",
    conversationTitle: "Long task",
    error: "The agent stopped.",
  }), {
    tone: "error",
    message: "HTML export for “Long task” failed: The agent stopped.",
    persistent: true,
  });
});
