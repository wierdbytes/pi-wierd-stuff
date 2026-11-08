/**
 * In-session side of pi-dream: what a normal pi session sees.
 *
 * - The approved memory (`main` of the memory repo) is read once per session
 *   and frozen: the `<memory>` section stays byte-identical turn after turn,
 *   so the provider's prompt cache keeps hitting. Resumed sessions replay the
 *   recorded section instead of reading disk again.
 * - A background `git fetch` + fast-forward keeps `main` current (merged pull
 *   requests show up in the next session).
 * - Search, read and inbox back the memory tools; status backs `/memory` and
 *   `/dream`; a due dream is started in the background.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type DreamConfig, disabledByEnv, loadConfig } from "./config.ts";
import { clipHead, renderEntryFull } from "./digest.ts";
import { git } from "./gitops.ts";
import { appendInbox, type InboxKind, readInbox } from "./inbox.ts";
import { GLOBAL_SCOPE, INDEX_FILE, keyToDir, memoryPaths, newRunId, projectScope, scopeDir } from "./layout.ts";
import { lockIsLive } from "./lock.ts";
import { estimateTokens, indexBody, indexIds, renderInjection } from "./memindex.ts";
import { listScopes, loadNotes, type Note } from "./notes.ts";
import { type ProjectInfo, resolveProject, shortKey } from "./project.ts";
import { checkDue, pendingInbox, pendingSessions, spawnDream } from "./scheduler.ts";
import { Bm25, chunkDigest, type Doc, snippet } from "./search.ts";
import { listSessionFiles, parseSession, sessionsRoot } from "./sessions.ts";
import { loadState } from "./state.ts";

export const EVENT = "pi-dream";
const SYNC_INTERVAL_MS = 5 * 60_000;

interface Snapshot {
	text?: string;
	ids: string[];
	tokens: number;
	memver?: string;
	projectKey: string;
}

interface InjectRecord {
	event: "inject";
	text?: string;
	ids: string[];
	tokens: number;
	memver?: string;
	projectKey: string;
}

const ru = (cfg: DreamConfig) => cfg.language.toLowerCase().startsWith("ru");

export class Runtime {
	cfg: DreamConfig = loadConfig();
	private snapshot: Snapshot | undefined;
	private syncing: Promise<string> | undefined;
	private noteIndex: { key: string; bm: Bm25<Note> } | undefined;
	private digestIndex = new Map<string, { key: string; bm: Bm25<{ sessionId: string; entryId?: string; dir: string }> }>();

	constructor(private pi: ExtensionAPI) {}

	get root(): string {
		return this.cfg.memoryDir;
	}

	active(): boolean {
		return !disabledByEnv() && this.pi.getFlag("no-memory") !== true;
	}

	project(cwd: string): Promise<ProjectInfo> {
		return resolveProject(cwd);
	}

	// ── session lifecycle ────────────────────────────────────────────────

	async onSessionStart(reason: string, ctx: ExtensionContext): Promise<void> {
		this.cfg = loadConfig();
		this.snapshot = undefined;
		if (!this.active()) {
			const keep = this.pi.getActiveTools().filter((n) => !n.startsWith("memory_"));
			this.pi.setActiveTools(keep);
			return;
		}
		if (reason === "resume" || reason === "fork" || reason === "reload") {
			const rec = this.recorded(ctx);
			if (rec) this.snapshot = { ...rec };
		}
		if (!this.snapshot && existsSync(join(this.root, ".git"))) this.syncing = this.sync(false);
		void this.project(ctx.cwd);
		if (ctx.hasUI) {
			this.notifyFinishedDream(ctx);
			if (reason === "startup" || reason === "new") setTimeout(() => void this.maybeDream(ctx).catch(() => undefined), 1500).unref?.();
		}
	}

	private recorded(ctx: ExtensionContext): InjectRecord | undefined {
		const branch = ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: unknown }>;
		for (let i = branch.length - 1; i >= 0; i--) {
			const e = branch[i];
			if (e.type === "custom" && e.customType === EVENT && (e.data as InjectRecord | undefined)?.event === "inject") return e.data as InjectRecord;
		}
		return undefined;
	}

	/** The `<memory>` section for this session (built on the first turn, then frozen). */
	async memorySection(ctx: ExtensionContext): Promise<string | undefined> {
		if (!this.active() || !this.cfg.inject) return undefined;
		if (!this.snapshot) {
			if (this.syncing) await Promise.race([this.syncing, new Promise((r) => setTimeout(r, 1500))]);
			const snap = await this.buildSnapshot(ctx.cwd);
			this.snapshot = snap;
			if (snap.text) {
				const rec: InjectRecord = { event: "inject", text: snap.text, ids: snap.ids, tokens: snap.tokens, memver: snap.memver, projectKey: snap.projectKey };
				this.pi.appendEntry(EVENT, rec);
			}
		}
		return this.snapshot.text;
	}

	private memver(): string | undefined {
		try {
			return execFileSync("git", ["-C", this.root, "rev-parse", "--short", "HEAD"], { timeout: 2000, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		} catch {
			return undefined;
		}
	}

	async buildSnapshot(cwd: string): Promise<Snapshot> {
		const proj = await this.project(cwd);
		const read = (scope: string) => {
			const p = join(scopeDir(this.root, scope), INDEX_FILE);
			return existsSync(p) ? indexBody(readFileSync(p, "utf-8")) : "";
		};
		const g = read(GLOBAL_SCOPE);
		const p = read(projectScope(proj.key));
		const memver = this.memver();
		const text = renderInjection({
			memver,
			global: g,
			project: p ? { key: proj.key, body: p } : undefined,
			maxTokens: this.cfg.budgets.globalTokens + this.cfg.budgets.projectTokens + 200,
		});
		return { text, ids: text ? indexIds(text) : [], tokens: text ? estimateTokens(text) : 0, memver, projectKey: proj.key };
	}

	resourcesFor(cwd: string): Promise<string[]> {
		return this.project(cwd).then((proj) =>
			[join(scopeDir(this.root, GLOBAL_SCOPE), "skills"), join(scopeDir(this.root, projectScope(proj.key)), "skills")].filter((d) => existsSync(d)),
		);
	}

	// ── sync ─────────────────────────────────────────────────────────────

	async sync(force: boolean): Promise<string> {
		const P = memoryPaths(this.root);
		if (!existsSync(join(this.root, ".git"))) return "not initialized";
		try {
			if (!force && existsSync(P.sync) && Date.now() - statSync(P.sync).mtimeMs < SYNC_INTERVAL_MS) return "recently synced";
			mkdirSync(P.local, { recursive: true });
			if (existsSync(P.sync)) utimesSync(P.sync, new Date(), new Date());
			else writeFileSync(P.sync, "");
		} catch {
			// best effort
		}
		const base = this.cfg.github.base;
		if ((await git(this.root, ["remote", "get-url", "origin"])).code !== 0) return "no remote";
		const fetch = await git(this.root, ["fetch", "origin", base, "--quiet"], 20_000);
		if (fetch.code !== 0) return `fetch failed: ${fetch.stderr.trim().split("\n")[0]}`;
		const branch = (await git(this.root, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
		if (branch !== base) return `memory repo is on ${branch}`;
		if ((await git(this.root, ["status", "--porcelain"])).stdout.trim()) return "memory repo has local changes";
		const merge = await git(this.root, ["merge", "--ff-only", `origin/${base}`]);
		if (merge.code !== 0) return `fast-forward failed: ${merge.stderr.trim().split("\n")[0]}`;
		return /Already up to date/i.test(merge.stdout) ? "up to date" : "updated";
	}

	// ── tools ────────────────────────────────────────────────────────────

	private allNotes(scopes: string[]): Note[] {
		return scopes.flatMap((s) => loadNotes(this.root, s));
	}

	private dirsKey(dirs: string[]): string {
		return dirs
			.map((d) => {
				try {
					return `${d}:${statSync(d).mtimeMs}`;
				} catch {
					return `${d}:-`;
				}
			})
			.join("|");
	}

	async search(ctx: ExtensionContext, query: string, scope: "all" | "notes" | "sessions", projects: "current" | "all", limit: number): Promise<string> {
		const proj = await this.project(ctx.cwd);
		const out: string[] = [];
		if (scope !== "sessions") {
			const scopes = projects === "all" ? listScopes(this.root) : [GLOBAL_SCOPE, projectScope(proj.key)];
			const dirs = scopes.map((s) => join(scopeDir(this.root, s), "notes"));
			const key = this.dirsKey(dirs);
			if (!this.noteIndex || this.noteIndex.key !== key) {
				const notes = this.allNotes(scopes).filter((n) => n.id);
				this.noteIndex = { key, bm: new Bm25(notes.map((n) => ({ id: n.id, text: `${n.title}\n${n.when ?? ""}\n${n.body}`, meta: n }))) };
			}
			const hits = this.noteIndex.bm.search(query, limit);
			out.push(`notes (${hits.length}):`);
			for (const h of hits) {
				const n = h.doc.meta;
				const st = n.status === "active" ? "" : ` [${n.status}]`;
				out.push(`- [${n.id}] (${n.scope === GLOBAL_SCOPE ? "global" : shortKey(n.scope)}, ${n.type})${st} ${n.title}${n.when ? ` — when: ${n.when}` : ""}`);
			}
		}
		if (scope !== "notes") {
			const P = memoryPaths(this.root);
			const dirNames = projects === "all" ? (existsSync(P.digests) ? readdirSync(P.digests).filter((d) => !d.endsWith(".json")) : []) : [keyToDir(proj.key)];
			const docs: Doc<{ sessionId: string; entryId?: string; dir: string }>[] = [];
			for (const dir of dirNames) {
				const full = join(P.digests, dir);
				if (!existsSync(full)) continue;
				const cacheKey = this.dirsKey([full]);
				let cached = this.digestIndex.get(full);
				if (!cached || cached.key !== cacheKey) {
					const ds: typeof docs = [];
					for (const name of readdirSync(full)) {
						if (!name.endsWith(".txt")) continue;
						const sessionId = name.slice(0, -4);
						let text = "";
						try {
							text = readFileSync(join(full, name), "utf-8");
						} catch {
							continue;
						}
						for (const [k, ch] of chunkDigest(text).entries()) ds.push({ id: `${sessionId}#${k}`, text: ch.text, meta: { sessionId, entryId: ch.entryId, dir } });
					}
					cached = { key: cacheKey, bm: new Bm25(ds) };
					this.digestIndex.set(full, cached);
				}
				docs.push(...cached.bm.docs);
			}
			const bm = dirNames.length === 1 ? this.digestIndex.get(join(P.digests, dirNames[0]))?.bm : new Bm25(docs);
			const own = ctx.sessionManager.getSessionId();
			const hits = (bm?.search(query, limit * 2) ?? []).filter((h) => h.doc.meta.sessionId !== own).slice(0, limit);
			out.push(`past sessions (${hits.length}${existsSync(P.digests) ? "" : " — no digests yet: /dream index"}):`);
			for (const h of hits) {
				const ref = `s:${h.doc.meta.sessionId}#${h.doc.meta.entryId ?? ""}`;
				out.push(`- ${ref} (${h.doc.meta.dir === keyToDir(proj.key) ? "this project" : h.doc.meta.dir})\n  ${snippet(h.doc.text, query, 400).replace(/\n/g, "\n  ")}`);
			}
		}
		out.push("Open a note or a session reference with memory_read.");
		return clipHead(out.join("\n"), 9000);
	}

	async read(ref: string): Promise<string> {
		const r = ref.trim();
		if (/^m-[0-9a-f]{6,12}$/.test(r)) {
			const note = this.allNotes(listScopes(this.root)).find((n) => n.id === r);
			if (!note) return `No note ${r}.`;
			const ev = note.evidence
				.slice(-6)
				.map((e) => `${e.s.slice(0, 13)}${e.e.length ? `#${e.e.join(",")}` : ""} ${e.date ?? ""} ${e.kind ?? ""}`.trim())
				.join("; ");
			return [
				`[${note.id}] ${note.title}`,
				`type: ${note.type} · status: ${note.status}${note.validUntil ? ` (until ${note.validUntil})` : ""} · scope: ${note.scope === GLOBAL_SCOPE ? "global" : note.scope} · updated: ${note.updated}`,
				note.when ? `when: ${note.when}` : "",
				note.supersededBy ? `superseded by: ${note.supersededBy}` : "",
				"",
				note.body,
				"",
				`evidence (${note.evidence.length}): ${ev}`,
				"Evidence references can be opened as s:<session>#<entry>.",
			]
				.filter((l) => l !== "")
				.join("\n");
		}
		const m = /^s:([0-9a-zA-Z-]+)(?:#([0-9a-f-]+))?$/.exec(r);
		if (!m) return `Unknown reference "${r}". Use a note id (m-xxxxxx) or s:<sessionId>#<entryId>.`;
		const file = this.findSessionFile(m[1]);
		if (!file) return `No session ${m[1]}.`;
		const s = await parseSession(file);
		if (!s) return `Unreadable session ${m[1]}.`;
		let i = m[2] ? s.branch.findIndex((e) => e.id === m[2]) : 0;
		if (i < 0) i = 0;
		const parts = [`session ${s.header.id} · ${s.header.timestamp.slice(0, 16)} · cwd ${s.header.cwd}${s.name ? ` · "${s.name}"` : ""}`];
		for (let k = Math.max(0, i - 3); k <= Math.min(s.branch.length - 1, i + 4); k++) parts.push(renderEntryFull(s.branch[k], 1500));
		return clipHead(parts.join("\n"), 9000);
	}

	private findSessionFile(id: string): string | undefined {
		const P = memoryPaths(this.root);
		try {
			const idx = JSON.parse(readFileSync(P.digestIndex, "utf-8")) as Record<string, { sessionId: string }>;
			for (const [file, rec] of Object.entries(idx)) if (rec.sessionId === id || (id.length >= 8 && rec.sessionId.startsWith(id))) return file;
		} catch {
			// no index yet
		}
		const root = sessionsRoot();
		if (!existsSync(root)) return undefined;
		for (const dir of readdirSync(root)) {
			const full = join(root, dir);
			try {
				for (const name of readdirSync(full)) if (name.endsWith(`_${id}.jsonl`)) return join(full, name);
			} catch {
				// not a directory
			}
		}
		return undefined;
	}

	async inbox(ctx: ExtensionContext, text: string, source: "agent" | "user", kind?: InboxKind, scope?: "global" | "project"): Promise<string> {
		const proj = await this.project(ctx.cwd);
		const item = appendInbox(this.root, {
			source,
			text: text.trim(),
			kind,
			scope,
			cwd: ctx.cwd,
			projectKey: proj.key,
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
			entryId: ctx.sessionManager.getLeafId() ?? undefined,
		});
		return item.id;
	}

	// ── dreams ───────────────────────────────────────────────────────────

	dreaming(): boolean {
		return !!lockIsLive(memoryPaths(this.root).lock, this.cfg.dream.maxRuntimeMinutes * 90_000);
	}

	dueCheck() {
		const state = loadState(memoryPaths(this.root).state);
		const sessions = pendingSessions(listSessionFiles(), state, this.cfg);
		const inbox = pendingInbox(readInbox(this.root), state);
		return checkDue(this.cfg, state, sessions.length, inbox.length, this.dreaming());
	}

	startDream(extra: string[] = []): { runId: string; log: string } {
		const runId = newRunId();
		const { log } = spawnDream(this.cfg, runId, extra);
		return { runId, log };
	}

	async maybeDream(ctx: ExtensionContext): Promise<void> {
		if (!this.active() || !this.cfg.schedule.enabled || process.env.PI_DREAM_CHILD === "1") return;
		if (!existsSync(join(this.root, ".git"))) return;
		const due = this.dueCheck();
		if (!due.due) return;
		const { log } = this.startDream();
		ctx.ui.notify(
			ru(this.cfg)
				? `pi-dream: засыпаю в фоне — ${due.reason}. Лог: ${log}`
				: `pi-dream: dreaming in the background — ${due.reason}. Log: ${log}`,
			"info",
		);
	}

	private notifyFinishedDream(ctx: ExtensionContext): void {
		const P = memoryPaths(this.root);
		const state = loadState(P.state);
		const last = state?.lastRun;
		if (!last?.finishedAt) return;
		let seen = "";
		try {
			seen = (JSON.parse(readFileSync(P.notify, "utf-8")) as { runId?: string }).runId ?? "";
		} catch {
			// first time
		}
		if (seen === last.id) return;
		try {
			mkdirSync(P.local, { recursive: true });
			writeFileSync(P.notify, JSON.stringify({ runId: last.id }));
		} catch {
			// best effort
		}
		const r = ru(this.cfg);
		if (last.status === "ok" && last.pr) ctx.ui.notify(r ? `pi-dream: сон закончился — PR на ревью: ${last.pr}` : `pi-dream: dream finished — PR to review: ${last.pr}`, "info");
		else if (last.status === "error") ctx.ui.notify(r ? `pi-dream: сон упал — ${last.error ?? ""} (/dream log)` : `pi-dream: dream failed — ${last.error ?? ""} (/dream log)`, "warning");
	}

	status(ctx: ExtensionContext): string {
		const P = memoryPaths(this.root);
		const state = loadState(P.state);
		const lock = lockIsLive(P.lock, this.cfg.dream.maxRuntimeMinutes * 90_000);
		const snap = this.snapshot;
		const scopes = existsSync(P.scopes) ? listScopes(this.root) : [];
		const counts = scopes.map((s) => {
			const notes = loadNotes(this.root, s);
			return `${s === GLOBAL_SCOPE ? "global" : s.slice("projects/".length)}: ${notes.filter((n) => n.status === "active").length}`;
		});
		let due = "";
		try {
			const d = this.dueCheck();
			due = `${d.due ? "due" : "not due"} (${d.reason})`;
		} catch (err) {
			due = String(err);
		}
		const last = state?.lastRun;
		return [
			`memory:   ${this.root}${existsSync(join(this.root, ".git")) ? "" : " (not initialized: /dream init)"}`,
			`active:   ${this.active() ? "yes" : "no (--no-memory / PI_DREAM_DISABLE)"} · inject: ${this.cfg.inject}`,
			`session:  ${snap ? `${snap.ids.length} notes, ~${snap.tokens} tokens, memver ${snap.memver ?? "?"}` : "nothing injected yet (first turn builds it)"}`,
			`project:  ${snap?.projectKey ?? "(resolving)"}`,
			`notes:    ${counts.join(", ") || "none yet"}`,
			`inbox:    ${pendingInbox(readInbox(this.root), state).length} pending`,
			`dream:    ${lock ? `running (${lock.runId})` : due}`,
			`last:     ${last ? `${last.status} ${last.finishedAt ?? last.startedAt}${last.pr ? ` ${last.pr}` : ""}${last.error ? ` — ${last.error}` : ""}` : "never"}`,
			`review:   ${state?.openPr ? state.openPr.url : "no open PR"}`,
			`cwd:      ${ctx.cwd}`,
		].join("\n");
	}

	latestLog(lines = 40): string {
		const P = memoryPaths(this.root);
		if (!existsSync(P.logs)) return "no dream logs yet";
		const files = readdirSync(P.logs)
			.filter((f) => f.endsWith(".log"))
			.map((f) => ({ f, t: statSync(join(P.logs, f)).mtimeMs }))
			.sort((a, b) => b.t - a.t);
		if (!files[0]) return "no dream logs yet";
		const path = join(P.logs, files[0].f);
		const text = readFileSync(path, "utf-8").trimEnd().split("\n");
		return [`${path}:`, ...text.slice(-lines)].join("\n");
	}
}
