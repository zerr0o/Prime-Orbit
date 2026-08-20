import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

const buildResult = await build({
  entryPoints: ["src/lib/conversation-links.ts"],
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
const { classifyConversationLink } = compiledModule.exports;

test("allows only explicit web protocols as external links", () => {
  assert.deepEqual(classifyConversationLink("https://example.com/report?q=1"), {
    kind: "external",
    url: "https://example.com/report?q=1",
  });
  assert.equal(classifyConversationLink("javascript:print()").kind, "unsupported");
  assert.equal(classifyConversationLink("data:text/html,print").kind, "unsupported");
  assert.equal(classifyConversationLink("sandbox:/mnt/data/report.pdf").kind, "unsupported");
  assert.equal(classifyConversationLink("\\\\server\\share\\report.pdf").kind, "unsupported");
  assert.equal(classifyConversationLink("file://server/share/report.pdf").kind, "unsupported");
});

test("recognizes project-relative and Windows file links without navigating the WebView", () => {
  assert.deepEqual(classifyConversationLink("dist/report.html#result"), {
    kind: "file",
    path: "dist/report.html",
  });
  assert.deepEqual(classifyConversationLink("C:\\Users\\Example\\report.pdf"), {
    kind: "file",
    path: "C:\\Users\\Example\\report.pdf",
  });
  assert.deepEqual(classifyConversationLink("file:///C:/Users/Example/report.pdf"), {
    kind: "file",
    path: "C:/Users/Example/report.pdf",
  });
});

test("keeps in-document anchors local and rejects empty links", () => {
  assert.deepEqual(classifyConversationLink("#résumé"), { kind: "anchor", id: "résumé" });
  assert.equal(classifyConversationLink("").kind, "unsupported");
  assert.equal(classifyConversationLink(undefined).kind, "unsupported");
});
