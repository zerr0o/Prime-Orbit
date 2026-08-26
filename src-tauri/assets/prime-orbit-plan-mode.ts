/**
 * Prime Orbit internal extension - Plan mode.
 *
 * Loaded by Prime Orbit as the ONLY extension of an isolated plan-mode runtime.
 * Turns a Prime Agent session into a strictly read-only planning surface:
 *
 * - Exactly three tools: prime_orbit_plan_inspect, prime_orbit_plan_question,
 *   prime_orbit_plan_submit. Everything else is denied by default in the
 *   tool_call handler, even if something re-enables it via setActiveTools().
 * - inspect: read-only list/read/search under ctx.cwd using node:fs promises.
 *   No shell, no subprocess, no writes. realpath containment + symlink-safe
 *   traversal + hard size/count/time bounds.
 * - question: blocks on ctx.ui.select with rich options and an optional
 *   free-text answer, and emits a small versioned machine-readable payload
 *   (`prime-orbit-plan:v1`) for Orbit to parse from the transcript.
 * - submit: takes the bounded Markdown plan document, asks the user
 *   apply/keep/revise via ctx.ui.select, and returns the decision payload.
 * - before_agent_start injects the plan doctrine every turn.
 *
 * This module is a standard public Prime Agent TypeScript extension
 * (default-exported factory receiving ExtensionAPI). It only imports what the
 * Prime Agent extension loader provides (typebox, @earendil-works/pi-ai,
 * node builtins) and never depends on the Prime Orbit repository at runtime.
 * Pure helpers are exported for unit testing without Prime Agent.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { Type } from "typebox";
import type { BigIntStats, Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Public constants and pure payload helpers (unit-testable without Prime Agent)
// ---------------------------------------------------------------------------

/** The three tools this extension registers; nothing else may execute. */
export const PLAN_TOOL_NAMES: readonly ["prime_orbit_plan_inspect", "prime_orbit_plan_question", "prime_orbit_plan_submit"] = [
	"prime_orbit_plan_inspect",
	"prime_orbit_plan_question",
	"prime_orbit_plan_submit",
] as const;

/** Version tag embedded in every machine-readable payload emitted for Orbit. */
export const PLAN_PAYLOAD_VERSION = 1 as const;

/** Prefix of the HTML-comment marker carrying encoded payloads. */
export const PLAN_PAYLOAD_MARKER_PREFIX = "prime-orbit-plan:v1:";
export const PLAN_INLINE_REVISION_PROTOCOL = "inline-feedback-v1";
export const PLAN_REVIEW_RESPONSE_PREFIX = "prime-orbit-plan-review-response:v1:";
export const PLAN_REVIEW_RESPONSE_TOKEN_MAX_CHARS = 32_768;

/** Machine-readable events emitted into tool results for Orbit to parse. */
export type PlanQuestionPayload = {
	kind: "question";
	v: typeof PLAN_PAYLOAD_VERSION;
	cancelled: boolean;
	custom: boolean;
	value: string;
	label: string;
	prompt: string;
	questionId?: string;
};

export type PlanDecisionPayload = {
	kind: "decision";
	v: typeof PLAN_PAYLOAD_VERSION;
	decision: "apply" | "keep" | "revise" | "cancelled" | "unknown";
	title: string;
	documentChars: number;
	documentLines: number;
	feedback?: string;
};

export type PlanPayload = PlanQuestionPayload | PlanDecisionPayload;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Encode a payload as `<!-- prime-orbit-plan:v1:<base64url(json)> -->`. */
export function encodePlanPayload(payload: PlanPayload): string {
	const json = JSON.stringify({ ...payload, v: PLAN_PAYLOAD_VERSION });
	const body = Buffer.from(json, "utf8").toString("base64url");
	return `<!-- ${PLAN_PAYLOAD_MARKER_PREFIX}${body} -->`;
}

function decodePlanPayloadToken(token: string): PlanPayload | null {
	try {
		const parsed: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
		if (!isRecord(parsed)) return null;
		if (parsed.v !== PLAN_PAYLOAD_VERSION) return null;
		if (parsed.kind === "question") {
			if (
				typeof parsed.cancelled !== "boolean"
				|| typeof parsed.custom !== "boolean"
				|| typeof parsed.value !== "string"
				|| typeof parsed.label !== "string"
				|| typeof parsed.prompt !== "string"
			) {
				return null;
			}
			return parsed as unknown as PlanQuestionPayload;
		}
		if (parsed.kind === "decision") {
			const decisions: readonly string[] = ["apply", "keep", "revise", "cancelled", "unknown"];
			if (
				typeof parsed.decision !== "string"
				|| !decisions.includes(parsed.decision)
				|| typeof parsed.title !== "string"
				|| typeof parsed.documentChars !== "number"
				|| typeof parsed.documentLines !== "number"
				|| (parsed.feedback !== undefined && typeof parsed.feedback !== "string")
			) {
				return null;
			}
			return parsed as unknown as PlanDecisionPayload;
		}
		return null;
	} catch {
		return null;
	}
}

/** Decode every well-formed plan payload found in free transcript text. */
export function extractPlanPayloads(text: string): PlanPayload[] {
	const out: PlanPayload[] = [];
	const pattern = new RegExp(`<!--\\s*${PLAN_PAYLOAD_MARKER_PREFIX}([A-Za-z0-9_-]+)\\s*-->`, "g");
	for (const match of text.matchAll(pattern)) {
		const decoded = decodePlanPayloadToken(match[1]);
		if (decoded) out.push(decoded);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Orbit UI-dialog contract: every ctx.ui dialog title starts with an encoded,
// bounded marker so Orbit can route Plan dialogs without heuristics.
//
// Title layout:  prime-orbit-plan-ui:v1:<base64url(json)>\n<human readable title>
// ---------------------------------------------------------------------------

/** Marker prefix that must open every Plan-mode dialog title. */
export const PLAN_UI_TITLE_PREFIX = "prime-orbit-plan-ui:v1:";

/** Hard bounds keeping the encoded marker small enough for dialog titles. */
export const PLAN_UI_LIMITS = {
	jsonChars: 12_000,
	tokenChars: 65_536,
	promptChars: 2_000,
	contextChars: 2_000,
	optionLabelChars: 200,
	optionValueChars: 200,
	optionDescriptionChars: 300,
	reviewTitleChars: 512,
	idChars: 256,
	maxOptions: 8,
} as const;

/** Data carried by the question selector title. */
export interface PlanUiQuestionData {
	kind: "question";
	toolCallId: string;
	prompt: string;
	context?: string;
	options: readonly PlanQuestionOption[];
	allowOther: boolean;
}

/** Data carried by the free-text ("Other answer") input title. */
export interface PlanUiCustomData {
	kind: "custom";
	toolCallId: string;
	prompt: string;
}

/** Data carried by the submit review selector title. */
export interface PlanUiReviewData {
	kind: "review";
	planId: string;
	title: string;
	revisionResponse?: typeof PLAN_INLINE_REVISION_PROTOCOL;
}

export type PlanUiData = PlanUiQuestionData | PlanUiCustomData | PlanUiReviewData;
export type PlanUiPayload = PlanUiData & { v: typeof PLAN_PAYLOAD_VERSION };

function clipText(text: string, maxChars: number): string {
	return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/** Encode a dialog title: bounded base64url JSON marker, newline, human title. */
export function encodePlanUiTitle(data: PlanUiData, humanTitle: string): string {
	let wire: PlanUiData;
	if (data.kind === "question") {
		wire = {
			kind: "question",
			toolCallId: clipText(data.toolCallId, PLAN_UI_LIMITS.idChars),
			prompt: clipText(data.prompt, PLAN_UI_LIMITS.promptChars),
			...(data.context !== undefined ? { context: clipText(data.context, PLAN_UI_LIMITS.contextChars) } : {}),
			allowOther: data.allowOther === true,
			options: data.options.slice(0, PLAN_UI_LIMITS.maxOptions).map((option) => ({
				value: clipText(option.value, PLAN_UI_LIMITS.optionValueChars),
				label: clipText(option.label, PLAN_UI_LIMITS.optionLabelChars),
				...(option.description !== undefined
					? { description: clipText(option.description, PLAN_UI_LIMITS.optionDescriptionChars) }
					: {}),
			})),
		};
	} else if (data.kind === "custom") {
		wire = {
			kind: "custom",
			toolCallId: clipText(data.toolCallId, PLAN_UI_LIMITS.idChars),
			prompt: clipText(data.prompt, PLAN_UI_LIMITS.promptChars),
		};
	} else {
		wire = {
			kind: "review",
			planId: clipText(data.planId, PLAN_UI_LIMITS.idChars),
			title: clipText(data.title, PLAN_UI_LIMITS.reviewTitleChars),
			...(data.revisionResponse === PLAN_INLINE_REVISION_PROTOCOL
				? { revisionResponse: PLAN_INLINE_REVISION_PROTOCOL }
				: {}),
		};
	}
	const json = JSON.stringify({ ...wire, v: PLAN_PAYLOAD_VERSION });
	if (json.length > PLAN_UI_LIMITS.jsonChars) {
		throw new Error("prime-orbit-plan UI payload exceeds its hard size bound");
	}
	const body = Buffer.from(json, "utf8").toString("base64url");
	if (body.length > PLAN_UI_LIMITS.tokenChars) {
		throw new Error("prime-orbit-plan UI token exceeds its hard size bound");
	}
	return `${PLAN_UI_TITLE_PREFIX}${body}\n${humanTitle}`;
}

function validatePlanUiParsed(parsed: Record<string, unknown>): PlanUiPayload | null {
	if (parsed.v !== PLAN_PAYLOAD_VERSION) return null;
	const idOk =
		typeof parsed.toolCallId === "string"
		&& parsed.toolCallId.length > 0
		&& parsed.toolCallId.length <= PLAN_UI_LIMITS.idChars;
	if (parsed.kind === "question") {
		if (!idOk) return null;
		if (typeof parsed.prompt !== "string" || parsed.prompt.length > PLAN_UI_LIMITS.promptChars) return null;
		if (parsed.context !== undefined) {
			if (typeof parsed.context !== "string" || parsed.context.length > PLAN_UI_LIMITS.contextChars) return null;
		}
		if (typeof parsed.allowOther !== "boolean") return null;
		if (!Array.isArray(parsed.options) || parsed.options.length === 0 || parsed.options.length > PLAN_UI_LIMITS.maxOptions) {
			return null;
		}
		for (const option of parsed.options) {
			if (!isRecord(option)) return null;
			if (
				typeof option.value !== "string"
				|| option.value.length === 0
				|| option.value.length > PLAN_UI_LIMITS.optionValueChars
				|| typeof option.label !== "string"
				|| option.label.length === 0
				|| option.label.length > PLAN_UI_LIMITS.optionLabelChars
			) {
				return null;
			}
			if (option.description !== undefined) {
				if (typeof option.description !== "string" || option.description.length > PLAN_UI_LIMITS.optionDescriptionChars) {
					return null;
				}
			}
		}
		return parsed as unknown as PlanUiPayload;
	}
	if (parsed.kind === "custom") {
		if (!idOk) return null;
		if (typeof parsed.prompt !== "string" || parsed.prompt.length > PLAN_UI_LIMITS.promptChars) return null;
		return parsed as unknown as PlanUiPayload;
	}
	if (parsed.kind === "review") {
		if (
			typeof parsed.planId !== "string"
			|| parsed.planId.length === 0
			|| parsed.planId.length > PLAN_UI_LIMITS.idChars
			|| typeof parsed.title !== "string"
			|| parsed.title.length === 0
			|| parsed.title.length > PLAN_UI_LIMITS.reviewTitleChars
			|| (parsed.revisionResponse !== undefined && parsed.revisionResponse !== PLAN_INLINE_REVISION_PROTOCOL)
		) {
			return null;
		}
		return parsed as unknown as PlanUiPayload;
	}
	return null;
}

/**
 * Decode a dialog title produced by encodePlanUiTitle.
 * Returns null for anything malformed, oversized, or foreign - never throws.
 */
export function decodePlanUiTitle(
	title: string | undefined | null,
): { payload: PlanUiPayload; humanTitle: string } | null {
	if (typeof title !== "string" || !title.startsWith(PLAN_UI_TITLE_PREFIX)) return null;
	const rest = title.slice(PLAN_UI_TITLE_PREFIX.length);
	const separator = rest.indexOf("\n");
	if (separator <= 0) return null;
	const token = rest.slice(0, separator);
	const humanTitle = rest.slice(separator + 1);
	if (token.length > PLAN_UI_LIMITS.tokenChars) return null;
	try {
		const parsed: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
		if (!isRecord(parsed)) return null;
		const payload = validatePlanUiParsed(parsed);
		if (!payload) return null;
		return { payload, humanTitle };
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Question dialog composition (pure)
// ---------------------------------------------------------------------------

export interface PlanQuestionOption {
	value: string;
	label: string;
	description?: string;
}

/** Label shown for the free-text answer when allowOther is enabled. */
export const OTHER_ANSWER_LABEL = "Other... (type your own answer)";

/**
 * Fill in whichever of `value`/`label` the caller omitted. Models routinely
 * send only one of the pair; rejecting that wasted a tool call and showed the
 * user a failed step for a question that was otherwise perfectly well formed.
 * An option carrying neither is still refused, with a message naming the
 * offending index instead of a raw schema path.
 */
export function normalizePlanQuestionOptions(
	options: readonly Partial<PlanQuestionOption>[],
): PlanQuestionOption[] {
	return options.map((option, index) => {
		const label = option.label?.trim() || option.value?.trim();
		const value = option.value?.trim() || option.label?.trim();
		if (!label || !value) {
			throw new Error(`options[${index}] needs at least one of "label" or "value"`);
		}
		return {
			value,
			label,
			...(option.description ? { description: option.description } : {}),
		};
	});
}

/** Build the exact option strings passed to ctx.ui.select, de-duplicated. */
export function composeOptionLabels(options: readonly PlanQuestionOption[]): string[] {
	const seen = new Set<string>();
	const labels: string[] = [];
	for (const option of options) {
		let label = option.description ? `${option.label} - ${option.description}` : option.label;
		let n = 2;
		while (seen.has(label)) {
			label = `${option.label} (${n++})`;
		}
		seen.add(label);
		labels.push(label);
	}
	return labels;
}

export type QuestionSelection =
	| { type: "option"; index: number; value: string; label: string; displayLabel: string }
	| { type: "other"; raw: string }
	| { type: "cancelled" };

/** Map the string returned by ctx.ui.select back to a structured selection. */
export function resolveSelection(options: readonly PlanQuestionOption[], selected: string | undefined): QuestionSelection {
	if (selected === undefined) return { type: "cancelled" };
	const index = composeOptionLabels(options).indexOf(selected);
	if (index >= 0 && index < options.length) {
		return {
			type: "option",
			index,
			value: options[index].value,
			label: options[index].label,
			displayLabel: selected,
		};
	}
	if (selected === OTHER_ANSWER_LABEL) return { type: "other", raw: "" };
	return { type: "other", raw: selected };
}

// ---------------------------------------------------------------------------
// Submit decision composition (pure)
// ---------------------------------------------------------------------------

export type PlanDecision = "apply" | "keep" | "revise";

interface DecisionChoice {
	decision: PlanDecision;
	label: string;
}

/** Exact strings shown in the submit confirmation dialog. */
export const DECISION_CHOICES: readonly DecisionChoice[] = [
	{ decision: "apply", label: "Apply plan - exit plan mode and start implementation" },
	{ decision: "keep", label: "Keep plan - save it without implementing" },
	{ decision: "revise", label: "Revise plan - go back and improve the document" },
];

export function composeDecisionLabels(): string[] {
	return DECISION_CHOICES.map((choice) => choice.label);
}

/** Normalize whatever ctx.ui.select returned into a stable decision value. */
export function normalizeDecision(selected: string | undefined): PlanDecisionPayload["decision"] {
	if (selected === undefined) return "cancelled";
	const choice = DECISION_CHOICES.find((candidate) => candidate.label === selected);
	return choice ? choice.decision : "unknown";
}

export interface PlanInlineRevisionResponse {
	v: typeof PLAN_PAYLOAD_VERSION;
	kind: "review-decision";
	planId: string;
	decision: "revise";
	feedback: string;
}

/** Decodes only Prime Orbit's capability-negotiated single-request Revise
 * response. The durable Plan tool call id is part of the signed-by-context
 * envelope and must match the exact submit currently executing. */
export function decodePlanInlineRevisionResponse(
	selected: string | undefined,
	expectedPlanId: string,
): PlanInlineRevisionResponse | undefined {
	if (typeof selected !== "string" || !selected.startsWith(PLAN_REVIEW_RESPONSE_PREFIX)) return undefined;
	const token = selected.slice(PLAN_REVIEW_RESPONSE_PREFIX.length);
	if (
		token.length < 1
		|| token.length > PLAN_REVIEW_RESPONSE_TOKEN_MAX_CHARS
		|| !/^[A-Za-z0-9_-]+$/.test(token)
	) return undefined;
	try {
		const bytes = Buffer.from(token, "base64url");
		if (bytes.length > 24_576) return undefined;
		const parsed: unknown = JSON.parse(bytes.toString("utf8"));
		if (
			!isRecord(parsed)
			|| Object.keys(parsed).length !== 5
			|| parsed.v !== PLAN_PAYLOAD_VERSION
			|| parsed.kind !== "review-decision"
			|| parsed.decision !== "revise"
			|| parsed.planId !== expectedPlanId
			|| typeof parsed.feedback !== "string"
		) return undefined;
		const feedback = parsed.feedback.trim();
		if (feedback.length < 1 || feedback.length > MAX_PLAN_CUSTOM_ANSWER_CHARS) return undefined;
		return {
			v: PLAN_PAYLOAD_VERSION,
			kind: "review-decision",
			planId: expectedPlanId,
			decision: "revise",
			feedback,
		};
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Document bounds (pure)
// ---------------------------------------------------------------------------

/** Hard cap for submitted plan documents (characters). */
export const MAX_PLAN_DOCUMENT_CHARS = 65_536;
export const MAX_PLAN_CUSTOM_ANSWER_CHARS = 4_096;

export type DocumentCheck = { ok: true } | { ok: false; reason: string };

export function validatePlanDocument(document: string): DocumentCheck {
	if (typeof document !== "string") return { ok: false, reason: "document must be a string" };
	if (document.trim().length === 0) return { ok: false, reason: "document must not be empty" };
	if (document.length > MAX_PLAN_DOCUMENT_CHARS) {
		return {
			ok: false,
			reason: `document is ${document.length} chars; limit is ${MAX_PLAN_DOCUMENT_CHARS}. Summarize or split the plan.`,
		};
	}
	return { ok: true };
}

// ---------------------------------------------------------------------------
// Path containment (pure part)
// ---------------------------------------------------------------------------

/** True when candidateAbs equals rootAbs or lies underneath it lexically. */
export function isPathInsideRoot(rootAbs: string, candidateAbs: string): boolean {
	const rel = path.relative(rootAbs, candidateAbs);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Strip a leading @ and normalize separators for project-relative inputs. */
export function sanitizeRelativeInput(raw: string): string {
	let cleaned = String(raw ?? "").trim();
	while (cleaned.startsWith("@")) cleaned = cleaned.slice(1);
	cleaned = cleaned.replace(/\\/g, "/").trim();
	if (cleaned.length === 0 || cleaned === "." || cleaned === "./") return ".";
	if (cleaned.includes("\0")) throw new Error("path contains a NUL byte");
	if (/^[A-Za-z]:/.test(cleaned)) throw new Error(`absolute paths are denied in plan mode: ${raw}`);
	if (cleaned.startsWith("//") || cleaned.startsWith("\\\\")) throw new Error(`UNC paths are denied in plan mode: ${raw}`);
	return cleaned;
}

// ---------------------------------------------------------------------------
// Inspect bounds
// ---------------------------------------------------------------------------

export const INSPECT_LIMITS = {
	maxListEntries: 500,
	defaultReadBytes: 256 * 1024,
	maxReadBytes: 1024 * 1024,
	defaultReadLines: 400,
	maxReadLines: 2000,
	maxLineChars: 400,
	searchMaxFiles: 2000,
	searchMaxDepth: 16,
	searchMaxMatches: 200,
	searchMaxBytesPerFile: 512 * 1024,
	searchTimeBudgetMs: 10_000,
} as const;

const SEARCH_SKIP_DIRS = new Set([
	".git",
	".hg",
	".svn",
	".prime",
	".prime-orbit",
	"node_modules",
	"dist",
	"build",
	"out",
	"coverage",
	".next",
	".venv",
	"venv",
	"__pycache__",
	"target",
]);

const BINARY_SUFFIXES = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".ico",
	".bmp",
	".pdf",
	".zip",
	".gz",
	".tgz",
	".bz2",
	".7z",
	".rar",
	".exe",
	".dll",
	".so",
	".dylib",
	".bin",
	".wasm",
	".woff",
	".woff2",
	".ttf",
	".otf",
	".eot",
	".mp3",
	".mp4",
	".avi",
	".mov",
	".sqlite",
	".db",
	".pdb",
	".jar",
	".class",
	".pyc",
	".lockb",
]);

/** Tiny wildcard matcher for basenames ("*.ts", "agent-*.json"). */
export function matchesWildcard(name: string, pattern: string): boolean {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`, "i").test(name);
}

export function buildPlanDoctrine(): string {
	return [
		"[PRIME ORBIT - PLAN MODE ACTIVE]",
		"",
		"You are a read-only planning agent inside the Prime Orbit desktop app.",
		"The user wants a reviewable implementation plan, not changes.",
		"",
		"Hard rules:",
		"- You can ONLY call: prime_orbit_plan_inspect, prime_orbit_plan_question, prime_orbit_plan_submit.",
		"- Every other tool (bash, edit, ipython, MCP, skills, ...) is denied at runtime. Never try workarounds.",
		"- You cannot and must not modify files, install anything, or run commands. Inspect the project read-only.",
		"- Ask the user whenever requirements are ambiguous instead of guessing silently.",
		"",
		"Workflow:",
		"1. Explore with prime_orbit_plan_inspect (list/read/search). Stay inside the project directory.",
		"2. Ask focused multiple-choice questions with prime_orbit_plan_question when decisions are needed.",
		"3. When the plan is complete, present it with prime_orbit_plan_submit. The user chooses:",
		"   - apply: Orbit exits plan mode and implementation starts from your document;",
		"   - keep: the document is saved and planning ends;",
		"   - revise: improve the document and submit again.",
		"",
		"Plan document format (Markdown):",
		"# <Title>",
		"## Summary - two or three sentences describing the outcome.",
		"## Context - relevant current behavior and constraints found in the code.",
		"## Proposed Changes - concrete changes grouped per file or component.",
		"## Implementation Steps - ordered, verifiable steps.",
		"## Risks and Open Questions - anything uncertain.",
		"## Verification - how to confirm the change works.",
		"",
		"Keep documents concise and grounded in what you actually inspected.",
	].join("\n");
}

// ---------------------------------------------------------------------------
// TypeBox schemas
// ---------------------------------------------------------------------------

// `value` and `label` are each optional and default to the other. Requiring
// both made a routine omission fail the whole call, costing the user a visible
// tool error and the agent a full retry round-trip for a question it had
// already composed correctly enough to ask.
const OptionSchema = Type.Object({
	value: Type.Optional(Type.String({
		description: "Stable value reported back to you in the payload (defaults to label)",
		minLength: 1,
		maxLength: PLAN_UI_LIMITS.optionValueChars,
	})),
	label: Type.Optional(Type.String({
		description: "Short button text shown to the user (defaults to value)",
		minLength: 1,
		maxLength: PLAN_UI_LIMITS.optionLabelChars,
	})),
	description: Type.Optional(Type.String({
		description: "Optional one-line explanation shown under the label",
		minLength: 1,
		maxLength: PLAN_UI_LIMITS.optionDescriptionChars,
	})),
});

const InspectParams = Type.Object({
	action: StringEnum(["list", "read", "search"], {
		description: "list = directory entries, read = text file content, search = grep-like scan",
	}),
	path: Type.Optional(
		Type.String({
			description:
				"Project-relative target path ('.' or omitted = project root). Absolute paths, drives and '..' escapes are denied.",
			maxLength: 1_024,
		}),
	),
	query: Type.Optional(Type.String({
		description: "search: literal text to find (case-insensitive)",
		minLength: 1,
		maxLength: 200,
	})),
	glob: Type.Optional(Type.String({
		description: "search: optional filename wildcard filter, e.g. '*.ts'",
		maxLength: 120,
	})),
	offset: Type.Optional(Type.Integer({
		description: "read: 1-based first line to return (default 1)",
		minimum: 1,
		maximum: 1_000_000,
	})),
	limit: Type.Optional(Type.Integer({
		description: `read: maximum number of lines (default ${INSPECT_LIMITS.defaultReadLines})`,
		minimum: 1,
		maximum: INSPECT_LIMITS.maxReadLines,
	})),
});

const QuestionParams = Type.Object({
	prompt: Type.String({
		description: "The question text shown to the user",
		minLength: 1,
		maxLength: PLAN_UI_LIMITS.promptChars,
	}),
	options: Type.Array(OptionSchema, {
		description: "1 to 8 structured choices; prefer 2-6",
		minItems: 1,
		maxItems: PLAN_UI_LIMITS.maxOptions,
	}),
	context: Type.Optional(Type.String({
		description: "Short background information shown above the question",
		minLength: 1,
		maxLength: PLAN_UI_LIMITS.contextChars,
	})),
	allowOther: Type.Optional(Type.Boolean({ description: "Offer a free-text 'Other...' answer (default true)" })),
});

const SubmitParams = Type.Object({
	document: Type.String({
		description: `The complete plan document in Markdown (at most ${MAX_PLAN_DOCUMENT_CHARS} characters)`,
		minLength: 1,
		maxLength: MAX_PLAN_DOCUMENT_CHARS,
	}),
	title: Type.Optional(Type.String({
		description: "Short plan title used in dialogs and payloads",
		maxLength: PLAN_UI_LIMITS.reviewTitleChars,
	})),
});

/** Inferred tool argument shapes, exported for tests and Orbit-side typing. */
export type InspectArgs = Static<typeof InspectParams>;
export type QuestionArgs = Static<typeof QuestionParams>;
export type SubmitArgs = Static<typeof SubmitParams>;

// ---------------------------------------------------------------------------
// Read-only filesystem engine (node:fs promises only - no child processes)
// ---------------------------------------------------------------------------

class PlanAccessError extends Error {}

interface ResolvedInsideRoot {
	rootReal: string;
	realPath: string;
	displayPath: string;
}

async function resolveInsideRoot(cwd: string, rawInput: string | undefined): Promise<ResolvedInsideRoot> {
	const rootReal = await fs.realpath(cwd);
	const rel = sanitizeRelativeInput(rawInput ?? ".");
	const resolved = path.resolve(rootReal, rel);
	if (!isPathInsideRoot(rootReal, resolved)) {
		throw new PlanAccessError(`path escapes the project directory: ${rawInput}`);
	}

	// Canonicalize the deepest existing ancestor so symlinks cannot smuggle us
	// outside the root, then rebuild the tail without following symlinks.
	let probe = resolved;
	const tail: string[] = [];
	for (;;) {
		try {
			const real = await fs.realpath(probe);
			const rebuilt = tail.length === 0 ? real : path.join(real, ...tail);
			if (!isPathInsideRoot(rootReal, rebuilt)) {
				throw new PlanAccessError(`resolved path escapes the project directory: ${rawInput}`);
			}
			return { rootReal, realPath: rebuilt, displayPath: displayPathFor(cwd, rebuilt) };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw new PlanAccessError(`cannot access ${rawInput}: ${(error as Error).message}`);
			}
		}
		const parent = path.dirname(probe);
		if (parent === probe) break;
		tail.unshift(path.basename(probe));
		probe = parent;
	}
	throw new PlanAccessError(`path not found: ${rawInput}`);
}

function displayPathFor(cwd: string, realPath: string): string {
	const rel = path.relative(cwd, realPath);
	if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel.split(path.sep).join("/");
	return realPath.split(path.sep).join("/");
}

function sameFilesystemObject(left: BigIntStats, right: BigIntStats): boolean {
	return left.isFile() === right.isFile()
		&& left.isDirectory() === right.isDirectory()
		&& left.dev === right.dev
		&& left.ino === right.ino;
}

async function stableCanonicalObject(candidate: string, rootReal: string): Promise<{ canonical: string; stat: BigIntStats }> {
	const canonical = await fs.realpath(candidate);
	if (!isPathInsideRoot(rootReal, canonical)) {
		throw new PlanAccessError(`resolved path escapes the project directory: ${candidate}`);
	}
	const stat = await fs.lstat(canonical, { bigint: true });
	if (stat.isSymbolicLink()) throw new PlanAccessError(`symbolic path refused: ${candidate}`);
	return { canonical, stat };
}

async function verifyUnchangedObject(
	candidate: string,
	rootReal: string,
	canonical: string,
	identity: BigIntStats,
): Promise<void> {
	const after = await stableCanonicalObject(candidate, rootReal);
	if (after.canonical !== canonical || !sameFilesystemObject(identity, after.stat)) {
		throw new PlanAccessError(`path changed during read-only inspection: ${candidate}`);
	}
}

function clipLine(line: string): string {
	return line.length > INSPECT_LIMITS.maxLineChars
		? `${line.slice(0, INSPECT_LIMITS.maxLineChars)}...`
		: line;
}

async function listDirectory(dirReal: string, rootReal: string): Promise<string> {
	const before = await stableCanonicalObject(dirReal, rootReal);
	if (!before.stat.isDirectory()) throw new PlanAccessError(`not a directory: ${dirReal}`);
	const dirents = await fs.readdir(before.canonical, { withFileTypes: true });
	await verifyUnchangedObject(dirReal, rootReal, before.canonical, before.stat);
	dirents.sort((a, b) => {
		const ad = a.isDirectory() ? 0 : 1;
		const bd = b.isDirectory() ? 0 : 1;
		return ad - bd || a.name.localeCompare(b.name);
	});
	const truncated = dirents.length > INSPECT_LIMITS.maxListEntries;
	const shown = truncated ? dirents.slice(0, INSPECT_LIMITS.maxListEntries) : dirents;
	const lines = shown.map((entry) => {
		if (entry.isDirectory()) return `[dir]  ${entry.name}/`;
		if (entry.isSymbolicLink()) return `[link] ${entry.name}`;
		return `[file] ${entry.name}`;
	});
	if (truncated) {
		lines.push(`... ${dirents.length - INSPECT_LIMITS.maxListEntries} more entries omitted`);
	}
	lines.push("", `${dirents.length} entr${dirents.length === 1 ? "y" : "ies"}.`);
	return lines.join("\n");
}

interface ReadRequest {
	offset?: number;
	limit?: number;
	maxBytes?: number;
}

async function readTextFile(fileReal: string, rootReal: string, request: ReadRequest): Promise<string> {
	const maxBytes = Math.min(
		Math.max(1, Math.floor(request.maxBytes ?? INSPECT_LIMITS.defaultReadBytes)),
		INSPECT_LIMITS.maxReadBytes,
	);
	const before = await stableCanonicalObject(fileReal, rootReal);
	if (!before.stat.isFile()) throw new PlanAccessError(`not a file: ${fileReal}`);
	const handle = await fs.open(before.canonical, "r");
	let buffer: Buffer;
	let fileSize: number;
	let truncatedBytes: boolean;
	try {
		const opened = await handle.stat({ bigint: true });
		if (!sameFilesystemObject(before.stat, opened)) {
			throw new PlanAccessError(`path changed before file open: ${fileReal}`);
		}
		fileSize = Number(opened.size);
		const toRead = Math.min(fileSize, maxBytes);
		buffer = Buffer.alloc(toRead);
		await handle.read(buffer, 0, toRead, 0);
		const afterRead = await handle.stat({ bigint: true });
		if (!sameFilesystemObject(opened, afterRead)) {
			throw new PlanAccessError(`file identity changed during read: ${fileReal}`);
		}
		truncatedBytes = fileSize > toRead;
	} finally {
		await handle.close();
	}
	await verifyUnchangedObject(fileReal, rootReal, before.canonical, before.stat);
	if (buffer.subarray(0, 4096).includes(0)) {
		throw new PlanAccessError("file looks binary; only text files can be read in plan mode");
	}

	const allLines = buffer.toString("utf8").split("\n");
	const start = Math.max(1, Math.floor(request.offset ?? 1));
	const maxLines = Math.min(Math.max(1, Math.floor(request.limit ?? INSPECT_LIMITS.defaultReadLines)), INSPECT_LIMITS.maxReadLines);
	const slice = allLines.slice(start - 1, start - 1 + maxLines);
	const clipped = slice.map(clipLine);

	const notes: string[] = [];
	if (start > 1) notes.push(`skipped lines 1-${start - 1}`);
	if (start - 1 + slice.length < allLines.length) {
		notes.push(`${allLines.length - (start - 1 + slice.length)} more lines`);
	}
	if (truncatedBytes) notes.push(`file truncated at ${maxBytes} of ${fileSize} bytes`);

	const header = `${fileSize} bytes, ${allLines.length} lines`;
	const body = clipped.length > 0 ? clipped.join("\n") : "(empty range)";
	return [header, ...(notes.length > 0 ? [`(${notes.join("; ")})`] : []), "", body].join("\n");
}

interface SearchRequest {
	query: string;
	glob?: string;
}

interface SearchHit {
	file: string;
	line: number;
	text: string;
}

async function searchTree(rootDir: string, rootReal: string, displayRoot: string, request: SearchRequest): Promise<SearchHit[]> {
	// Literal matching avoids regular-expression denial of service while still
	// covering the bounded project-search workflow needed for planning.
	const needle = request.query.toLowerCase();
	const matcher = (line: string) => line.toLowerCase().includes(needle);

	const hits: SearchHit[] = [];
	const deadline = Date.now() + INSPECT_LIMITS.searchTimeBudgetMs;
	let scannedFiles = 0;
	let scannedDirs = 0;

	const visit = async (dir: string, depth: number): Promise<void> => {
		if (hits.length >= INSPECT_LIMITS.searchMaxMatches) return;
		if (depth > INSPECT_LIMITS.searchMaxDepth || scannedFiles >= INSPECT_LIMITS.searchMaxFiles) return;
		if (scannedDirs++ % 32 === 0 && Date.now() > deadline) return;
		let dirents: Dirent[];
		let canonicalDir: string;
		try {
			const beforeDir = await stableCanonicalObject(dir, rootReal);
			if (!beforeDir.stat.isDirectory()) return;
			canonicalDir = beforeDir.canonical;
			dirents = await fs.readdir(canonicalDir, { withFileTypes: true });
			await verifyUnchangedObject(dir, rootReal, canonicalDir, beforeDir.stat);
		} catch {
			return;
		}
		for (const entry of dirents) {
			if (hits.length >= INSPECT_LIMITS.searchMaxMatches) return;
			if (entry.isSymbolicLink()) continue; // never follow symlinks
			const full = path.join(canonicalDir, entry.name);
			if (entry.isDirectory()) {
				if (!SEARCH_SKIP_DIRS.has(entry.name)) await visit(full, depth + 1);
				continue;
			}
			if (!entry.isFile()) continue;
			if (scannedFiles >= INSPECT_LIMITS.searchMaxFiles) return;
			if (request.glob && !matchesWildcard(entry.name, request.glob)) continue;
			if (BINARY_SUFFIXES.has(path.extname(entry.name).toLowerCase())) continue;
			scannedFiles++;
			let content: string;
			try {
				const before = await stableCanonicalObject(full, rootReal);
				if (!before.stat.isFile() || before.stat.size > BigInt(INSPECT_LIMITS.searchMaxBytesPerFile)) continue;
				const handle = await fs.open(before.canonical, "r");
				let buffer: Buffer;
				try {
					const opened = await handle.stat({ bigint: true });
					if (!sameFilesystemObject(before.stat, opened)) throw new PlanAccessError("search path changed before open");
					if (opened.size > BigInt(INSPECT_LIMITS.searchMaxBytesPerFile)) throw new PlanAccessError("search file grew beyond its limit");
					const openedSize = Number(opened.size);
					buffer = Buffer.alloc(openedSize);
					await handle.read(buffer, 0, openedSize, 0);
					if (!sameFilesystemObject(opened, await handle.stat({ bigint: true }))) throw new PlanAccessError("search file changed during read");
				} finally {
					await handle.close();
				}
				await verifyUnchangedObject(full, rootReal, before.canonical, before.stat);
				if (buffer.subarray(0, 4096).includes(0)) continue;
				content = buffer.toString("utf8");
			} catch {
				continue;
			}
			const lines = content.split("\n");
			const display = displayPathFor(displayRoot, full);
			for (let i = 0; i < lines.length; i++) {
				if (matcher(lines[i])) {
					hits.push({ file: display, line: i + 1, text: clipLine(lines[i]) });
					break;
				}
			}
		}
	};

	await visit(rootDir, 0);
	return hits.slice(0, INSPECT_LIMITS.searchMaxMatches);
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

function textResult(text: string, details: unknown) {
	return { content: [{ type: "text" as const, text }], details };
}

function requireUI(ctx: ExtensionContext): void {
	if (!ctx.hasUI) {
		throw new Error("UI is not available in this runtime; the user cannot be asked.");
	}
}

export default function primeOrbitPlanMode(pi: ExtensionAPI): void {
	// Deny-by-default gate: even if another extension or setting re-enables a
	// built-in tool, nothing except the three plan tools may execute here.
	pi.on("tool_call", async (event) => {
		if ((PLAN_TOOL_NAMES as readonly string[]).includes(event.toolName)) return;
		return {
			block: true,
			reason:
				`Prime Orbit plan mode denies "${event.toolName}". ` +
				`Only ${PLAN_TOOL_NAMES.join(", ")} are available. ` +
				"Do not try workarounds; inspect read-only, ask questions, and submit the plan.",
		};
	});

	pi.on("before_agent_start", async () => {
		return {
			message: {
				customType: "prime-orbit-plan-doctrine",
				content: buildPlanDoctrine(),
				display: false,
			},
		};
	});

	pi.on("session_start", async () => {
		try {
			pi.setActiveTools([...PLAN_TOOL_NAMES]);
		} catch {
			// Runtime may not be bound yet in some hosts; the tool_call gate still holds.
		}
	});

	// --- inspect -------------------------------------------------------------
	pi.registerTool({
		name: "prime_orbit_plan_inspect",
		label: "Plan: Inspect",
		description:
			"Read-only project inspection for plan mode. list = directory entries, read = bounded text file content, " +
			"search = bounded filename-filtered text scan. Strictly confined to the project directory; symlinks that " +
			"escape it are refused; no shell, no writes.",
		parameters: InspectParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const target = await resolveInsideRoot(ctx.cwd, params.path);

			if (params.action === "list") {
				const stat = await fs.lstat(target.realPath).catch(() => undefined);
				if (!stat?.isDirectory()) {
					const inner = await fs.stat(target.realPath).catch(() => undefined);
					if (!inner?.isDirectory()) {
						throw new Error(`not a directory: ${target.displayPath} (hint: use action="read")`);
					}
				}
				const body = await listDirectory(target.realPath, target.rootReal);
				return textResult(`Listing ${target.displayPath}\n\n${body}`, { action: "list", path: target.displayPath });
			}

			if (params.action === "read") {
				const stat = await fs.stat(target.realPath).catch(() => undefined);
				if (!stat?.isFile()) throw new Error(`not a file: ${target.displayPath} (hint: use action="list")`);
				const body = await readTextFile(target.realPath, target.rootReal, {
					offset: params.offset,
					limit: params.limit,
				});
				return textResult(`Reading ${target.displayPath}\n\n${body}`, { action: "read", path: target.displayPath });
			}

			// action === "search"
			if (!params.query || params.query.length === 0) {
				throw new Error('action="search" requires query');
			}
			const rootStat = await fs.stat(target.realPath).catch(() => undefined);
			if (!rootStat?.isDirectory()) throw new Error(`search root is not a directory: ${target.displayPath}`);
			const hits = await searchTree(target.realPath, target.rootReal, ctx.cwd, {
				query: params.query,
				glob: params.glob,
			});
			const lines = hits.map((hit) => `${hit.file}:${hit.line}: ${hit.text}`);
			const summary =
				lines.length === 0
					? "No matches."
					: `${lines.length} match${lines.length === 1 ? "" : "es"} (scan bounded: ${INSPECT_LIMITS.searchMaxFiles} files, depth ${INSPECT_LIMITS.searchMaxDepth}).`;
			return textResult(
				[`Search "${params.query}"${params.glob ? ` in ${params.glob}` : ""} under ${target.displayPath}`, summary, "", ...(lines.length > 0 ? lines : [])].join("\n"),
				{ action: "search", path: target.displayPath, matches: lines.length },
			);
		},
	});

	// --- question ------------------------------------------------------------
	pi.registerTool({
		name: "prime_orbit_plan_question",
		label: "Plan: Ask User",
		description:
			"Ask the user a blocking multiple-choice question with rich labeled options and an optional free-text " +
			"'Other' answer. Returns a versioned prime-orbit-plan payload describing the selection. " +
			"Use whenever scope, trade-offs, or priorities are unclear before writing the plan.",
		parameters: QuestionParams,

		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			requireUI(ctx);
			if (signal?.aborted) {
				return textResult("Cancelled before asking.", {
					payload: { kind: "question", v: PLAN_PAYLOAD_VERSION, cancelled: true, custom: false, value: "", label: "", prompt: params.prompt },
				});
			}

			const options = normalizePlanQuestionOptions(params.options);
			const title = params.context ? `${params.prompt}\n\n${params.context}` : params.prompt;
			const labels = [...composeOptionLabels(options)];
			if (params.allowOther !== false) labels.push(OTHER_ANSWER_LABEL);
			const questionTitle = encodePlanUiTitle(
				{
					kind: "question",
					toolCallId,
					prompt: params.prompt,
					...(params.context !== undefined ? { context: params.context } : {}),
					options,
					allowOther: params.allowOther !== false,
				},
				title,
			);

			const selected = await ctx.ui.select(questionTitle, labels, { signal });
			if (selected !== undefined && !labels.includes(selected)) {
				throw new Error("question dialog returned a value outside its allowed choices");
			}
			const selection = resolveSelection(
				options,
				params.allowOther === false && selected === OTHER_ANSWER_LABEL ? undefined : selected,
			);

			if (selection.type === "cancelled") {
				const cancelledPayload: PlanQuestionPayload = {
					kind: "question",
					v: PLAN_PAYLOAD_VERSION,
					cancelled: true,
					custom: false,
					value: "",
					label: "",
					prompt: params.prompt,
				};
				return textResult(
					"The user dismissed the question.\n\n" + encodePlanPayload(cancelledPayload),
					{ payload: cancelledPayload },
				);
			}

			let customAnswer = "";
			if (selection.type === "other") {
				const customTitle = encodePlanUiTitle(
					{ kind: "custom", toolCallId, prompt: params.prompt },
					"Your answer",
				);
				const typed = await ctx.ui.input(customTitle, "Type your answer...", { signal });
				if (typed === undefined || typed.trim().length === 0) {
					const payload: PlanQuestionPayload = {
						kind: "question",
						v: PLAN_PAYLOAD_VERSION,
						cancelled: true,
						custom: false,
						value: "",
						label: "",
						prompt: params.prompt,
					};
					return textResult("The user dismissed the free-text answer.", { payload });
				}
				customAnswer = typed.trim();
				if (customAnswer.length > MAX_PLAN_CUSTOM_ANSWER_CHARS) {
					throw new Error(`free-text answer exceeds ${MAX_PLAN_CUSTOM_ANSWER_CHARS} characters`);
				}
			}

			const payload: PlanQuestionPayload = {
				kind: "question",
				v: PLAN_PAYLOAD_VERSION,
				cancelled: false,
				custom: selection.type === "other",
				value: selection.type === "option" ? selection.value : customAnswer,
				label: selection.type === "option" ? selection.displayLabel : customAnswer,
				prompt: params.prompt,
			};
			const rendered = encodePlanPayload(payload);
			const echo =
				selection.type === "option"
					? `User selected: ${selection.displayLabel} (value: ${selection.value})`
					: `User answered: ${customAnswer}`;
			return textResult(`${echo}\n\n${rendered}`, { payload });
		},
	});

	// --- submit --------------------------------------------------------------
	pi.registerTool({
		name: "prime_orbit_plan_submit",
		label: "Plan: Submit Document",
		description:
			"Submit the final Markdown plan document to the user. They choose apply (exit plan mode and implement), " +
			"keep (save without implementing) or revise (improve and resubmit). Returns the decision as a " +
			"versioned prime-orbit-plan payload.",
		parameters: SubmitParams,

		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const check = validatePlanDocument(params.document);
			if (!check.ok) throw new Error(check.reason);
			requireUI(ctx);

			const title = (params.title ?? "").trim() || "Implementation plan";
			const reviewTitle = encodePlanUiTitle(
				{
					kind: "review",
					planId: toolCallId,
					title,
					revisionResponse: PLAN_INLINE_REVISION_PROTOCOL,
				},
				`Plan ready: ${title}. What next?`,
			);
			const decisionLabels = composeDecisionLabels();
			const selected = await ctx.ui.select(reviewTitle, decisionLabels, { signal });
			const inlineRevision = decodePlanInlineRevisionResponse(selected, toolCallId);
			if (selected !== undefined && !decisionLabels.includes(selected) && !inlineRevision) {
				throw new Error("review dialog returned a value outside its allowed choices");
			}
			let decision = inlineRevision ? "revise" as const : normalizeDecision(selected);
			let feedback: string | undefined = inlineRevision?.feedback;
			if (decision === "revise" && !feedback) {
				const prompt = "What should change in this plan?";
				const feedbackTitle = encodePlanUiTitle(
					{ kind: "custom", toolCallId, prompt },
					prompt,
				);
				const typed = await ctx.ui.input(feedbackTitle, "Describe the revision...", { signal });
				if (typed === undefined || typed.trim().length === 0) {
					decision = "cancelled";
				} else {
					feedback = typed.trim();
					if (feedback.length > MAX_PLAN_CUSTOM_ANSWER_CHARS) {
						throw new Error(`revision feedback exceeds ${MAX_PLAN_CUSTOM_ANSWER_CHARS} characters`);
					}
				}
			}

			const payload: PlanDecisionPayload = {
				kind: "decision",
				v: PLAN_PAYLOAD_VERSION,
				decision,
				title,
				documentChars: params.document.length,
				documentLines: params.document.split("\n").length,
				...(feedback ? { feedback } : {}),
			};
			try {
				pi.appendEntry("prime-orbit-plan-decision", payload);
			} catch {
				// Persistence is best-effort; the payload in the transcript remains authoritative.
			}

			const nextStep =
				decision === "apply"
					? "Orbit will exit plan mode and implementation starts from this document."
					: decision === "keep"
						? "The document is kept; planning ends without implementing."
						: decision === "revise"
							? `Improve the document using this feedback: ${feedback}. Then call prime_orbit_plan_submit again.`
							: "The user dismissed the dialog. Confirm how they want to proceed.";
			return textResult(`User decision: ${decision}. ${nextStep}\n\n${encodePlanPayload(payload)}`, { payload });
		},
	});
}
