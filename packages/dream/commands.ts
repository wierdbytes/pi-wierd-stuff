/**
 * /dream · /memory · /remember
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initMemory } from "./setup.ts";
import type { Runtime } from "./runtime.ts";

const DREAM_SUB = [
	{ value: "status", label: "status", description: "Memory, last dream, open review PR" },
	{ value: "run", label: "run", description: "Dream now in the background (--since <days> --max <sessions>)" },
	{ value: "review", label: "review", description: "Apply new comments on the review PR now (no new sessions)" },
	{ value: "dry", label: "dry", description: "Dream without pushing: report + worktree stay local" },
	{ value: "index", label: "index", description: "Rebuild session digests (search corpus) in the background" },
	{ value: "log", label: "log", description: "Tail of the latest dream log" },
	{ value: "init", label: "init", description: "Create the memory repo, its private GitHub remote and settings" },
];

const MEMORY_SUB = [
	{ value: "status", label: "status", description: "What this session got from memory" },
	{ value: "sync", label: "sync", description: "Pull approved memory from GitHub now" },
];

function completions(list: typeof DREAM_SUB) {
	return (prefix: string) => {
		const p = prefix.trim().toLowerCase();
		const items = list.filter((c) => c.value.startsWith(p));
		return items.length ? items : null;
	};
}

export function registerCommands(pi: ExtensionAPI, rt: Runtime): void {
	pi.registerCommand("dream", {
		description: "pi-dream: status, run, review, dry, index, log, init",
		getArgumentCompletions: completions(DREAM_SUB),
		handler: async (args, ctx) => {
			const [cmd = "status", ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
			switch (cmd) {
				case "status":
					return ctx.ui.notify(rt.status(ctx), "info");
				case "log":
					return ctx.ui.notify(rt.latestLog(), "info");
				case "init": {
					const lines: string[] = [];
					try {
						const res = await initMemory(rt.cfg, (m) => lines.push(m));
						lines.push(res.repo ? `ready: https://github.com/${res.repo}` : "ready (no GitHub remote)");
						ctx.ui.notify(`pi-dream init\n${lines.join("\n")}`, "info");
					} catch (err) {
						ctx.ui.notify(`pi-dream init failed: ${err instanceof Error ? err.message : String(err)}\n${lines.join("\n")}`, "error");
					}
					return;
				}
				case "run":
				case "review":
				case "dry":
				case "index": {
					if (rt.dreaming()) return ctx.ui.notify("pi-dream: a dream is already running (/dream log)", "warning");
					const extra = cmd === "dry" ? ["--dry-run", ...rest] : cmd === "index" ? ["--reindex"] : cmd === "review" ? ["--review-only"] : rest;
					const { runId, log } = rt.startDream(extra);
					return ctx.ui.notify(`pi-dream: ${cmd} started (${runId})\nlog: ${log}`, "info");
				}
				default:
					return ctx.ui.notify("Usage: /dream [status|run|review|dry|index|log|init]", "info");
			}
		},
	});

	pi.registerCommand("memory", {
		description: "pi-dream memory: status, sync",
		getArgumentCompletions: completions(MEMORY_SUB),
		handler: async (args, ctx) => {
			const cmd = (args ?? "").trim().toLowerCase() || "status";
			if (cmd === "sync") {
				const res = await rt.sync(true);
				return ctx.ui.notify(`pi-dream sync: ${res}${res === "updated" ? " — new sessions get the merged memory" : ""}`, "info");
			}
			const section = await rt.memorySection(ctx);
			return ctx.ui.notify(`${rt.status(ctx)}${section ? `\n\n<memory>\n${section}\n</memory>` : ""}`, "info");
		},
	});

	pi.registerCommand("remember", {
		description: "Save a note to the pi-dream inbox for the next dream to review",
		handler: async (args, ctx) => {
			const text = (args ?? "").trim();
			if (!text) return ctx.ui.notify("Usage: /remember <what future sessions should know>", "info");
			const id = await rt.inbox(ctx, text, "user");
			ctx.ui.notify(`pi-dream: saved to the inbox (${id}) — the next dream will propose it for review`, "info");
		},
	});
}
