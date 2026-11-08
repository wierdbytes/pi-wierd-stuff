/**
 * Session digest: a compact, line-per-entry rendering of the active branch.
 *
 * User messages are kept almost whole, assistant text is clipped, tool calls
 * are one line, tool results keep only a head (errors: head and tail).
 * Images and thinking never appear. Every line carries its entry id, so the
 * models can cite evidence the dream can later look up in the raw session.
 * Credentials are scrubbed from every line.
 */

import { homedir } from "node:os";
import { normalize, resolve } from "node:path";
import { type ParsedSession, type RawEntry, textOf } from "./sessions.ts";
import { scrubSecrets } from "./secrets.ts";

export type LineKind = "USER" | "AI" | "CALL" | "RESULT" | "ERROR" | "SHELL" | "MEMORY" | "SUMMARY" | "CUSTOM";

export interface DigestLine {
	id: string;
	kind: LineKind;
	text: string;
	ts?: string;
}

export interface DigestMeta {
	sessionId: string;
	file: string;
	cwd: string;
	started: string;
	ended?: string;
	name?: string;
	models: string[];
	userMessages: number;
	toolCalls: number;
	toolErrors: number;
	/** Memory notes injected into this session by pi-dream. */
	injected: string[];
	/** Memory notes the agent opened with memory_read. */
	read: string[];
	lastEntryId?: string;
	/** Absolute paths the session worked with (tool paths, `cd` targets), most used first. */
	paths: Array<[string, number]>;
}

const MAX_PATHS = 40;

/** `~/x`, `./x`, `x` (relative to cwd) → absolute path; undefined for globs, variables and flags. */
export function expandPath(raw: string, cwd: string): string | undefined {
	let t = raw.trim().replace(/^['"]|['"]$/g, "");
	if (!t || t.startsWith("-") || /[$*?{}`]/.test(t) || t.includes("://")) return undefined;
	if (t === "~") t = homedir();
	else if (t.startsWith("~/")) t = homedir() + t.slice(1);
	else if (!t.startsWith("/")) {
		if (!cwd) return undefined;
		t = resolve(cwd, t);
	}
	return normalize(t).replace(/\/+$/, "") || "/";
}

/** Paths a tool call works with: `path` arguments and, for bash, `cd` targets and home paths. */
/** Absolute paths under a home folder in a shell command: `~/…`, `/Users/<u>/…` (macOS), `/home/<u>/…` (Linux) or this machine's home. */
const HOME_PATH_RE = new RegExp(
	`(?:^|[\\s'"=(:])((?:~|/Users/[^/\\s'"]+|/home/[^/\\s'"]+|${homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})/[^\\s'"\`;|&)<>]+)`,
	"g",
);

export function callPaths(name: string, args: unknown, cwd: string): string[] {
	const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	const out: string[] = [];
	const add = (p: string | undefined) => {
		if (p) out.push(p);
	};
	if (typeof a.path === "string") add(expandPath(a.path, cwd));
	if (name === "bash" && typeof a.command === "string") {
		const cmd = a.command;
		for (const m of cmd.matchAll(/(?:^|[;&|(]|\n)\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g)) add(expandPath(m[1], cwd));
		for (const m of cmd.matchAll(HOME_PATH_RE)) add(expandPath(m[1], cwd));
	}
	return out;
}

export interface Digest {
	meta: DigestMeta;
	lines: DigestLine[];
}

export const LIMITS = { USER: 6000, AI: 2000, CALL: 400, RESULT: 200, ERROR: 700, SHELL: 600, SUMMARY: 1500, CUSTOM: 400 };

export function clipHead(text: string, max: number): string {
	const t = text.trim();
	return t.length <= max ? t : `${t.slice(0, max).trimEnd()} …[+${t.length - max} chars]`;
}

export function clipMiddle(text: string, max: number, headShare = 0.6): string {
	const t = text.trim();
	if (t.length <= max) return t;
	const head = Math.floor(max * headShare);
	const tail = max - head;
	return `${t.slice(0, head).trimEnd()} …[${t.length - max} chars omitted]… ${t.slice(t.length - tail).trimStart()}`;
}

/** Collapse skill bodies and attached files pi inlines into user messages. */
export function stripInjected(text: string): string {
	return text
		.replace(/<skill\b[^>]*\bname="([^"]+)"[^>]*>[\s\S]*?<\/skill>/g, "[skill: $1]")
		.replace(/<file\b[^>]*\bname="([^"]+)"[^>]*>[\s\S]*?<\/file>/g, "[file: $1]")
		.trim();
}

export function summarizeCall(name: string, args: unknown): string {
	const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	const s = (v: unknown) => (typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v));
	switch (name) {
		case "bash":
			return `bash $ ${s(a.command)}`;
		case "read":
			return `read ${s(a.path)}${a.offset ? ` @${s(a.offset)}` : ""}${a.limit ? `+${s(a.limit)}` : ""}`;
		case "edit":
			return `edit ${s(a.path)} (${Array.isArray(a.edits) ? a.edits.length : 1} edit(s))`;
		case "write":
			return `write ${s(a.path)} (${typeof a.content === "string" ? a.content.length : 0} chars)`;
		case "grep":
		case "find":
		case "ls":
			return `${name} ${s(a.pattern)} ${s(a.path)}`.trim();
		default:
			return `${name} ${s(args)}`;
	}
}

function toolResultText(m: Record<string, unknown>): string {
	return textOf(m.content);
}

function msgModel(m: Record<string, unknown>): string | undefined {
	return typeof m.provider === "string" && typeof m.model === "string" ? `${m.provider}/${m.model}` : undefined;
}

/** Note ids an entry shows as injected (our own `pi-dream` custom entries). */
function injectedIds(e: RawEntry): string[] {
	if (e.type !== "custom" || e.customType !== "pi-dream") return [];
	const d = e.data as { event?: string; ids?: unknown } | undefined;
	return d?.event === "inject" && Array.isArray(d.ids) ? d.ids.filter((x): x is string => typeof x === "string") : [];
}

export function buildDigest(s: ParsedSession): Digest {
	const lines: DigestLine[] = [];
	const models = new Set<string>();
	const injected = new Set<string>();
	const read = new Set<string>();
	let userMessages = 0;
	let toolCalls = 0;
	let toolErrors = 0;
	let ended: string | undefined;
	const paths = new Map<string, number>();
	const touch = (list: string[]) => {
		for (const p of list) paths.set(p, (paths.get(p) ?? 0) + 1);
	};
	const push = (e: RawEntry, kind: LineKind, text: string) => {
		const t = scrubSecrets(text).trim();
		if (t) lines.push({ id: e.id, kind, text: t, ts: e.timestamp });
	};

	for (const e of s.branch) {
		if (e.timestamp) ended = e.timestamp;
		const ids = injectedIds(e);
		if (ids.length) {
			for (const id of ids) injected.add(id);
			push(e, "MEMORY", `injected notes: ${ids.join(", ")}`);
			continue;
		}
		if (e.type === "branch_summary" && typeof e.summary === "string") {
			push(e, "SUMMARY", clipHead(e.summary, LIMITS.SUMMARY));
			continue;
		}
		if (e.type === "custom_message") {
			const ct = typeof e.customType === "string" ? e.customType : "custom";
			push(e, "CUSTOM", `${ct}: ${clipHead(textOf(e.content), LIMITS.CUSTOM)}`);
			continue;
		}
		if (e.type !== "message" || !e.message) continue;
		const m = e.message;
		switch (m.role) {
			case "user": {
				userMessages++;
				push(e, "USER", clipMiddle(stripInjected(textOf(m.content)), LIMITS.USER));
				break;
			}
			case "assistant": {
				const model = msgModel(m);
				if (model) models.add(model);
				const blocks = Array.isArray(m.content) ? m.content : [];
				for (const b of blocks) {
					if (!b || typeof b !== "object") continue;
					const blk = b as { type?: string; text?: string; name?: string; arguments?: unknown };
					if (blk.type === "text" && blk.text?.trim()) push(e, "AI", clipMiddle(blk.text, LIMITS.AI));
					else if (blk.type === "toolCall" && blk.name) {
						toolCalls++;
						if (blk.name === "memory_read") {
							const ref = (blk.arguments as { ref?: unknown } | undefined)?.ref;
							if (typeof ref === "string" && ref.startsWith("m-")) read.add(ref);
						}
						touch(callPaths(blk.name, blk.arguments, s.header.cwd));
						push(e, "CALL", clipHead(summarizeCall(blk.name, blk.arguments), LIMITS.CALL));
					}
				}
				break;
			}
			case "toolResult": {
				const name = typeof m.toolName === "string" ? m.toolName : "tool";
				const text = toolResultText(m);
				if (m.isError) {
					toolErrors++;
					push(e, "ERROR", `${name}: ${clipMiddle(text, LIMITS.ERROR, 0.65)}`);
				} else {
					push(e, "RESULT", `${name}: ${clipHead(text, LIMITS.RESULT) || "(empty)"}`);
				}
				break;
			}
			case "bashExecution": {
				const cmd = typeof m.command === "string" ? m.command : "";
				const out = typeof m.output === "string" ? m.output : "";
				touch(callPaths("bash", { command: cmd }, s.header.cwd));
				push(e, "SHELL", `$ ${cmd} (exit ${String(m.exitCode ?? "?")})\n${clipMiddle(out, LIMITS.SHELL, 0.5)}`);
				break;
			}
			case "custom": {
				const ct = typeof m.customType === "string" ? m.customType : "custom";
				push(e, "CUSTOM", `${ct}: ${clipHead(textOf(m.content), LIMITS.CUSTOM)}`);
				break;
			}
			default:
				break;
		}
	}

	return {
		meta: {
			sessionId: s.header.id,
			file: s.file,
			cwd: s.header.cwd,
			started: s.header.timestamp,
			ended,
			name: s.name,
			models: [...models],
			userMessages,
			toolCalls,
			toolErrors,
			injected: [...injected],
			read: [...read],
			lastEntryId: s.lastEntryId,
			paths: [...paths.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_PATHS),
		},
		lines,
	};
}

function renderLine(l: DigestLine): string {
	const body = l.text.replace(/\n/g, "\n    ");
	return `[${l.id}] ${l.kind}: ${body}`;
}

/** Shrinking passes applied in order until the digest fits. User lines survive longest. */
const PASSES: Array<(l: DigestLine) => DigestLine | null> = [
	(l) => (l.kind === "RESULT" ? { ...l, text: clipHead(l.text, 80) } : l),
	(l) => (l.kind === "AI" ? { ...l, text: clipMiddle(l.text, 700) } : l),
	(l) => (l.kind === "CALL" ? { ...l, text: clipHead(l.text, 160) } : l),
	(l) => (l.kind === "ERROR" || l.kind === "SHELL" || l.kind === "CUSTOM" ? { ...l, text: clipHead(l.text, 240) } : l),
	(l) => (l.kind === "RESULT" ? null : l),
	(l) => (l.kind === "AI" ? { ...l, text: clipMiddle(l.text, 300) } : l),
	(l) => (l.kind === "USER" ? { ...l, text: clipMiddle(l.text, 2000) } : l),
];

export function renderDigest(d: Digest, maxChars = Number.POSITIVE_INFINITY): string {
	let lines = d.lines;
	let text = lines.map(renderLine).join("\n");
	for (const pass of PASSES) {
		if (text.length <= maxChars) return text;
		lines = lines.map(pass).filter((l): l is DigestLine => l !== null);
		text = lines.map(renderLine).join("\n");
	}
	if (text.length <= maxChars) return text;
	const head = Math.floor(maxChars * 0.4);
	const tail = maxChars - head;
	return `${text.slice(0, head)}\n[… ${text.length - maxChars} chars omitted …]\n${text.slice(text.length - tail)}`;
}

export function digestHeader(meta: DigestMeta, projectKey: string): string {
	const parts = [
		`session ${meta.sessionId}`,
		`project ${projectKey}`,
		`cwd ${meta.cwd}`,
		`started ${meta.started}`,
		meta.name ? `name "${meta.name}"` : "",
		meta.models.length ? `models ${meta.models.join(", ")}` : "",
		`user messages ${meta.userMessages}, tool calls ${meta.toolCalls}, tool errors ${meta.toolErrors}`,
	];
	return parts.filter(Boolean).join(" | ");
}

/** A full rendering of one raw entry, for evidence excerpts shown to the fact checker. */
export function renderEntryFull(e: RawEntry, max = 4000): string {
	const line = (kind: string, text: string) => `[${e.id}] ${kind}: ${scrubSecrets(text).trim()}`;
	if (e.type === "branch_summary" && typeof e.summary === "string") return line("SUMMARY", clipHead(e.summary, max));
	if (e.type === "custom_message") return line("CUSTOM", clipHead(textOf(e.content), max));
	if (e.type !== "message" || !e.message) return line(e.type.toUpperCase(), "");
	const m = e.message;
	switch (m.role) {
		case "user":
			return line("USER", clipMiddle(stripInjected(textOf(m.content)), max));
		case "assistant": {
			const parts: string[] = [];
			for (const b of Array.isArray(m.content) ? m.content : []) {
				const blk = b as { type?: string; text?: string; name?: string; arguments?: unknown };
				if (blk?.type === "text" && blk.text) parts.push(blk.text);
				if (blk?.type === "toolCall" && blk.name) parts.push(`CALL ${clipHead(summarizeCall(blk.name, blk.arguments), 1500)}`);
			}
			return line("AI", clipMiddle(parts.join("\n"), max));
		}
		case "toolResult": {
			const name = typeof m.toolName === "string" ? m.toolName : "tool";
			return line(m.isError ? "ERROR" : "RESULT", `${name}: ${clipMiddle(textOf(m.content), Math.min(max, 2000), 0.7)}`);
		}
		case "bashExecution":
			return line("SHELL", `$ ${String(m.command ?? "")}\n${clipMiddle(String(m.output ?? ""), Math.min(max, 2000), 0.5)}`);
		default:
			return line(String(m.role ?? "ENTRY").toUpperCase(), clipHead(textOf(m.content), max));
	}
}
