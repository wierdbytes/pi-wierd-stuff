/**
 * AGENTS.md / CLAUDE.md proposals.
 *
 * Edits are exact text replacements. They are applied in a temporary git
 * worktree checked out from the project's default branch on `origin` — the
 * user's working copy is never touched — committed on a `pi-dream/…` branch,
 * pushed, and opened as a pull request in the project's own repository.
 * Without a GitHub remote the edits are returned as a patch for the report.
 * Public repositories get a minimal PR body: no rationale from private sessions.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gh, ghOk, git, githubRepoOf, gitOk } from "./gitops.ts";

export interface AgentsEdit {
	old: string;
	new: string;
}

export const CONTEXT_FILES = ["AGENTS.md", "CLAUDE.md", "AGENTS.MD", "CLAUDE.MD"];

export function findContextFile(dir: string | undefined): { path: string; rel: string } | undefined {
	if (!dir) return undefined;
	for (const rel of CONTEXT_FILES) {
		const path = join(dir, rel);
		if (existsSync(path)) return { path, rel };
	}
	return undefined;
}

export function applyEdits(content: string, edits: AgentsEdit[]): { content: string; skipped: number } | { error: string } {
	let out = content;
	let skipped = 0;
	for (const [i, e] of edits.entries()) {
		if (e.old === "") {
			if (e.new.trim() && out.includes(e.new.trim())) {
				skipped++;
				continue;
			}
			out = `${out.replace(/\s*$/, "")}\n\n${e.new.trim()}\n`;
			continue;
		}
		const first = out.indexOf(e.old);
		if (first < 0) {
			// Already applied (e.g. proposed again while the first pull request is open).
			if (e.new && out.includes(e.new)) {
				skipped++;
				continue;
			}
			return { error: `edit ${i + 1}: text not found` };
		}
		if (out.indexOf(e.old, first + 1) >= 0) return { error: `edit ${i + 1}: text is not unique` };
		out = out.slice(0, first) + e.new + out.slice(first + e.old.length);
	}
	return { content: out, skipped };
}

export function renderEditsDiff(rel: string, edits: AgentsEdit[]): string {
	const blocks = edits.map((e) => {
		const minus = e.old ? e.old.split("\n").map((l) => `- ${l}`) : ["- (append at the end)"];
		const plus = e.new.split("\n").map((l) => `+ ${l}`);
		return [...minus, ...plus].join("\n");
	});
	return `\`${rel}\`\n\n\`\`\`diff\n${blocks.join("\n\n")}\n\`\`\``;
}

/** URL of an open pi-dream AGENTS.md pull request in the repository at `repoRoot`, if any. */
export async function openAgentsPr(repoRoot: string): Promise<string | undefined> {
	const remote = await git(repoRoot, ["remote", "get-url", "origin"]);
	const repo = remote.code === 0 ? githubRepoOf(remote.stdout.trim()) : undefined;
	if (!repo) return undefined;
	const r = await gh(["pr", "list", "--repo", repo, "--state", "open", "--json", "url,headRefName"]);
	if (r.code !== 0) return undefined;
	try {
		return (JSON.parse(r.stdout || "[]") as Array<{ url: string; headRefName: string }>).find((p) => p.headRefName.startsWith("pi-dream/agents-"))?.url;
	} catch {
		return undefined;
	}
}

export interface AgentsPublishInput {
	/** Main repository root of the project. */
	repoRoot: string;
	rel: string;
	edits: AgentsEdit[];
	runId: string;
	worktreesDir: string;
	title: string;
	/** Rationale lines, shown only for private repositories. */
	details: string[];
	log: (msg: string) => void;
}

export interface AgentsPublishResult {
	url?: string;
	error?: string;
	patch: string;
}

async function defaultBranch(root: string, repo: string): Promise<string> {
	const head = await git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
	if (head.code === 0 && head.stdout.trim().startsWith("origin/")) return head.stdout.trim().slice("origin/".length);
	const r = await gh(["repo", "view", repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]);
	return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : "main";
}

export async function publishAgentsEdits(input: AgentsPublishInput): Promise<AgentsPublishResult> {
	const patch = renderEditsDiff(input.rel, input.edits);
	const remote = await git(input.repoRoot, ["remote", "get-url", "origin"]);
	const repo = remote.code === 0 ? githubRepoOf(remote.stdout.trim()) : undefined;
	if (!repo) return { patch, error: "no GitHub remote: patch only" };
	const wt = join(input.worktreesDir, `agents-${input.runId}-${repo.replace("/", "__")}`);
	let branch = `pi-dream/agents-${input.runId}`;
	try {
		await gitOk(input.repoRoot, ["fetch", "origin", "--quiet"], 120_000);
		const base = await defaultBranch(input.repoRoot, repo);
		// One open pi-dream pull request per repository: later proposals are added to it.
		const open = await gh(["pr", "list", "--repo", repo, "--state", "open", "--json", "number,url,headRefName"]);
		const existing = open.code === 0
			? (JSON.parse(open.stdout || "[]") as Array<{ number: number; url: string; headRefName: string }>).find((p) => p.headRefName.startsWith("pi-dream/agents-"))
			: undefined;
		if (existing) {
			branch = existing.headRefName;
			await gitOk(input.repoRoot, ["fetch", "origin", branch, "--quiet"], 120_000);
		}
		mkdirSync(input.worktreesDir, { recursive: true });
		await gitOk(input.repoRoot, ["worktree", "add", "--detach", wt, existing ? `origin/${branch}` : `origin/${base}`], 120_000);
		const file = join(wt, input.rel);
		if (!existsSync(file)) return { patch, error: `${input.rel} does not exist on origin/${base}` };
		const before = readFileSync(file, "utf-8");
		const res = applyEdits(before, input.edits);
		if ("error" in res) return { patch, error: `${res.error} on ${existing ? branch : `origin/${base}`}` };
		if (res.content === before) {
			input.log(`  agents_md: already proposed in ${existing?.url ?? repo}`);
			return { url: existing?.url, patch, error: existing ? undefined : "nothing to change" };
		}
		writeFileSync(file, res.content, "utf-8");
		if (!existing) await gitOk(wt, ["checkout", "-b", branch]);
		await gitOk(wt, ["add", input.rel]);
		await gitOk(wt, ["commit", "--no-verify", "-m", `${input.rel}: ${input.title}\n\nProposed by pi-dream.`]);
		await gitOk(wt, ["push", "origin", `HEAD:refs/heads/${branch}`], 120_000);
		if (existing) {
			input.log(`  agents_md: added to ${existing.url}`);
			return { url: existing.url, patch };
		}
		const vis = await gh(["repo", "view", repo, "--json", "visibility", "--jq", ".visibility"]);
		const isPublic = vis.code !== 0 || vis.stdout.trim().toUpperCase() !== "PRIVATE";
		const body = [
			`Proposed by [pi-dream](https://github.com/wierdbytes/pi-wierd-stuff/tree/master/packages/dream) from the owner's pi session history.`,
			"",
			...(isPublic ? ["Details are in the owner's private memory review."] : input.details.map((d) => `- ${d}`)),
			"",
			"<!-- pi-dream:agents -->",
		].join("\n");
		const url = await ghOk(["pr", "create", "--repo", repo, "--base", base, "--head", branch, "--title", `${input.rel}: ${input.title}`, "--body", body], {
			timeoutMs: 120_000,
		});
		input.log(`  agents_md PR: ${url}`);
		return { url: url.split("\n").pop()?.trim(), patch };
	} catch (err) {
		return { patch, error: err instanceof Error ? err.message : String(err) };
	} finally {
		if (existsSync(wt)) {
			await git(input.repoRoot, ["worktree", "remove", "--force", wt]);
			rmSync(wt, { recursive: true, force: true });
		}
		await git(input.repoRoot, ["worktree", "prune"]);
		if (branch.startsWith("pi-dream/agents-")) await git(input.repoRoot, ["branch", "-D", branch]);
	}
}
