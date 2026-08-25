import type { AppLanguage } from "../i18n";
import type { ChatMessage, ExtensionUiRequest } from "../types";

/**
 * Pure Plan-mode state machine for Prime Orbit.
 *
 * Product decisions (PRODUCT.md):
 * - Plan mode is opt-in and scoped to ONE conversation. New conversations
 *   always start in Normal mode; nothing here ever mutates a global mode.
 * - Generated plans belong to `<project>/.prime/plans/<name>.md` and are
 *   written atomically by native code only after generation completes.
 * - Applying a plan exits Plan mode and immediately starts implementation in
 *   the SAME conversation, using the generated document as source of truth.
 *   Keeping a plan exits without implementation.
 *
 * Safety posture: every decoder is bounded and fails closed. Malformed,
 * oversized, getter-backed, or prototype-tampered input yields `undefined`
 * (or a rejected transition) instead of a best-effort guess. Every transition
 * is a pure function that never mutates its input state, and every mutation
 * carries a monotone `revision` so stale callers can be discarded.
 */

/** Project-relative directory that owns generated plan documents. */
export const PLAN_MODE_DIRECTORY = ".prime/plans";

/** Wire version of every Plan payload produced by this module. */
export const PLAN_PAYLOAD_VERSION = 1;

/** Reserved title marker identifying Prime Orbit's internal Plan dialogs. */
export const PLAN_REQUEST_TITLE_PREFIX = "prime-orbit-plan-ui:v1:";
/** Renderer-hidden prompt used only to recreate an extension dialog after the
 * owning RPC client disappeared. It is persisted by Prime Agent, so transcript
 * projections must recognize it narrowly instead of displaying implementation
 * plumbing as a user message. */
export const PLAN_RECOVERY_PROMPT_PREFIX = "[Prime Orbit internal Plan recovery v1]";
const LEGACY_PLAN_RECOVERY_PROMPTS = [
  "[Prime Orbit recovery] The previous Plan review dialog was lost during a client reconnection.",
  "[Prime Orbit recovery] The previous Plan question dialogs were lost during a client reconnection.",
  "[Prime Orbit recovery] The previous Plan dialogs were lost during a client reconnection.",
] as const;
export const PLAN_REQUEST_TOKEN_MAX_CHARS = 65_536;
export const PLAN_REQUEST_JSON_MAX_CHARS = 12_000;

export const PLAN_ID_MAX_CHARS = 200;
export const PLAN_TEXT_MAX_CHARS = 4_096;
export const PLAN_OPTION_MAX_CHARS = 512;
export const PLAN_OPTIONS_MAX_COUNT = 10;
export const PLAN_DOCUMENT_NAME_MAX_CHARS = 80;
export const PLAN_DOCUMENT_MAX_CHARS = 65_536;
export const PLAN_ROUNDS_MAX = 8;
export const PLAN_TOOL_INPUT_MAX_DEPTH = 6;
export const PLAN_TOOL_INPUT_MAX_ITEMS = 32;
export const PLAN_TOOL_INPUT_MAX_KEY_CHARS = 120;
export const PLAN_TOOL_INPUT_MAX_STRING_CHARS = 512;
/** Hard ceiling for the serialized persistence snapshot (256 KiB). */
export const PLAN_SNAPSHOT_MAX_CHARS = 262_144;
/** Monotone revision ceiling; transitions beyond it fail closed. */
export const PLAN_REVISION_MAX = Number.MAX_SAFE_INTEGER - 1;

export type PlanModePhase = "idle" | "planning" | "question" | "review";
export type PlanOutcome = "applied" | "kept" | "cancelled";
export type PlanReviewDecision = "apply" | "keep" | "revise";
export type PlanUiRequestKind = "question" | "review";

export interface PlanUiDialogOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export type PlanUiDialogPayload =
  | {
      readonly v: typeof PLAN_PAYLOAD_VERSION;
      readonly kind: "question";
      readonly toolCallId: string;
      readonly prompt: string;
      readonly context?: string;
      readonly options: readonly PlanUiDialogOption[];
      readonly allowOther: boolean;
    }
  | {
      readonly v: typeof PLAN_PAYLOAD_VERSION;
      readonly kind: "custom";
      readonly toolCallId: string;
      readonly prompt: string;
    }
  | {
      readonly v: typeof PLAN_PAYLOAD_VERSION;
      readonly kind: "review";
      readonly planId: string;
      readonly title: string;
    };

export interface DecodedPlanUiDialog {
  readonly payload: PlanUiDialogPayload;
  readonly humanTitle: string;
}

/** A blocked, human-facing Plan question rendered from an internal request. */
export interface PlanQuestionView {
  readonly requestId: string;
  readonly method: "select" | "input";
  /** Marker-free, bounded display title. */
  readonly title: string;
  readonly message: string;
  /** Required for `select`: the exact answerable choices. */
  readonly options?: readonly string[];
  /** Optional prefilled custom response for `input`. */
  readonly prefill?: string;
}

/** A bounded plan document under review, named for `.prime/plans/<name>.md`. */
export interface PlanDocument {
  readonly name: string;
  readonly markdown: string;
  /** 1-based generation round; increments on every `revise` cycle. */
  readonly round: number;
}

export interface PlanModeState {
  readonly phase: PlanModePhase;
  /** Monotone guard incremented by every accepted, state-changing transition. */
  readonly revision: number;
  readonly question?: PlanQuestionView;
  readonly document?: PlanDocument;
  readonly outcome?: PlanOutcome;
  /** Highest review round reached in this Plan session (absent before review). */
  readonly round?: number;
}

export type PlanTransitionRejection =
  | "invalid_state"
  | "invalid_input"
  | "not_plan_request"
  | "wrong_phase"
  | "duplicate_question"
  | "stale_request"
  | "stale_revision"
  | "oversize"
  | "round_limit"
  | "revision_overflow";

export type PlanTransitionResult =
  | { readonly status: "accepted"; readonly state: PlanModeState; readonly changed: boolean }
  | { readonly status: "rejected"; readonly state: PlanModeState; readonly reason: PlanTransitionRejection };

export interface PlanQuestionPayload {
  readonly v: typeof PLAN_PAYLOAD_VERSION;
  readonly kind: "plan_question";
  readonly requestId: string;
  readonly method: "select" | "input";
  readonly title: string;
  readonly message: string;
  readonly options?: readonly string[];
  readonly prefill?: string;
}

export interface PlanReviewPayload {
  readonly v: typeof PLAN_PAYLOAD_VERSION;
  readonly kind: "plan_review";
  readonly name: string;
  readonly markdown: string;
  readonly round: number;
}

export interface PlanSnapshotPayload {
  readonly v: typeof PLAN_PAYLOAD_VERSION;
  readonly kind: "plan_snapshot";
  readonly phase: PlanModePhase;
  readonly revision: number;
  readonly question?: PlanQuestionPayload;
  readonly document?: PlanDocument;
  readonly outcome?: PlanOutcome;
  readonly round?: number;
}

export type PlanNotificationEvent = "question" | "review";

export type PlanDialogRecoveryKind = "question" | "review";

export interface PlanDialogRecoverySummary {
  readonly total: number;
  readonly questionCount: number;
  readonly reviewCount: number;
  /** The last unresolved blocking interaction in transcript order. */
  readonly latestKind?: PlanDialogRecoveryKind;
}

export interface PlanNotification {
  readonly show: boolean;
  readonly title: string;
  readonly body: string;
  readonly sound: boolean;
}

/**
 * Finds only unresolved, blocking Prime Orbit Plan tools. Inspect calls are
 * deliberately excluded: they never require a renderer form. The latest kind
 * lets recovery repeat the exact native interaction that was lost instead of
 * turning a missing review into another round of questions.
 */
export function unresolvedPlanDialogSummary(
  conversation: Pick<{ messages: ChatMessage[] }, "messages">,
): PlanDialogRecoverySummary {
  let questionCount = 0;
  let reviewCount = 0;
  let latestKind: PlanDialogRecoveryKind | undefined;
  for (const message of conversation.messages) {
    for (const tool of message.tools ?? []) {
      if (tool.status !== "unresolved") continue;
      if (tool.name === "prime_orbit_plan_question") {
        questionCount += 1;
        latestKind = "question";
      } else if (tool.name === "prime_orbit_plan_submit") {
        reviewCount += 1;
        latestKind = "review";
      }
    }
  }
  return {
    total: questionCount + reviewCount,
    questionCount,
    reviewCount,
    ...(latestKind ? { latestKind } : {}),
  };
}

/** Recovers the expected blocking interaction even when a reconnect has not
 * yet refreshed the unresolved tool call into the renderer transcript. */
export function recoverablePlanDialogKind(
  conversation: { messages: ChatMessage[]; planMode?: unknown },
): PlanDialogRecoveryKind | undefined {
  const transcriptKind = unresolvedPlanDialogSummary(conversation).latestKind;
  if (transcriptKind) return transcriptKind;
  const phase = resolvePlanState(conversation.planMode)?.phase;
  return phase === "question" || phase === "review" ? phase : undefined;
}

export function isInternalPlanRecoveryPrompt(value: unknown): boolean {
  return typeof value === "string" && (
    value.startsWith(`${PLAN_RECOVERY_PROMPT_PREFIX} `)
    || LEGACY_PLAN_RECOVERY_PROMPTS.some((prefix) => value.startsWith(`${prefix} `))
  );
}

/** Fresh, immutable Normal-mode state every conversation starts from. */
export const EMPTY_PLAN_MODE: PlanModeState = Object.freeze({ phase: "idle", revision: 0 });

const PLAN_PHASES: readonly PlanModePhase[] = ["idle", "planning", "question", "review"];
const PLAN_OUTCOMES: readonly PlanOutcome[] = ["applied", "kept", "cancelled"];
const PLAN_DECISIONS: readonly PlanReviewDecision[] = ["apply", "keep", "revise"];
/** Extension UI methods that actually block on a user answer. */
const PLAN_BLOCKING_METHODS: readonly string[] = ["select", "confirm", "input", "editor"];
const PLAN_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;
const PLAN_SLUG_FORBIDDEN = /[^a-z0-9]+/g;
const TOOL_INPUT_SKIPPED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const PLAN_KIND_WORDS: readonly PlanUiRequestKind[] = ["question", "review"];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Reads an own, data (non-getter) property. Prototype chains and accessor
 * properties are indistinguishable from absence, so tampering fails closed. */
function ownField(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function ownString(record: Record<string, unknown>, key: string): string | undefined {
  const value = ownField(record, key);
  return typeof value === "string" ? value : undefined;
}

function isBoundedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** Lenient encoder-side bounder: trims and clips display text into limits. */
function clipText(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxChars);
}

/** Strict decoder-side bounder: rejects absence and any overshoot. */
function strictText(value: unknown, minChars: number, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length < minChars || value.length > maxChars) return undefined;
  return value;
}

function oneOf<T extends string>(value: unknown, choices: readonly T[]): T | undefined {
  return choices.includes(value as T) ? value as T : undefined;
}

function sanitizeMultiline(value: string): string {
  return value.replace(/\r\n?/gu, "\n").replace(PLAN_CONTROL_CHARS, "");
}

/** Deterministic ASCII slug for `.prime/plans/<name>.md`; never empty. */
function slugifyPlanName(value: unknown): string {
  const folded = typeof value === "string" ? value.normalize("NFKD").replace(/\p{Mark}/gu, "") : "";
  const slug = folded
    .toLowerCase()
    .replace(PLAN_SLUG_FORBIDDEN, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, PLAN_DOCUMENT_NAME_MAX_CHARS)
    .replace(/-+$/g, "");
  return slug || "plan";
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((key) => (
    Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key])
  ));
}

/** Convert a UTF-8 byte sequence to/from the browser-safe base64url format. */
function decodeBase64UrlUtf8(token: string): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/u.test(token) || token.length > PLAN_REQUEST_TOKEN_MAX_CHARS) return undefined;
  try {
    const base64 = token.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(token.length / 4) * 4, "=");
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.length <= PLAN_REQUEST_JSON_MAX_CHARS ? text : undefined;
  } catch {
    return undefined;
  }
}

function encodeBase64UrlUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function strictDialogOption(value: unknown): PlanUiDialogOption | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const optionValue = strictText(ownField(record, "value"), 1, 200);
  const label = strictText(ownField(record, "label"), 1, 200);
  const descriptionValue = ownField(record, "description");
  if (!optionValue || !label) return undefined;
  if (descriptionValue !== undefined && !strictText(descriptionValue, 0, 300)) return undefined;
  return {
    value: optionValue,
    label,
    ...(typeof descriptionValue === "string" ? { description: descriptionValue } : {}),
  };
}

function validatePlanUiDialogPayload(value: unknown): PlanUiDialogPayload | undefined {
  const record = asRecord(value);
  if (!record || ownField(record, "v") !== PLAN_PAYLOAD_VERSION) return undefined;
  const kind = ownField(record, "kind");
  if (kind === "question") {
    const toolCallId = strictText(ownField(record, "toolCallId"), 1, 256);
    const prompt = strictText(ownField(record, "prompt"), 1, 2_000);
    const context = ownField(record, "context");
    const allowOther = ownField(record, "allowOther");
    const rawOptions = ownField(record, "options");
    if (
      !toolCallId
      || !prompt
      || typeof allowOther !== "boolean"
      || (context !== undefined && !strictText(context, 0, 2_000))
      || !Array.isArray(rawOptions)
      || rawOptions.length < 1
      || rawOptions.length > 8
    ) {
      return undefined;
    }
    const options = rawOptions.map(strictDialogOption);
    if (options.some((option) => !option)) return undefined;
    return {
      v: PLAN_PAYLOAD_VERSION,
      kind,
      toolCallId,
      prompt,
      ...(typeof context === "string" ? { context } : {}),
      options: options as PlanUiDialogOption[],
      allowOther,
    };
  }
  if (kind === "custom") {
    const toolCallId = strictText(ownField(record, "toolCallId"), 1, 256);
    const prompt = strictText(ownField(record, "prompt"), 1, 2_000);
    return toolCallId && prompt
      ? { v: PLAN_PAYLOAD_VERSION, kind, toolCallId, prompt }
      : undefined;
  }
  if (kind === "review") {
    const planId = strictText(ownField(record, "planId"), 1, 256);
    const title = strictText(ownField(record, "title"), 1, 512);
    return planId && title
      ? { v: PLAN_PAYLOAD_VERSION, kind, planId, title }
      : undefined;
  }
  return undefined;
}

/** Decode the explicit, versioned marker prepended by the trusted Plan extension. */
export function decodePlanUiRequestTitle(title: unknown): DecodedPlanUiDialog | undefined {
  if (typeof title !== "string" || !title.startsWith(PLAN_REQUEST_TITLE_PREFIX)) return undefined;
  const remainder = title.slice(PLAN_REQUEST_TITLE_PREFIX.length);
  const separator = remainder.indexOf("\n");
  if (separator <= 0) return undefined;
  const json = decodeBase64UrlUtf8(remainder.slice(0, separator));
  if (!json) return undefined;
  try {
    const payload = validatePlanUiDialogPayload(JSON.parse(json));
    if (!payload) return undefined;
    return { payload, humanTitle: remainder.slice(separator + 1).slice(0, PLAN_TEXT_MAX_CHARS) };
  } catch {
    return undefined;
  }
}

/** Test and fixture helper using the exact extension title format. */
export function encodePlanUiRequestTitle(
  payload: Omit<PlanUiDialogPayload, "v">,
  humanTitle: string,
): string | undefined {
  const json = JSON.stringify({ ...payload, v: PLAN_PAYLOAD_VERSION });
  if (json.length > PLAN_REQUEST_JSON_MAX_CHARS) return undefined;
  return `${PLAN_REQUEST_TITLE_PREFIX}${encodeBase64UrlUtf8(json)}\n${humanTitle.slice(0, PLAN_TEXT_MAX_CHARS)}`;
}

/** Recognizes only blocking dialogs with a valid trusted Plan marker. */
export function planUiRequestKind(request: ExtensionUiRequest | unknown): PlanUiRequestKind | undefined {
  const record = asRecord(request);
  if (!record || ownField(record, "type") !== "extension_ui_request") return undefined;
  if (!strictText(ownField(record, "id"), 1, PLAN_ID_MAX_CHARS)) return undefined;
  const method = oneOf(ownField(record, "method"), PLAN_BLOCKING_METHODS);
  const decoded = decodePlanUiRequestTitle(ownField(record, "title"));
  if (!method || !decoded) return undefined;
  if (decoded.payload.kind === "review") return method === "select" ? "review" : undefined;
  if (decoded.payload.kind === "question") return method === "select" ? "question" : undefined;
  return method === "input" ? "question" : undefined;
}

export function isInternalPlanUiRequest(request: ExtensionUiRequest | unknown): boolean {
  return planUiRequestKind(request) !== undefined;
}

/** The reserved protocol is trusted only inside the isolated native Plan runtime. */
export function isTrustedPlanUiRequest(request: ExtensionUiRequest | unknown, runtimeMode: unknown): boolean {
  return runtimeMode === "plan" && isInternalPlanUiRequest(request);
}

/** A reserved prefix is never allowed to fall back to third-party UI. */
export function isClaimedPlanUiRequest(request: unknown): boolean {
  const record = asRecord(request);
  return ownField(record ?? {}, "type") === "extension_ui_request"
    && typeof ownField(record ?? {}, "title") === "string"
    && (ownField(record ?? {}, "title") as string).startsWith(PLAN_REQUEST_TITLE_PREFIX);
}

/** Builds the bounded question view from a raw internal Plan request. */
export function planQuestionFromRequest(request: unknown): PlanQuestionView | undefined {
  if (planUiRequestKind(request) !== "question") return undefined;
  const record = asRecord(request);
  if (!record) return undefined;
  const requestId = strictText(ownField(record, "id"), 1, PLAN_ID_MAX_CHARS);
  const method = oneOf(ownField(record, "method"), ["select", "input"] as const);
  const decoded = decodePlanUiRequestTitle(ownField(record, "title"));
  if (!requestId || !method || !decoded || decoded.payload.kind === "review") return undefined;
  const title = clipText(decoded.humanTitle || decoded.payload.prompt, PLAN_TEXT_MAX_CHARS);
  const message = clipText(
    decoded.payload.kind === "question" && decoded.payload.context
      ? `${decoded.payload.prompt}

${decoded.payload.context}`
      : decoded.payload.prompt,
    PLAN_TEXT_MAX_CHARS,
  );
  if (!title || !message) return undefined;

  if (method === "select") {
    const rawOptions = ownField(record, "options");
    if (!Array.isArray(rawOptions) || rawOptions.length < 1 || rawOptions.length > PLAN_OPTIONS_MAX_COUNT) return undefined;
    const options: string[] = [];
    for (const item of rawOptions) {
      const option = typeof item === "string" ? item.trim() : "";
      if (!option || option.length > PLAN_OPTION_MAX_CHARS) return undefined;
      options.push(option);
    }
    return { requestId, method, title, message, options };
  }

  const prefill = ownField(record, "prefill");
  return {
    requestId,
    method,
    title,
    message,
    ...(typeof prefill === "string" && prefill.trim() ? { prefill: clipText(prefill, PLAN_TEXT_MAX_CHARS) } : {}),
  };
}

/** Bounded, JSON-safe projection of a plan document for `.prime/plans`. */
export function normalizePlanDocument(input: unknown): { name: string; markdown: string } | undefined {
  const record = asRecord(input);
  if (!record) return undefined;
  const rawMarkdown = ownString(record, "markdown");
  if (rawMarkdown === undefined) return undefined;
  if (rawMarkdown.length > PLAN_DOCUMENT_MAX_CHARS) return undefined;
  const markdown = sanitizeMultiline(rawMarkdown);
  if (!markdown.trim()) return undefined;
  return { name: slugifyPlanName(ownField(record, "name")), markdown };
}

/** Canonical project-relative path of a generated plan document. */
export function planDocumentPath(name: unknown): string {
  return `${PLAN_MODE_DIRECTORY}/${slugifyPlanName(name)}.md`;
}

/**
 * Bounds arbitrary tool-call input into a JSON-safe value for activity logs:
 * depth/item/key/string caps, finite numbers only, getter and prototype
 * hazards skipped, truncations explicitly marked. Never throws.
 */
export const TOOL_INPUT_BOUNDS = Object.freeze({
  maxDepth: PLAN_TOOL_INPUT_MAX_DEPTH,
  maxItems: PLAN_TOOL_INPUT_MAX_ITEMS,
  maxKeyChars: PLAN_TOOL_INPUT_MAX_KEY_CHARS,
  maxStringLength: PLAN_TOOL_INPUT_MAX_STRING_CHARS,
});

export function normalizeToolInput(value: unknown): unknown {
  return normalizeToolInputAt(value, 1);
}

function normalizeToolInputAt(value: unknown, depth: number): unknown {
  if (depth > PLAN_TOOL_INPUT_MAX_DEPTH) return "[max-depth]";
  if (typeof value === "string") {
    return value.length <= PLAN_TOOL_INPUT_MAX_STRING_CHARS
      ? value
      : `${value.slice(0, PLAN_TOOL_INPUT_MAX_STRING_CHARS - 1)}…`;
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    const items = value
      .slice(0, PLAN_TOOL_INPUT_MAX_ITEMS)
      .map((item) => normalizeToolInputAt(item, depth + 1));
    if (value.length > PLAN_TOOL_INPUT_MAX_ITEMS) items.push("[truncated]");
    return items;
  }
  const record = asRecord(value);
  if (!record) return null;
  const keys = Object.keys(record).filter((key) => {
    if (TOOL_INPUT_SKIPPED_KEYS.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor !== undefined && "value" in descriptor;
  });
  const result: Record<string, unknown> = {};
  for (const key of keys.slice(0, PLAN_TOOL_INPUT_MAX_ITEMS)) {
    const boundedKey = key.length <= PLAN_TOOL_INPUT_MAX_KEY_CHARS
      ? key
      : `${key.slice(0, PLAN_TOOL_INPUT_MAX_KEY_CHARS - 1)}…`;
    result[boundedKey] = normalizeToolInputAt(ownField(record, key), depth + 1);
  }
  if (keys.length > PLAN_TOOL_INPUT_MAX_ITEMS) result._truncated = true;
  return result;
}

/** Validates a question view; shared by request building and all decoders. */
function validateQuestionView(value: unknown): PlanQuestionView | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const requestId = strictText(ownField(record, "requestId"), 1, PLAN_ID_MAX_CHARS);
  const method = oneOf(ownField(record, "method"), ["select", "input"] as const);
  const title = strictText(ownField(record, "title"), 1, PLAN_TEXT_MAX_CHARS);
  const message = strictText(ownField(record, "message"), 1, PLAN_TEXT_MAX_CHARS);
  if (!requestId || !method || !title || !message) return undefined;

  let options: string[] | undefined;
  if (method === "select") {
    const rawOptions = ownField(record, "options");
    if (!Array.isArray(rawOptions) || rawOptions.length < 1 || rawOptions.length > PLAN_OPTIONS_MAX_COUNT) {
      return undefined;
    }
    options = [];
    for (const item of rawOptions) {
      if (typeof item !== "string" || item.length < 1 || item.length > PLAN_OPTION_MAX_CHARS) return undefined;
      options.push(item);
    }
  } else if (ownField(record, "options") !== undefined) {
    return undefined;
  }

  const rawPrefill = ownField(record, "prefill");
  const prefill = rawPrefill === undefined
    ? undefined
    : strictText(rawPrefill, 1, PLAN_TEXT_MAX_CHARS);
  if (rawPrefill !== undefined && prefill === undefined) return undefined;

  return {
    requestId,
    method,
    title,
    message,
    ...(options ? { options } : {}),
    ...(prefill !== undefined ? { prefill } : {}),
  };
}

function validateDocument(value: unknown): PlanDocument | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const name = strictText(ownField(record, "name"), 1, PLAN_DOCUMENT_NAME_MAX_CHARS);
  const markdown = strictText(ownField(record, "markdown"), 1, PLAN_DOCUMENT_MAX_CHARS);
  const round = ownField(record, "round");
  if (!name || !markdown || !isBoundedInteger(round, 1, PLAN_ROUNDS_MAX)) return undefined;
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(name)) return undefined;
  if (markdown !== sanitizeMultiline(markdown)) return undefined;
  return { name, markdown, round };
}

/** Encodes a question view into the versioned wire payload (bounding fields). */
export function encodePlanQuestionPayload(view: unknown): PlanQuestionPayload | undefined {
  const validated = validateQuestionView(view);
  if (!validated) return undefined;
  return {
    v: PLAN_PAYLOAD_VERSION,
    kind: "plan_question",
    requestId: validated.requestId,
    method: validated.method,
    title: validated.title,
    message: validated.message,
    ...(validated.options ? { options: [...validated.options] } : {}),
    ...(validated.prefill !== undefined ? { prefill: validated.prefill } : {}),
  };
}

/** Fails closed on any wrong version, kind, bound, or structure. */
export function decodePlanQuestionPayload(value: unknown): PlanQuestionView | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  if (ownField(record, "v") !== PLAN_PAYLOAD_VERSION || ownField(record, "kind") !== "plan_question") {
    return undefined;
  }
  return validateQuestionView(record);
}

/** Encodes a normalized plan document into the versioned review payload. */
export function encodePlanReviewPayload(document: unknown): PlanReviewPayload | undefined {
  const record = asRecord(document);
  if (!record) return undefined;
  const normalized = validateDocument({
    name: clipText(ownField(record, "name"), PLAN_DOCUMENT_NAME_MAX_CHARS),
    markdown: typeof ownField(record, "markdown") === "string"
      ? sanitizeMultiline(ownField(record, "markdown") as string)
      : "",
    round: ownField(record, "round"),
  });
  return normalized
    ? {
        v: PLAN_PAYLOAD_VERSION,
        kind: "plan_review",
        name: normalized.name,
        markdown: normalized.markdown,
        round: normalized.round,
      }
    : undefined;
}

export function decodePlanReviewPayload(value: unknown): PlanDocument | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  if (ownField(record, "v") !== PLAN_PAYLOAD_VERSION || ownField(record, "kind") !== "plan_review") {
    return undefined;
  }
  return validateDocument(record);
}

function snapshotDocument(state: PlanModeState): PlanDocument | undefined {
  return state.phase === "review" && state.document ? { ...state.document } : undefined;
}

/** Encodes a validated Plan state into the versioned persistence snapshot.
 * Returns `undefined` for anything that is not a coherent Plan state. */
export function encodePlanSnapshot(state: unknown): PlanSnapshotPayload | undefined {
  const resolved = resolvePlanState(state);
  if (!resolved) return undefined;
  const question = resolved.question ? encodePlanQuestionPayload(resolved.question) : undefined;
  if (resolved.question && !question) return undefined;
  const documentSource = snapshotDocument(resolved);
  const document = documentSource ? encodePlanReviewPayload(documentSource) : undefined;
  if (documentSource && !document) return undefined;
  return {
    v: PLAN_PAYLOAD_VERSION,
    kind: "plan_snapshot",
    phase: resolved.phase,
    revision: resolved.revision,
    ...(question ? { question } : {}),
    ...(document ? { document } : {}),
    ...(resolved.outcome ? { outcome: resolved.outcome } : {}),
    ...(resolved.round !== undefined ? { round: resolved.round } : {}),
  };
}

export function decodePlanSnapshot(value: unknown): PlanModeState | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  if (ownField(record, "v") !== PLAN_PAYLOAD_VERSION || ownField(record, "kind") !== "plan_snapshot") {
    return undefined;
  }
  const phase = oneOf(ownField(record, "phase"), PLAN_PHASES);
  const revisionRaw = ownField(record, "revision");
  if (!phase || !isBoundedInteger(revisionRaw, 0, PLAN_REVISION_MAX)) return undefined;

  const rawQuestion = ownField(record, "question");
  const question = rawQuestion === undefined ? undefined : decodePlanQuestionPayload(rawQuestion);
  if (rawQuestion !== undefined && !question) return undefined;
  const rawDocument = ownField(record, "document");
  const document = rawDocument === undefined ? undefined : decodePlanReviewPayload(rawDocument);
  if (rawDocument !== undefined && !document) return undefined;
  const rawOutcome = ownField(record, "outcome");
  const outcome = rawOutcome === undefined ? undefined : oneOf(rawOutcome, PLAN_OUTCOMES);
  if (rawOutcome !== undefined && !outcome) return undefined;
  const roundRaw = ownField(record, "round");
  if (roundRaw !== undefined && !isBoundedInteger(roundRaw, 1, PLAN_ROUNDS_MAX)) return undefined;

  const state: PlanModeState = {
    phase,
    revision: revisionRaw,
    ...(question ? { question } : {}),
    ...(document ? { document } : {}),
    ...(outcome ? { outcome } : {}),
    ...(roundRaw !== undefined ? { round: roundRaw } : {}),
  };
  return resolvePlanState(state);
}

/** Parses a persisted snapshot string with a hard serialized-size ceiling. */
export function decodePlanSnapshotText(text: unknown): PlanModeState | undefined {
  if (typeof text !== "string" || text.length > PLAN_SNAPSHOT_MAX_CHARS) return undefined;
  try {
    return decodePlanSnapshot(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

export function encodePlanSnapshotJson(state: unknown): string | undefined {
  const payload = encodePlanSnapshot(state);
  if (!payload) return undefined;
  try {
    const json = JSON.stringify(payload);
    return json !== undefined && json.length <= PLAN_SNAPSHOT_MAX_CHARS ? json : undefined;
  } catch {
    return undefined;
  }
}

/** Structural validator reused by every transition; coherence rules:
 * - `idle` carries no question/document, only a terminal outcome.
 * - `planning` is between interactions and carries nothing but `round`.
 * - `question` requires a question view; `review` requires a document. */
export function resolvePlanState(value: unknown): PlanModeState | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const phase = oneOf(ownField(record, "phase"), PLAN_PHASES);
  const revision = ownField(record, "revision");
  if (!phase || !isBoundedInteger(revision, 0, PLAN_REVISION_MAX)) return undefined;

  const question = ownField(record, "question");
  const document = ownField(record, "document");
  const outcomeRaw = ownField(record, "outcome");
  const roundRaw = ownField(record, "round");

  if (question !== undefined && !validateQuestionView(question)) return undefined;
  const validatedDocument = document === undefined ? undefined : validateDocument(document);
  if (document !== undefined && !validatedDocument) return undefined;
  if (outcomeRaw !== undefined && !oneOf(outcomeRaw, PLAN_OUTCOMES)) return undefined;
  if (roundRaw !== undefined && !isBoundedInteger(roundRaw, 1, PLAN_ROUNDS_MAX)) return undefined;

  if (phase === "idle") {
    if (question !== undefined || document !== undefined) return undefined;
  } else if (phase === "planning") {
    if (question !== undefined || document !== undefined) return undefined;
  } else if (phase === "question") {
    if (question === undefined || document !== undefined || outcomeRaw !== undefined) return undefined;
  } else if (phase === "review") {
    if (document === undefined || question !== undefined || outcomeRaw !== undefined) return undefined;
  }

  const base: PlanModeState = { phase, revision };
  const view = question === undefined ? undefined : validateQuestionView(question);
  return {
    ...base,
    ...(view ? { question: view } : {}),
    ...(validatedDocument ? { document: validatedDocument } : {}),
    ...(outcomeRaw !== undefined ? { outcome: outcomeRaw as PlanOutcome } : {}),
    ...(roundRaw !== undefined ? { round: roundRaw as number } : {}),
  };
}

export interface PlanTransitionGuard {
  /** Caller-observed revision; a mismatch rejects the transition as stale. */
  readonly expectedRevision?: unknown;
}

function accepted(state: PlanModeState, changed: boolean): PlanTransitionResult {
  return { status: "accepted", state, changed };
}

function rejected(reason: PlanTransitionRejection, state: PlanModeState): PlanTransitionResult {
  return { status: "rejected", state, reason };
}

function resolveOrIdle(state: unknown): { current: PlanModeState; valid: boolean } {
  const resolved = resolvePlanState(state);
  // Validation passed: echo the caller's own object so no-op transitions and
  // rejections preserve reference identity.
  return resolved ? { current: state as PlanModeState, valid: true } : { current: EMPTY_PLAN_MODE, valid: false };
}

function isStale(current: PlanModeState, guard: PlanTransitionGuard | undefined): boolean {
  const expected = guard?.expectedRevision;
  if (expected === undefined) return false;
  return !isBoundedInteger(expected, 0, PLAN_REVISION_MAX) || expected !== current.revision;
}

function nextRevision(current: PlanModeState): number | undefined {
  const candidate = current.revision + 1;
  return candidate <= PLAN_REVISION_MAX ? candidate : undefined;
}

/** Enters Plan mode for the current conversation. Restarting while a Plan
 * session is already running is an accepted no-op (idempotent). */
export function startPlanMode(
  state: PlanModeState,
  guard?: PlanTransitionGuard,
): PlanTransitionResult {
  const { current, valid } = resolveOrIdle(state);
  if (!valid) return rejected("invalid_state", current);
  if (isStale(current, guard)) return rejected("stale_revision", current);
  if (current.phase !== "idle") return accepted(current, false);
  const revision = nextRevision(current);
  if (revision === undefined) return rejected("revision_overflow", current);
  return accepted({ phase: "planning", revision }, true);
}

export interface PlanQuestionInput {
  /** Raw Prime Agent `extension_ui_request` event (validated, never trusted). */
  readonly request: unknown;
}

/** Opens a blocking internal Plan question. A second question while one is
 * pending is rejected; the pending one must be answered or cancelled first. */
export function openPlanQuestion(
  state: PlanModeState,
  input: PlanQuestionInput,
  guard?: PlanTransitionGuard,
): PlanTransitionResult {
  const { current, valid } = resolveOrIdle(state);
  if (!valid) return rejected("invalid_state", current);
  if (isStale(current, guard)) return rejected("stale_revision", current);
  if (current.phase === "question") return rejected("duplicate_question", current);
  if (current.phase !== "planning") return rejected("wrong_phase", current);
  const view = planQuestionFromRequest(input?.request);
  if (!view) {
    // Anything wearing the reserved title marker claims to be ours and must
    // satisfy the full contract; everything else is ordinary traffic.
    const requestRecord = asRecord((input ?? { }).request);
    const marked = typeof requestRecord?.title === "string"
      && requestRecord.title.startsWith(PLAN_REQUEST_TITLE_PREFIX);
    const isExtensionRequest = ownField(requestRecord ?? { }, "type") === "extension_ui_request";
    return rejected(marked && isExtensionRequest ? "invalid_input" : "not_plan_request", current);
  }
  const revision = nextRevision(current);
  if (revision === undefined) return rejected("revision_overflow", current);
  return accepted({ phase: "question", revision, question: view }, true);
}

export interface PlanQuestionAnswerInput {
  /** Echo of the pending question id; a mismatch marks a stale response. */
  readonly requestId?: unknown;
  readonly cancelled?: unknown;
  /** Selected option (exact match) or custom response for `input`. */
  readonly value?: unknown;
}

/** Answers the pending question and returns to `planning`. Replayed or stale
 * responses are rejected instead of being forwarded twice. */
export function answerPlanQuestion(
  state: PlanModeState,
  input: PlanQuestionAnswerInput,
  guard?: PlanTransitionGuard,
): PlanTransitionResult {
  const { current, valid } = resolveOrIdle(state);
  if (!valid) return rejected("invalid_state", current);
  if (isStale(current, guard)) return rejected("stale_revision", current);
  if (current.phase !== "question" || !current.question) return rejected("wrong_phase", current);

  const args = (input ?? { }) as PlanQuestionAnswerInput;
  const requestId = args.requestId;
  if (requestId !== undefined && requestId !== current.question.requestId) {
    return rejected("stale_request", current);
  }

  const cancelled = args.cancelled === true;
  if (!cancelled) {
    const value = args.value;
    if (typeof value !== "string" || value.length < 1) return rejected("invalid_input", current);
    if (value.length > PLAN_TEXT_MAX_CHARS) return rejected("oversize", current);
    if (current.question.method === "select" && !current.question.options?.includes(value)) {
      return rejected("invalid_input", current);
    }
  }

  const revision = nextRevision(current);
  if (revision === undefined) return rejected("revision_overflow", current);
  return accepted({
    phase: "planning",
    revision,
    ...(current.round !== undefined ? { round: current.round } : {}),
  }, true);
}

export interface PlanReviewInput {
  /** Candidate document `{ name?, markdown }`; normalized and bounded. */
  readonly document: unknown;
}

/** Presents a generated plan for review. Repeated reviews (after `revise`)
 * increment `round`; beyond `PLAN_ROUNDS_MAX` the transition fails closed. */
export function openPlanReview(
  state: PlanModeState,
  input: PlanReviewInput,
  guard?: PlanTransitionGuard,
): PlanTransitionResult {
  const { current, valid } = resolveOrIdle(state);
  if (!valid) return rejected("invalid_state", current);
  if (isStale(current, guard)) return rejected("stale_revision", current);
  if (current.phase !== "planning") return rejected("wrong_phase", current);

  const documentRecord = asRecord((input ?? { }).document);
  if (!documentRecord) return rejected("invalid_input", current);
  const rawMarkdown = ownString(documentRecord, "markdown");
  if (rawMarkdown === undefined) return rejected("invalid_input", current);
  if (rawMarkdown.length > PLAN_DOCUMENT_MAX_CHARS) return rejected("oversize", current);
  const normalized = normalizePlanDocument(input?.document);
  if (!normalized) return rejected("invalid_input", current);

  const round = (current.round ?? 0) + 1;
  if (round > PLAN_ROUNDS_MAX) return rejected("round_limit", current);
  const revision = nextRevision(current);
  if (revision === undefined) return rejected("revision_overflow", current);
  return accepted({ phase: "review", revision, round, document: { ...normalized, round } }, true);
}

export interface PlanDecisionInput {
  /** `apply` exits to implementation in the SAME conversation; `keep` exits
   * without implementation; `revise` regenerates the document. */
  readonly decision: unknown;
}

/** Applies the final review decision. `apply` and `keep` terminate Plan mode
 * (phase `idle` with a durable outcome); a second decision is rejected. */
export function decidePlanReview(
  state: PlanModeState,
  input: PlanDecisionInput,
  guard?: PlanTransitionGuard,
): PlanTransitionResult {
  const { current, valid } = resolveOrIdle(state);
  if (!valid) return rejected("invalid_state", current);
  if (isStale(current, guard)) return rejected("stale_revision", current);
  if (current.phase !== "review" || !current.document) return rejected("wrong_phase", current);
  const decision = oneOf(ownField(asRecord(input) ?? { }, "decision"), PLAN_DECISIONS);
  if (!decision) return rejected("invalid_input", current);

  const revision = nextRevision(current);
  if (revision === undefined) return rejected("revision_overflow", current);
  if (decision === "revise") {
    return accepted({
      phase: "planning",
      revision,
      ...(current.round !== undefined ? { round: current.round } : {}),
    }, true);
  }
  const outcome: PlanOutcome = decision === "apply" ? "applied" : "kept";
  return accepted({
    phase: "idle",
    revision,
    outcome,
    ...(current.round !== undefined ? { round: current.round } : {}),
  }, true);
}

/** Cancels Plan mode from any active phase. Cancelling an idle conversation
 * is an accepted no-op (idempotent). */
export function cancelPlanMode(
  state: PlanModeState,
  guard?: PlanTransitionGuard,
): PlanTransitionResult {
  const { current, valid } = resolveOrIdle(state);
  if (!valid) return rejected("invalid_state", current);
  if (isStale(current, guard)) return rejected("stale_revision", current);
  if (current.phase === "idle") return accepted(current, false);
  const revision = nextRevision(current);
  if (revision === undefined) return rejected("revision_overflow", current);
  return accepted({
    phase: "idle",
    revision,
    outcome: "cancelled",
    ...(current.round !== undefined ? { round: current.round } : {}),
  }, true);
}

/** Restores Plan metadata after an app reload. Invalid snapshots leave the
 * current state untouched (fail closed to the fresh state the caller passed),
 * older revisions are stale, and an identical snapshot is a no-op. */
export function reloadPlanMode(state: PlanModeState, snapshot: unknown): PlanTransitionResult {
  const { current, valid } = resolveOrIdle(state);
  if (!valid) return rejected("invalid_state", current);
  const restored = typeof snapshot === "string"
    ? decodePlanSnapshotText(snapshot)
    : decodePlanSnapshot(snapshot);
  if (!restored) return rejected("invalid_input", current);
  if (restored.revision < current.revision) return rejected("stale_revision", current);
  if (restored.revision === current.revision) {
    return deepEqual(restored, current) ? accepted(current, false) : rejected("stale_revision", current);
  }
  return accepted(restored, true);
}

const PLAN_NOTIFICATION_TITLES: Readonly<Record<AppLanguage, string>> = Object.freeze({
  en: "Prime Orbit · Plan",
  fr: "Prime Orbit · Plan",
});

const PLAN_NOTIFICATION_BODIES: Readonly<Record<PlanNotificationEvent, Record<AppLanguage, string>>> = Object.freeze({
  question: Object.freeze({
    en: "A Plan question needs your answer.",
    fr: "Une question de plan attend votre réponse.",
  }),
  review: Object.freeze({
    en: "The plan is ready for your decision.",
    fr: "Le plan est prêt pour votre décision.",
  }),
});

/** Windows must signal a pending Plan question or final decision with the
 * system notification sound whenever no Prime Orbit window is focused. An
 * unknown focus state stays silent because it cannot prove that every window is
 * unfocused; unknown events never notify. */
export function planNotificationChoice(input: {
  readonly event: unknown;
  readonly focused: unknown;
  readonly language?: unknown;
}): PlanNotification {
  const record = asRecord(input);
  const event = oneOf(record?.event, PLAN_KIND_WORDS);
  const language: AppLanguage = record?.language === "fr" ? "fr" : "en";
  const show = event !== undefined && record?.focused === false;
  return {
    show,
    title: show ? PLAN_NOTIFICATION_TITLES[language] : "",
    body: show && event ? PLAN_NOTIFICATION_BODIES[event][language] : "",
    sound: show,
  };
}
