/**
 * Persistent config for @wierdbytes/pi-facelift.
 *
 * Stored at `<piAgentDir>/wierd-facelift/config.json`. Pattern mirrors
 * `packages/voice/config.ts` and `packages/web/config.ts`:
 *
 *   - First-run load: file missing ⇒ seed from env, write to disk.
 *   - Subsequent loads: read JSON, `sanitize()` unknown fields back to
 *     defaults so a hand-edited file with typos doesn't crash the
 *     extension.
 *   - Saves write atomically (one JSON.stringify + trailing newline).
 *
 * The only knob we expose today is `diffLayout`, but the schema is
 * designed to accept more fields (icon mode, max preview lines, etc.)
 * without breaking older config files.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { configPath as defaultConfigPath, ensureFaceliftDir } from "./paths.ts";

/**
 * User-facing layout preference for the write/edit diff renderer.
 *
 * Mirrors `DiffLayoutPreference` from `@wierdbytes/pi-common/diff`. We
 * re-declare it here so the config module has no runtime dependency on
 * the diff package — the two values are kept in sync by the
 * `decideDiffLayout` helper in `index.ts`.
 */
export const VALID_DIFF_LAYOUTS = ["consistent", "split", "unified", "per-edit"] as const;
export type DiffLayoutPreference = (typeof VALID_DIFF_LAYOUTS)[number];
export const DEFAULT_DIFF_LAYOUT: DiffLayoutPreference = "consistent";

export interface WierdFaceliftConfig {
	/**
	 * How to pick split-vs-unified for write/edit diffs:
	 *
	 *   • `"consistent"` (default) — one layout per tool call. If every
	 *     diff fits without excessive line wrapping → split; else →
	 *     unified for all. Avoids `Edit 1 split, Edit 2 unified` mixed
	 *     renders within one tool call.
	 *   • `"split"`     — always side-by-side, even when long lines
	 *     wrap.
	 *   • `"unified"`   — always stacked single-column.
	 *   • `"per-edit"`  — each diff picks independently (original
	 *     pi-diff behaviour; can produce mixed layouts in one call).
	 */
	diffLayout: DiffLayoutPreference;
}

function isDiffLayout(value: unknown): value is DiffLayoutPreference {
	return typeof value === "string" && (VALID_DIFF_LAYOUTS as readonly string[]).includes(value);
}

/**
 * Seed defaults from the environment. `DIFF_LAYOUT` is the only env
 * override today; everything else falls back to the hard-coded default.
 *
 * The env var is read at every defaults() call, not cached at module
 * load, so callers can change it between tests / sub-processes without
 * having to re-import the module.
 */
export function envDefaults(): WierdFaceliftConfig {
	const envLayout = process.env.DIFF_LAYOUT?.trim().toLowerCase();
	const fromEnv = envLayout && isDiffLayout(envLayout) ? envLayout : undefined;
	return {
		diffLayout: fromEnv ?? DEFAULT_DIFF_LAYOUT,
	};
}

function sanitize(raw: unknown): WierdFaceliftConfig {
	const defaults = envDefaults();
	if (!raw || typeof raw !== "object") return defaults;
	const obj = raw as Record<string, unknown>;
	const cfg: WierdFaceliftConfig = { ...defaults };
	if (isDiffLayout(obj.diffLayout)) cfg.diffLayout = obj.diffLayout;
	return cfg;
}

/**
 * Canonical config path. Wrapper around `paths.ts` so callers (status
 * commands, error messages) have a single import target.
 */
export function getConfigPath(): string {
	return defaultConfigPath();
}

/**
 * Load config from disk. Missing / unreadable file ⇒ env-seeded
 * defaults (no write). Unknown fields are silently dropped.
 */
export function loadConfig(path: string = defaultConfigPath()): WierdFaceliftConfig {
	try {
		if (!existsSync(path)) return envDefaults();
		const raw = readFileSync(path, "utf-8");
		return sanitize(JSON.parse(raw));
	} catch {
		return envDefaults();
	}
}

/**
 * Persist config to disk. Creates the parent directory if missing.
 * Returns the path written to so callers can echo it in a status
 * message.
 */
export function saveConfig(
	cfg: WierdFaceliftConfig,
	path: string = defaultConfigPath(),
): string {
	if (path === defaultConfigPath()) {
		ensureFaceliftDir();
	} else {
		const dir = dirname(path);
		if (dir && !existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}
	const out: Record<string, unknown> = {
		diffLayout: cfg.diffLayout,
	};
	writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`, "utf-8");
	return path;
}

/**
 * Load config, seeding the file if missing. Used at extension boot so
 * users discover the config location naturally (via `/facelift` →
 * "config: ...") even before they edit anything.
 */
export function loadOrInitConfig(path: string = defaultConfigPath()): WierdFaceliftConfig {
	if (!existsSync(path)) {
		const seeded = envDefaults();
		try {
			saveConfig(seeded, path);
		} catch {
			// Non-fatal: fall back to in-memory defaults if disk write fails.
		}
		return seeded;
	}
	return loadConfig(path);
}
