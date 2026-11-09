/**
 * The curator's hands: operations proposed by the model are validated here
 * and applied by plain code — notes are edited item by item, never rewritten
 * wholesale, so memory cannot "collapse" into a short generic summary.
 *
 * Invariants: every note keeps its evidence; superseded and deprecated notes
 * stay on disk with `valid_until`; near-duplicates are merged into the
 * existing note; text with credentials or prompt-injection patterns is
 * refused; indexes are regenerated from front matter within budget.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildIndex, type IndexResult } from "./memindex.ts";
import {
	type Evidence,
	INDEX_MODES,
	type IndexMode,
	isNoteId,
	listScopes,
	loadNotes,
	type Note,
	NOTE_TYPES,
	type NoteType,
	newNoteId,
	serializeNote,
	slugify,
} from "./notes.ts";
import { CHARTER_FILE, GLOBAL_SCOPE, INDEX_FILE, projectScope, SCOPE_META_FILE, scopeDir } from "./layout.ts";
import { findInjection, findSecrets } from "./secrets.ts";
import { tokenize } from "./search.ts";

export type OpKind = "add" | "update" | "supersede" | "deprecate" | "confirm" | "agents_md" | "skill";

export interface EvidenceRef {
	s: string;
	e: string[];
}

export interface NoteFields {
	type?: NoteType;
	title?: string;
	body?: string;
	when?: string;
	index?: IndexMode;
}

interface BaseOp {
	ref: string;
	rationale: string;
	evidence: EvidenceRef[];
}

export interface AddOp extends BaseOp, NoteFields {
	op: "add";
	/** `global`, `project` or an existing scope id. */
	scope: string;
	title: string;
}
export interface UpdateOp extends BaseOp, NoteFields {
	op: "update";
	id: string;
	/** Move the note: `global`, `project`, `project:<key>` or a scope id. */
	scope?: string;
}
export interface SupersedeOp extends BaseOp {
	op: "supersede";
	id: string;
	replacement: NoteFields & { title: string };
}
export interface DeprecateOp extends BaseOp {
	op: "deprecate";
	id: string;
}
export interface ConfirmOp extends BaseOp {
	op: "confirm";
	id: string;
}
export interface AgentsMdOp extends BaseOp {
	op: "agents_md";
	/** Pull request title. */
	summary?: string;
	edits: Array<{ old: string; new: string }>;
}
export interface SkillOp extends BaseOp {
	op: "skill";
	scope: string;
	name: string;
	description: string;
	body: string;
}

export type Op = AddOp | UpdateOp | SupersedeOp | DeprecateOp | ConfirmOp | AgentsMdOp | SkillOp;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
	typeof v === "string" && (list as readonly string[]).includes(v);
const optStr = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function parseEvidenceRefs(v: unknown): EvidenceRef[] {
	if (!Array.isArray(v)) return [];
	const out: EvidenceRef[] = [];
	for (const item of v) {
		if (!isObj(item) || typeof item.s !== "string" || !item.s.trim()) continue;
		const e = Array.isArray(item.e) ? item.e : typeof item.e === "string" ? [item.e] : [];
		out.push({
			s: item.s.trim(),
			e: e.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim().replace(/^\[|\]$/g, "")),
		});
	}
	return out;
}

function noteFields(o: Record<string, unknown>): NoteFields {
	return {
		type: oneOf(NOTE_TYPES, o.type) ? o.type : undefined,
		title: optStr(o.title),
		body: typeof o.body === "string" ? o.body.trim() : undefined,
		when: optStr(o.when),
		index: oneOf(INDEX_MODES, o.index) ? o.index : undefined,
	};
}

export interface ParsedOps {
	ops: Op[];
	problems: string[];
	unhandled: Array<{ comment: string; reason: string }>;
}

/** Validate a curator reply. Throws only when the shape is unusable (so the model is asked again). */
export function parseOps(raw: unknown): ParsedOps {
	if (!isObj(raw) || !Array.isArray(raw.ops)) throw new Error('expected an object {"ops": [...]}');
	const ops: Op[] = [];
	const problems: string[] = [];
	const refs = new Set<string>();
	raw.ops.forEach((item, i) => {
		if (!isObj(item)) return problems.push(`op ${i + 1}: not an object`);
		let ref = optStr(item.ref) ?? `op${i + 1}`;
		if (refs.has(ref)) ref = `${ref}-${i + 1}`;
		refs.add(ref);
		const base: BaseOp = { ref, rationale: optStr(item.rationale) ?? "", evidence: parseEvidenceRefs(item.evidence) };
		const id = optStr(item.id);
		const bad = (why: string) => problems.push(`${ref} (${String(item.op)}): ${why}`);
		switch (item.op) {
			case "add": {
				const f = noteFields(item);
				const scope = optStr(item.scope);
				if (!f.title) return bad("missing title");
				if (!scope) return bad("missing scope");
				ops.push({ ...base, op: "add", ...f, title: f.title, scope });
				return;
			}
			case "update":
				if (!isNoteId(id)) return bad("invalid id");
				ops.push({ ...base, op: "update", id, ...noteFields(item), scope: optStr(item.scope) });
				return;
			case "supersede": {
				if (!isNoteId(id)) return bad("invalid id");
				const r = isObj(item.replacement) ? noteFields(item.replacement) : {};
				if (!r.title) return bad("replacement needs a title");
				ops.push({ ...base, op: "supersede", id, replacement: { ...r, title: r.title } });
				return;
			}
			case "deprecate":
			case "confirm":
				if (!isNoteId(id)) return bad("invalid id");
				ops.push({ ...base, op: item.op, id });
				return;
			case "agents_md": {
				const edits = (Array.isArray(item.edits) ? item.edits : [])
					.filter(isObj)
					.filter((e) => typeof e.old === "string" && typeof e.new === "string")
					.map((e) => ({ old: e.old as string, new: e.new as string }));
				if (!edits.length) return bad("no edits");
				ops.push({ ...base, op: "agents_md", summary: optStr(item.summary)?.slice(0, 90), edits });
				return;
			}
			case "skill": {
				const name = optStr(item.name);
				const description = optStr(item.description);
				const body = optStr(item.body);
				const scope = optStr(item.scope) ?? "project";
				if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) return bad("invalid skill name");
				if (!description || !body) return bad("skill needs description and body");
				ops.push({ ...base, op: "skill", scope, name, description: description.slice(0, 1024), body });
				return;
			}
			default:
				bad("unknown op");
		}
	});
	const unhandled = (Array.isArray(raw.unhandled) ? raw.unhandled : [])
		.filter(isObj)
		.map((u) => ({ comment: String(u.comment ?? ""), reason: String(u.reason ?? "") }));
	return { ops, problems, unhandled };
}

/** Token-set Jaccard similarity of two titles. */
export function similarity(a: string, b: string): number {
	const A = new Set(tokenize(a));
	const B = new Set(tokenize(b));
	if (!A.size || !B.size) return 0;
	let inter = 0;
	for (const t of A) if (B.has(t)) inter++;
	return inter / (A.size + B.size - inter);
}

export const DUPLICATE_THRESHOLD = 0.72;
export const MAX_TITLE = 240;
export const MAX_BODY = 4000;

/** Problems that make text unacceptable as memory. */
export function lintText(text: string): string[] {
	const out: string[] = [];
	const secrets = findSecrets(text);
	if (secrets.length) out.push(`contains credentials (${secrets.join(", ")})`);
	const inj = findInjection(text);
	if (inj.length) out.push(`contains a prompt-injection phrase (${inj.join(", ")})`);
	return out;
}

function evKey(e: Evidence): string {
	return `${e.s}|${[...e.e].sort().join(",")}`;
}

function mergeEvidence(into: Evidence[], add: Evidence[]): number {
	const seen = new Set(into.map(evKey));
	let n = 0;
	for (const e of add) {
		const k = evKey(e);
		if (seen.has(k)) continue;
		seen.add(k);
		into.push(e);
		n++;
	}
	return n;
}

export type ChangeKind = "added" | "merged" | "updated" | "moved" | "superseded" | "deprecated" | "removed" | "confirmed" | "skill";

export interface Change {
	kind: ChangeKind;
	ref: string;
	scope: string;
	noteId?: string;
	title: string;
	/** For superseded: the replacement's id. */
	newId?: string;
	/** For moved: the scope the note left. */
	from?: string;
	/** For updated: the title before, when it changed. */
	oldTitle?: string;
	file?: string;
	note?: string;
}

export class Workspace {
	readonly notes = new Map<string, Note[]>();
	readonly ids = new Set<string>();
	private dirty = new Set<Note>();
	private files = new Map<string, string>();
	private metas = new Map<string, Record<string, unknown>>();
	private removed = new Set<string>();
	/** Notes that exist only in the open pull request (not yet approved). */
	pending = new Set<string>();

	constructor(
		readonly root: string,
		readonly date: string,
	) {
		for (const s of listScopes(root)) this.scope(s);
		this.scope(GLOBAL_SCOPE);
	}

	scope(scope: string): Note[] {
		let list = this.notes.get(scope);
		if (!list) {
			list = loadNotes(this.root, scope);
			this.notes.set(scope, list);
			for (const n of list) if (n.id) this.ids.add(n.id);
		}
		return list;
	}

	/** Register a project scope; its `scope.json` is written once it holds a note. */
	ensureScope(scope: string, meta?: Record<string, unknown>): void {
		this.scope(scope);
		if (meta) this.metas.set(scope, meta);
	}

	all(): Note[] {
		return [...this.notes.values()].flat();
	}

	find(id: string): Note | undefined {
		return this.all().find((n) => n.id === id);
	}

	/** Fill ids and dates of hand-written notes. Returns the notes it touched. */
	normalize(): Note[] {
		const touched: Note[] = [];
		for (const n of this.all()) {
			let changed = false;
			if (!n.id) {
				n.id = newNoteId(this.ids);
				changed = true;
			}
			if (!n.created) {
				n.created = this.date;
				changed = true;
			}
			if (!n.updated) {
				n.updated = n.created;
				changed = true;
			}
			if (changed) {
				this.dirty.add(n);
				touched.push(n);
			}
		}
		return touched;
	}

	private uniqueFile(scope: string, title: string): string {
		const base = slugify(title);
		const dir = join(scopeDir(this.root, scope), "notes");
		const taken = new Set(this.scope(scope).map((n) => n.file.split("/").pop()));
		let name = `${base}.md`;
		for (let i = 2; taken.has(name) || existsSync(join(dir, name)); i++) name = `${base}-${i}.md`;
		return join("scopes", scope, "notes", name);
	}

	createNote(scope: string, f: NoteFields & { title: string }, evidence: Evidence[]): Note {
		const note: Note = {
			id: newNoteId(this.ids),
			title: f.title,
			type: f.type ?? "fact",
			status: "active",
			index: f.index ?? "none",
			when: f.when,
			created: this.date,
			updated: this.date,
			stats: { helpful: 0, harmful: 0 },
			evidence: [...evidence],
			body: f.body ?? "",
			file: this.uniqueFile(scope, f.title),
			scope,
			extra: {},
			problems: [],
		};
		this.scope(scope).push(note);
		this.dirty.add(note);
		return note;
	}

	touch(n: Note): void {
		this.dirty.add(n);
	}

	/** Move a note to another scope; id, evidence and history stay. */
	moveNote(n: Note, scope: string): void {
		const from = this.scope(n.scope);
		const i = from.indexOf(n);
		if (i >= 0) from.splice(i, 1);
		this.removed.add(n.file);
		n.scope = scope;
		n.file = this.uniqueFile(scope, n.title);
		this.removed.delete(n.file);
		this.scope(scope).push(n);
		this.dirty.add(n);
	}

	/** Drop a note that was never approved (only exists in the open pull request). */
	removeNote(n: Note): void {
		const list = this.scope(n.scope);
		const i = list.indexOf(n);
		if (i >= 0) list.splice(i, 1);
		this.dirty.delete(n);
		this.removed.add(n.file);
	}

	writeFile(absPath: string, content: string): void {
		this.files.set(absPath, content);
	}

	removeFile(absPath: string): void {
		this.files.delete(absPath);
		this.removed.add(absPath.slice(this.root.length + 1));
	}

	/** Write changed notes and files; returns repo-relative paths written. */
	flush(): string[] {
		const out: string[] = [];
		for (const rel of this.removed) {
			const abs = join(this.root, rel);
			if (existsSync(abs)) {
				rmSync(abs);
				out.push(rel);
			}
		}
		this.removed.clear();
		for (const [scope, meta] of this.metas) {
			const metaPath = join(scopeDir(this.root, scope), SCOPE_META_FILE);
			if (this.scope(scope).length && !existsSync(metaPath)) this.files.set(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
		}
		for (const n of this.dirty) {
			const abs = join(this.root, n.file);
			mkdirSync(dirname(abs), { recursive: true });
			const text = serializeNote(n);
			if (!existsSync(abs) || readFileSync(abs, "utf-8") !== text) {
				writeFileSync(abs, text, "utf-8");
				out.push(n.file);
			}
		}
		this.dirty.clear();
		for (const [abs, content] of this.files) {
			mkdirSync(dirname(abs), { recursive: true });
			if (!existsSync(abs) || readFileSync(abs, "utf-8") !== content) {
				writeFileSync(abs, content, "utf-8");
				out.push(abs.slice(this.root.length + 1));
			}
		}
		this.files.clear();
		return out;
	}
}

export interface ApplyContext {
	/** Scope id that "project" refers to in this pass. */
	projectScope?: string;
	evidence: Evidence[];
	/** Corrections from the fact checker. */
	fix?: { title?: string; body?: string; scope?: string };
}

export type ApplyResult = { ok: true; change: Change } | { ok: false; reason: string };

function cleanFields<T extends NoteFields>(f: T): T {
	const out = { ...f };
	if (out.title && out.title.length > MAX_TITLE) out.title = `${out.title.slice(0, MAX_TITLE - 1)}…`;
	if (out.body && out.body.length > MAX_BODY) out.body = `${out.body.slice(0, MAX_BODY - 1)}…`;
	return out;
}

/** `global` | `project` (this pass) | `project:<key>` | an existing scope id → scope id. */
export function resolveScope(ws: Workspace, scope: string, thisProject?: string): string | undefined {
	if (scope === "global") return GLOBAL_SCOPE;
	if (scope === "project") return thisProject;
	if (scope.startsWith("project:") && scope.length > 8) {
		const id = projectScope(scope.slice(8));
		ws.scope(id);
		return id;
	}
	if (ws.notes.has(scope)) return scope;
	return undefined;
}

export function applyOp(ws: Workspace, op: Op, actx: ApplyContext): ApplyResult {
	const fix = actx.fix ?? {};
	const ev = actx.evidence;
	switch (op.op) {
		case "add": {
			const scope = resolveScope(ws, fix.scope ?? op.scope, actx.projectScope);
			if (!scope) return { ok: false, reason: `unknown scope ${fix.scope ?? op.scope}` };
			const f = cleanFields({ ...op, title: fix.title ?? op.title, body: fix.body ?? op.body });
			const problems = lintText(`${f.title}\n${f.body ?? ""}\n${f.when ?? ""}`);
			if (problems.length) return { ok: false, reason: problems.join("; ") };
			const dup = ws
				.scope(scope)
				.filter((n) => n.status === "active")
				.map((n) => ({ n, s: similarity(n.title, f.title) }))
				.sort((a, b) => b.s - a.s)[0];
			if (dup && dup.s >= DUPLICATE_THRESHOLD) {
				mergeEvidence(dup.n.evidence, ev);
				dup.n.confirmed = ws.date;
				ws.touch(dup.n);
				return { ok: true, change: { kind: "merged", ref: op.ref, scope, noteId: dup.n.id, title: dup.n.title, note: `duplicate of ${dup.n.id}` } };
			}
			const note = ws.createNote(scope, f, ev);
			return { ok: true, change: { kind: "added", ref: op.ref, scope, noteId: note.id, title: note.title, file: note.file } };
		}
		case "update": {
			const n = ws.find(op.id);
			if (!n) return { ok: false, reason: `no note ${op.id}` };
			const f = cleanFields({ ...op, title: fix.title ?? op.title, body: fix.body ?? op.body });
			const problems = lintText(`${f.title ?? ""}\n${f.body ?? ""}\n${f.when ?? ""}`);
			if (problems.length) return { ok: false, reason: problems.join("; ") };
			const target = fix.scope ?? op.scope;
			const to = target ? resolveScope(ws, target, actx.projectScope) : undefined;
			if (target && !to) return { ok: false, reason: `unknown scope ${target}` };
			const oldTitle = f.title && f.title !== n.title ? n.title : undefined;
			if (f.title) n.title = f.title;
			if (f.body !== undefined) n.body = f.body;
			if (f.when) n.when = f.when;
			if (f.index) n.index = f.index;
			if (f.type) n.type = f.type;
			mergeEvidence(n.evidence, ev);
			n.updated = ws.date;
			ws.touch(n);
			const from = n.scope;
			if (to && to !== n.scope) ws.moveNote(n, to);
			const moved = n.scope !== from;
			return {
				ok: true,
				change: { kind: moved ? "moved" : "updated", ref: op.ref, scope: n.scope, noteId: n.id, title: n.title, file: n.file, from: moved ? from : undefined, oldTitle },
			};
		}
		case "supersede": {
			const old = ws.find(op.id);
			if (!old) return { ok: false, reason: `no note ${op.id}` };
			if (old.status !== "active") return { ok: false, reason: `${op.id} is already ${old.status}` };
			const f = cleanFields({ ...op.replacement, title: fix.title ?? op.replacement.title, body: fix.body ?? op.replacement.body });
			const problems = lintText(`${f.title}\n${f.body ?? ""}`);
			if (problems.length) return { ok: false, reason: problems.join("; ") };
			const repl = ws.createNote(old.scope, { type: old.type, index: old.index, when: old.when, ...f }, ev);
			repl.supersedes = [old.id];
			old.status = "superseded";
			old.validUntil = ws.date;
			old.supersededBy = repl.id;
			old.updated = ws.date;
			ws.touch(old);
			return {
				ok: true,
				change: { kind: "superseded", ref: op.ref, scope: old.scope, noteId: old.id, newId: repl.id, title: repl.title, file: repl.file },
			};
		}
		case "deprecate": {
			const n = ws.find(op.id);
			if (!n) return { ok: false, reason: `no note ${op.id}` };
			if (ws.pending.has(n.id)) {
				ws.removeNote(n);
				return { ok: true, change: { kind: "removed", ref: op.ref, scope: n.scope, noteId: n.id, title: n.title, file: n.file } };
			}
			if (n.pinned) return { ok: false, reason: `${op.id} is pinned` };
			if (n.status !== "active") return { ok: false, reason: `${op.id} is already ${n.status}` };
			n.status = "deprecated";
			n.validUntil = ws.date;
			n.updated = ws.date;
			mergeEvidence(n.evidence, ev);
			ws.touch(n);
			return { ok: true, change: { kind: "deprecated", ref: op.ref, scope: n.scope, noteId: n.id, title: n.title, file: n.file } };
		}
		case "confirm": {
			const n = ws.find(op.id);
			if (!n) return { ok: false, reason: `no note ${op.id}` };
			const added = mergeEvidence(n.evidence, ev);
			if (!added) return { ok: false, reason: "no new evidence" };
			n.confirmed = ws.date;
			ws.touch(n);
			return { ok: true, change: { kind: "confirmed", ref: op.ref, scope: n.scope, noteId: n.id, title: n.title, file: n.file } };
		}
		case "skill": {
			const scope = resolveScope(ws, op.scope, actx.projectScope);
			if (!scope) return { ok: false, reason: `unknown scope ${op.scope}` };
			const problems = lintText(`${op.description}\n${op.body}`);
			if (problems.length) return { ok: false, reason: problems.join("; ") };
			const rel = join("scopes", scope, "skills", op.name, "SKILL.md");
			const content = `---\nname: ${op.name}\ndescription: ${JSON.stringify(op.description)}\n---\n\n${op.body.trim()}\n`;
			ws.writeFile(join(ws.root, rel), content);
			return { ok: true, change: { kind: "skill", ref: op.ref, scope, title: `${op.name}: ${op.description}`, file: rel } };
		}
		case "agents_md":
			return { ok: false, reason: "agents_md is published separately" };
	}
}

/** Record helpful / harmful votes from session cards on existing notes. */
export function applyVotes(ws: Workspace, votes: Array<{ id: string; effect: string }>): number {
	let n = 0;
	for (const v of votes) {
		const note = ws.find(v.id);
		if (!note) continue;
		if (v.effect === "helpful") note.stats.helpful++;
		else if (v.effect === "harmful" || v.effect === "stale") note.stats.harmful++;
		else continue;
		ws.touch(note);
		n++;
	}
	return n;
}

export interface IndexStat extends IndexResult {
	scope: string;
	budget: number;
	changed: boolean;
}

/** Regenerate `MEMORY.md` of every scope; returns per-scope stats. */
export function regenerateIndexes(ws: Workspace, budgets: { globalTokens: number; projectTokens: number }, titleOf: (scope: string) => string): IndexStat[] {
	const out: IndexStat[] = [];
	for (const [scope, notes] of ws.notes) {
		const dir = scopeDir(ws.root, scope);
		if (scope !== GLOBAL_SCOPE && !notes.length) {
			// A project scope left without notes (all moved or removed in the open PR) disappears,
			// unless the user keeps a charter or skills there.
			if (existsSync(dir) && !existsSync(join(dir, "skills")) && !existsSync(join(dir, CHARTER_FILE))) {
				for (const f of [INDEX_FILE, SCOPE_META_FILE]) if (existsSync(join(dir, f))) ws.removeFile(join(dir, f));
			}
			continue;
		}
		const budget = scope === GLOBAL_SCOPE ? budgets.globalTokens : budgets.projectTokens;
		const res = buildIndex(notes, titleOf(scope), budget);
		const path = join(dir, INDEX_FILE);
		const changed = !existsSync(path) || readFileSync(path, "utf-8") !== res.text;
		if (changed) ws.writeFile(path, res.text);
		out.push({ ...res, scope, budget, changed });
	}
	return out;
}
