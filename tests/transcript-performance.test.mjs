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
  buildTranscriptEntries,
  hasSameTranscriptPresentation,
  haveSameMessageReferences,
  resetTranscriptScrollForConversation,
} = compiledModule.exports;

function message(index) {
  const lane = index % 3;
  return {
    id: `message-${index}`,
    role: lane === 0 ? "user" : "assistant",
    content: lane === 2 ? "" : `Message ${index}\n\n- transcript performance fixture`,
    createdAt: new Date(1_800_000_000_000 + index).toISOString(),
    status: "complete",
    ...(lane === 2 ? {
      tools: [{
        id: `tool-${index}`,
        name: "python",
        title: "Python",
        status: "completed",
        startedAt: new Date(1_800_000_000_000 + index).toISOString(),
        output: { index },
      }],
    } : {}),
  };
}

function transcriptProps(messages, overrides = {}) {
  return {
    conversation: {
      id: "long-conversation",
      projectId: "project-1",
      title: "Long conversation",
      messages,
      draft: "",
      status: "idle",
      hasContent: true,
      sessionId: "session-1",
      sessionPath: "C:/sessions/session-1.jsonl",
      ...overrides,
    },
    project: {
      id: "project-1",
      name: "Large project",
      path: "C:/workspace",
      accent: "violet",
    },
  };
}

test("draft persistence skips transcript work for a 3,300-entry history", () => {
  const messages = Array.from({ length: 3_300 }, (_, index) => message(index));
  const previous = transcriptProps(messages);
  const next = transcriptProps(messages, { draft: "a persisted keystroke" });

  assert.equal(hasSameTranscriptPresentation(previous, next), true);
  assert.equal(previous.conversation.messages, next.conversation.messages);

  // The comparison must remain independent of transcript length. Accessing an
  // element would throw, while an identity-only comparison remains valid.
  const opaqueMessages = new Proxy(messages, {
    get(target, property, receiver) {
      if (property !== Symbol.toStringTag) throw new Error(`unexpected transcript access: ${String(property)}`);
      return Reflect.get(target, property, receiver);
    },
  });
  const opaquePrevious = transcriptProps(opaqueMessages);
  const opaqueNext = transcriptProps(opaqueMessages, { draft: "another keystroke" });
  assert.equal(hasSameTranscriptPresentation(opaquePrevious, opaqueNext), true);
});

test("all transcript-visible changes invalidate the draft memo boundary", () => {
  const messages = [message(0), message(1), message(2)];
  const previous = transcriptProps(messages);

  assert.equal(hasSameTranscriptPresentation(previous, transcriptProps([...messages])), false);
  assert.equal(hasSameTranscriptPresentation(previous, transcriptProps(messages, { status: "streaming" })), false);
  assert.equal(hasSameTranscriptPresentation(previous, transcriptProps(messages, { lastError: "restore failed" })), false);
  assert.equal(hasSameTranscriptPresentation(previous, transcriptProps(messages, { hasContent: false })), false);
  assert.equal(hasSameTranscriptPresentation(previous, transcriptProps(messages, { sessionId: "session-2" })), false);
  assert.equal(hasSameTranscriptPresentation(previous, transcriptProps(messages, { sessionPath: "C:/sessions/session-2.jsonl" })), false);
  assert.equal(hasSameTranscriptPresentation(previous, {
    ...previous,
    project: { ...previous.project, path: "C:/other-workspace" },
  }), false);
});

test("changing conversations resets the shared transcript viewport to the latest turn", () => {
  const viewport = { scrollHeight: 42_000, scrollTop: 6_000 };
  assert.equal(resetTranscriptScrollForConversation("conversation-a", "conversation-b", viewport), true);
  assert.equal(viewport.scrollTop, 42_000);

  viewport.scrollTop = 3_000;
  assert.equal(resetTranscriptScrollForConversation("conversation-b", "conversation-b", viewport), false);
  assert.equal(viewport.scrollTop, 3_000, "rerenders inside one conversation preserve the reader's position");
});

test("a streaming append reuses every historical turn in a 3,300-entry history", () => {
  const messages = Array.from({ length: 3_300 }, (_, index) => message(index));
  const before = buildTranscriptEntries(messages);
  const streaming = {
    ...message(messages.length),
    role: "assistant",
    content: "Streaming continuation",
    status: "streaming",
  };
  const after = buildTranscriptEntries([...messages, streaming]);
  const historicalTurns = before.filter((entry) => entry.kind === "assistant-turn");
  const nextTurns = after.filter((entry) => entry.kind === "assistant-turn");

  assert.equal(nextTurns.length, historicalTurns.length);
  const changedTurnIndexes = historicalTurns.flatMap((entry, index) => (
    haveSameMessageReferences(entry.messages, nextTurns[index].messages) ? [] : [index]
  ));
  assert.deepEqual(changedTurnIndexes, [historicalTurns.length - 1]);
  assert.equal(nextTurns.at(-1).messages.at(-1), streaming);
});
