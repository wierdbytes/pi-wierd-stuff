/**
 * Filesystem paths for @wierdbytes/pi-peon.
 *
 * Two roots are involved:
 *
 *  1. **CESP pack root** — `~/.openpeon/packs/<pack>/` (overridable via
 *     `PEON_PACKS_DIR`). This is the location prescribed by the CESP
 *     spec; multiple OpenPeon-aware tools can share the same packs
 *     directory across CLIs.
 *
 *  2. **Per-extension state** — `<piAgentDir>/peon/` (`config.json`).
 *     This stays inside the pi state tree so it follows `pi`'s normal
 *     state-isolation rules.
 *
 * Directory creation is lazy: `ensurePacksDir()` / `ensureStateDir()`
 * are called from the few call sites that actually need to write.
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIRNAME = "peon";

/** Resolve the pi agent state root (`PI_AGENT_DIR` or `~/.pi/agent`). */
export function piAgentDir(): string {
  const fromEnv = process.env.PI_AGENT_DIR?.trim();
  if (fromEnv) return fromEnv;
  return join(homedir(), ".pi", "agent");
}

/**
 * Where installed CESP packs live. Default `~/.openpeon/packs/`,
 * override with `PEON_PACKS_DIR`. The directory itself is not created
 * here — callers that write to it must call `ensurePacksDir()`.
 */
export function packsDir(): string {
  const fromEnv = process.env.PEON_PACKS_DIR?.trim();
  if (fromEnv) return fromEnv;
  return join(homedir(), ".openpeon", "packs");
}

/** Absolute path to one installed pack's root directory. */
export function packDir(packName: string): string {
  return join(packsDir(), packName);
}

/** Absolute path to one installed pack's manifest. */
export function packManifestPath(packName: string): string {
  return join(packDir(packName), "openpeon.json");
}

/** Per-extension state directory under pi's agent state tree. */
export function stateDir(): string {
  return join(piAgentDir(), STATE_DIRNAME);
}

/** Path to the persisted config JSON. */
export function configPath(): string {
  return join(stateDir(), "config.json");
}

/** Ensure the packs root exists. Idempotent. */
export function ensurePacksDir(): void {
  const dir = packsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Ensure the state directory exists. Idempotent. */
export function ensureStateDir(): void {
  const dir = stateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
