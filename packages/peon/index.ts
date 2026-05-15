/**
 * @wierdbytes/pi-peon — CESP / OpenPeon sound pack player for pi.
 *
 * Listens to pi lifecycle events, maps them onto CESP categories, and
 * plays a random sound from the active pack — peons saying "Work,
 * work.", GLaDOS, Stronghold abbots, whatever's installed at
 * `~/.openpeon/packs/<pack>/`.
 *
 * Event → category mapping (every category is per-event toggleable
 * from the settings modal; the pack itself decides whether it has
 * sounds for that category):
 *
 *   session_start (reason ≠ "reload")  →  session.start
 *   agent_start                        →  task.acknowledge
 *   agent_end (turn used tools)        →  task.complete
 *   agent_end (no tools, just talk)    →  input.required
 *   tool_result (isError === true)     →  task.error
 *   after_provider_response (429)      →  resource.limit
 *   session_shutdown (reason "quit")   →  session.end
 *   input events ≥3 in 5s              →  user.spam  (rate-limited)
 *
 * No special handling for task.progress — pi has no clean signal for
 * "long-running task still running" that wouldn't fire constantly.
 *
 * Slash command: `/peon` opens the settings modal. Sub-actions
 * (`/peon mute|unmute|test [category]`) handle the imperative cases.
 */

import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  notifyToast,
  type NotifyLevel,
} from "@wierdbytes/pi-events";
import {
  envDefaults,
  getConfigPath,
  isCategoryEnabled,
  loadOrInitConfig,
  saveConfig,
  type PeonConfig,
} from "./config.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  CESP_CATEGORIES,
  listInstalledPacks,
  loadPack,
  resolveCategory,
  type CespCategory,
  type InstalledPack,
  type ManifestSound,
} from "./pack.ts";
import {
  detectPlayer,
  play,
  resetPlayerCache,
  type ExecLike,
  type PlayerSpec,
} from "./player.ts";
import { createPickerState, pickSound } from "./picker.ts";
import { fetchRegistry, resetRegistryCache, type RegistryEntry } from "./registry.ts";
import {
  downloadSoundToTemp,
  fetchPackManifest,
  installPack as installPackFromRegistry,
} from "./install.ts";
import { openPeonSettings } from "./settings.ts";

const EVENT_SOURCE = "@wierdbytes/pi-peon";

/** Number of input events (in 5s) that triggers user.spam. */
const SPAM_THRESHOLD = 3;
const SPAM_WINDOW_MS = 5_000;
/** Suppress repeat spam triggers within this window. */
const SPAM_COOLDOWN_MS = 10_000;

export default function piPeon(pi: ExtensionAPI) {
  let config: PeonConfig = loadOrInitConfig();
  let activePack: InstalledPack | null = loadPack(config.activePack);
  let playerSpec: PlayerSpec | null | undefined;
  let cliDisabled = false;
  const picker = createPickerState();
  /** Track tool usage per agent turn so agent_end can pick between
   *  task.complete (work happened) and input.required (just chat). */
  let toolsUsedThisTurn = false;
  /** Rolling buffer of recent user-input timestamps for spam detection. */
  const inputTimestamps: number[] = [];
  let lastSpamPlayedAt = 0;

  pi.registerFlag("no-peon", {
    type: "boolean",
    description: "Disable @wierdbytes/pi-peon sound playback for this session.",
    default: false,
  });

  // ── helpers ──────────────────────────────────────────────────────

  const persist = (ctx?: ExtensionContext): void => {
    try {
      saveConfig(config);
    } catch (err) {
      ctx?.ui.notify(
        `peon: failed to save config to ${getConfigPath()}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        "error",
      );
    }
  };

  const refreshActivePack = (): void => {
    activePack = loadPack(config.activePack);
  };

  const emitToast = (level: NotifyLevel, message: string): void => {
    notifyToast(pi, { source: EVENT_SOURCE, level, message });
  };

  const isActive = (): boolean => {
    if (cliDisabled) return false;
    if (config.muted) return false;
    if (!activePack) return false;
    if (!playerSpec) return false;
    return true;
  };

  /**
   * Resolve, pick, and play a sound for `category`. Silently skips
   * when:
   *   - the extension is globally inactive (muted, no pack, no player);
   *   - the per-category toggle is off;
   *   - the pack has no sounds for the category (after alias fallback);
   *   - the picker debounced this call.
   *
   * Never throws — playback failures are best-effort.
   */
  const playFor = (category: CespCategory): void => {
    if (!isActive()) return;
    if (!isCategoryEnabled(config, category)) return;
    const pack = activePack;
    if (!pack || !playerSpec) return;
    const candidates = resolveCategory(pack, category);
    if (candidates.length === 0) return;
    const chosen = pickSound(picker, pack.name, category, candidates);
    if (!chosen) return;
    try {
      const child = play(playerSpec, chosen.absPath, config.volume);
      // Detach + ignore errors. The spec is emphatic: never block on
      // a missing sound. Listeners on `error` keep Node from logging
      // unhandled-error noise.
      child.once("error", () => {});
      child.unref();
    } catch {
      // best-effort
    }
  };

  /**
   * Auto-install the configured active pack when it isn't present on
   * disk. Fire-and-forget — emits progress / result toasts via the
   * events bus so the user knows what's happening but isn't blocked.
   *
   * After a successful install we play the `session.start` sound
   * (gated by `playWelcome`) so the very first run of a fresh pi
   * install still gets the audio greeting it would otherwise miss
   * (the synchronous welcome-sound call below fires before the
   * download finishes, when there's still no pack to play from).
   */
  const autoInstallActivePack = async (playWelcome: boolean): Promise<void> => {
    const wantedName = config.activePack;
    emitToast(
      "info",
      `peon: pack "${wantedName}" not installed — fetching registry…`,
    );
    let entries: RegistryEntry[];
    try {
      entries = await fetchRegistry();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emitToast(
        "error",
        `peon: registry fetch failed (${msg}). Pack "${wantedName}" not installed.`,
      );
      return;
    }
    const entry = entries.find((e) => e.name === wantedName);
    if (!entry) {
      emitToast(
        "warning",
        `peon: "${wantedName}" is not in the public registry — open /peon → Packs… to pick another.`,
      );
      return;
    }
    emitToast("info", `peon: installing "${wantedName}"…`);
    try {
      await installPackFromRegistry(entry);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emitToast("error", `peon: install of "${wantedName}" failed (${msg}).`);
      return;
    }
    // Drop the cached registry so the next /peon browse pulls fresh
    // `updated`/`version` fields.
    resetRegistryCache();
    refreshActivePack();
    emitToast("info", `peon: installed "${wantedName}" and ready to go.`);
    if (playWelcome) playFor("session.start");
  };

  // ── lifecycle ─────────────────────────────────────────────────────

  pi.on("session_start", async (event, ctx) => {
    config = loadOrInitConfig();
    refreshActivePack();
    cliDisabled = pi.getFlag("no-peon") === true;
    toolsUsedThisTurn = false;
    inputTimestamps.length = 0;
    lastSpamPlayedAt = 0;
    resetPlayerCache();
    playerSpec = undefined;

    if (cliDisabled) return;

    // Detect a player asynchronously so we don't slow startup. The
    // first event that fires before detection finishes will silently
    // skip (`isActive()` returns false until `playerSpec` is set).
    try {
      const exec: ExecLike = async (cmd, args, opts) => {
        const r = await pi.exec(cmd, args, opts ?? {});
        return { code: r.code };
      };
      playerSpec = await detectPlayer(exec);
      if (!playerSpec) {
        emitToast(
          "warning",
          "peon: no audio player on PATH (afplay / paplay / aplay / ffplay).",
        );
      }
    } catch {
      playerSpec = null;
    }

    // Auto-install the configured active pack when it isn't present
    // on disk yet. Runs asynchronously — we don't want to block the
    // session_start handler on a network round-trip. The welcome
    // sound below will be replayed by `autoInstallActivePack` once
    // the pack is actually on disk.
    const wantsWelcome = event.reason === "startup" || event.reason === "new";
    if (!activePack) {
      void autoInstallActivePack(wantsWelcome);
    } else if (wantsWelcome) {
      // Reasons we deliberately *skip* the welcome sound otherwise:
      //   - "reload" — the user just ran /reload; firing again would
      //     be noisy.
      //   - "fork" / "resume" — same idea, the user is mid-flow.
      playFor("session.start");
    }
  });

  pi.on("session_shutdown", async (event) => {
    if (event.reason === "quit") {
      // Fire and forget — the player is async; the actual sound may
      // be cut off when the process exits, but the spec is OK with
      // best-effort here.
      playFor("session.end");
    }
  });

  pi.on("agent_start", async () => {
    toolsUsedThisTurn = false;
    playFor("task.acknowledge");
  });

  pi.on("tool_execution_start", async () => {
    toolsUsedThisTurn = true;
  });

  pi.on("agent_end", async (_event: AgentEndEvent) => {
    // Heuristic: if the assistant actually did work (called tools)
    // play "task.complete"; otherwise the agent just chatted back
    // and pi is now waiting on the user, which the spec calls
    // "input.required".
    if (toolsUsedThisTurn) {
      playFor("task.complete");
    } else {
      playFor("input.required");
    }
    toolsUsedThisTurn = false;
  });

  pi.on("tool_result", async (event) => {
    if (event.isError) playFor("task.error");
  });

  pi.on("after_provider_response", (event) => {
    // 429 → "Why not?" style "we hit a wall" sound. 5xx is also a
    // resource-ish failure but we leave that to `task.error` via
    // tool_result so we don't double-fire on every transient hiccup.
    if (event.status === 429) playFor("resource.limit");
  });

  pi.on("input", async () => {
    // Rolling-window spam detection. Skip if we just played one
    // recently (so the peon doesn't shout at the user three times in
    // a row).
    const now = Date.now();
    inputTimestamps.push(now);
    while (
      inputTimestamps.length > 0 &&
      now - inputTimestamps[0]! > SPAM_WINDOW_MS
    ) {
      inputTimestamps.shift();
    }
    if (
      inputTimestamps.length >= SPAM_THRESHOLD &&
      now - lastSpamPlayedAt > SPAM_COOLDOWN_MS
    ) {
      lastSpamPlayedAt = now;
      playFor("user.spam");
    }
    return undefined;
  });

  // ── slash command ────────────────────────────────────────────────

  const openSettings = async (ctx: ExtensionContext): Promise<void> => {
    if (!ctx.hasUI) {
      showStatus(ctx);
      return;
    }
    await openPeonSettings(ctx, {
      getConfig: () => config,
      saveConfig: (next) => {
        config = { ...next, volume: next.volume };
        persist(ctx);
      },
      getActivePack: () => activePack,
      listInstalled: () => listInstalledPacks(),
      setActivePack: (name) => {
        const loaded = loadPack(name);
        if (!loaded) return false;
        config = { ...config, activePack: name };
        activePack = loaded;
        persist(ctx);
        return true;
      },
      fetchRegistry: async () => fetchRegistry(),
      installPack: async (entry) => {
        // Progress + result toasts are emitted here (not in the
        // submenu) so the same wrapper covers both the registry
        // browser and the "Reinstall active pack" action — and so
        // they keep working even if a future caller does the install
        // outside of any UI.
        emitToast("info", `peon: installing ${entry.name}…`);
        try {
          await installPackFromRegistry(entry);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          emitToast("error", `peon: install failed (${msg}).`);
          throw err;
        }
        // The cached registry is unchanged, but we drop it so the next
        // browse pulls fresh `updated`/`version` fields.
        resetRegistryCache();
        // Auto-activate freshly installed packs. The user almost
        // always wants to hear what they just installed; if they
        // don't, the Active pack enum still lets them switch back.
        config = { ...config, activePack: entry.name };
        refreshActivePack();
        persist(ctx);
        emitToast(
          "info",
          `peon: installed ${entry.name} and made it active.`,
        );
      },
      fetchPackManifest: async (entry) => fetchPackManifest(entry),
      previewRemoteSound: async (entry, sound) =>
        previewRemoteSound(ctx, entry, sound),
    });
  };

  /**
   * Play one sound from a *registry entry*, falling back to a
   * single-file download when the pack isn't installed locally.
   * Used by the "Browse registry → files" drill-in view so the user
   * can audition clips without installing the whole pack.
   */
  const previewRemoteSound = async (
    ctx: ExtensionContext,
    entry: RegistryEntry,
    sound: ManifestSound,
  ): Promise<void> => {
    if (!playerSpec) {
      ctx.ui.notify("peon: no audio player detected.", "warning");
      return;
    }
    if (config.muted) {
      // The settings UI already exposes the muted toggle. Stay silent
      // here so the user doesn't get a toast every keystroke.
      return;
    }

    // Implicit `sounds/` prefix per CESP spec.
    const rel = sound.file.includes("/") ? sound.file : `sounds/${sound.file}`;

    // Prefer the local copy when available — saves a download round-trip
    // and works offline once the pack is installed.
    const localPack = loadPack(entry.name);
    if (localPack) {
      const localPath = join(localPack.root, ...rel.split("/"));
      if (existsSync(localPath)) {
        try {
          const child = play(playerSpec, localPath, config.volume);
          child.once("error", () => {});
          child.unref();
        } catch {
          // best-effort
        }
        return;
      }
    }

    // Otherwise, fetch this *one* clip into the temp cache and play
    // from there. The first hit re-downloads; subsequent picks of the
    // same file are served from cache.
    try {
      const tmpPath = await downloadSoundToTemp(entry, rel);
      if (config.muted) return; // user muted while we were downloading
      const child = play(playerSpec, tmpPath, config.volume);
      child.once("error", () => {});
      child.unref();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emitToast("error", `peon: preview failed (${msg}).`);
    }
  };

  const showStatus = (ctx: ExtensionContext): void => {
    const lines = [
      `config:       ${getConfigPath()}`,
      `active pack:  ${
        activePack
          ? `${activePack.displayName} (${activePack.name})`
          : `${config.activePack} — NOT INSTALLED`
      }`,
      `pack root:    ${activePack ? activePack.root : "(none)"}`,
      `volume:       ${Math.round(config.volume * 100)}%`,
      `muted:        ${config.muted}`,
      `cli flag:     ${cliDisabled ? "--no-peon (disabled)" : "(none)"}`,
      `player:       ${
        playerSpec === undefined
          ? "(probing…)"
          : playerSpec === null
            ? "(none found)"
            : playerSpec.label
      }`,
      `enabled cats: ${CESP_CATEGORIES.filter((c) => isCategoryEnabled(config, c)).join(", ") || "(none)"}`,
    ];
    ctx.ui.notify(lines.join("\n"), "info");
  };

  const mute = (ctx: ExtensionContext): void => {
    config = { ...config, muted: true };
    persist(ctx);
    ctx.ui.notify("peon: muted.", "info");
  };

  const unmute = (ctx: ExtensionContext): void => {
    config = { ...config, muted: false };
    persist(ctx);
    ctx.ui.notify("peon: unmuted.", "info");
  };

  const test = (ctx: ExtensionContext, arg: string): void => {
    if (!activePack) {
      ctx.ui.notify(
        `peon: no pack loaded (config: ${config.activePack}). Open /peon to install one.`,
        "warning",
      );
      return;
    }
    if (!playerSpec) {
      ctx.ui.notify("peon: no audio player detected.", "warning");
      return;
    }
    const cat = (arg.trim() || "session.start") as CespCategory;
    if (!(CESP_CATEGORIES as readonly string[]).includes(cat)) {
      ctx.ui.notify(
        `peon: unknown category "${cat}". Try one of: ${CESP_CATEGORIES.join(", ")}.`,
        "warning",
      );
      return;
    }
    const sounds = resolveCategory(activePack, cat);
    if (sounds.length === 0) {
      ctx.ui.notify(`peon: pack has no sounds for ${cat}.`, "info");
      return;
    }
    // Bypass the picker's debounce + no-repeat so /peon test is
    // imperative — the user explicitly asked to hear it.
    const chosen = sounds[Math.floor(Math.random() * sounds.length)]!;
    try {
      const child = play(playerSpec, chosen.absPath, config.volume);
      child.once("error", () => {});
      child.unref();
    } catch {
      // best-effort
    }
    ctx.ui.notify(`peon: playing ${cat} → ${chosen.label}`, "info");
  };

  const reset = (ctx: ExtensionContext): void => {
    config = envDefaults();
    persist(ctx);
    refreshActivePack();
    ctx.ui.notify("peon: config reset to defaults.", "info");
  };

  const dispatch = async (
    args: string,
    ctx: ExtensionContext,
  ): Promise<void> => {
    const trimmed = (args ?? "").trim();
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    const cmd = tokens[0]?.toLowerCase() ?? "";
    const rest = trimmed.slice(cmd.length).trim();

    if (!cmd) return openSettings(ctx);
    if (cmd === "status") return showStatus(ctx);
    if (cmd === "mute") return mute(ctx);
    if (cmd === "unmute") return unmute(ctx);
    if (cmd === "test") return test(ctx, rest);
    if (cmd === "reset") return reset(ctx);

    ctx.ui.notify(
      "Usage: /peon [status|mute|unmute|test <category>|reset]  (no args ⇒ open settings)",
      "info",
    );
  };

  pi.registerCommand("peon", {
    description:
      "Open the @wierdbytes/pi-peon settings overlay (no args). Subcommands: status | mute | unmute | test <category> | reset",
    handler: dispatch,
    getArgumentCompletions: (prefix: string) => {
      const tokens = prefix.split(/\s+/);
      const first = tokens[0] ?? "";
      const subs = ["status", "mute", "unmute", "test", "reset"];

      // Once "test " is typed, offer category completions.
      if (first === "test" && /\s/.test(prefix)) {
        const tail = (tokens[1] ?? "").toLowerCase();
        return CESP_CATEGORIES.filter((c) =>
          c.toLowerCase().startsWith(tail),
        ).map((c) => ({ value: `test ${c}`, label: c }));
      }

      // Otherwise complete the subcommand name.
      if (subs.includes(first) && /\s/.test(prefix)) return null;
      const lc = prefix.toLowerCase();
      return subs
        .filter((s) => s.toLowerCase().startsWith(lc))
        .map((s) => ({
          value: s === "test" ? "test " : s,
          label: s,
        }));
    },
  });
}
