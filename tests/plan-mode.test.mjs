import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

const buildResult = await build({
  entryPoints: ["src/lib/plan-mode.ts"],
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
  EMPTY_PLAN_MODE,
  PLAN_MODE_DIRECTORY,
  PLAN_PAYLOAD_VERSION,
  PLAN_DOCUMENT_MAX_CHARS,
  PLAN_OPTIONS_MAX_COUNT,
  PLAN_REVISION_MAX,
  PLAN_ROUNDS_MAX,
  PLAN_SNAPSHOT_MAX_CHARS,
  PLAN_TEXT_MAX_CHARS,
  PLAN_TOOL_INPUT_MAX_DEPTH,
  TOOL_INPUT_BOUNDS,
  encodePlanUiRequestTitle,
  decodePlanUiRequestTitle,
  planUiRequestKind,
  isClaimedPlanUiRequest,
  isInternalPlanUiRequest,
  isTrustedPlanUiRequest,
  planQuestionFromRequest,
  normalizePlanDocument,
  planDocumentPath,
  normalizeToolInput,
  encodePlanQuestionPayload,
  decodePlanQuestionPayload,
  encodePlanReviewPayload,
  decodePlanReviewPayload,
  encodePlanSnapshot,
  decodePlanSnapshot,
  decodePlanSnapshotText,
  encodePlanSnapshotJson,
  resolvePlanState,
  startPlanMode,
  openPlanQuestion,
  answerPlanQuestion,
  openPlanReview,
  decidePlanReview,
  cancelPlanMode,
  reloadPlanMode,
  planNotificationChoice,
} = compiledModule.exports;

const QUESTION_PROMPT = "Quelle base de données faut-il utiliser ?";
const QUESTION_PAYLOAD = {
  kind: "question",
  toolCallId: "tool-1",
  prompt: QUESTION_PROMPT,
  options: [
    { value: "sqlite", label: "SQLite" },
    { value: "postgres", label: "PostgreSQL" },
  ],
  allowOther: false,
};

function planTitle(payload = QUESTION_PAYLOAD, humanTitle = "question — Choix de base") {
  const title = encodePlanUiRequestTitle(payload, humanTitle);
  assert.ok(title);
  return title;
}

function planRequest(overrides = {}) {
  const method = overrides.method ?? "select";
  const title = Object.hasOwn(overrides, "title")
    ? overrides.title
    : method === "input"
      ? planTitle({ kind: "custom", toolCallId: "tool-1", prompt: QUESTION_PROMPT }, "Your answer")
      : planTitle();
  return {
    type: "extension_ui_request",
    id: "req-1",
    method,
    title,
    message: QUESTION_PROMPT,
    options: ["SQLite", "PostgreSQL"],
    ...overrides,
  };
}

function startedPlan() {
  return startPlanMode(EMPTY_PLAN_MODE).state;
}

/** start → question(req-1) → answer → review(round) */
function reviewedPlan({ name = "Refactor Auth", markdown = "# Plan\nÉtape 1" } = {}) {
  let state = startPlanMode(EMPTY_PLAN_MODE).state;
  state = openPlanQuestion(state, { request: planRequest() }).state;
  state = answerPlanQuestion(state, { requestId: "req-1", value: "PostgreSQL" }).state;
  const review = openPlanReview(state, { document: { name, markdown } });
  return review;
}

const VALID_DOCUMENT = { name: "plan", markdown: "# Plan", round: 1 };

function assertSameReference(result, state) {
  assert.equal(result.status, "rejected");
  assert.equal(result.state, state, "a rejected transition must never touch the state");
}

test("the initial state is Normal mode and frozen", () => {
  assert.equal(EMPTY_PLAN_MODE.phase, "idle");
  assert.equal(EMPTY_PLAN_MODE.revision, 0);
  assert.ok(Object.isFrozen(EMPTY_PLAN_MODE));
});

test("starting Plan mode is conversation-local, monotone, and idempotent", () => {
  const started = startPlanMode(EMPTY_PLAN_MODE);
  assert.equal(started.status, "accepted");
  assert.deepEqual(started.state, { phase: "planning", revision: 1 });

  const restart = startPlanMode(started.state);
  assert.equal(restart.status, "accepted");
  assert.equal(restart.changed, false);
  assert.equal(restart.state, started.state, "restart while active must be a no-op");

  // Even mid-question, starting again cannot reset the blocking question.
  const questioning = openPlanQuestion(started.state, { request: planRequest() }).state;
  const midQuestion = startPlanMode(questioning);
  assert.equal(midQuestion.changed, false);
  assert.equal(midQuestion.state, questioning);

  // Cancelling an idle conversation is equally idempotent.
  const cancelIdle = cancelPlanMode(EMPTY_PLAN_MODE);
  assert.equal(cancelIdle.status, "accepted");
  assert.equal(cancelIdle.changed, false);
  assert.equal(cancelIdle.state, EMPTY_PLAN_MODE);
});

test("transitions reject corrupt states instead of guessing", () => {
  for (const garbage of [undefined, null, 42, "planning", [], new Date(0)]) {
    const result = startPlanMode(garbage);
    assert.equal(result.status, "rejected");
    assert.equal(result.reason, "invalid_state");
    assert.equal(result.state, EMPTY_PLAN_MODE, "corrupt states fail closed to Normal mode");
  }
  const inherited = Object.create({ phase: "planning", revision: 3 });
  assert.equal(resolvePlanState(inherited), undefined, "prototype-inherited state fields are invisible");
});

test("every transition honors the caller-observed revision (stale guards)", () => {
  const planning = startedPlan();

  assertSameReference(startPlanMode(EMPTY_PLAN_MODE, { expectedRevision: 7 }), EMPTY_PLAN_MODE);
  assertSameReference(
    openPlanQuestion(planning, { request: planRequest() }, { expectedRevision: 99 }),
    planning,
  );
  const questioning = openPlanQuestion(planning, { request: planRequest() }).state;
  assertSameReference(
    answerPlanQuestion(questioning, { value: "SQLite" }, { expectedRevision: 0 }),
    questioning,
  );
  assertSameReference(cancelPlanMode(questioning, { expectedRevision: -1 }), questioning);
  // Malformed guards fail closed exactly like stale ones.
  assertSameReference(cancelPlanMode(questioning, { expectedRevision: "two" }), questioning);
});

test("opening a bounded internal question blocks the conversation", () => {
  const planning = startedPlan();
  const frozen = JSON.stringify(planning);
  const result = openPlanQuestion(planning, { request: planRequest({ id: "req-9" }) });

  assert.equal(result.status, "accepted");
  assert.equal(result.changed, true);
  assert.equal(result.state.phase, "question");
  assert.equal(result.state.revision, 2);
  assert.deepEqual(result.state.question, {
    requestId: "req-9",
    method: "select",
    title: "question — Choix de base",
    message: "Quelle base de données faut-il utiliser ?",
    options: ["SQLite", "PostgreSQL"],
  });
  assert.equal(JSON.stringify(planning), frozen, "transitions never mutate their input");
});

test("a second question cannot preempt the pending one", () => {
  const planning = startedPlan();
  const questioning = openPlanQuestion(planning, { request: planRequest() }).state;
  const second = openPlanQuestion(questioning, { request: planRequest({ id: "req-2" }) });
  assert.equal(second.reason, "duplicate_question");
  assert.equal(second.state, questioning);
});

test("non-plan requests are classified, and marked-but-malformed ones fail closed", () => {
  const planning = startedPlan();

  // Ordinary extension prompts stay out of Plan mode.
  const ordinary = openPlanQuestion(planning, {
    request: planRequest({ title: "Choisis une option" }),
  });
  assert.equal(ordinary.reason, "not_plan_request");

  // A request wearing the reserved marker through a non-blocking method is
  // malformed Plan traffic and fails closed like any other broken contract.
  const notify = openPlanQuestion(planning, { request: planRequest({ method: "notify" }) });
  assert.equal(notify.reason, "invalid_input");
  // Without the marker, the same shape stays ordinary extension traffic.
  const unmarked = openPlanQuestion(planning, {
    request: planRequest({ method: "notify", title: "Notification" }),
  });
  assert.equal(unmarked.reason, "not_plan_request");

  // A select question without usable choices is rejected outright…
  const noOptions = openPlanQuestion(planning, { request: planRequest({ options: [] }) });
  assert.equal(noOptions.reason, "invalid_input");

  // …as are oversized identities and overlong options.
  assert.equal(
    openPlanQuestion(planning, { request: planRequest({ id: "x".repeat(201) }) }).reason,
    "invalid_input",
  );
  assert.equal(
    openPlanQuestion(planning, {
      request: planRequest({ options: ["ok", "y".repeat(513)] }),
    }).reason,
    "invalid_input",
  );
  // More choices than the bound fail closed instead of dropping some.
  assert.equal(
    openPlanQuestion(planning, {
      request: planRequest({ options: Array.from({ length: PLAN_OPTIONS_MAX_COUNT + 1 }, (_, i) => `o${i}`) }),
    }).reason,
    "invalid_input",
  );

  // Oversized display text is clipped into bounds, not rejected…
  const clipped = openPlanQuestion(planning, {
    request: planRequest({
      title: planTitle(QUESTION_PAYLOAD, `question ${"t".repeat(PLAN_TEXT_MAX_CHARS + 40)}`),
      message: "m".repeat(PLAN_TEXT_MAX_CHARS * 2),
    }),
  });
  assert.equal(clipped.status, "accepted");
  assert.equal(clipped.state.question.title.length, PLAN_TEXT_MAX_CHARS);
  assert.equal(clipped.state.question.message, QUESTION_PROMPT);
});

test("answers accept exact options, custom input, and cancellation", () => {
  const planning = startedPlan();
  const questioning = openPlanQuestion(planning, { request: planRequest() }).state;

  const selected = answerPlanQuestion(questioning, { requestId: "req-1", value: "PostgreSQL" });
  assert.equal(selected.status, "accepted");
  assert.deepEqual(selected.state, { phase: "planning", revision: 3 });

  const reasked = openPlanQuestion(selected.state, {
    request: planRequest({ id: "req-2", method: "input", options: undefined, prefill: "N/A" }),
  }).state;
  const custom = answerPlanQuestion(reasked, { requestId: "req-2", value: "MariaDB derrière Docker" });
  assert.equal(custom.status, "accepted");

  const reaskedAgain = openPlanQuestion(custom.state, {
    request: planRequest({ id: "req-3", method: "input", options: undefined }),
  }).state;
  const cancelled = answerPlanQuestion(reaskedAgain, { requestId: "req-3", cancelled: true, value: "ignored" });
  assert.equal(cancelled.status, "accepted");
  assert.deepEqual(cancelled.state, { phase: "planning", revision: 7 });
});

test("double responses and stale responses are rejected, never forwarded twice", () => {
  const questioning = openPlanQuestion(startedPlan(), { request: planRequest() }).state;

  const first = answerPlanQuestion(questioning, { requestId: "req-1", value: "SQLite" });
  assert.equal(first.status, "accepted");

  // Replay of the exact same response once the question is consumed: the
  // caller must operate on the latest state, where the replay is rejected.
  const replay = answerPlanQuestion(first.state, { requestId: "req-1", value: "SQLite" });
  assert.equal(replay.reason, "wrong_phase");
  assert.equal(replay.state, first.state);

  // A second question opens; a late duplicate answer to the FIRST id is stale.
  const second = openPlanQuestion(first.state, { request: planRequest({ id: "req-2" }) }).state;
  const late = answerPlanQuestion(second, { requestId: "req-1", value: "PostgreSQL" });
  assert.equal(late.reason, "stale_request");
  assert.equal(late.state, second);
});

test("invalid answers fail closed on shape, size, and exact-option match", () => {
  const questioning = openPlanQuestion(startedPlan(), { request: planRequest() }).state;

  assert.equal(answerPlanQuestion(questioning, {}).reason, "invalid_input");
  assert.equal(answerPlanQuestion(questioning, { value: "" }).reason, "invalid_input");
  assert.equal(answerPlanQuestion(questioning, { value: 42 }).reason, "invalid_input");
  assert.equal(answerPlanQuestion(questioning, { value: "sqlite" }).reason, "invalid_input", "options match exactly");
  assert.equal(
    answerPlanQuestion(questioning, { value: "v".repeat(PLAN_TEXT_MAX_CHARS + 1) }).reason,
    "oversize",
  );

  // Unicode-normalization lookalikes are not equal to the real option.
  const accentFree = openPlanQuestion(startedPlan(), {
    request: planRequest({ options: ["caf\u00E9"] }),
  }).state;
  assert.equal(
    answerPlanQuestion(accentFree, { value: "cafe\u0301" }).reason,
    "invalid_input",
  );
});

test("review presents a normalized, safely named document", () => {
  const review = reviewedPlan({
    name: "Créer l'API 🚀",
    markdown: "# Titre\r\n\r\nCorps\u0000 fin",
  });
  assert.equal(review.status, "accepted");
  assert.equal(review.state.phase, "review");
  assert.equal(review.state.revision, 4);
  assert.deepEqual(review.state.document, {
    name: "creer-l-api",
    markdown: "# Titre\n\nCorps fin",
    round: 1,
  });
  assert.equal(review.state.round, 1);
});

test("oversized or empty documents are rejected without touching the state", () => {
  const ready = answerPlanQuestion(
    openPlanQuestion(startedPlan(), { request: planRequest() }).state,
    { requestId: "req-1", value: "SQLite" },
  ).state;

  const oversize = openPlanReview(ready, {
    document: { markdown: "d".repeat(PLAN_DOCUMENT_MAX_CHARS + 1) },
  });
  assert.equal(oversize.reason, "oversize");
  assert.equal(oversize.state, ready);

  const empty = openPlanReview(ready, { document: { markdown: "   \n\t " } });
  assert.equal(empty.reason, "invalid_input");
  assert.equal(empty.state, ready);

  const noDocument = openPlanReview(ready, {});
  assert.equal(noDocument.reason, "invalid_input");
});

test("apply exits to implementation in the same conversation; keep exits without it", () => {
  const review = reviewedPlan().state;

  const applied = decidePlanReview(review, { decision: "apply" });
  assert.equal(applied.status, "accepted");
  assert.deepEqual(applied.state, { phase: "idle", revision: 5, round: 1, outcome: "applied" });

  // A decision is terminal: deciding again on the latest state is rejected.
  assert.equal(decidePlanReview(applied.state, { decision: "keep" }).reason, "wrong_phase");
  assert.equal(decidePlanReview(applied.state, { decision: "apply" }).reason, "wrong_phase");

  const kept = decidePlanReview(review, { decision: "keep" });
  assert.deepEqual(kept.state, { phase: "idle", revision: 5, round: 1, outcome: "kept" });

  assert.equal(decidePlanReview(review, { decision: "ship it" }).reason, "invalid_input");
  assert.equal(decidePlanReview(review, {}).reason, "invalid_input");
});

test("revise regenerates the document and respects the round limit", () => {
  let state = reviewedPlan().state;

  for (let round = 2; round <= PLAN_ROUNDS_MAX; round += 1) {
    const revised = decidePlanReview(state, { decision: "revise" });
    assert.equal(revised.status, "accepted");
    assert.deepEqual(revised.state, { phase: "planning", revision: state.revision + 1, round: round - 1 });
    const next = openPlanReview(revised.state, { document: { markdown: `# v${round}` } });
    assert.equal(next.status, "accepted");
    assert.equal(next.state.round, round);
    assert.equal(next.state.revision, state.revision + 2);
    state = next.state;
  }

  const beyondLimit = decidePlanReview(state, { decision: "revise" });
  const afterRevise = openPlanReview(beyondLimit.state, { document: { markdown: "# v9" } });
  assert.equal(afterRevise.reason, "round_limit");
  assert.equal(afterRevise.state, beyondLimit.state);
});

test("cancel works from any active phase and records why Plan mode ended", () => {
  const planning = startedPlan();
  const fromPlanning = cancelPlanMode(planning);
  assert.deepEqual(fromPlanning.state, { phase: "idle", revision: 2, outcome: "cancelled" });

  const questioning = openPlanQuestion(startedPlan(), { request: planRequest() }).state;
  const fromQuestion = cancelPlanMode(questioning);
  assert.deepEqual(fromQuestion.state, { phase: "idle", revision: 3, outcome: "cancelled" });

  const fromReview = cancelPlanMode(reviewedPlan().state);
  assert.deepEqual(fromReview.state, { phase: "idle", revision: 5, round: 1, outcome: "cancelled" });
});

test("reloading restores snapshots and fails closed on garbage or stale data", () => {
  const questioning = openPlanQuestion(startedPlan(), { request: planRequest({ id: "req-7" }) }).state;
  const snapshot = encodePlanSnapshotJson(questioning);
  assert.ok(typeof snapshot === "string" && snapshot.startsWith(`{"v":${PLAN_PAYLOAD_VERSION},"kind":"plan_snapshot"`));

  const restored = reloadPlanMode(EMPTY_PLAN_MODE, snapshot);
  assert.equal(restored.status, "accepted");
  assert.equal(restored.changed, true);
  assert.deepEqual(restored.state, questioning);

  // Reloading the already-current snapshot is an acknowledged no-op.
  const again = reloadPlanMode(restored.state, snapshot);
  assert.equal(again.changed, false);
  assert.equal(again.state, restored.state);

  // A snapshot older than the live state is stale.
  const advanced = cancelPlanMode(restored.state).state;
  assert.equal(reloadPlanMode(advanced, snapshot).reason, "stale_revision");

  // Same revision but different content means corruption, not progress.
  const conflicting = encodePlanSnapshotJson(
    openPlanQuestion(startedPlan(), { request: planRequest({ id: "req-other" }) }).state,
  );
  assert.equal(reloadPlanMode(restored.state, conflicting).reason, "stale_revision");

  // Unusable payloads leave the passed state untouched.
  for (const junk of [undefined, null, 42, "{}", "{broken", "x".repeat(PLAN_SNAPSHOT_MAX_CHARS + 1)]) {
    const failed = reloadPlanMode(questioning, junk);
    assert.equal(failed.reason, "invalid_input");
    assert.equal(failed.state, questioning);
  }
});

test("snapshot decoding validates version, coherence, and structure strictly", () => {
  const review = reviewedPlan().state;
  const payload = encodePlanSnapshot(review);
  assert.deepEqual(decodePlanSnapshot(payload), review);

  const mutate = (patch) => {
    const copy = JSON.parse(JSON.stringify(payload));
    return Object.assign(copy, patch);
  };
  assert.equal(decodePlanSnapshot(mutate({ v: 2 })), undefined, "future versions fail closed");
  assert.equal(decodePlanSnapshot(mutate({ kind: "plan_other" })), undefined);
  assert.equal(decodePlanSnapshot(mutate({ phase: "suspended" })), undefined);
  assert.equal(decodePlanSnapshot(mutate({ revision: 1.5 })), undefined);
  assert.equal(decodePlanSnapshot(mutate({ revision: -1 })), undefined);
  assert.equal(decodePlanSnapshot(mutate({ phase: "question", document: undefined })), undefined,
    "a blocked phase without its question is incoherent");
  assert.equal(decodePlanSnapshot(mutate({ phase: "idle", question: undefined })), undefined,
    "idle states carry neither interactions nor documents");

  // Structural hazards: inheritance, getters, arrays, primitives.
  const protoBacked = Object.create({
    v: PLAN_PAYLOAD_VERSION,
    kind: "plan_snapshot",
    phase: "planning",
    revision: 4,
  });
  assert.equal(decodePlanSnapshot(protoBacked), undefined);
  const getterBacked = Object.create(payload);
  Object.defineProperty(getterBacked, "v", {
    enumerable: true,
    get() {
      throw new Error("getter must never run during decoding");
    },
  });
  assert.equal(decodePlanSnapshot(getterBacked), undefined,
    "accessor properties are indistinguishable from absence and never invoked");
  assert.equal(decodePlanSnapshot([payload]), undefined);
  assert.equal(decodePlanSnapshot("json"), undefined);
});

test("persistence stays inside hard serialized limits and survives JSON", () => {
  const review = reviewedPlan().state;
  const json = encodePlanSnapshotJson(review);
  assert.ok(json.length < PLAN_SNAPSHOT_MAX_CHARS);
  assert.deepEqual(decodePlanSnapshotText(json), review);
  assert.equal(decodePlanSnapshotText("{nope"), undefined);
  assert.equal(decodePlanSnapshotText(42), undefined);
  assert.equal(
    decodePlanSnapshotText(`"${"a".repeat(PLAN_SNAPSHOT_MAX_CHARS)}"`),
    undefined,
    "oversized persistence blobs are refused before parsing",
  );
});

test("question payloads round-trip through the versioned wire format", () => {
  const view = planQuestionFromRequest(planRequest({ id: "req-u", prefill: undefined }));
  const encoded = encodePlanQuestionPayload(view);
  assert.equal(encoded.v, PLAN_PAYLOAD_VERSION);
  assert.equal(encoded.kind, "plan_question");
  assert.deepEqual(decodePlanQuestionPayload(encoded), view);

  assert.equal(decodePlanQuestionPayload(mutateFirst(encoded, { v: PLAN_PAYLOAD_VERSION + 3 })), undefined);
  assert.equal(decodePlanQuestionPayload(mutateFirst(encoded, { kind: "plan_review" })), undefined);
  assert.equal(decodePlanQuestionPayload(mutateFirst(encoded, { title: "" })), undefined);
  assert.equal(decodePlanQuestionPayload(mutateFirst(encoded, { title: "t".repeat(PLAN_TEXT_MAX_CHARS + 1) })), undefined);
  assert.equal(decodePlanQuestionPayload(mutateFirst(encoded, { options: [] })), undefined);
  assert.equal(decodePlanQuestionPayload(mutateFirst(encoded, { options: ["a".repeat(513)] })), undefined);
  assert.equal(decodePlanQuestionPayload(mutateFirst(encoded, { message: "m".repeat(PLAN_TEXT_MAX_CHARS + 1) })), undefined);
  // A select payload losing its options, or an input one gaining them, is incoherent.
  assert.equal(decodePlanQuestionPayload(mutateFirst(encoded, { options: undefined })), undefined);
  const inputEncoded = encodePlanQuestionPayload(
    planQuestionFromRequest(planRequest({ method: "input", options: undefined })),
  );
  assert.equal(inputEncoded.options, undefined);
  assert.equal(decodePlanQuestionPayload(mutateFirst(inputEncoded, { options: ["x"] })), undefined);

  // Unicode content survives intact, including astral-plane characters.
  const unicodePrompt = "Confirmez-vous 🚀 — « mise en œuvre » ?";
  const unicodeView = planQuestionFromRequest(planRequest({
    id: "req-ü",
    title: planTitle({
      kind: "question",
      toolCallId: "tool-ü",
      prompt: unicodePrompt,
      options: [
        { value: "yes", label: "Oui ✅" },
        { value: "no", label: "Non ❌" },
      ],
      allowOther: false,
    }, unicodePrompt),
    message: unicodePrompt,
    options: ["Oui ✅", "Non ❌"],
  }));
  assert.deepEqual(decodePlanQuestionPayload(encodePlanQuestionPayload(unicodeView)), unicodeView);

  function mutateFirst(source, patch) {
    return Object.assign(JSON.parse(JSON.stringify(source)), patch);
  }
});

test("review payloads round-trip and refuse denormalized or oversized documents", () => {
  const normalized = normalizePlanDocument({ name: "Plan Final !", markdown: "# Plan\r\ntexte" });
  assert.deepEqual(normalized, { name: "plan-final", markdown: "# Plan\ntexte" });

  const encoded = encodePlanReviewPayload({ ...normalized, round: 1 });
  assert.equal(encoded.kind, "plan_review");
  assert.deepEqual(decodePlanReviewPayload(encoded), { ...normalized, round: 1 });

  assert.equal(decodePlanReviewPayload(mutate(encoded, { v: 9 })), undefined);
  assert.equal(decodePlanReviewPayload(mutate(encoded, { kind: "plan_question" })), undefined);
  assert.equal(decodePlanReviewPayload(mutate(encoded, { name: "Bad_Name" })), undefined);
  assert.equal(decodePlanReviewPayload(mutate(encoded, { round: 0 })), undefined);
  assert.equal(
    decodePlanReviewPayload(mutate(encoded, { markdown: "a".repeat(PLAN_DOCUMENT_MAX_CHARS + 1) })),
    undefined,
  );
  // CR characters must be normalized away before encoding, never carried.
  assert.equal(decodePlanReviewPayload(mutate(encoded, { markdown: "# Plan\r\ntexte" })), undefined);

  function mutate(source, patch) {
    return Object.assign(JSON.parse(JSON.stringify(source)), patch);
  }
});

test("internal Plan requests are recognized precisely", () => {
  assert.equal(isInternalPlanUiRequest(planRequest()), true);
  assert.equal(isTrustedPlanUiRequest(planRequest(), "normal"), false);
  assert.equal(isTrustedPlanUiRequest(planRequest(), "plan"), true);
  assert.equal(planUiRequestKind(planRequest()), "question");
  const reviewTitle = planTitle(
    { kind: "review", planId: "tool-review", title: "Décision finale" },
    "review — Décision finale",
  );
  assert.equal(planUiRequestKind(planRequest({ method: "select", title: reviewTitle })), "review");
  assert.equal(planUiRequestKind(planRequest({ method: "confirm", title: reviewTitle })), undefined);
  const malformedClaim = planRequest({ title: "prime-orbit-plan-ui:v1:not-base64\nQuestion" });
  assert.equal(planUiRequestKind(malformedClaim), undefined);
  assert.equal(isClaimedPlanUiRequest(malformedClaim), true);
  assert.equal(isInternalPlanUiRequest(planRequest({ title: planTitle().toUpperCase() })), false);
  assert.equal(decodePlanUiRequestTitle(planTitle())?.payload.kind, "question");

  const negatives = [
    planRequest({ title: "Choisis une option" }),
    planRequest({ method: "notify" }),
    planRequest({ method: "setWidget" }),
    planRequest({ id: "" }),
    planRequest({ id: "x".repeat(201) }),
    planRequest({ type: "rpc" }),
    null,
    42,
    "extension_ui_request",
    [],
  ];
  for (const candidate of negatives) {
    assert.equal(isInternalPlanUiRequest(candidate), false, JSON.stringify(candidate));
  }
});

test("notifications fire only for known events while no window is focused", () => {
  assert.deepEqual(planNotificationChoice({ event: "question", focused: false, language: "fr" }), {
    show: true,
    title: "Prime Orbit · Plan",
    body: "Une question de plan attend votre réponse.",
    sound: true,
  });
  assert.deepEqual(planNotificationChoice({ event: "review", focused: false }), {
    show: true,
    title: "Prime Orbit · Plan",
    body: "The plan is ready for your decision.",
    sound: true,
  });
  // A focused window suppresses the toast entirely.
  assert.deepEqual(planNotificationChoice({ event: "question", focused: true, language: "fr" }), {
    show: false,
    title: "",
    body: "",
    sound: false,
  });
  // Unknown focus still notifies: the durable transcript signal must not be lost.
  assert.equal(planNotificationChoice({ event: "review", focused: undefined }).show, false);
  assert.equal(planNotificationChoice({ event: "review", focused: "yes" }).show, false);
  // Unknown events never notify.
  assert.deepEqual(planNotificationChoice({ event: "applied", focused: false }), {
    show: false,
    title: "",
    body: "",
    sound: false,
  });
  assert.equal(planNotificationChoice({}).sound, false);
});

test("tool inputs are bounded, JSON-safe, and immune to prototype hazards", () => {
  const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
  assert.deepEqual(normalizeToolInput(deep), { a: { b: { c: { d: { e: { f: "[max-depth]" } } } } } });

  const bigArray = Array.from({ length: 40 }, (_, index) => index);
  const boundedArray = normalizeToolInput(bigArray);
  assert.equal(boundedArray.length, 33);
  assert.equal(boundedArray.at(-1), "[truncated]");

  assert.equal(normalizeToolInput("s".repeat(600)).length, 512);
  assert.equal(normalizeToolInput("s".repeat(600)).endsWith("…"), true);
  assert.deepEqual(normalizeToolInput([Number.NaN, Number.POSITIVE_INFINITY, 3n]), [null, null, null]);
  assert.deepEqual(normalizeToolInput(() => 1), null);
  assert.deepEqual(normalizeToolInput(undefined), null);

  const inherited = Object.create({ inherited: "nope" });
  inherited.own = 1;
  assert.deepEqual(normalizeToolInput(inherited), { own: 1 });

  // A JSON-parsed "__proto__" is data, but it must never become structure.
  const polluted = JSON.parse('{"__proto__": {"flag": true}, "ok": 2}');
  const cleaned = normalizeToolInput(polluted);
  assert.deepEqual(cleaned, { ok: 2 });
  assert.equal(Object.getPrototypeOf(cleaned), Object.prototype);
  assert.equal(cleaned.flag, undefined);

  // Getters are never invoked while bounding.
  const calls = [];
  const withGetter = { plain: 1 };
  Object.defineProperty(withGetter, "lazy", { enumerable: true, get() { calls.push(1); return 2; } });
  assert.deepEqual(normalizeToolInput(withGetter), { plain: 1 });
  assert.deepEqual(calls, []);
});

test("documents map onto .prime/plans with deterministic names", () => {
  assert.equal(PLAN_MODE_DIRECTORY, ".prime/plans");
  assert.equal(planDocumentPath("Créer l'API 🚀"), ".prime/plans/creer-l-api.md");
  assert.equal(planDocumentPath(""), ".prime/plans/plan.md");
  assert.equal(planDocumentPath(undefined), ".prime/plans/plan.md");
  assert.equal(planDocumentPath("x".repeat(200)), `.prime/plans/${"x".repeat(80)}.md`);
});

test("revision counters fail closed at the safe-integer ceiling", () => {
  const ceiling = { phase: "planning", revision: PLAN_REVISION_MAX };
  assert.ok(resolvePlanState(ceiling));
  // Idempotent restart needs no counter space.
  const restarted = startPlanMode(ceiling);
  assert.equal(restarted.changed, false);

  const questioned = openPlanQuestion(ceiling, { request: planRequest() });
  assert.equal(questioned.reason, "revision_overflow");
  assert.equal(questioned.state, ceiling);
});

test("rejected transitions always echo the untouched input state", () => {
  const questioning = openPlanQuestion(startedPlan(), { request: planRequest() }).state;
  const frozen = JSON.stringify(questioning);

  const results = [
    openPlanQuestion(questioning, { request: planRequest({ id: "req-x" }) }),
    answerPlanQuestion(questioning, { value: "nope" }),
    openPlanReview(questioning, { document: VALID_DOCUMENT }),
    decidePlanReview(questioning, { decision: "apply" }),
    cancelPlanMode(questioning, { expectedRevision: 41 }),
    reloadPlanMode(questioning, null),
  ];
  for (const result of results) {
    assert.equal(result.status, "rejected");
    assert.equal(result.state, questioning);
  }
  assert.equal(JSON.stringify(questioning), frozen);
});

test("TOOL_INPUT_BOUNDS exposes the tool-input budget used by activity rendering", () => {
  // The export exists so callers can render truncation hints consistently.
  assert.deepEqual(TOOL_INPUT_BOUNDS, {
    maxDepth: PLAN_TOOL_INPUT_MAX_DEPTH,
    maxItems: 32,
    maxKeyChars: 120,
    maxStringLength: 512,
  });
});
