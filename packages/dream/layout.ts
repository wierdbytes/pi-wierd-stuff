/**
 * Layout of the memory repository.
 *
 * ```
 * <memoryDir>/                 git repo, `main` = approved memory
 *   scopes/global/             loaded in every session on this machine
 *     charter.md               what this memory is for (steers the dream)
 *     MEMORY.md                generated index — the part injected into sessions
 *     notes/<slug>.md          one note per file, YAML front matter + body
 *     skills/<name>/SKILL.md   approved skills (exposed to pi)
 *   scopes/projects/<key>/     same, for one project (git remote or path)
 *   reports/<run>.md           one report per dream
 *   prompts/<stage>.md         optional overrides of the dream prompts
 *   .local/                    gitignored: inbox, digests, cards, state, logs
 * ```
 */

import { createHash } from "node:crypto";
import { join } from "node:path";

export const GLOBAL_SCOPE = "global";
export const INDEX_FILE = "MEMORY.md";
export const CHARTER_FILE = "charter.md";
export const SCOPE_META_FILE = "scope.json";

/** Directory-safe name for a project key (`github.com/o/r` → `github.com__o__r`). */
export function keyToDir(key: string): string {
	const raw = key.startsWith("local:") ? `local/${key.slice(6)}` : key;
	let s = raw
		.split("/")
		.filter(Boolean)
		.join("__")
		.replace(/[^A-Za-z0-9._-]/g, "_");
	if (s.length > 120) s = `${s.slice(0, 100)}__${createHash("sha256").update(key).digest("hex").slice(0, 8)}`;
	return s || "_";
}

/** Scope id for a project key: `projects/<dir>`. */
export function projectScope(key: string): string {
	return `projects/${keyToDir(key)}`;
}

export function scopeDir(root: string, scope: string): string {
	return join(root, "scopes", scope);
}

export interface MemoryPaths {
	root: string;
	scopes: string;
	reports: string;
	prompts: string;
	local: string;
	state: string;
	lock: string;
	notify: string;
	inbox: string;
	digests: string;
	digestIndex: string;
	cards: string;
	runs: string;
	logs: string;
	worktrees: string;
	sync: string;
}

export function memoryPaths(root: string): MemoryPaths {
	const local = join(root, ".local");
	return {
		root,
		scopes: join(root, "scopes"),
		reports: join(root, "reports"),
		prompts: join(root, "prompts"),
		local,
		state: join(local, "state.json"),
		lock: join(local, "dream.lock"),
		notify: join(local, "notified.json"),
		inbox: join(local, "inbox"),
		digests: join(local, "digests"),
		digestIndex: join(local, "digests", "index.json"),
		cards: join(local, "cards"),
		runs: join(local, "runs"),
		logs: join(local, "logs"),
		worktrees: join(local, "worktrees"),
		sync: join(local, "last-sync"),
	};
}

/** Local calendar date `YYYY-MM-DD`. */
export function today(d: Date = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Sortable run id: `20261108-0415-a1b2`. */
export function newRunId(d: Date = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	const rand = Math.random().toString(16).slice(2, 6);
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-${rand}`;
}
