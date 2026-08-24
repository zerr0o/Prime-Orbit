import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

const buildResult = await build({
  entryPoints: ["src/components/ConversationView.tsx"],
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
  attachmentSubmitError,
  attachmentDropError,
  buildComposerSlashCommands,
  buildQueuedRows,
  filterComposerSlashCommands,
  getConversationAttachmentDraft,
  isSupportedDroppedImage,
  mergeAttachmentSelection,
  moveSlashCommandSelection,
  parseActiveComposerSlashCommand,
  releaseConversationAttachmentDrafts,
  resolveComposerActionSubmission,
  rememberConversationAttachmentDraft,
  resolveComposerDraftAfterSelection,
  scheduleComposerDraftReport,
  shouldRestoreAttachmentSubmission,
} = compiledModule.exports;

const image = (id, size) => ({ id, name: `${id}.png`, mimeType: "image/png", size, attachmentHandle: crypto.randomUUID(), isImage: true });
const document = (id, size) => ({ id, name: `${id}.txt`, mimeType: "text/plain", size, attachmentHandle: crypto.randomUUID(), isImage: false });

test("requires opaque native handles for picker and dropped documents without exposing paths", () => {
  const admitted = document("notes", 20);
  const missingHandle = { id: "doc-2", name: "drop.txt", mimeType: "text/plain", size: 20, isImage: false };
  const result = mergeAttachmentSelection([], [admitted, missingHandle]);

  assert.deepEqual(result.attachments, [admitted]);
  assert.equal(result.issue, "missing-handle");
  assert.equal("path" in result.attachments[0], false);
});

test("enforces individual and aggregate byte limits across images and documents", () => {
  const mib = 1024 * 1024;
  const oversizedDocument = mergeAttachmentSelection([], [document("large", 20 * mib + 1)]);
  assert.equal(oversizedDocument.attachments.length, 0);
  assert.equal(oversizedDocument.issue, "document-size");

  const oversizedImage = mergeAttachmentSelection([], [image("large-image", 8 * mib + 1)]);
  assert.equal(oversizedImage.attachments.length, 0);
  assert.equal(oversizedImage.issue, "image-size");

  const imageAggregate = mergeAttachmentSelection([image("existing", 7 * mib)], [image("next", 4 * mib)]);
  assert.equal(imageAggregate.attachments.length, 1);
  assert.equal(imageAggregate.issue, "image-total");

  const totalAggregate = mergeAttachmentSelection(
    [document("first", 20 * mib)],
    [document("second", 20 * mib), document("extra", 1)],
  );
  assert.equal(totalAggregate.attachments.length, 2);
  assert.equal(totalAggregate.issue, "attachment-total");
});

test("requires opaque native handles for every file and localizes expired-handle failures", () => {
  const missingHandle = mergeAttachmentSelection([], [{
    id: "image-1",
    name: "image.png",
    mimeType: "image/png",
    size: 10,
    isImage: true,
  }]);
  assert.equal(missingHandle.attachments.length, 0);
  assert.equal(missingHandle.issue, "missing-handle");
  assert.match(attachmentSubmitError(new Error("attachment handle expired"), "en"), /no longer available/i);
  assert.match(attachmentSubmitError(new Error("handle expiré"), "fr"), /plus disponible/i);
});

test("localizes conversation activation failures without mixing languages", () => {
  assert.equal(
    attachmentSubmitError(new DOMException("La conversation n’est plus active.", "AbortError"), "en"),
    "Could not send: the conversation is no longer active.",
  );
  assert.equal(
    attachmentSubmitError(new DOMException("The conversation is no longer active.", "AbortError"), "fr"),
    "Envoi impossible : la conversation n’est plus active.",
  );
  assert.equal(
    attachmentSubmitError(new DOMException("Le chargement a été remplacé par une autre conversation.", "AbortError"), "en"),
    "Send cancelled: another conversation was opened.",
  );
});

test("accepts supported dropped images without requiring an exposed path", () => {
  assert.equal(isSupportedDroppedImage({ name: "capture.png", type: "image/png" }), true);
  assert.equal(isSupportedDroppedImage({ name: "capture.webp", type: "" }), true);
  assert.equal(isSupportedDroppedImage({ name: "notes.txt", type: "text/plain" }), false);
  assert.equal(isSupportedDroppedImage({ name: "fake.png", type: "text/plain" }), false);
});

test("localizes raw dropped-file and limit failures", () => {
  assert.match(attachmentDropError("Ce dépôt a expiré", "en"), /drop expired/i);
  assert.match(attachmentDropError("Vous pouvez encore joindre 2 fichier(s)", "fr"), /20 fichiers/i);
  assert.match(attachmentDropError("Le fichier dépasse le budget restant", "en"), /8 MiB.*10 MiB/i);
});

test("never restores a failed attachment submission into another conversation", () => {
  assert.equal(shouldRestoreAttachmentSubmission("a", 4, "a", 4), true);
  assert.equal(shouldRestoreAttachmentSubmission("a", 4, "b", 4), false);
  assert.equal(shouldRestoreAttachmentSubmission("a", 4, "a", 5), false);
});

test("keeps unsent handle-backed attachments scoped to their conversation and renderer window", async () => {
  const first = document("draft-a", 120);
  const second = image("draft-b", 240);
  rememberConversationAttachmentDraft("conversation-a", [first]);
  rememberConversationAttachmentDraft("conversation-b", [second]);

  assert.deepEqual(getConversationAttachmentDraft("conversation-a"), [first]);
  assert.deepEqual(getConversationAttachmentDraft("conversation-b"), [second]);
  assert.equal("path" in getConversationAttachmentDraft("conversation-a")[0], false);

  await releaseConversationAttachmentDrafts("conversation-a");
  assert.deepEqual(getConversationAttachmentDraft("conversation-a"), []);
  rememberConversationAttachmentDraft("conversation-a", [first]);
  assert.deepEqual(
    getConversationAttachmentDraft("conversation-a"),
    [],
    "a late Composer cleanup cannot resurrect handles after archive/delete",
  );
  assert.deepEqual(getConversationAttachmentDraft("conversation-b"), [second]);
  await releaseConversationAttachmentDrafts("conversation-b");
});

test("renders queued rows in Prime Agent order with exact mutable indexes", () => {
  const queuedDocument = { id: "queued-doc", name: "queued.pdf", mimeType: "application/pdf", size: 2048, isImage: false };
  const rows = buildQueuedRows({
    messages: [
      { id: "local-first", content: "First", queueDelivery: "follow_up", queueText: "First" },
      { id: "local-second", content: "Second", queueDelivery: "follow_up", queueText: "Second" },
    ],
  }, {
    sessionActions: {
      queuedCount: 3,
      steering: ["External steer"],
      followUps: ["Second", "First"],
      queueAttachments: {
        steering: [[queuedDocument]],
        followUps: [[], []],
      },
    },
  });

  assert.deepEqual(rows.map((row) => [row.id, row.lane, row.index, row.expectedText]), [
    ["remote-queue:steer:0:External steer", "steering", 0, "External steer"],
    ["local-second", "followUp", 0, "Second"],
    ["local-first", "followUp", 1, "First"],
  ]);
  assert.deepEqual(rows[0].attachments, [queuedDocument]);
});

test("slash palette combines wired Orbit commands with authoritative Prime Agent commands", () => {
  const commands = buildComposerSlashCommands([
    { name: "review", description: "Review the current changes", source: "skill" },
    { name: "/custom-prompt", description: "Run a project prompt", source: "prompt" },
    { name: "goal", description: "duplicate upstream entry", source: "extension" },
    { name: "not a command", source: "prompt" },
  ], "en");

  assert.deepEqual(commands.slice(0, 6).map((command) => command.name), [
    "plan",
    "goal",
    "compact",
    "refine",
    "autonomous",
    "reload",
  ]);
  assert.equal(commands.find((command) => command.name === "plan")?.source, "orbit");
  assert.equal(commands.filter((command) => command.name === "goal").length, 1);
  assert.equal(commands.find((command) => command.name === "goal")?.source, "session");
  assert.equal(commands.find((command) => command.name === "review")?.source, "prime");
  assert.equal(commands.find((command) => command.name === "custom-prompt")?.source, "prime");
  assert.equal(commands.some((command) => command.name === "not a command"), false);
  assert.match(commands.find((command) => command.name === "autonomous")?.description ?? "", /separate from Orbit permissions/i);
  assert.deepEqual(
    commands.find((command) => command.name === "reload"),
    {
      name: "reload",
      label: "Reload resources",
      description: "Reload settings, skills, extensions, prompts, and MCP integrations",
      source: "session",
      behavior: "action",
      action: "reload_resources",
    },
  );
});

test("slash palette filters commands and turns an applied command into a prompt token", () => {
  const commands = buildComposerSlashCommands([
    { name: "review", description: "Review the current changes", source: "skill" },
  ], "fr");

  assert.deepEqual(filterComposerSlashCommands(commands, "obj").map((command) => command.name), ["goal"]);
  assert.deepEqual(filterComposerSlashCommands(commands, "changes").map((command) => command.name), ["review"]);
  const active = parseActiveComposerSlashCommand("/goal livrer une interface complète", commands);
  assert.equal(active?.command.name, "goal");
  assert.equal(active?.argument, "livrer une interface complète");
  assert.equal(parseActiveComposerSlashCommand("/go", commands), undefined, "a partial query remains in palette mode");
  assert.equal(moveSlashCommandSelection(0, commands.length, -1), commands.length - 1);
  assert.equal(moveSlashCommandSelection(commands.length - 1, commands.length, 1), 0);
});

test("manual /reload dispatches the native action and rejects arguments instead of becoming a prompt", () => {
  const commands = buildComposerSlashCommands([], "fr");
  assert.equal(resolveComposerActionSubmission("/reload", commands)?.command.action, "reload_resources");
  assert.equal(resolveComposerActionSubmission(" /reload   ", commands)?.command.action, "reload_resources");
  assert.match(resolveComposerActionSubmission("/reload now", commands)?.error ?? "", /aucun argument/i);
  assert.equal(resolveComposerActionSubmission("/goal livrer", commands), undefined);
  assert.equal(resolveComposerActionSubmission("message normal", commands), undefined);
});

test("/reload stays intercepted but reports the capability boundary for system installs", () => {
  const commands = buildComposerSlashCommands([], "en", false);
  const reload = commands.find((command) => command.name === "reload");

  assert.match(reload?.disabledReason ?? "", /source or managed installation/i);
  assert.match(resolveComposerActionSubmission("/reload", commands)?.error ?? "", /source or managed installation/i);
  assert.match(resolveComposerActionSubmission("/reload now", commands)?.error ?? "", /aucun argument/i);
});

test("deferred draft reports remain bound to the conversation that scheduled them", () => {
  let pending;
  const writes = [];
  const reportConversationA = (draft) => writes.push(["conversation-a", draft]);
  const reportConversationB = (draft) => writes.push(["conversation-b", draft]);
  let currentReport = reportConversationA;

  scheduleComposerDraftReport(currentReport, "draft A", (callback) => {
    pending = callback;
    return 1;
  });
  // Simulate selecting B before A's 180 ms timer fires. Replacing an outer
  // callback reference cannot retarget the callback captured by the helper.
  currentReport = reportConversationB;
  pending();

  assert.deepEqual(writes, [["conversation-a", "draft A"]]);
  assert.equal(
    resolveComposerDraftAfterSelection("conversation-a", "conversation-b", "draft A", "", ""),
    "",
    "selecting B resets the local A draft even when both persisted draft props are the same",
  );
});
