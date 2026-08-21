import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const buildResult = await build({
  entryPoints: ["src/components/ReleaseNotesMarkdown.tsx"],
  bundle: true,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  write: false,
  logLevel: "silent",
  external: ["react", "react-dom"],
});
const compiledModule = { exports: {} };
const require = createRequire(import.meta.url);
new Function("module", "exports", "require", buildResult.outputFiles[0].text)(
  compiledModule,
  compiledModule.exports,
  require,
);

const { ReleaseNotesMarkdown, safeReleaseNotesHref } = compiledModule.exports;

test("allows only explicit safe protocols in release-note links", () => {
  assert.equal(safeReleaseNotesHref("https://github.com/zerr0o/Prime-Orbit/issues/1"), "https://github.com/zerr0o/Prime-Orbit/issues/1");
  assert.equal(safeReleaseNotesHref("mailto:maintainer@example.com"), "mailto:maintainer@example.com");
  assert.equal(safeReleaseNotesHref("javascript:alert(1)"), undefined);
  assert.equal(safeReleaseNotesHref("/relative/path"), undefined);
});

test("renders structured Markdown without executable HTML or remote images", () => {
  const markup = renderToStaticMarkup(createElement(ReleaseNotesMarkdown, {
    content: "# Version 1\n\n- Correction **importante**\n- Voir [le ticket](https://github.com/zerr0o/Prime-Orbit/issues/1)\n\n`npm test`\n\n<script>alert(1)</script>\n\n![pixel](https://example.com/pixel.png)\n\n[mauvais](javascript:alert(1))",
  }));
  assert.match(markup, /<h1>Version 1<\/h1>/);
  assert.match(markup, /<ul>/);
  assert.match(markup, /<strong>importante<\/strong>/);
  assert.match(markup, /href="https:\/\/github\.com\/zerr0o\/Prime-Orbit\/issues\/1"/);
  assert.doesNotMatch(markup, /<script/i);
  assert.doesNotMatch(markup, /<img/i);
  assert.doesNotMatch(markup, /href="javascript:/i);
});
