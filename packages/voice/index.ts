/**
 * pi-wierd-voice extension entry point.
 *
 * Subscribes to `agent_end` and (when configured) speaks a 1–2 sentence
 * summary of the assistant's reply through `gemini-3.1-flash-tts-preview`.
 *
 * State machine (see VoiceJob below):
 *
 *   idle → summarizing → synthesizing → playing → idle
 *
 * A fresh `agent_end` (or `/wierd-voice mute`, session shutdown, etc.)
 * aborts whatever stage the previous job is in and starts over.
 *
 * Slash commands all live under the `/wierd-voice` prefix to match the
 * repo-wide `wierd-` convention.
 */

import { existsSync, writeFileSync } from "node:fs";
import { type ChildProcess } from "node:child_process";
import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { pickVoiceConfig } from "./config-picker.ts";
import {
  envDefaults,
  getConfigPath,
  loadOrInitConfig,
  saveConfig,
  type WierdVoiceConfig,
} from "./config.ts";
import { resolveGeminiKey } from "./auth.ts";
import { ensureVoiceDir, lastWavPath } from "./paths.ts";
import { runSummarizer } from "./summarizer.ts";
import { synthesize } from "./tts.ts";
import { pcmToWav } from "./wav.ts";
import {
  detectPlayer,
  play,
  resetPlayerCache,
  type ExecLike,
  type PlayerSpec,
} from "./player.ts";
import {
  selectSummaryInput,
  type SummaryMessage,
} from "./messages.ts";
import { isValidVoice } from "./voices.ts";

const STATUS_KEY = "wierd-voice";
const STATUS_THINKING = "🔊 thinking";
const STATUS_SPEAKING = "🔊 speaking";
const STATUS_MUTED = "🔇 muted";

interface VoiceJob {
  id: number;
  abortController: AbortController;
  player?: ChildProcess;
  state: "summarizing" | "synthesizing" | "playing";
  /** True when this job came from `/wierd-voice say` — bypasses summarizer. */
  isAdHoc: boolean;
}

export default function piWierdVoice(pi: ExtensionAPI) {
  let config: WierdVoiceConfig = loadOrInitConfig();
  let cliDisabled = false;
  let playerSpec: PlayerSpec | null | undefined;
  let currentJob: VoiceJob | undefined;
  let nextJobId = 1;
  const oneTimeNotices = new Set<string>();

  pi.registerFlag("no-voice", {
    type: "boolean",
    description: "Disable pi-wierd-voice playback for this session.",
    default: false,
  });

  // ───────────────────────────────────────────────────────── helpers ──

  const persist = (ctx?: ExtensionContext): void => {
    try {
      saveConfig(config);
    } catch (err) {
      ctx?.ui.notify(
        `wierd-voice: failed to save config to ${getConfigPath()}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        "error",
      );
    }
  };

  const notifyOnce = (
    ctx: ExtensionContext,
    key: string,
    message: string,
    level: "info" | "warning" | "error" = "info",
  ): void => {
    if (oneTimeNotices.has(key)) return;
    oneTimeNotices.add(key);
    ctx.ui.notify(message, level);
  };

  const setStatus = (ctx: ExtensionContext, value: string | undefined): void => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY, value);
  };

  const isExtensionActive = (ctx: ExtensionContext): boolean => {
    if (!ctx.hasUI) return false;
    if (cliDisabled) return false;
    if (config.muted) return false;
    if (!resolveGeminiKey()) return false;
    return true;
  };

  const abortJob = (job: VoiceJob | undefined): void => {
    if (!job) return;
    try {
      job.abortController.abort();
    } catch {
      // already aborted
    }
    if (job.player && !job.player.killed) {
      try {
        job.player.kill("SIGTERM");
      } catch {
        // best effort
      }
      const playerRef = job.player;
      setTimeout(() => {
        if (playerRef && !playerRef.killed) {
          try {
            playerRef.kill("SIGKILL");
          } catch {
            // best effort
          }
        }
      }, 500);
    }
  };

  const writeWav = (pcm: Buffer): string => {
    ensureVoiceDir();
    const wavPath = lastWavPath();
    const wav = pcmToWav(pcm);
    writeFileSync(wavPath, wav);
    return wavPath;
  };

  const startPlayback = (
    ctx: ExtensionContext,
    job: VoiceJob,
    wavPath: string,
  ): void => {
    if (!playerSpec) {
      // No player but we still wrote last.wav — user can install a
      // player later and `/wierd-voice replay`.
      notifyOnce(
        ctx,
        "no-player",
        "wierd-voice: no audio player on PATH (afplay/paplay/aplay/ffplay).",
        "warning",
      );
      setStatus(ctx, undefined);
      if (currentJob?.id === job.id) currentJob = undefined;
      return;
    }
    if (job.abortController.signal.aborted) return;

    job.state = "playing";
    setStatus(ctx, STATUS_SPEAKING);

    const player = play(playerSpec, wavPath);
    job.player = player;

    player.once("error", (err) => {
      if (currentJob?.id !== job.id) return;
      notifyOnce(
        ctx,
        `player-error-${playerSpec?.command ?? "unknown"}`,
        `wierd-voice: failed to spawn ${playerSpec?.label ?? "player"}: ${err.message}`,
        "error",
      );
      setStatus(ctx, undefined);
      currentJob = undefined;
    });

    player.once("exit", (code) => {
      if (currentJob?.id !== job.id) return;
      if (code !== null && code !== 0 && !job.abortController.signal.aborted) {
        notifyOnce(
          ctx,
          `player-exit-${playerSpec?.command ?? "unknown"}`,
          `wierd-voice: ${playerSpec?.label ?? "player"} exited with code ${code}.`,
          "warning",
        );
      }
      setStatus(ctx, undefined);
      currentJob = undefined;
    });
  };

  const runPipelineForSummary = async (
    ctx: ExtensionContext,
    event: AgentEndEvent,
  ): Promise<void> => {
    const job: VoiceJob = {
      id: nextJobId++,
      abortController: new AbortController(),
      state: "summarizing",
      isAdHoc: false,
    };
    currentJob = job;

    const messages = (event.messages ?? []) as SummaryMessage[];
    const inputText = selectSummaryInput(messages, config.scope);
    if (!inputText) {
      // Nothing to summarise — tool-only turn or empty assistant text.
      if (currentJob?.id === job.id) currentJob = undefined;
      return;
    }

    setStatus(ctx, STATUS_THINKING);

    const summaryResult = await runSummarizer({
      text: inputText,
      model: config.summarizerModel,
      thinkingLevel: config.summarizerThinkingLevel,
      signal: job.abortController.signal,
    });

    if (currentJob?.id !== job.id) return; // superseded

    if (!summaryResult.ok) {
      // Aborted / error — clear status, no playback.
      if (
        summaryResult.error !== "Aborted" &&
        !job.abortController.signal.aborted
      ) {
        notifyOnce(
          ctx,
          `summarizer-error`,
          `wierd-voice: summarizer failed (${summaryResult.error}).`,
          "warning",
        );
      }
      setStatus(ctx, undefined);
      currentJob = undefined;
      return;
    }
    if (summaryResult.kind === "skip") {
      setStatus(ctx, undefined);
      currentJob = undefined;
      return;
    }

    await synthesizeAndPlay(ctx, job, summaryResult.text);
  };

  const synthesizeAndPlay = async (
    ctx: ExtensionContext,
    job: VoiceJob,
    text: string,
  ): Promise<void> => {
    if (currentJob?.id !== job.id) return;
    if (job.abortController.signal.aborted) return;

    const keyEntry = resolveGeminiKey();
    if (!keyEntry) {
      // Race: key was unset between trigger and synthesis.
      setStatus(ctx, undefined);
      currentJob = undefined;
      return;
    }

    job.state = "synthesizing";
    setStatus(ctx, STATUS_THINKING);

    const tts = await synthesize({
      text,
      voice: config.voice,
      apiKey: keyEntry.key,
      signal: job.abortController.signal,
    });

    if (currentJob?.id !== job.id) return;

    if (!tts.ok) {
      if (tts.error === "Aborted") {
        setStatus(ctx, undefined);
        currentJob = undefined;
        return;
      }
      // Every TTS error — including auth and rate-limit — is reported
      // as a one-shot notification and otherwise ignored. The next
      // `agent_end` will retry; we don't persist any kill-switch (a
      // previous version did, which silently stranded users whose key
      // briefly stopped working).
      const dedupeKey = /auth/i.test(tts.error)
        ? "tts-auth"
        : /rate limited/i.test(tts.error)
          ? "tts-rate-limited"
          : "tts-error";
      notifyOnce(ctx, dedupeKey, `wierd-voice: ${tts.error}`, "warning");
      setStatus(ctx, undefined);
      currentJob = undefined;
      return;
    }

    const wavPath = writeWav(tts.pcm);
    if (currentJob?.id !== job.id) return;

    startPlayback(ctx, job, wavPath);
  };

  // ────────────────────────────────────────────────── lifecycle hooks ──

  pi.on("session_start", async (_event, ctx) => {
    config = loadOrInitConfig();
    cliDisabled = pi.getFlag("no-voice") === true;
    oneTimeNotices.clear();
    resetPlayerCache();
    playerSpec = undefined;

    if (!ctx.hasUI || cliDisabled) {
      setStatus(ctx, undefined);
      return;
    }

    if (config.muted) {
      setStatus(ctx, STATUS_MUTED);
    } else {
      setStatus(ctx, undefined);
    }

    if (!resolveGeminiKey()) {
      notifyOnce(
        ctx,
        "no-key",
        "wierd-voice: no GEMINI_API_KEY found; /wierd-voice disabled.",
        "warning",
      );
    }

    try {
      const exec: ExecLike = async (cmd, args, opts) => {
        const r = await pi.exec(cmd, args, opts ?? {});
        return { code: r.code };
      };
      playerSpec = await detectPlayer(exec);
      if (!playerSpec) {
        notifyOnce(
          ctx,
          "no-player",
          "wierd-voice: no audio player on PATH (install afplay/paplay/aplay/ffplay).",
          "warning",
        );
      }
    } catch (err) {
      playerSpec = null;
      notifyOnce(
        ctx,
        "player-detect-error",
        `wierd-voice: player detection failed (${err instanceof Error ? err.message : String(err)}).`,
        "warning",
      );
    }
  });

  pi.on("session_shutdown", async () => {
    abortJob(currentJob);
    currentJob = undefined;
  });

  pi.on("session_before_switch", async () => {
    abortJob(currentJob);
    currentJob = undefined;
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!isExtensionActive(ctx)) return;

    abortJob(currentJob);
    currentJob = undefined;

    void runPipelineForSummary(ctx, event);
  });

  // ───────────────────────────────────────────────── slash commands ──

  const dispatch = async (args: string, ctx: ExtensionContext): Promise<void> => {
    const trimmed = (args ?? "").trim();
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    const cmd = tokens[0]?.toLowerCase() ?? "";

    // Bare `/wierd-voice` opens the configuration overlay (or falls back
    // to `status` when there's no UI to attach the overlay to). Other
    // subcommands are imperative actions — they stay text-only.
    if (!cmd) return openConfigOverlay(ctx);
    if (cmd === "status") return showStatus(ctx);
    if (cmd === "mute") return mute(ctx);
    if (cmd === "unmute") return unmute(ctx);
    if (cmd === "say") return say(ctx, trimmed.slice(cmd.length).trim());
    if (cmd === "replay") return replay(ctx);
    if (cmd === "reset") return reset(ctx);

    ctx.ui.notify(
      "Usage: /wierd-voice [status|mute|unmute|say <text>|replay|reset]  (no args ⇒ open settings overlay)",
      "info",
    );
  };

  const openConfigOverlay = async (ctx: ExtensionContext): Promise<void> => {
    if (!ctx.hasUI) {
      // Non-interactive sessions can't host the overlay. Show the same
      // text dump as `/wierd-voice status` so the user still sees the
      // current state and learns where the config lives.
      showStatus(ctx);
      return;
    }
    await pickVoiceConfig(ctx, config, {
      onMutedChange: (muted) => {
        const wasMuted = config.muted;
        config = { ...config, muted };
        persist(ctx);
        if (muted) {
          // Mute aborts any in-flight job — same semantics as the
          // `/wierd-voice mute` shortcut below.
          abortJob(currentJob);
          currentJob = undefined;
          setStatus(ctx, STATUS_MUTED);
        } else if (wasMuted) {
          setStatus(ctx, undefined);
        }
      },
      onVoiceChange: (voice) => {
        if (!isValidVoice(voice)) return; // shouldn't happen — list is whitelisted
        config = { ...config, voice };
        persist(ctx);
      },
      onScopeChange: (scope) => {
        config = { ...config, scope };
        persist(ctx);
      },
      onSummarizerChange: (modelId) => {
        if (!modelId) {
          // Empty ⇒ clear the override and inherit the session model.
          const next = { ...config };
          delete next.summarizerModel;
          config = next;
        } else {
          config = { ...config, summarizerModel: modelId };
        }
        persist(ctx);
      },
      onSummarizerThinkingChange: (level) => {
        // The picker always hands us a concrete level (clamped to the
        // model's supported ladder). We persist verbatim and pi will
        // re-clamp at runtime if the model changes underneath us.
        config = { ...config, summarizerThinkingLevel: level };
        persist(ctx);
      },
      onClose: () => {
        // Nothing to do — every change has already been persisted in
        // the per-field handlers above.
      },
    });
  };

  const showStatus = (ctx: ExtensionContext): void => {
    const keyEntry = resolveGeminiKey();
    const lines = [
      `config:     ${getConfigPath()}`,
      `key:        ${keyEntry ? keyEntry.source : "none"}`,
      `voice:      ${config.voice}${isValidVoice(config.voice) ? "" : " (UNKNOWN — see /wierd-voice voice)"}`,
      `scope:      ${config.scope}`,
      `summarizer: ${config.summarizerModel ?? "(session model)"}`,
      `thinking:   ${config.summarizerThinkingLevel ?? "(session level)"}`,
      `muted:      ${config.muted}`,
      `cli flag:   ${cliDisabled ? "--no-voice (disabled)" : "(none)"}`,
      `player:     ${
        playerSpec === undefined
          ? "(not yet probed)"
          : playerSpec === null
            ? "(none found)"
            : playerSpec.label
      }`,
    ];
    ctx.ui.notify(lines.join("\n"), "info");
  };

  const mute = (ctx: ExtensionContext): void => {
    config = { ...config, muted: true };
    persist(ctx);
    abortJob(currentJob);
    currentJob = undefined;
    setStatus(ctx, STATUS_MUTED);
    ctx.ui.notify("wierd-voice muted.", "info");
  };

  const unmute = (ctx: ExtensionContext): void => {
    config = { ...config, muted: false };
    persist(ctx);
    setStatus(ctx, undefined);
    ctx.ui.notify("wierd-voice unmuted.", "info");
  };

  const say = async (ctx: ExtensionContext, text: string): Promise<void> => {
    if (!text) {
      ctx.ui.notify("Usage: /wierd-voice say <text>", "warning");
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify(
        "/wierd-voice say requires an interactive UI.",
        "warning",
      );
      return;
    }
    const keyEntry = resolveGeminiKey();
    if (!keyEntry) {
      ctx.ui.notify(
        "wierd-voice: no GEMINI_API_KEY found.",
        "warning",
      );
      return;
    }
    if (config.muted) {
      ctx.ui.notify("wierd-voice is muted; run /wierd-voice unmute first.", "info");
      return;
    }

    abortJob(currentJob);

    const job: VoiceJob = {
      id: nextJobId++,
      abortController: new AbortController(),
      state: "synthesizing",
      isAdHoc: true,
    };
    currentJob = job;

    setStatus(ctx, STATUS_THINKING);
    await synthesizeAndPlay(ctx, job, text);
  };

  const replay = (ctx: ExtensionContext): void => {
    if (!playerSpec) {
      ctx.ui.notify(
        "wierd-voice: no audio player available; cannot replay.",
        "warning",
      );
      return;
    }
    const wavPath = lastWavPath();
    if (!existsSync(wavPath)) {
      ctx.ui.notify("wierd-voice: nothing to replay (no last.wav).", "info");
      return;
    }

    abortJob(currentJob);

    const job: VoiceJob = {
      id: nextJobId++,
      abortController: new AbortController(),
      state: "playing",
      isAdHoc: true,
    };
    currentJob = job;
    startPlayback(ctx, job, wavPath);
  };

  const reset = (ctx: ExtensionContext): void => {
    config = envDefaults();
    persist(ctx);
    setStatus(ctx, undefined);
    ctx.ui.notify("wierd-voice: config reset to defaults.", "info");
  };

  pi.registerCommand("wierd-voice", {
    description:
      "Open the pi-wierd-voice settings overlay (no args). Action subcommands: status | mute | unmute | say <text> | replay | reset",
    handler: dispatch,
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      // The pi-tui autocomplete provider replaces the *entire* argument
      // string (everything after `/wierd-voice `) with `value`. So our
      // `value` must be the full argument we want the editor to end up
      // with — not just the last token. (See
      // node_modules/@mariozechner/pi-tui/dist/autocomplete.js:applyCompletion.)
      //
      // Since the rework, every config knob lives behind the overlay —
      // the only remaining text subcommands are imperative actions.
      // `say` is the only one that takes a follow-up argument, so it's
      // also the only one that gets a trailing space (so a typed letter
      // re-triggers autocomplete; we don't actually offer suggestions
      // for the body of `say`, the user just types).
      const subsWithArgs = new Set(["say"]);
      const subsNoArgs = ["status", "mute", "unmute", "replay", "reset"];
      const allSubs = [...subsWithArgs, ...subsNoArgs];

      const tokens = prefix.split(/\s+/);
      const firstToken = tokens[0] ?? "";
      const subcommandFinished =
        allSubs.includes(firstToken) && /\s/.test(prefix);

      // Once a known action subcommand is followed by a space we have
      // nothing further to offer — the only such subcommand is `say`,
      // which takes free-form text.
      if (subcommandFinished) return null;

      const lcPrefix = prefix.toLowerCase();
      return allSubs
        .filter((s) => s.toLowerCase().startsWith(lcPrefix))
        .map((s) => ({
          value: subsWithArgs.has(s) ? `${s} ` : s,
          label: s,
        }));
    },
  });
}
