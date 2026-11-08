/**
 * Which project a working directory belongs to.
 *
 * The key is the normalized `origin` remote (`github.com/owner/repo`) when the
 * directory is inside a git repository with a remote, otherwise
 * `local:<repo root or cwd>`. Worktrees resolve to their main repository
 * through `--git-common-dir`, so every checkout of a repo shares one memory.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface ProjectInfo {
	key: string;
	/** Main repository root (or the cwd outside git). */
	root: string;
	/** Root of the checkout the cwd is in (differs from `root` in a worktree). */
	checkout?: string;
	remote?: string;
	git: boolean;
	exists: boolean;
	/** A git repo or a folder with project markers (not ~/Downloads, ~/.pi/agent, /tmp…). */
	project: boolean;
}

export const PROJECT_MARKERS = [
	".git",
	".pi",
	".agents",
	"AGENTS.md",
	"CLAUDE.md",
	"package.json",
	"pyproject.toml",
	"requirements.txt",
	"Cargo.toml",
	"go.mod",
	"deno.json",
	"Gemfile",
	"Makefile",
	"justfile",
	"flake.nix",
];

export function looksLikeProject(dir: string): boolean {
	return PROJECT_MARKERS.some((m) => existsSync(join(dir, m)));
}

/** `git@github.com:o/r.git`, `https://user@github.com/o/r`, `ssh://git@host:22/o/r` → `host/o/r`. */
export function normalizeRemote(url: string): string | undefined {
	const u = url.trim();
	if (!u) return undefined;
	let host: string;
	let path: string;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
		let parsed: URL;
		try {
			parsed = new URL(u);
		} catch {
			return undefined;
		}
		if (parsed.protocol === "file:") return undefined;
		host = parsed.hostname;
		path = decodeURIComponent(parsed.pathname);
	} else {
		const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(u);
		if (!scp) return undefined;
		host = scp[1];
		path = scp[2];
	}
	path = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
	if (!host || !path) return undefined;
	return `${host.toLowerCase()}/${path}`;
}

function gitOut(args: string[], timeoutMs = 4000): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("git", args, { timeout: timeoutMs, maxBuffer: 1 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout) =>
			resolve(err ? undefined : String(stdout).trim() || undefined),
		);
	});
}

async function compute(cwd: string): Promise<ProjectInfo> {
	if (!cwd || !existsSync(cwd)) return { key: `local:${cwd}`, root: cwd, git: false, exists: false, project: false };
	const common = await gitOut(["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
	if (!common) return { key: `local:${cwd}`, root: cwd, git: false, exists: true, project: looksLikeProject(cwd) };
	const checkout = await gitOut(["-C", cwd, "rev-parse", "--show-toplevel"]);
	const root = basename(common) === ".git" ? dirname(common) : (checkout ?? cwd);
	let remote = await gitOut(["-C", root, "config", "--get", "remote.origin.url"]);
	if (!remote) {
		const first = (await gitOut(["-C", root, "remote"]))?.split("\n")[0];
		if (first) remote = await gitOut(["-C", root, "config", "--get", `remote.${first}.url`]);
	}
	const norm = remote ? normalizeRemote(remote) : undefined;
	return { key: norm ?? `local:${root}`, root, checkout, remote, git: true, exists: true, project: true };
}

const cache = new Map<string, Promise<ProjectInfo>>();

export function resolveProject(cwd: string): Promise<ProjectInfo> {
	let hit = cache.get(cwd);
	if (!hit) {
		hit = compute(cwd);
		cache.set(cwd, hit);
	}
	return hit;
}

/** Short human label for a key: `github.com/o/r` → `o/r`, `local:/a/b/c` → `c`. */
export function shortKey(key: string): string {
	if (key.startsWith("local:")) return basename(key.slice(6)) || key;
	const parts = key.split("/");
	return parts.length >= 3 ? parts.slice(1).join("/") : key;
}
