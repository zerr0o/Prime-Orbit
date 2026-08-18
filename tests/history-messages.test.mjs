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
const { mapAgentMessages } = compiledModule.exports;

test("rehydrates historical tool calls by id with terminal states and bounded payloads", () => {
  const oversized = "x".repeat(20_000);
  const assistantTimestamp = 1_720_000_000_000;
  const successTimestamp = assistantTimestamp + 2_000;
  const failureTimestamp = assistantTimestamp + 1_000;
  const orphanTimestamp = assistantTimestamp + 3_000;

  const mapped = mapAgentMessages([
    {
      role: "user",
      content: [{ type: "text", text: "Synthetic request" }],
      timestamp: assistantTimestamp - 1_000,
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "not displayable" },
        { type: "toolCall", id: "call-success", name: "python", arguments: { script: oversized } },
        { type: "toolCall", id: "call-failure", name: "read", arguments: { path: "fixture.txt" } },
      ],
      timestamp: assistantTimestamp,
      usage: { input: 10, output: 20, cacheRead: 5, totalTokens: 35 },
    },
    // Results intentionally arrive in the opposite call order: association
    // must use toolCallId, never array position.
    {
      role: "toolResult",
      toolCallId: "call-failure",
      toolName: "read",
      isError: true,
      content: [{ type: "text", text: "" }],
      details: { stderr: oversized },
      timestamp: failureTimestamp,
    },
    {
      role: "toolResult",
      toolCallId: "call-success",
      toolName: "python",
      isError: false,
      content: [{ type: "text", text: oversized }],
      details: { ignoredBecauseTextExists: oversized },
      timestamp: successTimestamp,
    },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-without-result", name: "bash", arguments: { command: "noop" } }],
      timestamp: orphanTimestamp,
    },
  ]);

  assert.equal(mapped.length, 3);
  const tools = mapped[1].tools;
  assert.equal(tools.length, 2);

  const success = tools.find((tool) => tool.id === "call-success");
  const failure = tools.find((tool) => tool.id === "call-failure");
  assert.equal(success.status, "completed");
  assert.equal(failure.status, "failed");
  assert.equal(success.endedAt, new Date(successTimestamp).toISOString());
  assert.equal(failure.endedAt, new Date(failureTimestamp).toISOString());

  assert.equal(typeof success.input, "string");
  assert.equal(typeof success.output, "string");
  assert.equal(typeof failure.output, "string");
  assert.ok(success.input.length < oversized.length);
  assert.ok(success.output.length < oversized.length);
  assert.ok(failure.output.length < oversized.length);
  assert.match(success.input, /historique tronqué/u);
  assert.match(success.output, /historique tronqué/u);
  assert.match(failure.output, /historique tronqué/u);

  const unmatched = mapped[2].tools[0];
  assert.equal(unmatched.id, "call-without-result");
  assert.equal(unmatched.status, "cancelled");
  assert.equal(unmatched.endedAt, new Date(orphanTimestamp).toISOString());
});
