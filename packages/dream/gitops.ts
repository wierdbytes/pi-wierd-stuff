/**
 * Thin, timeout-bounded wrappers around `git` and `gh`.
 *
 * Background dreams must never hang on a prompt: git runs with
 * `GIT_TERMINAL_PROMPT=0` and ssh in batch mode, gh with `GH_PROMPT_DISABLED`.
 */

import { execFile } from "node:child_process";

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

const ENV = {
	GIT_TERMINAL_PROMPT: "0",
	GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o ConnectTimeout=20",
	GH_PROMPT_DISABLED: "1",
	GH_NO_UPDATE_NOTIFIER: "1",
};

export function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
	return new Promise((resolve) => {
		execFile(
			cmd,
			args,
			{ cwd: opts.cwd, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...ENV } },
			(err, stdout, stderr) => {
				const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
				const code = !e ? 0 : typeof e.code === "number" ? e.code : 1;
				const extra = e && !String(stderr ?? "").trim() ? (e.killed ? "timed out" : e.message) : "";
				resolve({ code, stdout: String(stdout ?? ""), stderr: `${String(stderr ?? "")}${extra}` });
			},
		);
	});
}

export function git(cwd: string, args: string[], timeoutMs?: number): Promise<ExecResult> {
	return run("git", ["-C", cwd, ...args], { timeoutMs });
}

/** Run git and return trimmed stdout; throws with stderr on failure. */
export async function gitOk(cwd: string, args: string[], timeoutMs?: number): Promise<string> {
	const r = await git(cwd, args, timeoutMs);
	if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim() || `exit ${r.code}`}`);
	return r.stdout.trim();
}

export function gh(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
	return run("gh", args, opts);
}

export async function ghOk(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<string> {
	const r = await gh(args, opts);
	if (r.code !== 0) throw new Error(`gh ${args.slice(0, 3).join(" ")}: ${r.stderr.trim() || `exit ${r.code}`}`);
	return r.stdout.trim();
}

export async function ghJson<T>(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<T> {
	return JSON.parse(await ghOk(args, opts)) as T;
}

/** `owner/repo` for a GitHub remote URL, or undefined. */
export function githubRepoOf(remoteUrl: string | undefined): string | undefined {
	if (!remoteUrl) return undefined;
	const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
	return m ? `${m[1]}/${m[2]}` : undefined;
}
