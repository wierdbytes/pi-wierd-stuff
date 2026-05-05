/**
 * Filesystem paths for pi-wierd-voice.
 *
 * Per-package state lives under `~/.pi/agent/pi-wierd-voice/` (or
 * `${PI_AGENT_DIR}/pi-wierd-voice/` if the env var is set):
 *
 * - `config.json` — user-editable settings (see config.ts).
 * - `last.wav`    — most recent synthesized audio, overwritten on every
 *                   summary playback and on `/wierd-voice say`. Read by
 *                   `/wierd-voice replay`.
 *
 * The directory is created lazily on first write — we never call
 * `mkdirSync` from module load.
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PACKAGE_DIRNAME = "pi-wierd-voice";

/** Resolve the pi agent root (`PI_AGENT_DIR` if set, otherwise `~/.pi/agent`). */
export function piAgentDir(): string {
  const fromEnv = process.env.PI_AGENT_DIR?.trim();
  if (fromEnv) return fromEnv;
  return join(homedir(), ".pi", "agent");
}

/** Per-package state directory: `<piAgentDir>/pi-wierd-voice`. */
export function voiceDir(): string {
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
