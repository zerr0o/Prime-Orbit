import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

const buildResult = await build({
  entryPoints: ["src/lib/redaction.ts"],
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
const { redactText, redactValue } = compiledModule.exports;

test("redacts bearer, API-key, JWT and query-string credentials from diagnostic text", () => {
  const source = [
    "Authorization: Bearer very-secret-token",
    "OPENAI_API_KEY=sk-proj-abcdefghijklmnop",
    'client_secret: "a secret containing spaces"',
    "https://example.test/run?access_token=abc123&mode=debug",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123",
  ].join("\n");
  const redacted = redactText(source);

  assert.doesNotMatch(redacted, /very-secret-token|abcdefghijklmnop|secret containing spaces|abc123|signature123/u);
  assert.match(redacted, /\[REDACTED\]/u);
  assert.match(redacted, /mode=debug/u);
  assert.match(redacted, /^Authorization: \[REDACTED\]$/mu);
  assert.equal(redactText(redacted), redacted, "redaction should be idempotent");
});

test("redacts recursively by sensitive field name while preserving useful token metrics", () => {
  const input = {
    provider: "openai",
    apiKey: "top-secret",
    nested: {
      refresh_token: "refresh-secret",
      authorization: "Bearer nested-secret",
      tokensUsed: 420,
      tokenBudget: 1_000,
    },
  };
  const output = redactValue(input);

  assert.equal(output.apiKey, "[REDACTED]");
  assert.equal(output.nested.refresh_token, "[REDACTED]");
  assert.equal(output.nested.authorization, "[REDACTED]");
  assert.equal(output.nested.tokensUsed, 420);
  assert.equal(output.nested.tokenBudget, 1_000);
  assert.equal(input.apiKey, "top-secret", "redaction must not mutate the source event");
});
