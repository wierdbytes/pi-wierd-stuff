/**
 * One dream, end to end. Runs inside a headless pi process (`runner.ts`).
 *
 * 1. sync the memory repo; learn from the previous pull request (merged →
 *    accepted, closed → its notes are rejected)
 * 2. read new review comments on the open pull request
 * 3. rebuild digests of changed sessions (search corpus for everything)
 * 4. summarize pending sessions into cards (cheap model, cached)
 * 5. review pass: turn review comments into operations
 * 6. per project: the curator proposes operations (strong model) with
 *    history hits from older sessions; cited evidence is looked up in the raw
 *    sessions; an independent model checks every operation against it
 * 7. code applies what passed, regenerates the indexes within budget
 * 8. commit on the review branch, push, open or update the pull request;
 *    AGENTS.md edits become pull requests in the projects' repositories
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AgentsEdit, findContextFile, openAgentsPr, publishAgentsEdits, renderEditsDiff } from "./agentsmd.ts";
import { type DreamConfig, loadConfig } from "./config.ts";
import { type AgentsMdOp, applyOp, applyVotes, type IndexStat, type Op, type ParsedOps, parseOps, regenerateIndexes, Workspace } from "./curate.ts";
import { buildDigest, clipHead, digestHeader, renderDigest, renderEntryFull } from "./digest.ts";
import { gh, ghJson, ghOk, git, githubRepoOf, gitOk } from "./gitops.ts";
import { type InboxItem, readInbox } from "./inbox.ts";
import { CHARTER_FILE, GLOBAL_SCOPE, keyToDir, type MemoryPaths, memoryPaths, newRunId, projectScope, SCOPE_META_FILE, scopeDir, today } from "./layout.ts";
import { Llm } from "./llm.ts";
import { acquireLock, releaseLock } from "./lock.ts";
import { buildIndex } from "./memindex.ts";
import type { Evidence, Note } from "./notes.ts";
import { resolveProject, shortKey } from "./project.ts";
import { ProjectMap } from "./projects.ts";
import { DEFAULT_GLOBAL_CHARTER, DEFAULT_PROJECT_CHARTER, systemPrompt } from "./prompts.ts";
import { prTitle, type ReportAgents, type ReportChange, type ReportData, type ReportRejected, type ReportSession, renderReport } from "./report.ts";
import { pendingInbox, pendingSessions } from "./scheduler.ts";
import { Bm25, chunkDigest, type Doc, snippet } from "./search.ts";
import { listSessionFiles, parseSession, SessionCache, type SessionFile, sessionIdFromPath } from "./sessions.ts";
import { type DreamState, freshState, loadState, saveState } from "./state.ts";

const MINUTE = 60_000;
const DAY = 86_400_000;

export interface RunOptions {
	runId?: string;
	dryRun?: boolean;
	sinceDays?: number;
	maxSessions?: number;
	reindexOnly?: boolean;
	/** Apply new review comments on the open pull request; no new sessions. */
	reviewOnly?: boolean;
}

export function parseRunArgs(args: string): RunOptions {
	const t = args.trim().split(/\s+/).filter(Boolean);
	const o: RunOptions = {};
	for (let i = 0; i < t.length; i++) {
		const a = t[i];
		if (a === "--run-id") o.runId = t[++i];
		else if (a === "--dry-run" || a === "--dry") o.dryRun = true;
		else if (a === "--reindex") o.reindexOnly = true;
		else if (a === "--review-only") o.reviewOnly = true;
		else if (a === "--since") o.sinceDays = Number(t[++i]);
		else if (a === "--max") o.maxSessions = Number(t[++i]);
	}
	if (o.sinceDays !== undefined && !Number.isFinite(o.sinceDays)) delete o.sinceDays;
	if (o.maxSessions !== undefined && !(o.maxSessions > 0)) delete o.maxSessions;
	return o;
}

// ── digests ──────────────────────────────────────────────────────────────

/** Bump when the digest format or its record changes: every digest is rebuilt. */
export const DIGEST_VERSION = 3;

export interface DigestRecord {
	v?: number;
	size: number;
	mtimeMs: number;
	sessionId: string;
	/** Project of the session's cwd. */
	projectKey: string;
	/** Root of that project (repo root or cwd). */
	root?: string;
	/** The root is a real project (git repo or project markers). */
	project?: boolean;
	dir: string;
	cwd: string;
	started: string;
	name?: string;
	userMessages: number;
	toolCalls: number;
	/** Paths the session worked with, most used first. */
	paths?: Array<[string, number]>;
	error?: string;
}

export type DigestIndex = Record<string, DigestRecord>;

export function loadDigestIndex(path: string): DigestIndex {
	try {
		return existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as DigestIndex) : {};
	} catch {
		return {};
	}
}

function saveJson(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 1)}\n`, "utf-8");
}

export function digestFile(P: MemoryPaths, rec: Pick<DigestRecord, "dir" | "sessionId">): string {
	return join(P.digests, rec.dir, `${rec.sessionId}.txt`);
}

/** Project roots known from every session's cwd (existing ones only). */
export function knownProjects(digests: DigestIndex): ProjectMap {
	const byRoot = new Map<string, { key: string; project: boolean }>();
	for (const rec of Object.values(digests))
		if (rec.root && rec.projectKey && !byRoot.has(rec.root)) byRoot.set(rec.root, { key: rec.projectKey, project: rec.project === true });
	return new ProjectMap([...byRoot.entries()].filter(([r]) => existsSync(r)).map(([root, v]) => ({ root, key: v.key, project: v.project })));
}

async function updateDigests(files: SessionFile[], P: MemoryPaths, log: (m: string) => void, signal: AbortSignal): Promise<DigestIndex> {
	const idx = loadDigestIndex(P.digestIndex);
	const live = new Set(files.map((f) => f.path));
	for (const [k, rec] of Object.entries(idx)) {
		if (live.has(k)) continue;
		if (rec.dir) rmSync(digestFile(P, rec), { force: true });
		delete idx[k];
	}
	const stale = files.filter((f) => idx[f.path]?.size !== f.size || idx[f.path]?.v !== DIGEST_VERSION);
	if (stale.length) log(`digests: rebuilding ${stale.length} of ${files.length} sessions`);
	let n = 0;
	for (const f of stale) {
		if (signal.aborted) break;
		try {
			const s = await parseSession(f.path);
			if (!s) {
				idx[f.path] = {
					v: DIGEST_VERSION,
					size: f.size,
					mtimeMs: f.mtimeMs,
					sessionId: sessionIdFromPath(f.path),
					projectKey: "",
					dir: "",
					cwd: "",
					started: "",
					userMessages: 0,
					toolCalls: 0,
					error: "no header",
				};
				continue;
			}
			const proj = await resolveProject(s.header.cwd);
			const d = buildDigest(s);
			const dir = keyToDir(proj.key);
			const prev = idx[f.path];
			if (prev?.dir && prev.dir !== dir) rmSync(digestFile(P, prev), { force: true });
			const rec: DigestRecord = {
				v: DIGEST_VERSION,
				size: f.size,
				mtimeMs: f.mtimeMs,
				sessionId: s.header.id,
				projectKey: proj.key,
				root: proj.exists ? proj.root : undefined,
				project: proj.project,
				dir,
				cwd: s.header.cwd,
				started: s.header.timestamp,
				name: s.name,
				userMessages: d.meta.userMessages,
				toolCalls: d.meta.toolCalls,
				paths: d.meta.paths,
			};
			mkdirSync(join(P.digests, dir), { recursive: true });
			writeFileSync(digestFile(P, rec), `${digestHeader(d.meta, proj.key)}\n${renderDigest(d)}\n`, "utf-8");
			idx[f.path] = rec;
		} catch (err) {
			log(`  ! digest ${f.path}: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (++n % 200 === 0) {
			saveJson(P.digestIndex, idx);
			log(`  digests ${n}/${stale.length}`);
		}
	}
	saveJson(P.digestIndex, idx);
	return idx;
}

// ── cards ────────────────────────────────────────────────────────────────

export interface Learning {
	n: string;
	kind: string;
	scope: "global" | "project";
	statement: string;
	details?: string;
	evidence: string[];
	source: "user" | "observed";
	confidence: string;
	why?: string;
}

export interface Card {
	sessionId: string;
	file: string;
	size: number;
	projectKey: string;
	date: string;
	title: string;
	summary: string;
	outcome: { status: string; signals: string[] };
	feedback: Array<{ entry: string; kind: string; quote: string }>;
	learnings: Learning[];
	memoryFeedback: Array<{ id: string; effect: string; entry?: string; note?: string }>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const s = (v: unknown, max = 2000): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function validateCard(raw: unknown, ids: Set<string>, base: Pick<Card, "sessionId" | "file" | "size" | "projectKey" | "date">, fallbackTitle: string): Card {
	if (!isObj(raw)) throw new Error("expected a JSON object");
	const cleanId = (x: unknown) => s(x, 80).replace(/^\[|\]$/g, "");
	const outcome = isObj(raw.outcome) ? raw.outcome : {};
	const learnings: Learning[] = [];
	(Array.isArray(raw.learnings) ? raw.learnings : []).forEach((l) => {
		if (!isObj(l) || !s(l.statement)) return;
		const evidence = (Array.isArray(l.evidence) ? l.evidence : []).map(cleanId).filter((id) => ids.has(id));
		if (!evidence.length) return;
		learnings.push({
			n: `L${learnings.length + 1}`,
			kind: s(l.kind, 30) || "fact",
			scope: l.scope === "global" ? "global" : "project",
			statement: s(l.statement, 600),
			details: s(l.details, 1500) || undefined,
			evidence,
			source: l.source === "user" ? "user" : "observed",
			confidence: s(l.confidence, 10) || "medium",
			why: s(l.why, 400) || undefined,
		});
	});
	return {
		...base,
		title: s(raw.title, 120) || fallbackTitle,
		summary: s(raw.summary, 800),
		outcome: {
			status: s(outcome.status, 20) || "unclear",
			signals: (Array.isArray(outcome.signals) ? outcome.signals : []).map((x) => s(x, 300)).filter(Boolean),
		},
		feedback: (Array.isArray(raw.feedback) ? raw.feedback : [])
			.filter(isObj)
			.map((f) => ({ entry: cleanId(f.entry), kind: s(f.kind, 20), quote: s(f.quote, 400) }))
			.filter((f) => ids.has(f.entry) && f.quote),
		learnings,
		memoryFeedback: (Array.isArray(raw.memory_feedback) ? raw.memory_feedback : [])
			.filter(isObj)
			.map((f) => ({ id: s(f.id, 20), effect: s(f.effect, 10), entry: cleanId(f.entry) || undefined, note: s(f.note, 300) || undefined }))
			.filter((f) => /^m-[0-9a-f]{6,12}$/.test(f.id) && ["helpful", "harmful", "stale"].includes(f.effect)),
	};
}

async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i], i);
		}
	};
	await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
	return out;
}

// ── evidence & verification ──────────────────────────────────────────────

interface ReviewComment {
	id: string;
	author: string;
	at: string;
	body: string;
	path?: string;
	line?: number;
}

interface EvidenceDeps {
	sessions: SessionCache;
	fileBySession: Map<string, string>;
	inboxById: Map<string, InboxItem>;
	comments: Map<string, ReviewComment>;
	pr?: number;
}

interface Resolved {
	op: Op;
	evidence: Evidence[];
	excerpts: string;
	error?: string;
}

function findSessionFile(deps: EvidenceDeps, id: string): string | undefined {
	const hit = deps.fileBySession.get(id);
	if (hit || id.length < 8) return hit;
	for (const [sid, file] of deps.fileBySession) if (sid.startsWith(id)) return file;
	return undefined;
}

async function resolveOp(op: Op, deps: EvidenceDeps): Promise<Resolved> {
	const evidence: Evidence[] = [];
	const parts: string[] = [];
	const fail = (error: string): Resolved => ({ op, evidence, excerpts: "", error });
	if (!op.evidence.length) return fail("no evidence cited");
	for (const ref of op.evidence) {
		if (ref.s.startsWith("inbox:")) {
			const item = deps.inboxById.get(ref.s.slice(6));
			if (!item) return fail(`unknown inbox item ${ref.s}`);
			const who = item.source === "user" ? "written by the user with /remember" : "saved by the agent with memory_inbox";
			parts.push(`--- ${ref.s} (${who}, ${item.ts}, cwd ${item.cwd}) ---`, item.text);
			if (item.sessionFile && item.entryId && existsSync(item.sessionFile)) {
				const sess = await deps.sessions.get(item.sessionFile);
				const i = sess?.branch.findIndex((e) => e.id === item.entryId) ?? -1;
				if (sess && i >= 0) {
					parts.push("(session context before the item was saved)");
					for (let k = Math.max(0, i - 5); k <= i; k++) parts.push(renderEntryFull(sess.branch[k], 1200));
				}
			}
			evidence.push({ s: ref.s, e: [], date: item.ts.slice(0, 10), kind: item.source === "user" ? "user" : "inbox" });
			continue;
		}
		if (ref.s.startsWith("pr#")) {
			const comment = ref.e.map((id) => deps.comments.get(id)).find(Boolean);
			if (!comment) return fail(`unknown review comment ${ref.e.join(",")}`);
			parts.push(`--- review comment ${comment.id} by ${comment.author} (${comment.at}) ---`, comment.body);
			evidence.push({ s: ref.s, e: [comment.id], date: comment.at.slice(0, 10), kind: "reviewer" });
			continue;
		}
		const file = findSessionFile(deps, ref.s);
		if (!file) return fail(`unknown session ${ref.s}`);
		const sess = await deps.sessions.get(file);
		if (!sess) return fail(`unreadable session ${ref.s}`);
		if (!ref.e.length) return fail(`no entry ids for session ${ref.s.slice(0, 8)}`);
		const pos = new Map(sess.branch.map((e, i) => [e.id, i]));
		const shown = new Set<number>();
		let isUser = false;
		let date: string | undefined;
		parts.push(`--- session ${sess.header.id} (${sess.header.timestamp.slice(0, 10)}, cwd ${sess.header.cwd}) ---`);
		for (const id of ref.e) {
			const i = pos.get(id);
			if (i === undefined) return fail(`entry ${id} is not in session ${ref.s.slice(0, 8)}`);
			const e = sess.branch[i];
			const isUserEntry = e.message?.role === "user";
			for (let k = Math.max(0, i - (isUserEntry ? 2 : 1)); k <= i; k++) {
				if (shown.has(k)) continue;
				shown.add(k);
				parts.push(renderEntryFull(sess.branch[k], k === i ? 4000 : 1500));
			}
			if (isUserEntry) isUser = true;
			date ??= e.timestamp?.slice(0, 10);
		}
		evidence.push({ s: sess.header.id, e: [...new Set(ref.e)], date: date ?? sess.header.timestamp.slice(0, 10), kind: isUser ? "user" : "observed" });
	}
	return { op, evidence, excerpts: clipHead(parts.join("\n"), 16_000) };
}

interface Verdict {
	ref: string;
	verdict: "supported" | "partial" | "unsupported" | "contradicted";
	unsafe: boolean;
	reason: string;
	fix?: { title?: string; body?: string; scope?: string };
}

function validateVerdicts(raw: unknown): Verdict[] {
	if (!isObj(raw) || !Array.isArray(raw.verdicts)) throw new Error('expected {"verdicts": [...]}');
	const kinds = ["supported", "partial", "unsupported", "contradicted"];
	return raw.verdicts.filter(isObj).flatMap((v) => {
		const verdict = s(v.verdict, 20);
		if (!s(v.ref, 40) || !kinds.includes(verdict)) return [];
		const scope = s(v.fix && isObj(v.fix) ? v.fix.scope : undefined, 200);
		const fix = isObj(v.fix)
			? {
					title: s(v.fix.title, 300) || undefined,
					body: s(v.fix.body, 4000) || undefined,
					scope: scope === "global" || scope === "project" || scope.startsWith("project:") ? scope : undefined,
				}
			: undefined;
		return [{ ref: s(v.ref, 40), verdict: verdict as Verdict["verdict"], unsafe: v.unsafe === true, reason: s(v.reason, 600), fix }];
	});
}

function noteForPrompt(n: Note) {
	return {
		id: n.id,
		type: n.type,
		index: n.index,
		title: n.title,
		...(n.when ? { when: n.when } : {}),
		body: clipHead(n.body, 700),
		evidence: n.evidence.length,
		updated: n.updated,
		...(n.pinned ? { pinned: true } : {}),
		...(n.stats.helpful || n.stats.harmful ? { stats: n.stats } : {}),
	};
}

function opTitle(op: Op): string {
	switch (op.op) {
		case "add":
			return op.title;
		case "update":
			return op.title ?? op.id;
		case "supersede":
			return op.replacement.title;
		case "skill":
			return op.name;
		case "agents_md":
			return `AGENTS.md (${op.edits.length} edit(s))`;
		default:
			return op.id;
	}
}

function proposalForCheck(op: Op, ws: Workspace) {
	const current = "id" in op ? ws.find(op.id) : undefined;
	const base = { ref: op.ref, op: op.op, rationale: op.rationale, ...(current ? { current_note: noteForPrompt(current) } : {}) };
	switch (op.op) {
		case "add":
			return { ...base, scope: op.scope, proposal: { type: op.type, title: op.title, body: op.body, when: op.when, index: op.index } };
		case "update":
			return { ...base, ...(op.scope ? { scope: op.scope } : {}), proposal: { type: op.type, title: op.title, body: op.body, when: op.when, index: op.index } };
		case "supersede":
			return { ...base, proposal: op.replacement };
		case "skill":
			return { ...base, scope: op.scope, proposal: { name: op.name, description: op.description, body: op.body } };
		case "agents_md":
			return { ...base, proposal: { edits: op.edits } };
		default:
			return base;
	}
}

async function verifyOps(
	items: Resolved[],
	ws: Workspace,
	llm: Llm,
	cfg: DreamConfig,
	root: string,
	save: (name: string, v: unknown) => void,
	tag: string,
	scopes: { project: string; other_projects: string[] },
) {
	const verdicts = new Map<string, Verdict>();
	const batches: Resolved[][] = [];
	let cur: Resolved[] = [];
	let size = 0;
	for (const r of items) {
		const sz = r.excerpts.length + 1500;
		if (cur.length && (cur.length >= 10 || size + sz > 110_000)) {
			batches.push(cur);
			cur = [];
			size = 0;
		}
		cur.push(r);
		size += sz;
	}
	if (cur.length) batches.push(cur);
	const system = systemPrompt("verify", { language: cfg.language }, root);
	for (const [i, batch] of batches.entries()) {
		const input = { scopes, proposals: batch.map((r) => ({ ...proposalForCheck(r.op, ws), excerpts: r.excerpts })) };
		const out = await llm.json("verify", cfg.models.verify, system, JSON.stringify(input, null, 1), validateVerdicts, { maxTokens: 32_000, timeoutMs: 12 * MINUTE });
		save(`verify-${tag}-${i + 1}.json`, { input, out });
		for (const v of out) verdicts.set(v.ref, v);
	}
	return verdicts;
}

function decide(v: Verdict | undefined): { apply: boolean; fix?: Verdict["fix"]; reason: string } {
	if (!v) return { apply: false, reason: "no verdict from the fact check" };
	if (v.unsafe) return { apply: false, reason: `unsafe — ${v.reason}` };
	if (v.verdict === "supported") return { apply: true, reason: v.reason };
	if (v.verdict === "partial" && (v.fix?.title || v.fix?.body || v.fix?.scope)) return { apply: true, fix: v.fix, reason: v.reason };
	return { apply: false, reason: `${v.verdict} — ${v.reason}` };
}

// ── GitHub ───────────────────────────────────────────────────────────────

async function fetchReviewComments(repo: string, pr: number, since: string | undefined): Promise<ReviewComment[]> {
	const out: ReviewComment[] = [];
	const view = await ghJson<{
		comments?: Array<{ id: string; author?: { login?: string }; body?: string; createdAt?: string }>;
		reviews?: Array<{ id: string; author?: { login?: string }; body?: string; submittedAt?: string }>;
	}>(["pr", "view", String(pr), "--repo", repo, "--json", "comments,reviews"]);
	for (const c of view.comments ?? []) out.push({ id: String(c.id), author: c.author?.login ?? "?", at: c.createdAt ?? "", body: c.body ?? "" });
	for (const r of view.reviews ?? []) out.push({ id: String(r.id), author: r.author?.login ?? "?", at: r.submittedAt ?? "", body: r.body ?? "" });
	const inline = await gh(["api", `repos/${repo}/pulls/${pr}/comments`, "--paginate", "--jq", ".[] | @json"]);
	if (inline.code === 0) {
		for (const line of inline.stdout.split("\n")) {
			if (!line.trim()) continue;
			try {
				const c = JSON.parse(line) as { id: number; path?: string; line?: number; body?: string; created_at?: string; user?: { login?: string } };
				out.push({ id: String(c.id), author: c.user?.login ?? "?", at: c.created_at ?? "", body: c.body ?? "", path: c.path, line: c.line });
			} catch {
				// not a comment object
			}
		}
	}
	return out
		.filter((c) => c.body.trim() && !c.body.includes("<!-- pi-dream:") && (!since || c.at > since))
		.sort((a, b) => a.at.localeCompare(b.at));
}

/** Ids of the notes committed at `ref` (e.g. the approved `origin/main`). */
async function noteIdsAt(root: string, ref: string): Promise<Set<string>> {
	const ids = new Set<string>();
	const ls = await git(root, ["ls-tree", "-r", "--name-only", ref, "scopes"]);
	if (ls.code !== 0) return ids;
	for (const path of ls.stdout.split("\n").filter((p) => /\/notes\/[^/]+\.md$/.test(p))) {
		const show = await git(root, ["show", `${ref}:${path}`]);
		const m = /^id:\s*(m-[0-9a-f]{6,12})\s*$/m.exec(show.stdout);
		if (m) ids.add(m[1]);
	}
	return ids;
}

/** Remove worktrees left by dry runs or crashed dreams (older than a day). */
async function cleanupWorktrees(root: string, P: MemoryPaths, log: (m: string) => void): Promise<void> {
	if (existsSync(P.worktrees)) {
		for (const name of readdirSync(P.worktrees)) {
			const dir = join(P.worktrees, name);
			try {
				if (Date.now() - statSync(dir).mtimeMs < DAY) continue;
			} catch {
				continue;
			}
			await git(root, ["worktree", "remove", "--force", dir]);
			rmSync(dir, { recursive: true, force: true });
			await git(root, ["branch", "-D", `dream-${name}`]);
			log(`  removed old worktree ${name}`);
		}
	}
	await git(root, ["worktree", "prune"]);
}

async function ffBase(root: string, base: string, log: (m: string) => void): Promise<void> {
	const branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
	if (branch !== base) return log(`  memory repo is on ${branch}, not ${base}: not fast-forwarding`);
	if ((await git(root, ["status", "--porcelain"])).stdout.trim()) return log("  memory repo has local changes: not fast-forwarding");
	const r = await git(root, ["merge", "--ff-only", `origin/${base}`]);
	if (r.code !== 0) log(`  fast-forward of ${base} failed: ${r.stderr.trim()}`);
}

// ── the dream ────────────────────────────────────────────────────────────

export async function runDream(ctx: ExtensionContext, opts: RunOptions): Promise<void> {
	const cfg = loadConfig();
	const root = cfg.memoryDir;
	const P = memoryPaths(root);
	const runId = opts.runId ?? newRunId();
	const runDir = join(P.runs, runId);
	mkdirSync(runDir, { recursive: true });
	const logFile = join(runDir, "log.txt");
	const log = (m: string) => {
		const line = `[${new Date().toISOString()}] ${m}`;
		console.log(line);
		appendFileSync(logFile, `${line}\n`);
	};
	if (!existsSync(join(root, ".git"))) {
		log(`memory repo not initialized at ${root}: run /dream init`);
		return;
	}
	const maxMs = cfg.dream.maxRuntimeMinutes * MINUTE;
	if (!acquireLock(P.lock, runId, maxMs * 1.5)) {
		log("another dream is running; exiting");
		return;
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), maxMs);
	const state = loadState(P.state) ?? freshState(opts.sinceDays ?? cfg.dream.firstRunLookbackDays);
	if (opts.sinceDays !== undefined) state.cutoffMs = Math.min(state.cutoffMs, Date.now() - opts.sinceDays * DAY);
	// Dry runs and reindexing leave the dream state alone: they are not dreams.
	// Review-only runs save what they consumed but do not move the dream schedule.
	const persist = !opts.dryRun && !opts.reindexOnly;
	const track = persist && !opts.reviewOnly;
	if (track) {
		state.lastRun = { id: runId, startedAt: new Date().toISOString(), status: "running" };
		saveState(P.state, state);
	}
	log(`dream ${runId}${opts.dryRun ? " (dry run)" : ""}${opts.reindexOnly ? " (reindex only)" : ""} — memory ${root}`);
	try {
		const result = await dream(ctx, cfg, P, state, opts, runId, runDir, log, controller.signal);
		if (track) state.lastRun = { id: runId, startedAt: state.lastRun?.startedAt ?? new Date().toISOString(), finishedAt: new Date().toISOString(), ...result };
		log(`done: ${result.status}${result.pr ? ` — ${result.pr}` : ""}`);
	} catch (err) {
		const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
		log(`ERROR: ${msg}`);
		if (track)
			state.lastRun = { id: runId, startedAt: state.lastRun?.startedAt ?? new Date().toISOString(), finishedAt: new Date().toISOString(), status: "error", error: msg.split("\n")[0] };
	} finally {
		clearTimeout(timer);
		if (persist) saveState(P.state, state);
		releaseLock(P.lock);
	}
}

type DreamResult = { status: "ok" | "noop"; pr?: string; sessions?: number; cost?: number };

async function dream(
	ctx: ExtensionContext,
	cfg: DreamConfig,
	P: MemoryPaths,
	state: DreamState,
	opts: RunOptions,
	runId: string,
	runDir: string,
	log: (m: string) => void,
	signal: AbortSignal,
): Promise<DreamResult> {
	const root = cfg.memoryDir;
	const date = today();
	const save = (name: string, v: unknown) => saveJson(join(runDir, name), v);
	const problems: string[] = [];

	// 1. sync, previous pull request
	const remoteUrl = (await git(root, ["remote", "get-url", "origin"])).stdout.trim();
	const repo = githubRepoOf(remoteUrl);
	if (remoteUrl) await gitOk(root, ["fetch", "origin", "--prune", "--quiet"], 120_000);
	let openPr = state.openPr;
	let mergedPr: number | undefined;
	if (repo && openPr) {
		const v = await ghJson<{ state: string; url: string }>(["pr", "view", String(openPr.number), "--repo", repo, "--json", "state,url"]);
		if (v.state === "MERGED") {
			log(`PR #${openPr.number} was merged`);
			mergedPr = openPr.number;
			openPr = undefined;
		} else if (v.state === "CLOSED") {
			log(`PR #${openPr.number} was closed without merging: its notes count as rejected`);
			for (const run of state.runs.filter((r) => r.pr === openPr?.number))
				for (const a of run.added) state.rejected.push({ title: a.title, at: date, pr: run.pr });
			state.runs = state.runs.filter((r) => r.pr !== openPr?.number);
			openPr = undefined;
		}
	}
	if (repo && !openPr) {
		const list = await ghJson<Array<{ number: number; url: string; headRefName: string }>>([
			"pr", "list", "--repo", repo, "--state", "open", "--label", cfg.github.label, "--json", "number,url,headRefName",
		]);
		if (list[0]) openPr = { number: list[0].number, url: list[0].url, branch: list[0].headRefName };
	}
	if (!opts.dryRun) state.openPr = openPr;
	if (remoteUrl) await ffBase(root, cfg.github.base, log);

	// 2. review comments
	let feedback: ReviewComment[] = [];
	if (repo && openPr) {
		feedback = await fetchReviewComments(repo, openPr.number, state.reviewSeen[String(openPr.number)]);
		if (feedback.length) log(`${feedback.length} new review comment(s) on PR #${openPr.number}`);
	}

	// 3. digests
	const files = listSessionFiles();
	const digests = await updateDigests(files, P, log, signal);
	if (opts.reindexOnly) return { status: "noop" };
	if (opts.reviewOnly && !feedback.length) {
		log("review only: no new review comments");
		return { status: "noop" };
	}
	const fileBySession = new Map<string, string>();
	for (const [file, rec] of Object.entries(digests)) if (rec.sessionId) fileBySession.set(rec.sessionId, file);
	const projects = knownProjects(digests);
	const primaryOf = (rec: DigestRecord | undefined) => (rec ? projects.primary(rec.projectKey, rec.paths ?? []) : undefined);

	// 4. cards
	const now = Date.now();
	const pending = opts.reviewOnly ? [] : pendingSessions(files, state, cfg, now).slice(0, opts.maxSessions ?? cfg.dream.maxSessionsPerRun);
	const inbox = opts.reviewOnly ? [] : pendingInbox(readInbox(root), state);
	log(`${pending.length} session(s) to summarize, ${inbox.length} inbox item(s)`);
	const sessions = new SessionCache(cfg.dream.concurrency * 2);
	const llm = new Llm(ctx, log, signal);
	const marks: Record<string, DreamState["sessions"][string]> = {};
	const cardsSystem = systemPrompt("cards", { language: cfg.language }, root);
	const cards = (
		await pool(pending, cfg.dream.concurrency, async (f): Promise<Card | undefined> => {
			const rec = digests[f.path];
			const mark = (ok: boolean) => {
				const prev = state.sessions[f.path];
				marks[f.path] = { size: f.size, mtimeMs: f.mtimeMs, at: new Date().toISOString(), ok, failures: ok ? 0 : (prev?.size === f.size ? (prev.failures ?? 0) : 0) + 1 };
			};
			if (!rec || rec.error || rec.userMessages === 0) {
				mark(true);
				return undefined;
			}
			const cachePath = join(P.cards, `${rec.sessionId}.json`);
			try {
				if (existsSync(cachePath)) {
					const cached = JSON.parse(readFileSync(cachePath, "utf-8")) as Card;
					if (cached.size === f.size) {
						mark(true);
						return cached;
					}
				}
				const sess = await sessions.get(f.path);
				if (!sess) throw new Error("unreadable session");
				const d = buildDigest(sess);
				const ids = new Set(d.lines.map((l) => l.id));
				const user = `${digestHeader(d.meta, rec.projectKey)}\n\n${renderDigest(d, 160_000)}`;
				const base = { sessionId: rec.sessionId, file: f.path, size: f.size, projectKey: rec.projectKey, date: (rec.started || "").slice(0, 10) };
				const card = await llm.json("cards", cfg.models.cards, cardsSystem, user, (raw) => validateCard(raw, ids, base, rec.name ?? ""), {
					maxTokens: 16_000,
					timeoutMs: 6 * MINUTE,
				});
				saveJson(cachePath, card);
				mark(true);
				log(`  card ${rec.sessionId.slice(0, 8)} ${shortKey(rec.projectKey)}: ${card.title} — ${card.learnings.length} learning(s)`);
				return card;
			} catch (err) {
				mark(false);
				log(`  ! card ${rec.sessionId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
				return undefined;
			}
		})
	).filter((c): c is Card => !!c);
	save("cards.json", cards);

	// 5. workspace on the review branch
	const base = openPr ? `origin/${openPr.branch}` : remoteUrl ? `origin/${cfg.github.base}` : cfg.github.base;
	const branch = openPr ? openPr.branch : `pi-dream/${date}-${runId.slice(-4)}`;
	const wt = join(P.worktrees, runId);
	await cleanupWorktrees(root, P, log);
	mkdirSync(P.worktrees, { recursive: true });
	await gitOk(root, ["worktree", "add", "-B", `dream-${runId}`, wt, base], 120_000);
	try {
		const ws = new Workspace(wt, date);
		if (openPr && remoteUrl) {
			const approved = await noteIdsAt(root, `origin/${cfg.github.base}`);
			for (const id of ws.ids) if (!approved.has(id)) ws.pending.add(id);
		}
		if (mergedPr !== undefined) {
			for (const run of state.runs.filter((r) => r.pr === mergedPr))
				for (const a of run.added) if (!ws.ids.has(a.id)) state.rejected.push({ title: a.title, at: date, pr: mergedPr });
			if (!opts.dryRun) state.runs = state.runs.filter((r) => r.pr !== mergedPr);
		}
		const normalized = ws.normalize();
		const changes: ReportChange[] = [];
		const rejected: ReportRejected[] = [];
		const unhandled: Array<{ comment: string; reason: string }> = [];
		const agentsOps: Array<{ key: string; repoRoot: string; rel: string; op: AgentsMdOp }> = [];
		const scopeTitles: Record<string, string> = { global: "global" };
		const deps: EvidenceDeps = {
			sessions,
			fileBySession,
			inboxById: new Map(inbox.map((i) => [i.id, i])),
			comments: new Map(feedback.map((c) => [c.id, c])),
			pr: openPr?.number,
		};
		const scopeTitle = (scope: string): string => {
			if (scopeTitles[scope]) return scopeTitles[scope];
			try {
				const meta = JSON.parse(readFileSync(join(scopeDir(wt, scope), SCOPE_META_FILE), "utf-8")) as { key?: string };
				if (meta.key) return (scopeTitles[scope] = meta.key);
			} catch {
				// no meta yet
			}
			return scope;
		};
		const readText = (path: string) => (existsSync(path) ? readFileSync(path, "utf-8").trim() : "");
		const globalCharter = readText(join(scopeDir(wt, GLOBAL_SCOPE), CHARTER_FILE)) || DEFAULT_GLOBAL_CHARTER;

		// 6a. review pass
		if (feedback.length && openPr) {
			const input = {
				pull_request: openPr.number,
				comments: feedback.map((c) => ({ id: c.id, author: c.author, at: c.at, ...(c.path ? { file: c.path, line: c.line } : {}), body: c.body })),
				scopes: Object.fromEntries(
					[...ws.notes].map(([sc, ns]) => [
						sc,
						{
							title: scopeTitle(sc),
							notes: ns.filter((n) => n.status === "active").map((n) => ({ ...noteForPrompt(n), ...(ws.pending.has(n.id) ? { pending: true } : {}) })),
						},
					]),
				),
			};
			const parsed = await llm.json<ParsedOps>("analyze", cfg.models.analyze, systemPrompt("review", { language: cfg.language }, wt), JSON.stringify(input, null, 1), parseOps, {
				maxTokens: 48_000,
				timeoutMs: 15 * MINUTE,
			});
			save("review.json", { input, parsed });
			problems.push(...parsed.problems.map((p) => `review: ${p}`));
			unhandled.push(...parsed.unhandled);
			for (const op of parsed.ops) {
				if (op.op === "agents_md") {
					unhandled.push({ comment: op.evidence[0]?.e[0] ?? "?", reason: "AGENTS.md changes from review comments are not supported yet" });
					continue;
				}
				const evidence: Evidence[] = (op.evidence.length ? op.evidence : [{ s: `pr#${openPr.number}`, e: [] }]).map((r) => ({
					s: r.s.startsWith("pr#") ? r.s : `pr#${openPr?.number}`,
					e: r.e,
					date,
					kind: "reviewer" as const,
				}));
				const res = applyOp(ws, op, { evidence });
				if (!res.ok) rejected.push({ ref: op.ref, op: op.op, title: opTitle(op), reason: res.reason });
				else changes.push({ ...res.change, rationale: op.rationale, evidence, source: "reviewer" });
			}
		}

		// 6b. project passes
		// Sessions are grouped by the project they were about (not where pi was started).
		const primaryKey = (file: string, fallback: string) => primaryOf(digests[file])?.key ?? fallback;
		const groups = new Map<string, { cards: Card[]; inbox: InboxItem[] }>();
		const group = (key: string) => {
			let g = groups.get(key);
			if (!g) groups.set(key, (g = { cards: [], inbox: [] }));
			return g;
		};
		for (const c of cards) if (c.learnings.length || c.feedback.length || c.memoryFeedback.length) group(primaryKey(c.file, c.projectKey)).cards.push(c);
		for (const i of inbox) group(i.sessionFile ? primaryKey(i.sessionFile, i.projectKey) : i.projectKey).inbox.push(i);
		type HitMeta = { sessionId: string; projectKey: string; entryId?: string; date: string };
		let corpus: Bm25<HitMeta> | undefined;
		const history = (c: Card, l: Learning, passKey: string) => {
			if (!corpus) {
				const docs: Doc<HitMeta>[] = [];
				for (const [file, rec] of Object.entries(digests)) {
					if (!rec.dir || rec.userMessages === 0) continue;
					let text: string;
					try {
						text = readFileSync(digestFile(P, rec), "utf-8");
					} catch {
						continue;
					}
					const projectKey = primaryKey(file, rec.projectKey);
					for (const [k, ch] of chunkDigest(text).entries())
						docs.push({ id: `${rec.sessionId}#${k}`, text: ch.text, meta: { sessionId: rec.sessionId, projectKey, entryId: ch.entryId, date: rec.started.slice(0, 10) } });
				}
				corpus = new Bm25(docs);
				log(`history corpus: ${docs.length} chunks`);
			}
			const query = `${l.statement} ${l.details ?? ""}`;
			return corpus
				.search(query, 3, (d) => d.meta.sessionId !== c.sessionId && (l.scope === "global" || d.meta.projectKey === passKey))
				.filter((h) => h.score > 2)
				.map((h) => ({
					s: h.doc.meta.sessionId,
					e: h.doc.meta.entryId ? [h.doc.meta.entryId] : [],
					date: h.doc.meta.date,
					project: h.doc.meta.projectKey,
					snippet: snippet(h.doc.text, query, 360),
				}));
		};
		/** Projects of the sessions an op cites, and whether the user (or a deliberate inbox item) stands behind it. */
		const evidenceProjects = (ev: Evidence[]) => {
			const keys = new Set<string>();
			let explicit = false;
			for (const e of ev) {
				if (e.kind === "user" || e.kind === "inbox" || e.kind === "reviewer") explicit = true;
				const file = fileBySession.get(e.s);
				const key = file ? primaryKey(file, digests[file]?.projectKey ?? "") : "";
				if (key && projects.isProject(key)) keys.add(key);
			}
			return { keys, explicit };
		};
		const curatorBase = systemPrompt(
			"curator",
			{ language: cfg.language, charter: "{{charter}}", globalBudget: cfg.budgets.globalTokens, projectBudget: cfg.budgets.projectTokens },
			wt,
		);
		const ordered = [...groups.entries()].sort((a, b) => b[1].cards.length + b[1].inbox.length - (a[1].cards.length + a[1].inbox.length));
		const votes: Array<{ id: string; effect: string }> = [];
		for (const [key, g] of ordered) {
			if (signal.aborted) throw new Error("dream aborted (time limit)");
			const scope = projectScope(key);
			const knownRoot = projects.rootOf(key)?.root;
			const proj = await resolveProject(
				knownRoot ?? (key.startsWith("local:") ? key.slice(6) : g.cards[0] ? (digests[g.cards[0].file]?.cwd ?? "") : (g.inbox[0]?.cwd ?? "")),
			);
			ws.ensureScope(scope, { key, root: proj.root });
			scopeTitles[scope] = key;
			// Other projects these sessions worked in or that history ties the topic to.
			const candidates = new Map<string, Set<string>>();
			const addCandidate = (k: string, why: string) => {
				if (!k || k === key || !projects.isProject(k)) return;
				if (!candidates.has(k)) candidates.set(k, new Set());
				candidates.get(k)?.add(why);
			};
			const sessionInfo = new Map<string, { cwd: string; workspace: boolean; touched: Array<{ project: string; n: number }> }>();
			for (const c of g.cards) {
				const rec = digests[c.file];
				const p = primaryOf(rec);
				for (const t of p?.touched ?? []) addCandidate(t.key, "touched by these sessions");
				if (rec && !projects.isBroad(rec.projectKey)) addCandidate(rec.projectKey, "cwd of a session");
				sessionInfo.set(c.sessionId, {
					cwd: rec?.cwd ?? "",
					workspace: p?.workspace ?? false,
					touched: (p?.touched ?? []).slice(0, 5).map((t) => ({ project: t.key, n: t.n })),
				});
			}
			const sessionsInput = g.cards.map((c) => ({
				session: c.sessionId,
				date: c.date,
				...sessionInfo.get(c.sessionId),
				title: c.title,
				summary: c.summary,
				outcome: c.outcome,
				feedback: c.feedback,
				learnings: c.learnings.map((l) => {
					const hist = history(c, l, key);
					for (const h of hist) addCandidate(h.project, "history hits");
					return { ...l, history: hist };
				}),
				memory_feedback: c.memoryFeedback,
			}));
			const otherProjects = [...candidates.entries()].slice(0, 8).map(([k, why]) => {
				const sc = projectScope(k);
				ws.ensureScope(sc, { key: k, root: projects.rootOf(k)?.root });
				scopeTitles[sc] = k;
				const active = ws.scope(sc).filter((n) => n.status === "active");
				return { scope: `project:${k}`, why: [...why], notes: active.slice(0, 12).map((n) => ({ id: n.id, title: n.title })) };
			});
			for (const c of g.cards) for (const f of c.memoryFeedback) votes.push({ id: f.id, effect: f.effect });
			const projectCharter =
				readText(join(scopeDir(wt, scope), CHARTER_FILE)) || readText(join(wt, "scopes", "projects", "_charter.md")) || DEFAULT_PROJECT_CHARTER;
			const ctxFile = cfg.agentsMd && proj.exists ? findContextFile(proj.checkout ?? proj.root) : undefined;
			// One AGENTS.md proposal at a time: while one awaits review, do not stack another.
			const agentsPending = ctxFile ? await openAgentsPr(proj.root) : undefined;
			const used = (sc: string, budget: number) => buildIndex(ws.scope(sc), sc, budget).tokens;
			const input = {
				project: { key, scope: "project", root: proj.root },
				other_projects: otherProjects,
				budgets: {
					global: { budget: cfg.budgets.globalTokens, used: used(GLOBAL_SCOPE, cfg.budgets.globalTokens) },
					project: { budget: cfg.budgets.projectTokens, used: used(scope, cfg.budgets.projectTokens) },
				},
				notes: {
					global: ws.scope(GLOBAL_SCOPE).filter((n) => n.status === "active").map(noteForPrompt),
					project: ws.scope(scope).filter((n) => n.status === "active").map(noteForPrompt),
				},
				sessions: sessionsInput,
				inbox: g.inbox.map((i) => ({ s: `inbox:${i.id}`, at: i.ts, source: i.source, kind: i.kind, scope: i.scope, text: i.text })),
				context_file: ctxFile
					? {
							path: ctxFile.rel,
							content: clipHead(readFileSync(ctxFile.path, "utf-8"), 40_000),
							...(agentsPending ? { pending_pr: agentsPending } : {}),
						}
					: null,
				rejected_before: state.rejected.slice(-40).map((r) => r.title),
			};
			const charter = `Global: ${globalCharter}\n\nThis project (${key}): ${projectCharter}`;
			const tag = keyToDir(key).slice(0, 60);
			const parsed = await llm.json<ParsedOps>("analyze", cfg.models.analyze, curatorBase.replaceAll("{{charter}}", charter), JSON.stringify(input, null, 1), parseOps, {
				maxTokens: 64_000,
				timeoutMs: 20 * MINUTE,
			});
			save(`curator-${tag}.json`, { input, parsed });
			problems.push(...parsed.problems.map((p) => `${shortKey(key)}: ${p}`));
			log(`curator ${shortKey(key)}: ${parsed.ops.length} op(s)`);
			if (!parsed.ops.length) continue;
			const resolved = await Promise.all(parsed.ops.map((op) => resolveOp(op, deps)));
			for (const r of resolved.filter((x) => x.error)) rejected.push({ ref: r.op.ref, op: r.op.op, title: opTitle(r.op), reason: r.error ?? "" });
			const valid = resolved.filter((x) => !x.error);
			const scopeChoices = { project: key, other_projects: otherProjects.map((o) => o.scope.slice(8)) };
			const verdicts = valid.length ? await verifyOps(valid, ws, llm, cfg, wt, save, tag, scopeChoices) : new Map<string, Verdict>();
			for (const r of valid) {
				const v = verdicts.get(r.op.ref);
				const d = decide(v);
				if (!d.apply) {
					rejected.push({ ref: r.op.ref, op: r.op.op, title: opTitle(r.op), reason: d.reason });
					continue;
				}
				// Global only with the user behind it or evidence from more than one project.
				let guardNote: string | undefined;
				if ((r.op.op === "add" || r.op.op === "update") && (d.fix?.scope ?? r.op.scope) === "global") {
					const ep = evidenceProjects(r.evidence);
					if (!ep.explicit && ep.keys.size === 1) {
						const only = [...ep.keys][0];
						d.fix = { ...d.fix, scope: `project:${only}` };
						ws.ensureScope(projectScope(only), { key: only, root: projects.rootOf(only)?.root });
						scopeTitles[projectScope(only)] = only;
						guardNote = `global → ${shortKey(only)}: all evidence comes from this one project`;
					}
				}
				if (r.op.op === "agents_md") {
					if (!ctxFile) rejected.push({ ref: r.op.ref, op: r.op.op, title: opTitle(r.op), reason: "project has no context file" });
					else if (agentsPending)
						rejected.push({ ref: r.op.ref, op: r.op.op, title: opTitle(r.op), reason: `a pi-dream AGENTS.md PR is still open: ${agentsPending}` });
					else agentsOps.push({ key, repoRoot: proj.root, rel: ctxFile.rel, op: r.op });
					continue;
				}
				const res = applyOp(ws, r.op, { projectScope: scope, evidence: r.evidence, fix: d.fix });
				if (!res.ok) {
					rejected.push({ ref: r.op.ref, op: r.op.op, title: opTitle(r.op), reason: res.reason });
					continue;
				}
				changes.push({
					...res.change,
					note: [res.change.note, guardNote].filter(Boolean).join(" · ") || undefined,
					rationale: r.op.rationale,
					evidence: r.evidence,
					source: "curator",
					verdict: v ? { verdict: v.verdict, reason: v.reason, corrected: !!(d.fix?.title || d.fix?.body || (d.fix?.scope && !guardNote)) } : undefined,
					proposedTitle: d.fix?.title ? opTitle(r.op) : undefined,
				});
			}
		}
		const voteCount = applyVotes(ws, votes);

		// 7. write notes, indexes
		ws.flush();
		const indexes: IndexStat[] = regenerateIndexes(ws, cfg.budgets, scopeTitle);
		ws.flush();

		// AGENTS.md proposals
		const agents: ReportAgents[] = [];
		const byRepo = new Map<string, { key: string; repoRoot: string; rel: string; edits: AgentsEdit[]; rationale: string[]; summaries: string[] }>();
		for (const a of agentsOps) {
			const k = `${a.repoRoot}::${a.rel}`;
			let entry = byRepo.get(k);
			if (!entry) byRepo.set(k, (entry = { key: a.key, repoRoot: a.repoRoot, rel: a.rel, edits: [], rationale: [], summaries: [] }));
			entry.edits.push(...a.op.edits);
			if (a.op.rationale) entry.rationale.push(a.op.rationale);
			if (a.op.summary) entry.summaries.push(a.op.summary);
		}
		for (const e of byRepo.values()) {
			if (opts.dryRun) {
				agents.push({ project: e.key, rel: e.rel, error: "dry run", patch: renderEditsDiff(e.rel, e.edits), rationale: e.rationale });
				continue;
			}
			const res = await publishAgentsEdits({
				repoRoot: e.repoRoot,
				rel: e.rel,
				edits: e.edits,
				runId,
				worktreesDir: P.worktrees,
				title: e.summaries.length === 1 ? e.summaries[0] : `${e.edits.length} edit(s) from the memory review`,
				details: e.rationale,
				log,
			});
			agents.push({ project: e.key, rel: e.rel, url: res.url, error: res.error, patch: res.patch, rationale: e.rationale });
		}

		// 8. report, commit, pull request
		const sessionTitles: Record<string, string> = {};
		for (const c of cards) sessionTitles[c.sessionId] = c.title;
		for (const rec of Object.values(digests)) if (rec.name && !sessionTitles[rec.sessionId]) sessionTitles[rec.sessionId] = rec.name;
		const reportSessions: ReportSession[] = cards.map((c) => {
			const primary = primaryKey(c.file, c.projectKey);
			return {
				sessionId: c.sessionId,
				date: c.date,
				project: primary === c.projectKey ? shortKey(primary) : `${shortKey(primary)} ← ${shortKey(c.projectKey)}`,
				title: c.title,
				outcome: c.outcome.status,
				learnings: c.learnings.length,
			};
		});
		const data: ReportData = {
			runId,
			date,
			language: cfg.language,
			models: { cards: cfg.models.cards.model, analyze: cfg.models.analyze.model, verify: cfg.models.verify.model },
			usage: llm.usage,
			sessions: reportSessions,
			sessionTitles,
			inbox: inbox.length,
			feedback: feedback.length,
			unhandled,
			changes,
			rejected,
			agents,
			indexes,
			votes: voteCount,
			normalized: normalized.length,
			problems,
			scopeTitles,
		};
		const report = renderReport(data);
		writeFileSync(join(runDir, "report.md"), report, "utf-8");
		const memoryChanged = (await git(wt, ["status", "--porcelain"])).stdout.trim().length > 0;
		const result: DreamResult = { status: "noop", sessions: pending.length, cost: llm.totalCost() };
		if (opts.dryRun) {
			log(`dry run: report ${join(runDir, "report.md")}, worktree ${wt}`);
			return result;
		}

		if (memoryChanged) {
			mkdirSync(join(wt, "reports"), { recursive: true });
			writeFileSync(join(wt, "reports", `${runId}.md`), report, "utf-8");
			await gitOk(wt, ["add", "-A"]);
			await gitOk(wt, ["commit", "-m", prTitle(data)]);
			if (repo) {
				await gitOk(wt, ["push", "origin", `HEAD:refs/heads/${branch}`], 120_000);
				const body = report.length > 60_000 ? `${report.slice(0, 60_000)}\n\n…(truncated: reports/${runId}.md)` : report;
				const bodyFile = join(runDir, "pr-body.md");
				writeFileSync(bodyFile, body, "utf-8");
				let stillOpen = false;
				if (openPr) {
					const v = await gh(["pr", "view", String(openPr.number), "--repo", repo, "--json", "state", "--jq", ".state"]);
					stillOpen = v.code === 0 && v.stdout.trim() === "OPEN";
				}
				if (openPr && stillOpen) {
					await ghOk(["pr", "comment", String(openPr.number), "--repo", repo, "--body-file", bodyFile]);
					result.pr = openPr.url;
					log(`updated PR #${openPr.number}: ${openPr.url}`);
				} else {
					await gh(["label", "create", cfg.github.label, "--repo", repo, "--color", "7AA2F7", "--description", "pi-dream memory review", "--force"]);
					const created = await ghOk(
						["pr", "create", "--repo", repo, "--base", cfg.github.base, "--head", branch, "--title", prTitle(data), "--body-file", bodyFile, "--label", cfg.github.label],
						{ timeoutMs: 120_000 },
					);
					const url = created.split("\n").pop()?.trim() ?? created;
					const number = Number(url.split("/").pop());
					openPr = { number, url, branch };
					state.openPr = openPr;
					result.pr = url;
					log(`opened PR #${number}: ${url}`);
				}
			}
			result.status = "ok";
			state.runs.push({
				id: runId,
				pr: openPr?.number,
				added: changes.filter((c) => c.kind === "added" || c.kind === "superseded").map((c) => ({ id: c.newId ?? c.noteId ?? "", title: c.title })),
			});
			state.runs = state.runs.slice(-60);
		} else if (repo && openPr && (feedback.length || unhandled.length)) {
			const bodyFile = join(runDir, "pr-body.md");
			writeFileSync(bodyFile, report, "utf-8");
			await ghOk(["pr", "comment", String(openPr.number), "--repo", repo, "--body-file", bodyFile]);
			result.pr = openPr.url;
		}
		if (!memoryChanged && agents.length) result.status = "ok";

		// state: what this dream has consumed
		Object.assign(state.sessions, marks);
		state.inboxDone.push(...inbox.map((i) => i.id));
		state.rejected = state.rejected.slice(-200);
		if (openPr && feedback.length) state.reviewSeen[String(openPr.number)] = feedback[feedback.length - 1].at;
		return result;
	} finally {
		if (!opts.dryRun) {
			await git(root, ["worktree", "remove", "--force", wt]);
			await git(root, ["branch", "-D", `dream-${runId}`]);
		}
		await git(root, ["worktree", "prune"]);
	}
}

