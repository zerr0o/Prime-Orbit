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
const {
  isInternalCustomMessage,
  mapAgentMessages,
  normalizePrimeOrbitSessionActions,
  parsePrimeOrbitAttachmentContext,
  stripPrimeOrbitAttachmentWrapper,
} = compiledModule.exports;

const contextId = "9b8ad0e7-8796-4a7b-9d47-82fd342d9ae8";

function escapeFileName(name) {
  return name
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function attachmentFragment(document) {
  return `<file name="${escapeFileName(document.name)}" content_utf16="${document.inline.length}">\n${document.inline}\n</file>`;
}

function hydratedPrompt(visibleText, documents, overrides = {}) {
  const id = overrides.id ?? contextId;
  const boundaryId = overrides.boundaryId ?? id;
  const manifest = overrides.manifest ?? documents.map(({ name, mimeType, size }) => ({
    name,
    mimeType,
    size,
    isImage: false,
  }));
  const encoded = overrides.encoded
    ?? Buffer.from(JSON.stringify(manifest), "utf8").toString("base64url");
  const fragments = overrides.fragments ?? documents.map(attachmentFragment).join("\n");
  const visibleUtf16 = overrides.visibleUtf16 ?? visibleText.length;
  const suffix = `<prime_orbit_attachment_context v="1" id="${id}">\n<prime_orbit_manifest encoding="base64url">${encoded}</prime_orbit_manifest>\n${fragments}\n</prime_orbit_attachment_context>\n<prime_orbit_ui_boundary v="1" id="${boundaryId}" visible_utf16="${visibleUtf16}"/>`;
  return `${visibleText ? `${visibleText}\n\n` : ""}${suffix}${overrides.trailing ?? ""}`;
}

test("restores exact UTF-16 prompt text and document cards from Orbit's strict trailing manifest", () => {
  const typed = `Inspect these literal tags:
<file name="example.txt">keep me</file>
<prime_orbit_attachment_context v="1" id="not-native">keep this</prime_orbit_attachment_context>
Do not normalize  spaces. Emoji: 🪐`;
  const documents = [{
    name: "notes.txt",
    mimeType: "text/plain",
    size: 42,
    inline: "private inline content from C:\\Users\\person\\notes.txt with <xml>tags</xml>",
  }];
  const hydrated = hydratedPrompt(typed, documents);

  assert.equal(stripPrimeOrbitAttachmentWrapper(hydrated), typed);
  assert.equal(stripPrimeOrbitAttachmentWrapper(typed), typed);
  const parsed = parsePrimeOrbitAttachmentContext(hydrated);
  assert.equal(parsed.visibleText, typed);
  assert.deepEqual(parsed.attachments, [{
    id: `orbit-attachment:${contextId}:0`,
    name: "notes.txt",
    mimeType: "text/plain",
    size: 42,
    isImage: false,
  }]);
  assert.equal("path" in parsed.attachments[0], false);
  assert.equal("attachmentHandle" in parsed.attachments[0], false);
  const mapped = mapAgentMessages([{ role: "user", content: hydrated, timestamp: "2026-08-20T12:00:00.000Z" }]);
  assert.equal(mapped[0]?.content, typed);
  assert.deepEqual(mapped[0]?.attachments, parsed.attachments);
  assert.doesNotMatch(JSON.stringify(mapped), /private inline|C:\\\\Users/u);
});

test("accepts exact XML-escaped names and UTF-16-sized fragment bodies", () => {
  const documents = [{
    name: 'notes & "plan" <final>.txt',
    mimeType: "text/plain",
    size: 18,
    inline: "Emoji 🪐 and a literal </file> tag",
  }];
  const hydrated = hydratedPrompt("Review", documents);
  const parsed = parsePrimeOrbitAttachmentContext(hydrated);

  assert.equal(parsed.visibleText, "Review");
  assert.equal(parsed.attachments[0]?.name, documents[0].name);
  assert.doesNotMatch(parsed.visibleText, /prime_orbit_attachment_context/u);
});

test("leaves spoofed or malformed attachment envelopes completely visible", () => {
  const typed = "Keep this prompt";
  const documents = [{ name: "notes.txt", mimeType: "text/plain", size: 12, inline: "secret" }];
  const malformed = [
    hydratedPrompt(typed, documents, { visibleUtf16: typed.length - 1 }),
    hydratedPrompt(typed, documents, { boundaryId: "3ef76a94-67ca-4d40-852e-c8cba54cbb5c" }),
    hydratedPrompt(typed, documents, { encoded: "not+base64url" }),
    hydratedPrompt(typed, documents, {
      manifest: [{ name: "notes.txt", mimeType: "text/plain", size: 12, isImage: false, path: "C:\\secret" }],
    }),
    hydratedPrompt(typed, documents, {
      id: contextId.toUpperCase(),
      boundaryId: contextId.toUpperCase(),
    }),
    hydratedPrompt(typed, documents, {
      fragments: '<file name="other.txt" content_utf16="6">\nsecret\n</file>',
    }),
    hydratedPrompt(typed, documents, {
      fragments: '<file name="notes.txt" content_utf16="5">\nsecret\n</file>',
    }),
    hydratedPrompt(typed, documents, {
      fragments: `${attachmentFragment(documents[0])}\n${attachmentFragment(documents[0])}`,
    }),
    hydratedPrompt(typed, documents, { trailing: " trailing" }),
  ];
  malformed.forEach((value) => {
    assert.deepEqual(parsePrimeOrbitAttachmentContext(value), { visibleText: value, attachments: [] });
  });
});

test("uses native structured document metadata for sanitized history and queue snapshots", () => {
  const document = {
    id: `orbit-attachment:${contextId}:0`,
    name: "audit.pdf",
    mimeType: "application/pdf",
    size: 2048,
    isImage: false,
  };
  const mapped = mapAgentMessages([{
    role: "user",
    content: "Review it",
    primeOrbitAttachments: [document],
    timestamp: "2026-08-20T12:00:00.000Z",
  }]);
  assert.deepEqual(mapped[0]?.attachments, [document]);

  const actions = normalizePrimeOrbitSessionActions({
    queuedCount: 2,
    steering: ["Review it"],
    followUps: [""],
    queueAttachments: {
      steering: [[document]],
      followUps: [[{ ...document, id: `orbit-attachment:${contextId}:1`, name: "later.pdf" }]],
    },
  });
  assert.deepEqual(actions.steering, ["Review it"]);
  assert.deepEqual(actions.followUps, [""]);
  assert.equal(actions.queueAttachments.steering[0][0].name, "audit.pdf");
  assert.equal(actions.queueAttachments.followUps[0][0].name, "later.pdf");
  assert.equal(JSON.stringify(actions).includes("path"), false);
});

test("strips hydrated queue and active payloads before renderer state or matching", () => {
  const rawQueue = hydratedPrompt("Queue visible 🪐", [{
    name: "queue.txt",
    mimeType: "text/plain",
    size: 120,
    inline: "secret queue content from C:\\Users\\person\\queue.txt",
  }]);
  const actions = normalizePrimeOrbitSessionActions({
    queuedCount: 2,
    steering: [rawQueue],
    followUps: [rawQueue],
    active: { kind: "turn", phase: "running", label: rawQueue },
  });

  assert.deepEqual(actions.steering, ["Queue visible 🪐"]);
  assert.deepEqual(actions.followUps, ["Queue visible 🪐"]);
  assert.equal(actions.active.label, "Queue visible 🪐");
  assert.equal(actions.queueAttachments.steering[0][0].name, "queue.txt");
  assert.equal(actions.queueAttachments.followUps[0][0].name, "queue.txt");
  assert.equal(actions.queueAttachments.active[0].name, "queue.txt");
  assert.doesNotMatch(JSON.stringify(actions), /secret queue|C:\\\\Users/u);
});

test("rehydrates historical tool calls by id with terminal or unresolved states and bounded payloads", () => {
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
  assert.equal(unmatched.status, "unresolved");
  assert.equal(unmatched.endedAt, undefined);
});

test("hides Prime Agent's internal IPython restore envelope without hiding real conversation text", () => {
  const restored = `<ipython_state_restored>
Your IPython kernel state was revived from your previous session. These names are available again: Image, Path, goal.
</ipython_state_restored>`;
  const mapped = mapAgentMessages([
    {
      role: "custom",
      customType: "ipython_state_restored",
      display: true,
      content: restored,
      timestamp: "2026-08-20T08:47:57.713Z",
    },
    // Read-only history sanitizers used to omit customType. The strict,
    // full-envelope fallback still recognizes that internal record.
    {
      role: "custom",
      display: true,
      content: restored,
      timestamp: "2026-08-20T08:48:00.000Z",
    },
    {
      role: "user",
      content: restored,
      timestamp: "2026-08-20T08:48:01.000Z",
    },
    {
      role: "assistant",
      content: restored,
      timestamp: "2026-08-20T08:48:02.000Z",
    },
    {
      role: "custom",
      customType: "extension_notice",
      display: true,
      content: `Extension output before ${restored} and after`,
      timestamp: "2026-08-20T08:48:03.000Z",
    },
  ]);

  assert.deepEqual(mapped.map((message) => message.role), ["user", "assistant", "system"]);
  assert.equal(mapped[0].content, restored);
  assert.equal(mapped[1].content, restored);
  assert.match(mapped[2].content, /^Extension output before/u);
});

test("recognizes internal restore records only in the custom-message channel", () => {
  const content = "<ipython_state_restored>restored</ipython_state_restored>";
  assert.equal(isInternalCustomMessage({ role: "custom", customType: "ipython_state_restored", content }), true);
  assert.equal(isInternalCustomMessage({ role: "custom", content }), true);
  assert.equal(isInternalCustomMessage({ role: "user", customType: "ipython_state_restored", content }), false);
  assert.equal(isInternalCustomMessage({ role: "assistant", content }), false);
  assert.equal(isInternalCustomMessage({ role: "custom", content: `prefix ${content}` }), false);
});
