/**
 * Local dream state (`.local/state.json`, never committed): which sessions and
 * inbox items were processed, the open review pull request, what was rejected.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SessionMark {
	size: number;
	mtimeMs: number;
	at: string;
	/** The session (at this size) was summarized, or had nothing to summarize. */
	ok: boolean;
	/** Failed card attempts at this size; the session is skipped after 3. */
	failures: number;
}

export interface RunRecord {
	id: string;
	pr?: number;
	/** Notes added by this run (id + title), to learn from rejections. */
	added: Array<{ id: string; title: string }>;
}

export interface DreamState {
	version: 1;
	createdAt: string;
	/** Sessions last written before this and never processed are ignored. */
	cutoffMs: number;
	sessions: Record<string, SessionMark>;
	inboxDone: string[];
	lastRun?: {
		id: string;
		startedAt: string;
		finishedAt?: string;
		status: "running" | "ok" | "noop" | "error";
		error?: string;
		pr?: string;
		sessions?: number;
		cost?: number;
	};
	openPr?: { number: number; url: string; branch: string };
	/** PR number → ISO time of the newest review comment already applied. */
	reviewSeen: Record<string, string>;
	rejected: Array<{ title: string; at: string; pr?: number }>;
	runs: RunRecord[];
}

export function freshState(lookbackDays: number, now = Date.now()): DreamState {
	return {
		version: 1,
		createdAt: new Date(now).toISOString(),
		cutoffMs: now - lookbackDays * 86_400_000,
		sessions: {},
		inboxDone: [],
		reviewSeen: {},
		rejected: [],
		runs: [],
	};
}

export function loadState(path: string): DreamState | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const s = JSON.parse(readFileSync(path, "utf-8")) as DreamState;
		if (s?.version !== 1) return undefined;
		s.sessions ??= {};
		s.inboxDone ??= [];
		s.reviewSeen ??= {};
		s.rejected ??= [];
		s.runs ??= [];
		return s;
	} catch {
		return undefined;
	}
}

export function saveState(path: string, state: DreamState): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(state, null, 1)}\n`, "utf-8");
	renameSync(tmp, path);
}
