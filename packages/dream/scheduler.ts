/**
 * When to dream, and how to start one.
 *
 * pi itself is the scheduler: when a session starts and a dream is due
 * (enough new sessions or inbox items, enough time since the last one, no
 * dream running), a detached headless pi process runs the dream. It keeps
 * running after the interactive pi exits.
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { DreamConfig } from "./config.ts";
import type { InboxItem } from "./inbox.ts";
import { memoryPaths } from "./layout.ts";
import type { SessionFile } from "./sessions.ts";
import type { DreamState } from "./state.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Sessions the next dream should summarize, oldest first. */
export function pendingSessions(files: readonly SessionFile[], state: DreamState | undefined, cfg: DreamConfig, now = Date.now()): SessionFile[] {
	const cutoff = state?.cutoffMs ?? now - cfg.dream.firstRunLookbackDays * DAY;
	return files
		.filter((f) => {
			const mark = state?.sessions[f.path];
			if (mark && mark.size === f.size && (mark.ok || mark.failures >= 3)) return false;
			if (!mark && f.mtimeMs < cutoff) return false;
			if (now - f.mtimeMs < cfg.dream.minIdleMinutes * MINUTE) return false;
			return true;
		})
		.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

export function pendingInbox(items: readonly InboxItem[], state: DreamState | undefined): InboxItem[] {
	const done = new Set(state?.inboxDone ?? []);
	return items.filter((i) => !done.has(i.id));
}

export interface DueCheck {
	due: boolean;
	reason: string;
	sessions: number;
	inbox: number;
}

export function checkDue(
	cfg: DreamConfig,
	state: DreamState | undefined,
	sessions: number,
	inbox: number,
	dreaming: boolean,
	now = Date.now(),
): DueCheck {
	const base = { sessions, inbox };
	if (!cfg.schedule.enabled) return { ...base, due: false, reason: "schedule disabled" };
	if (dreaming) return { ...base, due: false, reason: "a dream is running" };
	const last = state?.lastRun?.finishedAt ?? state?.lastRun?.startedAt;
	const minHours = state?.lastRun?.status === "error" ? Math.min(cfg.schedule.minHoursBetween, 2) : cfg.schedule.minHoursBetween;
	if (last) {
		const hours = (now - Date.parse(last)) / HOUR;
		if (hours < minHours) return { ...base, due: false, reason: `last dream ${hours.toFixed(1)} h ago (< ${minHours} h)` };
	}
	if (sessions + inbox < cfg.schedule.minNewSessions)
		return { ...base, due: false, reason: `${sessions} new sessions + ${inbox} inbox (< ${cfg.schedule.minNewSessions})` };
	return { ...base, due: true, reason: `${sessions} new sessions, ${inbox} inbox items` };
}

/** `@scope/name@1.2.3` → `@scope/name`, `name@1` → `name`. */
export function npmPackageName(spec: string): string {
	const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
	return at > 0 ? spec.slice(0, at) : spec;
}

/** Resolve `childExtensions` entries to paths pi can load with `-e`. */
export function resolveChildExtensions(list: readonly string[]): string[] {
	const out: string[] = [];
	for (const entry of list) {
		if (entry.startsWith("npm:")) {
			const path = join(getAgentDir(), "npm", "node_modules", npmPackageName(entry.slice(4)));
			if (existsSync(path)) out.push(path);
		} else if (existsSync(entry)) {
			out.push(entry);
		}
	}
	return out;
}

export function runnerFile(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "runner.ts");
}

/** How to invoke pi again: the running CLI when we know it, else `pi` from PATH. */
function piCommand(): { cmd: string; pre: string[] } {
	const script = process.argv[1];
	if (script && (basename(script) === "pi" || script.endsWith("cli.js"))) return { cmd: process.execPath, pre: [script] };
	return { cmd: "pi", pre: [] };
}

export function dreamArgs(cfg: DreamConfig, runId: string, extra: readonly string[]): { cmd: string; args: string[] } {
	const { cmd, pre } = piCommand();
	const exts = resolveChildExtensions(cfg.dream.childExtensions).flatMap((p) => ["-e", p]);
	const command = ["/pi-dream-run", "--run-id", runId, ...extra].join(" ");
	return {
		cmd,
		args: [...pre, "-p", "--no-session", "--no-extensions", ...exts, "-e", runnerFile(), "--no-skills", "--no-context-files", "--no-prompt-templates", command],
	};
}

/** Start a detached dream; returns the log file path. */
export function spawnDream(cfg: DreamConfig, runId: string, extra: readonly string[] = []): { pid?: number; log: string } {
	const P = memoryPaths(cfg.memoryDir);
	mkdirSync(P.logs, { recursive: true });
	const log = join(P.logs, `${runId}.log`);
	const fd = openSync(log, "a");
	const { cmd, args } = dreamArgs(cfg, runId, extra);
	try {
		const child = spawn(cmd, args, {
			cwd: cfg.memoryDir,
			detached: true,
			stdio: ["ignore", fd, fd],
			env: { ...process.env, PI_DREAM_CHILD: "1" },
		});
		child.unref();
		return { pid: child.pid, log };
	} finally {
		closeSync(fd);
	}
}
