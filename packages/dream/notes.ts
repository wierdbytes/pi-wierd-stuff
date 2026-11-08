/**
 * Memory notes: one Markdown file per note with YAML front matter.
 *
 * Front matter values are written as JSON (a subset of YAML), so they parse
 * back exactly and survive hand edits in a pull request. Parsing is lenient:
 * a note written by hand without an id or with unknown fields still loads;
 * the next dream fills in what is missing.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { scopeDir } from "./layout.ts";

export const NOTE_TYPES = ["preference", "procedure", "pitfall", "fact", "decision", "reference"] as const;
export const NOTE_STATUSES = ["active", "superseded", "deprecated"] as const;
export const INDEX_MODES = ["always", "pointer", "none"] as const;
export const EVIDENCE_KINDS = ["user", "observed", "inbox", "reviewer"] as const;

export type NoteType = (typeof NOTE_TYPES)[number];
export type NoteStatus = (typeof NOTE_STATUSES)[number];
export type IndexMode = (typeof INDEX_MODES)[number];
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface Evidence {
	/** Session id, `inbox:<id>` or `pr#<n>`. */
	s: string;
	/** Entry ids (or comment ids). */
	e: string[];
	date?: string;
	/** When the cited entries were written (ISO, minute precision, UTC); the latest of them. */
	at?: string;
	kind?: EvidenceKind;
}

/** ISO timestamp cut to minutes: `2026-10-31T13:50Z`. */
export function isoMinute(v: string | number | undefined): string | undefined {
	if (v === undefined || v === "") return undefined;
	const t = typeof v === "number" ? v : Date.parse(v);
	if (!Number.isFinite(t)) return undefined;
	return `${new Date(t).toISOString().slice(0, 16)}Z`;
}

/** Creation time of a UUIDv7 session id (pi session ids are v7), in ms. */
export function uuidV7Time(id: string): number | undefined {
	const hex = id.replace(/-/g, "");
	if (!/^[0-9a-f]{32}$/i.test(hex) || hex[12] !== "7") return undefined;
	return Number.parseInt(hex.slice(0, 12), 16);
}

/**
 * When a piece of evidence was observed, in ms: the cited entries' time, else
 * the session start (`startOf`, then the id itself), else the day.
 */
export function evidenceTime(e: Evidence, startOf?: (sessionId: string) => string | undefined): number | undefined {
	const at = e.at ? Date.parse(e.at) : Number.NaN;
	if (Number.isFinite(at)) return at;
	if (!e.s.startsWith("inbox:") && !e.s.startsWith("pr#")) {
		const started = startOf?.(e.s);
		const t = started ? Date.parse(started) : Number.NaN;
		if (Number.isFinite(t)) return t;
		const v7 = uuidV7Time(e.s);
		if (v7 !== undefined) return v7;
	}
	const day = e.date ? Date.parse(e.date) : Number.NaN;
	return Number.isFinite(day) ? day : undefined;
}

export interface Note {
	id: string;
	title: string;
	type: NoteType;
	status: NoteStatus;
	index: IndexMode;
	when?: string;
	pinned?: boolean;
	created: string;
	updated: string;
	confirmed?: string;
	validUntil?: string;
	supersededBy?: string;
	supersedes?: string[];
	stats: { helpful: number; harmful: number };
	evidence: Evidence[];
	body: string;
	/** Path relative to the memory root. */
	file: string;
	/** Scope id: `global` or `projects/<dir>`. */
	scope: string;
	/** Unknown front matter keys, preserved on rewrite. */
	extra: Record<string, unknown>;
	/** Problems found while parsing (missing id, bad yaml…). */
	problems: string[];
}

const KNOWN = new Set([
	"id",
	"title",
	"type",
	"status",
	"index",
	"when",
	"pinned",
	"created",
	"updated",
	"confirmed",
	"valid_until",
	"superseded_by",
	"supersedes",
	"stats",
	"evidence",
]);

const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
	typeof v === "string" && (list as readonly string[]).includes(v);

function dateStr(v: unknown): string | undefined {
	if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
	if (typeof v === "string" && v.trim()) return v.trim();
	return undefined;
}

function parseEvidence(v: unknown): Evidence[] {
	if (!Array.isArray(v)) return [];
	const out: Evidence[] = [];
	for (const item of v) {
		if (!item || typeof item !== "object") continue;
		const o = item as Record<string, unknown>;
		if (typeof o.s !== "string" || !o.s) continue;
		const e = Array.isArray(o.e) ? o.e.filter((x): x is string => typeof x === "string") : typeof o.e === "string" ? [o.e] : [];
		const at = typeof o.at === "string" ? isoMinute(o.at) : o.at instanceof Date ? isoMinute(o.at.getTime()) : undefined;
		out.push({ s: o.s, e, date: dateStr(o.date), ...(at ? { at } : {}), kind: oneOf(EVIDENCE_KINDS, o.kind) ? o.kind : undefined });
	}
	return out;
}

export function isNoteId(v: unknown): v is string {
	return typeof v === "string" && /^m-[0-9a-f]{6,12}$/.test(v);
}

export function parseNote(content: string, file: string, scope: string): Note {
	const problems: string[] = [];
	let fm: Record<string, unknown> = {};
	let body = content;
	try {
		const parsed = parseFrontmatter<Record<string, unknown>>(content);
		fm = parsed.frontmatter ?? {};
		body = parsed.body;
	} catch (err) {
		problems.push(`front matter: ${err instanceof Error ? err.message : String(err)}`);
	}
	body = body.trim();
	const id = isNoteId(fm.id) ? fm.id : "";
	if (!id) problems.push("missing or invalid id");
	const firstLine = body.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "").trim() ?? "";
	const title = typeof fm.title === "string" && fm.title.trim() ? fm.title.trim() : firstLine;
	if (!title) problems.push("missing title");
	const stats = (fm.stats && typeof fm.stats === "object" ? fm.stats : {}) as Record<string, unknown>;
	const extra: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(fm)) if (!KNOWN.has(k)) extra[k] = v;
	const created = dateStr(fm.created) ?? "";
	return {
		id,
		title,
		type: oneOf(NOTE_TYPES, fm.type) ? fm.type : "fact",
		status: oneOf(NOTE_STATUSES, fm.status) ? fm.status : "active",
		index: oneOf(INDEX_MODES, fm.index) ? fm.index : "none",
		when: typeof fm.when === "string" && fm.when.trim() ? fm.when.trim() : undefined,
		pinned: fm.pinned === true ? true : undefined,
		created,
		updated: dateStr(fm.updated) ?? created,
		confirmed: dateStr(fm.confirmed),
		validUntil: dateStr(fm.valid_until),
		supersededBy: typeof fm.superseded_by === "string" ? fm.superseded_by : undefined,
		supersedes: Array.isArray(fm.supersedes) ? fm.supersedes.filter((x): x is string => typeof x === "string") : undefined,
		stats: {
			helpful: typeof stats.helpful === "number" ? stats.helpful : 0,
			harmful: typeof stats.harmful === "number" ? stats.harmful : 0,
		},
		evidence: parseEvidence(fm.evidence),
		body,
		file,
		scope,
		extra,
		problems,
	};
}

const j = (v: unknown) => JSON.stringify(v);

export function serializeNote(n: Note): string {
	const lines = ["---", `id: ${n.id}`, `title: ${j(n.title)}`, `type: ${n.type}`, `status: ${n.status}`, `index: ${n.index}`];
	if (n.when) lines.push(`when: ${j(n.when)}`);
	if (n.pinned) lines.push("pinned: true");
	lines.push(`created: ${j(n.created)}`, `updated: ${j(n.updated)}`);
	if (n.confirmed) lines.push(`confirmed: ${j(n.confirmed)}`);
	if (n.validUntil) lines.push(`valid_until: ${j(n.validUntil)}`);
	if (n.supersededBy) lines.push(`superseded_by: ${j(n.supersededBy)}`);
	if (n.supersedes?.length) lines.push(`supersedes: ${j(n.supersedes)}`);
	if (n.stats.helpful || n.stats.harmful) lines.push(`stats: ${j({ helpful: n.stats.helpful, harmful: n.stats.harmful })}`);
	if (n.evidence.length) {
		lines.push("evidence:");
		for (const ev of n.evidence) {
			const o: Record<string, unknown> = { s: ev.s, e: ev.e };
			if (ev.date) o.date = ev.date;
			if (ev.at) o.at = ev.at;
			if (ev.kind) o.kind = ev.kind;
			lines.push(`  - ${j(o)}`);
		}
	}
	for (const [k, v] of Object.entries(n.extra)) if (v !== undefined) lines.push(`${k}: ${j(v)}`);
	lines.push("---", "", n.body.trim(), "");
	return lines.join("\n");
}

export function loadNotes(root: string, scope: string): Note[] {
	const dir = join(scopeDir(root, scope), "notes");
	if (!existsSync(dir)) return [];
	const out: Note[] = [];
	for (const name of readdirSync(dir).sort()) {
		if (!name.endsWith(".md")) continue;
		const rel = join("scopes", scope, "notes", name);
		try {
			out.push(parseNote(readFileSync(join(root, rel), "utf-8"), rel, scope));
		} catch {
			// unreadable file: skip
		}
	}
	return out;
}

/** All scope ids present in the repo (`global`, `projects/<dir>`…). */
export function listScopes(root: string): string[] {
	const scopes: string[] = [];
	if (existsSync(join(root, "scopes", "global"))) scopes.push("global");
	const projects = join(root, "scopes", "projects");
	if (existsSync(projects)) {
		for (const d of readdirSync(projects, { withFileTypes: true })) if (d.isDirectory()) scopes.push(`projects/${d.name}`);
	}
	return scopes;
}

export function newNoteId(taken: Set<string>): string {
	for (;;) {
		const id = `m-${randomBytes(3).toString("hex")}`;
		if (!taken.has(id)) {
			taken.add(id);
			return id;
		}
	}
}

const TRANSLIT: Record<string, string> = {
	а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m",
	н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "",
	ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

export function slugify(title: string, max = 60): string {
	const t = [...title.toLowerCase()].map((c) => TRANSLIT[c] ?? c).join("");
	let s = t
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (s.length > max) {
		s = s.slice(0, max);
		const cut = s.lastIndexOf("-");
		if (cut > max / 2) s = s.slice(0, cut);
	}
	return s || "note";
}
