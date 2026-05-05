/**
 * Audio player detection + spawn helper for pi-wierd-voice.
 *
 * We rely on whatever the host already has — no bundled binary. Probe
 * order is platform-specific:
 *
 *   darwin       afplay
 *   linux/*nix   paplay → aplay → ffplay
 *   win32        powershell.exe (Media.SoundPlayer.PlaySync)
 *
 * Detection runs once per session via `pi.exec` (which we receive as the
 * `exec` argument so tests can stub it). The cache lives in module-scope
 * `detectedSpec`; `resetPlayerCache()` is exposed for tests.
 *
 * We probe with `which <cmd>` on POSIX and `where <cmd>` on win32 — the
 * `--version` route works for some binaries (paplay, aplay, ffplay)
 * but not others (afplay has no version flag), so a uniform `which`/
 * `where` probe is simpler and more reliable.
 */

import { spawn, type ChildProcess } from "node:child_process";

export interface PlayerSpec {
  /** Display label for `/wierd-voice status`. */
  label: string;
  /** Executable name as found on $PATH. */
  command: string;
  /** Build the args list for a given WAV path. */
  buildArgs: (wavPath: string) => string[];
}

interface ProbeStep {
  /** Binary name we're probing for. */
  command: string;
  /** PlayerSpec to return when the probe succeeds. */
  spec: PlayerSpec;
}

const PROBE_TIMEOUT_MS = 5_000;

/** Platform-specific probe order. Resolved once by `detectPlayer()`. */
function probesForPlatform(platform: NodeJS.Platform): ProbeStep[] {
  if (platform === "darwin") {
    return [
      {
        command: "afplay",
        spec: {
          label: "afplay",
          command: "afplay",
          buildArgs: (wav) => [wav],
        },
      },
    ];
  }

  if (platform === "win32") {
    return [
      {
        command: "powershell.exe",
        spec: {
          label: "powershell SoundPlayer",
          command: "powershell.exe",
          buildArgs: (wav) => [
            "-NoProfile",
            "-Command",
            `(New-Object Media.SoundPlayer '${wav.replace(/'/g, "''")}').PlaySync()`,
          ],
        },
      },
    ];
  }

  // linux, freebsd, openbsd, etc. — try common players in order.
  return [
    {
      command: "paplay",
      spec: {
        label: "paplay (PulseAudio)",
        command: "paplay",
        buildArgs: (wav) => [wav],
      },
    },
    {
      command: "aplay",
      spec: {
        label: "aplay (ALSA)",
        command: "aplay",
        buildArgs: (wav) => ["-q", wav],
      },
    },
    {
      command: "ffplay",
      spec: {
        label: "ffplay (ffmpeg)",
        command: "ffplay",
        buildArgs: (wav) => ["-nodisp", "-autoexit", "-loglevel", "quiet", wav],
      },
    },
  ];
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

/** Reset the memoized detection. Tests use this between platform fixtures. */
export function resetPlayerCache(): void {
  detectedSpec = undefined;
  detectionInFlight = undefined;
}

/** Build the probe command for a target binary on the current platform. */
function buildProbe(target: string, platform: NodeJS.Platform): { command: string; args: string[] } {
  if (platform === "win32") {
    return { command: "where", args: [target] };
  }
  return { command: "which", args: [target] };
}

/**
 * Probe for a usable audio player. Memoized — subsequent calls return
 * the cached result. Returns `null` when no probe succeeded; callers
 * should `notify` once and stop trying.
 */
export function detectPlayer(
  exec: ExecLike,
  platform: NodeJS.Platform = process.platform,
): Promise<PlayerSpec | null> {
  if (detectedSpec !== undefined) return Promise.resolve(detectedSpec);
  if (detectionInFlight) return detectionInFlight;

  detectionInFlight = (async () => {
    for (const probe of probesForPlatform(platform)) {
      const cmd = buildProbe(probe.command, platform);
      try {
        const result = await exec(cmd.command, cmd.args, { timeout: PROBE_TIMEOUT_MS });
        if (result.code === 0) {
          detectedSpec = probe.spec;
          return detectedSpec;
        }
      } catch {
        // Probe rejected (binary missing, timeout, etc.) — try next.
      }
    }
    detectedSpec = null;
    return null;
  })();

  return detectionInFlight;
}

/**
 * Spawn the audio player on `wavPath`. Returns the ChildProcess so the
 * caller can `kill` it on a fresh `agent_end`.
 */
export function play(spec: PlayerSpec, wavPath: string): ChildProcess {
  const args = spec.buildArgs(wavPath);
  return spawn(spec.command, args, { stdio: "ignore" });
}
