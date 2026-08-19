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
const { attachmentSubmitError, buildQueuedRows, mergeAttachmentSelection } = compiledModule.exports;

const image = (id, size) => ({ id, name: `${id}.png`, mimeType: "image/png", size, attachmentHandle: crypto.randomUUID(), isImage: true });

test("keeps an explicitly selected external document path but rejects a pathless dropped document", () => {
  const external = { id: "doc-1", name: "notes.txt", path: "D:\\Shared\\notes.txt", mimeType: "text/plain", size: 20, isImage: false };
  const pathless = { id: "doc-2", name: "drop.txt", mimeType: "text/plain", size: 20, isImage: false };
  const result = mergeAttachmentSelection([], [external, pathless]);

  assert.deepEqual(result.attachments, [external]);
  assert.equal(result.issue, "pathless-file");
});

test("enforces individual and aggregate image limits across repeated selections", () => {
  const mib = 1024 * 1024;
  const oversized = mergeAttachmentSelection([], [image("large", 8 * mib + 1)]);
  assert.equal(oversized.attachments.length, 0);
  assert.equal(oversized.issue, "image-size");

  const aggregate = mergeAttachmentSelection([image("existing", 7 * mib)], [image("next", 4 * mib)]);
  assert.equal(aggregate.attachments.length, 1);
  assert.equal(aggregate.issue, "image-total");
});

test("requires opaque native handles and localizes expired-handle submit failures", () => {
  const missingHandle = mergeAttachmentSelection([], [{
    id: "image-1",
    name: "image.png",
    mimeType: "image/png",
    size: 10,
    isImage: true,
  }]);
  assert.equal(missingHandle.attachments.length, 0);
  assert.equal(missingHandle.issue, "missing-image-handle");
  assert.match(attachmentSubmitError(new Error("attachment handle expired"), "en"), /no longer available/i);
  assert.match(attachmentSubmitError(new Error("handle expiré"), "fr"), /plus disponible/i);
});

test("renders queued rows in Prime Agent order with exact mutable indexes", () => {
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
    },
  });

  assert.deepEqual(rows.map((row) => [row.id, row.lane, row.index, row.expectedText]), [
    ["remote-queue:steer:0:External steer", "steering", 0, "External steer"],
    ["local-second", "followUp", 0, "Second"],
    ["local-first", "followUp", 1, "First"],
  ]);
});
