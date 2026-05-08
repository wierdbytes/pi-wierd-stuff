/**
 * Filesystem paths for @wierdbytes/pi-voice.
 *
 * Per-package state lives under `~/.pi/agent/wierd-voice/` (or
 * `${PI_AGENT_DIR}/wierd-voice/` if the env var is set):
 *
 * - `config.json` — user-editable settings (see config.ts).
 * - `last.wav`    — most recent synthesized audio, overwritten on every
 *                   summary playback and on `/voice say`. Read by
 *                   `/voice replay`.
 *
 * The directory is created lazily on first write — we never call
 * `mkdirSync` from module load.
 *
 * Legacy migration: prior to the @wierdbytes scope rename, this
 * directory was named `pi-wierd-voice`. On the first call to
 * `voiceDir()` we silently rename the old dir to the new one if the
 * legacy dir exists and the new dir does not. Idempotent and
 * best-effort: any failure (permissions, race) is swallowed and the
 * caller proceeds with the new path, which `ensureVoiceDir()` will
 * create from scratch on first write.
 */

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PACKAGE_DIRNAME = "wierd-voice";
const LEGACY_PACKAGE_DIRNAME = "pi-wierd-voice";

let migrationChecked = false;

/** Resolve the pi agent root (`PI_AGENT_DIR` if set, otherwise `~/.pi/agent`). */
export function piAgentDir(): string {
  const fromEnv = process.env.PI_AGENT_DIR?.trim();
  if (fromEnv) return fromEnv;
  return join(homedir(), ".pi", "agent");
}

/**
 * One-shot migration of the legacy `pi-wierd-voice` directory to the
 * new `wierd-voice` directory. Runs at most once per process; safe to
 * call from any code path.
 */
function migrateLegacyDirIfNeeded(): void {
  if (migrationChecked) return;
  migrationChecked = true;
  try {
    const legacy = join(piAgentDir(), LEGACY_PACKAGE_DIRNAME);
    const current = join(piAgentDir(), PACKAGE_DIRNAME);
    if (existsSync(legacy) && !existsSync(current)) {
      renameSync(legacy, current);
    }
  } catch {
    // Best-effort: leave legacy in place; new dir will be created on
    // first write and the user just loses their old voice config.
  }
}

/** Per-package state directory: `<piAgentDir>/wierd-voice`. */
export function voiceDir(): string {
  migrateLegacyDirIfNeeded();
  return join(piAgentDir(), PACKAGE_DIRNAME);
}

/** Path to the persisted config JSON. */
export function configPath(): string {
  return join(voiceDir(), "config.json");
}

/** Path to the most recent synthesized WAV. */
export function lastWavPath(): string {
  return join(voiceDir(), "last.wav");
}

/**
 * Ensure the package directory exists. Idempotent. Caller should invoke
 * this once before any write (config save, WAV write).
 */
export function ensureVoiceDir(): void {
  const dir = voiceDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
