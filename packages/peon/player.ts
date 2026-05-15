/**
 * Cross-platform async audio player for @wierdbytes/pi-peon.
 *
 * Design rules from the CESP spec:
 *
 *   - Always play **async**, never block the CLI.
 *   - Pick the first working backend per platform; skip silently if
 *     nothing is available.
 *   - Master volume is `0.0..1.0`; we scale per-backend.
 *   - Supported formats: WAV / MP3 / OGG. We don't introspect — the
 *     player picks whatever it can decode.
 *
 * Probe order matches the spec's recommendations:
 *
 *   darwin   afplay
 *   linux    pw-play → paplay → ffplay → mpv → play (sox) → aplay
 *   win32    powershell (System.Windows.Media.MediaPlayer)
 *
 * Detection runs once per session via `pi.exec`-style `ExecLike`; the
 * result is cached on the module scope and can be reset with
 * `resetPlayerCache()` (intended for tests).
 */

import { spawn, type ChildProcess } from "node:child_process";

export interface PlayerSpec {
  /** Human-readable label for the settings UI. */
  label: string;
  /** Executable name as found on $PATH. */
  command: string;
  /** Build the arg list for a given file path + volume 0..1. */
  buildArgs: (file: string, volume: number) => string[];
}

const PROBE_TIMEOUT_MS = 5_000;

function probesForPlatform(platform: NodeJS.Platform): PlayerSpec[] {
  if (platform === "darwin") {
    return [
      {
        label: "afplay",
        command: "afplay",
        buildArgs: (f, v) => ["-v", clamp01(v).toFixed(2), f],
      },
    ];
  }
  if (platform === "win32") {
    return [
      {
        label: "powershell (MediaPlayer)",
        command: "powershell.exe",
        buildArgs: (f, v) => [
          "-NoProfile",
          "-Command",
          // We block the helper process on `Play()` + a short sleep so
          // the spawned PowerShell stays alive long enough to actually
          // play. Volume is the same 0..1 scale.
          `$p = New-Object System.Windows.Media.MediaPlayer; ` +
            `$p.Open([Uri]::new((Resolve-Path '${f.replace(/'/g, "''")}'))); ` +
            `$p.Volume = ${clamp01(v).toFixed(2)}; ` +
            `$p.Play(); ` +
            `Start-Sleep -Seconds 10`,
        ],
      },
    ];
  }
  // linux / *bsd / *nix
  return [
    {
      label: "pw-play (PipeWire)",
      command: "pw-play",
      buildArgs: (f, v) => [`--volume=${clamp01(v).toFixed(2)}`, f],
    },
    {
      label: "paplay (PulseAudio)",
      command: "paplay",
      // PulseAudio takes 0..65536. Round so we don't blow past it.
      buildArgs: (f, v) => [
        `--volume=${Math.round(clamp01(v) * 65536)}`,
        f,
      ],
    },
    {
      label: "ffplay (FFmpeg)",
      command: "ffplay",
      buildArgs: (f, v) => [
        "-nodisp",
        "-autoexit",
        "-loglevel",
        "quiet",
        "-volume",
        String(Math.round(clamp01(v) * 100)),
        f,
      ],
    },
    {
      label: "mpv",
      command: "mpv",
      buildArgs: (f, v) => [
        "--no-terminal",
        `--volume=${Math.round(clamp01(v) * 100)}`,
        f,
      ],
    },
    {
      label: "play (SoX)",
      command: "play",
      buildArgs: (f, v) => ["-v", clamp01(v).toFixed(2), "-q", f],
    },
    {
      label: "aplay (ALSA)",
      command: "aplay",
      // aplay has no volume control — we play unattenuated and let
      // the user fall back to a softer pack / lower their system mixer.
      buildArgs: (f, _v) => ["-q", f],
    },
  ];
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

export interface ExecLike {
  (
    command: string,
    args: string[],
    options?: { timeout?: number },
  ): Promise<{ code: number | null }>;
}

let detectedSpec: PlayerSpec | null | undefined;
let detectionInFlight: Promise<PlayerSpec | null> | undefined;

export function resetPlayerCache(): void {
  detectedSpec = undefined;
  detectionInFlight = undefined;
}

function buildProbe(
  target: string,
  platform: NodeJS.Platform,
): { command: string; args: string[] } {
  if (platform === "win32") return { command: "where", args: [target] };
  return { command: "which", args: [target] };
}

/**
 * Probe for a usable audio player. Memoized — subsequent calls return
 * the cached value. `null` means "no backend found; stop trying".
 */
export function detectPlayer(
  exec: ExecLike,
  platform: NodeJS.Platform = process.platform,
): Promise<PlayerSpec | null> {
  if (detectedSpec !== undefined) return Promise.resolve(detectedSpec);
  if (detectionInFlight) return detectionInFlight;
  detectionInFlight = (async () => {
    for (const spec of probesForPlatform(platform)) {
      const probe = buildProbe(spec.command, platform);
      try {
        const r = await exec(probe.command, probe.args, {
          timeout: PROBE_TIMEOUT_MS,
        });
        if (r.code === 0) {
          detectedSpec = spec;
          return spec;
        }
      } catch {
        // try next
      }
    }
    detectedSpec = null;
    return null;
  })();
  return detectionInFlight;
}

/**
 * Spawn the player on `file` at `volume` (0..1). The returned
 * ChildProcess is detached + stdio-ignored so killing the parent
 * doesn't truncate playback — events fire async and we don't wait.
 *
 * Failure modes (binary missing, decode error, etc.) are reported via
 * `error` / `exit` listeners attached by the caller, or silently
 * dropped on the floor — the spec is explicit: **never block the CLI
 * on a missing sound**.
 */
export function play(
  spec: PlayerSpec,
  file: string,
  volume: number,
): ChildProcess {
  const args = spec.buildArgs(file, volume);
  return spawn(spec.command, args, { stdio: "ignore", detached: true });
}
