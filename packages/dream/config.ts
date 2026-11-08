/**
 * Settings for @wierdbytes/pi-dream.
 *
 * Stored at `~/.pi/agent/@wierdbytes/pi-dream/settings.json` (under
 * `PI_CODING_AGENT_DIR` when pi is pointed elsewhere). Missing, unknown or
 * malformed fields fall back to defaults, so a hand-edited file can never
 * break the extension. `PI_DREAM_DIR` overrides `memoryDir`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Mirrors pi-ai's thinking levels; kept local so this module has no pi-ai runtime import. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type Stage = "cards" | "analyze" | "verify";
export const STAGES: readonly Stage[] = ["cards", "analyze", "verify"];

export interface StageModel {
	/** `<provider>/<model-id>` */
	model: string;
	thinking: ThinkingLevel;
}

export interface DreamConfig {
	/** Root of the memory git repository. */
	memoryDir: string;
	/** Language the dream writes notes and reports in. */
	language: string;
	/** Inject the approved memory index into sessions. */
	inject: boolean;
	models: Record<Stage, StageModel>;
	schedule: {
		/** Start a background dream from pi when one is due. */
		enabled: boolean;
		minHoursBetween: number;
		/** New or grown sessions (or inbox items) needed before a dream is due. */
		minNewSessions: number;
	};
	dream: {
		/** How far back the very first dream looks. */
		firstRunLookbackDays: number;
		/** Sessions summarized per dream; the rest wait for the next one. */
		maxSessionsPerRun: number;
		/** Sessions written to more recently than this are treated as still in use. */
		minIdleMinutes: number;
		/** Parallel session-card calls. */
		concurrency: number;
		maxRuntimeMinutes: number;
		/**
		 * Extensions loaded into the headless dream process (it runs with
		 * `--no-extensions`). Use it for provider/auth extensions. `npm:<name>`
		 * resolves to pi's installed copy; missing entries are skipped.
		 */
		childExtensions: string[];
	};
	budgets: {
		/** Token budget of the global index injected into every session. */
		globalTokens: number;
		/** Token budget of a project's index injected into its sessions. */
		projectTokens: number;
	};
	github: {
		/** Repository name `/dream init` creates for the memory remote. */
		repo: string;
		base: string;
		label: string;
	};
	/** Propose AGENTS.md / CLAUDE.md changes as pull requests in project repositories. */
	agentsMd: boolean;
}

export function defaults(): DreamConfig {
	return {
		memoryDir: join(homedir(), ".pi", "memory"),
		language: "Russian",
		inject: true,
		models: {
			cards: { model: "anthropic/claude-sonnet-5-5", thinking: "low" },
			analyze: { model: "anthropic/claude-opus-5-5", thinking: "high" },
			verify: { model: "openai-codex/gpt-6.1-sol", thinking: "medium" },
		},
		schedule: { enabled: true, minHoursBetween: 20, minNewSessions: 3 },
		dream: {
			firstRunLookbackDays: 14,
			maxSessionsPerRun: 60,
			minIdleMinutes: 30,
			concurrency: 4,
			maxRuntimeMinutes: 180,
			childExtensions: ["npm:@wierdbytes/pi-anthropic"],
		},
		budgets: { globalTokens: 1000, projectTokens: 1500 },
		github: { repo: "pi-memory", base: "main", label: "pi-dream" },
		agentsMd: true,
	};
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
	typeof v === "string" && (list as readonly string[]).includes(v);
const num = (v: unknown, min: number, max: number, fallback: number): number =>
	typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
const str = (v: unknown, fallback: string): string => (typeof v === "string" && v.trim() ? v.trim() : fallback);

export function expandHome(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return resolve(p);
}

function stageModel(raw: unknown, fallback: StageModel): StageModel {
	if (!isObj(raw)) return { ...fallback };
	const model = typeof raw.model === "string" && raw.model.includes("/") ? raw.model.trim() : fallback.model;
	const thinking = oneOf(THINKING_LEVELS, raw.thinking) ? raw.thinking : fallback.thinking;
	return { model, thinking };
}

export function sanitize(raw: unknown): DreamConfig {
	const d = defaults();
	if (!isObj(raw)) return d;
	const cfg = d;
	cfg.memoryDir = expandHome(str(raw.memoryDir, d.memoryDir));
	cfg.language = str(raw.language, d.language);
	cfg.inject = bool(raw.inject, d.inject);
	if (isObj(raw.models)) {
		for (const stage of STAGES) cfg.models[stage] = stageModel(raw.models[stage], d.models[stage]);
	}
	if (isObj(raw.schedule)) {
		const s = raw.schedule;
		cfg.schedule = {
			enabled: bool(s.enabled, d.schedule.enabled),
			minHoursBetween: num(s.minHoursBetween, 0, 24 * 30, d.schedule.minHoursBetween),
			minNewSessions: Math.round(num(s.minNewSessions, 1, 1000, d.schedule.minNewSessions)),
		};
	}
	if (isObj(raw.dream)) {
		const s = raw.dream;
		cfg.dream = {
			firstRunLookbackDays: num(s.firstRunLookbackDays, 0, 3650, d.dream.firstRunLookbackDays),
			maxSessionsPerRun: Math.round(num(s.maxSessionsPerRun, 1, 1000, d.dream.maxSessionsPerRun)),
			minIdleMinutes: num(s.minIdleMinutes, 0, 24 * 60, d.dream.minIdleMinutes),
			concurrency: Math.round(num(s.concurrency, 1, 16, d.dream.concurrency)),
			maxRuntimeMinutes: num(s.maxRuntimeMinutes, 5, 24 * 60, d.dream.maxRuntimeMinutes),
			childExtensions: Array.isArray(s.childExtensions)
				? s.childExtensions.filter((x): x is string => typeof x === "string" && !!x.trim())
				: d.dream.childExtensions,
		};
	}
	if (isObj(raw.budgets)) {
		cfg.budgets = {
			globalTokens: Math.round(num(raw.budgets.globalTokens, 0, 20000, d.budgets.globalTokens)),
			projectTokens: Math.round(num(raw.budgets.projectTokens, 0, 20000, d.budgets.projectTokens)),
		};
	}
	if (isObj(raw.github)) {
		cfg.github = {
			repo: str(raw.github.repo, d.github.repo),
			base: str(raw.github.base, d.github.base),
			label: str(raw.github.label, d.github.label),
		};
	}
	cfg.agentsMd = bool(raw.agentsMd, d.agentsMd);
	return cfg;
}

export function configPath(): string {
	return join(getAgentDir(), "@wierdbytes", "pi-dream", "settings.json");
}

export function loadConfig(path: string = configPath()): DreamConfig {
	let cfg: DreamConfig;
	try {
		cfg = existsSync(path) ? sanitize(JSON.parse(readFileSync(path, "utf-8"))) : defaults();
	} catch {
		cfg = defaults();
	}
	if (process.env.PI_DREAM_DIR) cfg.memoryDir = expandHome(process.env.PI_DREAM_DIR);
	return cfg;
}

export function saveConfig(cfg: DreamConfig, path: string = configPath()): void {
	mkdirSync(dirname(path), { recursive: true });
	const out = { ...cfg, memoryDir: cfg.memoryDir.replace(homedir(), "~") };
	writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`, "utf-8");
}

/** `true` when the user disabled pi-dream for this process. */
export function disabledByEnv(): boolean {
	return process.env.PI_DREAM_DISABLE === "1" || process.env.PI_DREAM_CHILD === "1";
}
