/**
 * @wierdbytes/pi-voice extension entry point.
 *
 * Subscribes to `agent_end` and (when configured) speaks a 1–2 sentence
 * summary of the assistant's reply through `gemini-3.1-flash-tts-preview`.
 *
 * State machine (see VoiceJob below):
 *
 *   idle → summarizing → synthesizing → playing → idle
 *
 * A fresh `agent_end` (or `/voice mute`, session shutdown, etc.)
 * aborts whatever stage the previous job is in and starts over.
 *
 * Slash commands all live under the `/voice` prefix.
 * (Storage paths, package name, and notify tags still use the
 * `wierd-voice` prefix to keep the existing `~/.pi/agent/wierd-voice/`
 * state directory and the `pi-wierd-voice` brand.)
 */

import { existsSync, writeFileSync } from "node:fs";
import { type ChildProcess } from "node:child_process";
import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
  type NotifyLevel,
  notifyStatus,
  notifyToast,
} from "@wierdbytes/pi-events";

/** `source` value for every notify:* event we emit. Hard-coded to our
 *  npm package name so the statusline keys our chip consistently and
 *  the events log shows a stable identifier. */
const EVENT_SOURCE = "@wierdbytes/pi-voice";
import { openSettingsModal, type Field } from "@wierdbytes/pi-common";
import {
  envDefaults,
  getConfigPath,
  loadOrInitConfig,
  saveConfig,
  type Scope,
  type SummarizerThinkingLevel,
  type WierdVoiceConfig,
} from "./config.ts";
import { PREBUILT_VOICES, isValidVoice as voicesIsValid } from "./voices.ts";
void voicesIsValid; // re-exported below
import { refreshFromRegistry, resolveGeminiKey } from "./auth.ts";
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
  /** True when this job came from `/voice say` — bypasses summarizer. */
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
    description: "Disable @wierdbytes/pi-voice playback for this session.",
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

  // ───────────────────────── notify:* event helpers ───────────────────
  //
  // The voice extension owns one chip in the statusline. Every emit
  // overwrites the previous one (no `id` is set), so the chip is keyed
  // solely by `source: EVENT_SOURCE`. We never let the chip vanish
  // mid-flow — idle state is `🔊 ready`, working states reuse the
  // same icon, and errors switch to `🔇` until something else from
  // this source replaces them.

  /** Idle armed indicator: `🔊 ready`. */
  const emitVoiceReady = (): void => {
    notifyStatus(pi, {
      source: EVENT_SOURCE,
      state: "active",
      icon: "🔊",
      label: "ready",
      level: "info",
    });
  };

  /** Persistent muted indicator: `🔇 muted`. */
  const emitVoiceMutedStatus = (): void => {
    notifyStatus(pi, {
      source: EVENT_SOURCE,
      state: "active",
      icon: "🔇",
      label: "muted",
      level: "info",
    });
  };

  /** Working state with the sound icon and a custom label
   *  (`thinking` / `synthesizing` / `speaking`). */
  const emitVoiceWorking = (label: string): void => {
    notifyStatus(pi, {
      source: EVENT_SOURCE,
      state: "active",
      icon: "🔊",
      label,
      level: "info",
    });
  };

  /** Sticky error chip — stays until the next pipeline emit replaces
   *  it (or the user runs `/statusline events clear`). Used for
   *  genuine runtime failures (TTS, summarizer, player). */
  const emitVoiceErrorStatus = (label: string, detail?: string): void => {
    notifyStatus(pi, {
      source: EVENT_SOURCE,
      state: "error",
      icon: "🔇",
      label,
      detail,
      level: "error",
    });
  };

  /** Sticky "no GEMINI_API_KEY" chip — uses the muted-speaker icon
   *  rather than the warning sign because voice is effectively silent,
   *  not malfunctioning. */
  const emitVoiceNoKeyStatus = (): void => {
    notifyStatus(pi, {
      source: EVENT_SOURCE,
      state: "error",
      icon: "🔇",
      label: "no key",
      detail: "GEMINI_API_KEY not set",
      level: "error",
    });
  };

  /**
   * Pick the right idle chip based on current state:
   *   muted    → `🔇 muted`   (user-chosen takes priority)
   *   no key   → `🔇 no key`  (sticky error — voice is silent until fixed)
   *   default  → `🔊 ready`
   *
   * Use this whenever the voice extension transitions back to a
   * waiting-for-next-event state so the chip never lies about the
   * actual capability of the extension.
   */
  const emitVoiceIdleStatus = (): void => {
    if (config.muted) {
      emitVoiceMutedStatus();
      return;
    }
    if (!resolveGeminiKey()) {
      emitVoiceNoKeyStatus();
      return;
    }
    emitVoiceReady();
  };

  /** Brief `state: "done"` flash so subscribers can react to job
   *  completion, immediately followed by the appropriate idle chip
   *  (ready / muted / no-key) so the indicator stays present and
   *  truthful. */
  const emitVoiceDoneFlash = (): void => {
    notifyStatus(pi, {
      source: EVENT_SOURCE,
      state: "done",
      icon: "🔊",
      label: "done",
      level: "success",
    });
    emitVoiceIdleStatus();
  };

  /** Remove the voice chip entirely (used on session shutdown). */
  const emitVoiceCleared = (): void => {
    notifyStatus(pi, {
      source: EVENT_SOURCE,
      state: "cleared",
      label: "",
    });
  };

  /** Convenience wrapper for transient toast notifications. */
  const emitVoiceToast = (
    level: NotifyLevel,
    message: string,
    title?: string,
  ): void => {
    notifyToast(pi, {
      source: EVENT_SOURCE,
      level,
      message,
      title,
    });
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
      // player later and `/voice replay`.
      notifyOnce(
        ctx,
        "no-player",
        "wierd-voice: no audio player on PATH (afplay/paplay/aplay/ffplay).",
        "warning",
      );
      emitVoiceToast(
        "warning",
        "no audio player on PATH (afplay/paplay/aplay/ffplay)",
      );
      emitVoiceErrorStatus("no player", "audio player not detected");
      setStatus(ctx, undefined);
      if (currentJob?.id === job.id) currentJob = undefined;
      return;
    }
    if (job.abortController.signal.aborted) return;

    job.state = "playing";
    setStatus(ctx, STATUS_SPEAKING);
    emitVoiceWorking("speaking");

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
      emitVoiceToast(
        "error",
        `failed to spawn ${playerSpec?.label ?? "player"}: ${err.message}`,
      );
      emitVoiceErrorStatus("player error", err.message);
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
        emitVoiceToast(
          "warning",
          `${playerSpec?.label ?? "player"} exited with code ${code}`,
        );
        emitVoiceErrorStatus("player exit", `code ${code}`);
      } else if (!job.abortController.signal.aborted) {
        // Normal completion — brief done flash, then idle "ready".
        emitVoiceDoneFlash();
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
      // The previous job (if any) was aborted by `agent_end` before we
      // got here, so its working chip (`thinking` / `synthesizing` /
      // `speaking`) would remain stuck on screen if we just returned.
      // Reset the chip back to idle so it reflects current capability.
      emitVoiceIdleStatus();
      if (currentJob?.id === job.id) currentJob = undefined;
      return;
    }

    setStatus(ctx, STATUS_THINKING);
    emitVoiceWorking("thinking");

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
        emitVoiceToast(
          "warning",
          `summarizer failed: ${summaryResult.error}`,
        );
        emitVoiceErrorStatus("summarizer", summaryResult.error);
      } else {
        // Aborted: drop back to idle so the chip doesn't get stuck.
        emitVoiceIdleStatus();
      }
      setStatus(ctx, undefined);
      currentJob = undefined;
      return;
    }
    if (summaryResult.kind === "skip") {
      // Tool-only / empty turn — quietly return to idle.
      emitVoiceIdleStatus();
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
    emitVoiceWorking("synthesizing");

    const tts = await synthesize({
      text,
      voice: config.voice,
      apiKey: keyEntry.key,
      signal: job.abortController.signal,
    });

    if (currentJob?.id !== job.id) return;

    if (!tts.ok) {
      if (tts.error === "Aborted") {
        // Aborted: drop back to idle so the chip doesn't get stuck.
        emitVoiceIdleStatus();
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
      emitVoiceToast("error", tts.error);
      emitVoiceErrorStatus("tts", tts.error);
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

    // Pull pi's stored Google credential into the auth cache so the
    // sync chip-rendering paths below (and every later command) see
    // the right state. Best-effort — a missing/failed registry just
    // leaves the cache empty and resolution falls through to env.
    await refreshFromRegistry(ctx);

    if (!ctx.hasUI || cliDisabled) {
      setStatus(ctx, undefined);
      // No UI / fully disabled — don't claim a chip slot.
      emitVoiceCleared();
      return;
    }

    // Surface the missing-key warning *before* emitting the idle chip
    // so emitVoiceIdleStatus() picks the right state (muted > no-key >
    // ready) instead of optimistically rendering "ready".
    if (!resolveGeminiKey()) {
      notifyOnce(
        ctx,
        "no-key",
        "wierd-voice: no Google credential available; run `/login google`, set GEMINI_API_KEY, or set PI_VOICE_GEMINI_API_KEY.",
        "warning",
      );
      // Error-level so the toast is sticky by default (statusline
      // config maps `error` to lifetime 0). Voice can't function
      // without the key, so the user must see this until they fix it.
      emitVoiceToast(
        "error",
        "no Google credential available; /voice disabled",
      );
    }

    if (config.muted) {
      setStatus(ctx, STATUS_MUTED);
    } else {
      setStatus(ctx, undefined);
    }
    emitVoiceIdleStatus();

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
        emitVoiceToast(
          "warning",
          "no audio player on PATH (install afplay/paplay/aplay/ffplay)",
          "voice",
        );
      }
    } catch (err) {
      playerSpec = null;
      const message = err instanceof Error ? err.message : String(err);
      notifyOnce(
        ctx,
        "player-detect-error",
        `wierd-voice: player detection failed (${message}).`,
        "warning",
      );
      emitVoiceToast("warning", `player detection failed: ${message}`);
    }
  });

  pi.on("session_shutdown", async () => {
    abortJob(currentJob);
    currentJob = undefined;
    // Drop our chip so the statusline doesn't render a stale `🔊 ready`
    // after the session has gone away.
    emitVoiceCleared();
  });

  pi.on("session_before_switch", async () => {
    abortJob(currentJob);
    currentJob = undefined;
  });

  pi.on("agent_end", async (event, ctx) => {
    // Re-prime the auth cache so a credential rotated mid-session
    // (`/login google`, env var change, `pi auth set ...`) is picked
    // up before we decide whether to fire the pipeline.
    await refreshFromRegistry(ctx);

    if (!isExtensionActive(ctx)) return;

    abortJob(currentJob);
    currentJob = undefined;

    void runPipelineForSummary(ctx, event);
  });

  // ───────────────────────────────────────────────── slash commands ──

  const dispatch = async (args: string, ctx: ExtensionContext): Promise<void> => {
    // Refresh the auth cache before any subcommand runs so /voice
    // status, /voice say, etc. all see the latest stored Google
    // credential.
    await refreshFromRegistry(ctx);

    const trimmed = (args ?? "").trim();
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    const cmd = tokens[0]?.toLowerCase() ?? "";

    // Bare `/voice` opens the configuration overlay (or falls back
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
      "Usage: /voice [status|mute|unmute|say <text>|replay|reset]  (no args ⇒ open settings overlay)",
      "info",
    );
  };

  const openConfigOverlay = async (ctx: ExtensionContext): Promise<void> => {
    if (!ctx.hasUI) {
      // Non-interactive sessions can't host the overlay. Show the same
      // text dump as `/voice status` so the user still sees the
      // current state and learns where the config lives.
      showStatus(ctx);
      return;
    }

    // The settings modal is stateless about disk — we hand it the
    // current config snapshot, persist on every onChange, and let the
    // user dismiss when they're done. Reopening reads the live `config`
    // again so any external mutations (mute via shortcut, etc.) show up.
    const voiceLabels: Partial<Record<string, string>> = Object.fromEntries(
      PREBUILT_VOICES.map((v) => [v.name, `${v.name}  ·  ${v.descriptor}`]),
    );

    const fields: Field[] = [
      {
        key: "muted",
        type: "boolean",
        label: "Muted",
        description: "Mute the spoken summary after every assistant turn.",
        value: config.muted,
      },
      {
        key: "voice",
        type: "enum",
        label: "Voice",
        description: "Prebuilt Gemini TTS voice.",
        value: config.voice,
        options: PREBUILT_VOICES.map((v) => v.name),
        optionLabels: voiceLabels,
        // 30+ voices — force the SelectList submenu rather than cycling.
        cycleThreshold: 4,
      },
      {
        key: "scope",
        type: "enum",
        label: "Summary scope",
        description:
          "What to feed the summarizer: just the final assistant message (last) or everything since the last user turn (sinceUser).",
        value: config.scope,
        options: ["last", "sinceUser"] as const,
      },
      {
        key: "summarizer",
        type: "model",
        label: "Summarizer model",
        description:
          "Sub-agent model + reasoning effort used to produce the spoken summary. Empty model means inherit the session model.",
        value: {
          id: config.summarizerModel ?? "",
          thinking: config.summarizerThinkingLevel,
        },
      },
    ];

    await openSettingsModal(ctx, {
      title: "@wierdbytes/pi-voice",
      fields,
      onChange: (key, value) => {
        if (key === "muted") {
          const wasMuted = config.muted;
          config = { ...config, muted: value as boolean };
          persist(ctx);
          if (config.muted) {
            // Mute aborts any in-flight job — same semantics as the
            // `/voice mute` shortcut below.
            abortJob(currentJob);
            currentJob = undefined;
            setStatus(ctx, STATUS_MUTED);
            emitVoiceIdleStatus();
            emitVoiceToast("info", "muted");
          } else if (wasMuted) {
            setStatus(ctx, undefined);
            emitVoiceIdleStatus();
            emitVoiceToast("info", "unmuted");
          }
          return;
        }
        if (key === "voice") {
          const v = value as string;
          if (!isValidVoice(v)) return; // shouldn't happen — options are whitelisted
          config = { ...config, voice: v };
          persist(ctx);
          return;
        }
        if (key === "scope") {
          config = { ...config, scope: value as Scope };
          persist(ctx);
          return;
        }
        if (key === "summarizer") {
          const v = value as { id: string; thinking?: SummarizerThinkingLevel };
          const next: WierdVoiceConfig = { ...config };
          if (!v.id) delete next.summarizerModel;
          else next.summarizerModel = v.id;
          if (v.thinking) next.summarizerThinkingLevel = v.thinking;
          config = next;
          persist(ctx);
          return;
        }
      },
    });
  };

  const showStatus = (ctx: ExtensionContext): void => {
    const keyEntry = resolveGeminiKey();
    const lines = [
      `config:     ${getConfigPath()}`,
      `key:        ${keyEntry ? keyEntry.source : "none"}`,
      `voice:      ${config.voice}${isValidVoice(config.voice) ? "" : " (UNKNOWN — see /voice voice)"}`,
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
    // config.muted is now true — emitVoiceIdleStatus() will pick the
    // muted chip. Going through the helper keeps every "transition to
    // idle" code path consistent.
    emitVoiceIdleStatus();
    emitVoiceToast("info", "muted");
    ctx.ui.notify("wierd-voice muted.", "info");
  };

  const unmute = (ctx: ExtensionContext): void => {
    config = { ...config, muted: false };
    persist(ctx);
    setStatus(ctx, undefined);
    // Reflect actual capability — if the key is missing we want the
    // no-key error chip, not a misleading "ready".
    emitVoiceIdleStatus();
    emitVoiceToast("info", "unmuted");
    ctx.ui.notify("wierd-voice unmuted.", "info");
  };

  const say = async (ctx: ExtensionContext, text: string): Promise<void> => {
    if (!text) {
      ctx.ui.notify("Usage: /voice say <text>", "warning");
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify(
        "/voice say requires an interactive UI.",
        "warning",
      );
      return;
    }
    const keyEntry = resolveGeminiKey();
    if (!keyEntry) {
      ctx.ui.notify(
        "wierd-voice: no Google credential available. Run `/login google`, set GEMINI_API_KEY, or set PI_VOICE_GEMINI_API_KEY.",
        "warning",
      );
      return;
    }
    if (config.muted) {
      ctx.ui.notify("wierd-voice is muted; run /voice unmute first.", "info");
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
    emitVoiceWorking("synthesizing");
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
    emitVoiceIdleStatus();
    emitVoiceToast("info", "config reset to defaults");
    ctx.ui.notify("wierd-voice: config reset to defaults.", "info");
  };

  pi.registerCommand("voice", {
    description:
      "Open the @wierdbytes/pi-voice settings overlay (no args). Action subcommands: status | mute | unmute | say <text> | replay | reset",
    handler: dispatch,
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      // The pi-tui autocomplete provider replaces the *entire* argument
      // string (everything after `/voice `) with `value`. So our
      // `value` must be the full argument we want the editor to end up
      // with — not just the last token. (See
      // node_modules/@earendil-works/pi-tui/dist/autocomplete.js:applyCompletion.)
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
