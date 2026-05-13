/**
 * Filesystem paths for @wierdbytes/pi-facelift.
 *
 * Per-package state lives under `~/.pi/agent/wierd-facelift/` (or
 * `${PI_AGENT_DIR}/wierd-facelift/` if the env var is set):
 *
 *   - `config.json` — user-editable settings (see config.ts). Today
 *     this is just the `diffLayout` preference; more knobs (themes,
 *     icon mode, max preview lines, etc.) can be added later without
 *     changing the directory layout.
 *
 * The directory is created lazily on first write — `ensureFaceliftDir`
 * is the canonical entry point. We never call `mkdirSync` from module
 * load so test runners and unrelated tooling don't accidentally touch
 * the agent dir.
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PACKAGE_DIRNAME = "wierd-facelift";

/** Resolve the pi agent root (`PI_AGENT_DIR` if set, otherwise `~/.pi/agent`). */
export function piAgentDir(): string {
	const fromEnv = process.env.PI_AGENT_DIR?.trim();
	if (fromEnv) return fromEnv;
	return join(homedir(), ".pi", "agent");
}

/** Per-package state directory: `<piAgentDir>/wierd-facelift`. */
export function faceliftDir(): string {
	return join(piAgentDir(), PACKAGE_DIRNAME);
}

/** Path to the persisted config JSON. */
export function configPath(): string {
	return join(faceliftDir(), "config.json");
}

/**
 * Ensure the package directory exists. Idempotent. Caller should invoke
 * this once before the first config save.
 */
export function ensureFaceliftDir(): void {
	const dir = faceliftDir();
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}
