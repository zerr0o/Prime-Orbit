import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

const buildResult = await build({
  entryPoints: ["src/lib/refinement-outcome-notices.ts"],
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
const { appendUniqueRefinementOutcome, parseRefinementOutcomeNotice } = compiledModule.exports;

function outcome(overrides = {}) {
  return {
    role: "custom",
    customType: "refinement_outcome",
    display: true,
    content: "transport content must not win",
    details: {
      refinementId: "refine_20260822",
      summary: "Persist the verified runtime migration.",
      scope: "local",
      edits: [{
        action: "update",
        kind: "memory",
        id: "prime-agent-runtime",
        title: "Prime Agent runtime",
        applied: true,
        before: { content: "private old harness content" },
        after: { content: "private new harness content" },
      }],
    },
    ...overrides,
  };
}

test("parses only the safe durable refinement projection", () => {
  const parsed = parseRefinementOutcomeNotice(outcome());
  assert.equal(parsed.content, "Persist the verified runtime migration.");
  assert.deepEqual(parsed.notice, {
    kind: "refinement_outcome",
    refinementId: "refine_20260822",
    summary: "Persist the verified runtime migration.",
    scope: "local",
    edits: [{
      action: "update",
      kind: "memory",
      id: "prime-agent-runtime",
      title: "Prime Agent runtime",
      applied: true,
    }],
  });
  assert.doesNotMatch(JSON.stringify(parsed), /private old|private new/u);
});

test("rejects forged and incomplete outcome envelopes", () => {
  assert.equal(parseRefinementOutcomeNotice({ ...outcome(), role: "system" }), undefined);
  assert.equal(parseRefinementOutcomeNotice({ ...outcome(), display: false }), undefined);
  assert.equal(parseRefinementOutcomeNotice(outcome({ details: { refinementId: "x", summary: "ok", scope: "project", edits: [] } })), undefined);
  assert.equal(parseRefinementOutcomeNotice(outcome({ details: { refinementId: "x", summary: "ok", scope: "local", edits: [{ action: "read", kind: "memory", id: "x", applied: true }] } })), undefined);
});

test("deduplicates start and end delivery by refinement id", () => {
  const parsed = parseRefinementOutcomeNotice(outcome());
  const message = { id: parsed.notice.refinementId, role: "system", content: parsed.content, createdAt: new Date().toISOString(), notice: parsed.notice };
  const once = appendUniqueRefinementOutcome([], message);
  const twice = appendUniqueRefinementOutcome(once, { ...message, id: "second-envelope" });
  assert.equal(once.length, 1);
  assert.equal(twice.length, 1);
});
