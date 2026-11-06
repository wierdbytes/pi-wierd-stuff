/**
 * Session naming state machine for @wierdbytes/pi-autoname.
 *
 * One `Autonamer` lives for the extension's lifetime; `reset()` runs on
 * every session start. Pi calls are injected (`AutonamerDeps`) so the
 * logic is testable without a running pi.
 *
 * Rules:
 * - A name set by anyone else (`/name`, `--name`, another extension) locks
 *   auto-naming for the session; the terminal title then mirrors that name.
 *   Clearing the name unlocks. `/autoname regen` unlocks too.
 * - Each generated name is recorded as a `wierd-autoname` custom entry, so
 *   a resumed session knows whether its current name is ours (keep
 *   following it) or the user's (locked), and title-only mode can restore
 *   the title without a model call.
 * - Pi rewrites the terminal title to `π - <name> - <cwd>` on session
 *   start, rebind, reload and every name change, so the title is
 *   re-asserted right away and again shortly after those events.
 */

import { basename } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutonameConfig } from "./config.ts";
import { clip, collectInput, FIRST_REQUEST_CHARS, type NamingInput, stripInjected } from "./conversation.ts";
import { generateName, resolveModel, type GenerateOptions, type GenerateResult, type ModelLookup } from "./generator.ts";
import { fallbackName, KEEP, piDefaultTitle, renderTitle } from "./prompt.ts";

export const ENTRY_TYPE = "wierd-autoname";
export const MAX_FAILURES = 3;
/** Re-assert delays after pi may have rewritten the title (ms). */
export const REASSERT_DELAYS = [0, 300, 1500];

export interface AutonameEntry {
  name: string;
  fallback?: boolean;
}

export interface AutonamerDeps {
  config(): AutonameConfig;
  getSessionName(): string | undefined;
  setSessionName(name: string): void;
  appendEntry(customType: string, data: AutonameEntry): void;
  /** One-line notice for the statusline (toast). */
  toast(level: "info" | "warning" | "error", message: string): void;
  resolveModel?: (ctx: ExtensionContext, id: string) => ModelLookup;
  generate?: (ctx: ExtensionContext, opts: GenerateOptions) => Promise<GenerateResult>;
  schedule?: (fn: () => void, ms: number) => void;
}

export interface AutonameStatus {
  name: string | undefined;
  source: "auto" | "fallback" | "manual" | "none";
  locked: boolean;
  busy: boolean;
  failures: number;
  gaveUp: boolean;
}

export class Autonamer {
  private epoch = 0;
  private auto: string | undefined;
  private autoIsFallback = false;
  private manual = false;
  private readonly own = new Set<string>();
  private failures = 0;
  private gaveUp = false;
  private job: AbortController | undefined;
  private titled = false;
  private readonly warned = new Set<string>();

  constructor(private readonly deps: AutonamerDeps) {}

  // ─────────────────────────────────────────────── lifecycle hooks ──

  /** New, resumed, forked or reloaded session. */
  reset(ctx: ExtensionContext): void {
    this.stop();
    this.auto = undefined;
    this.autoIsFallback = false;
    this.manual = false;
    this.own.clear();
    this.failures = 0;
    this.gaveUp = false;
    this.titled = false;
    this.warned.clear();

    const last = lastEntry(ctx.sessionManager.getBranch());
    if (last) {
      this.auto = last.name;
      this.autoIsFallback = last.fallback === true;
    }
    const current = this.deps.getSessionName();
    if (current && current !== this.auto) this.manual = true;
    this.applyTitle(ctx);
  }

  /** Session is going away: drop in-flight work and pending title timers. */
  stop(): void {
    this.epoch++;
    this.job?.abort();
    this.job = undefined;
  }

  onNameChanged(ctx: ExtensionContext, name: string | undefined): void {
    if (name && this.own.delete(name)) {
      // Our own setSessionName echoing back.
    } else if (name) {
      this.manual = true;
      this.job?.abort();
      this.job = undefined;
    } else {
      this.manual = false;
    }
    this.applyTitle(ctx);
  }

  onAgentStart(ctx: ExtensionContext): void {
    this.applyTitle(ctx);
  }

  /**
   * A user prompt was submitted. An unnamed session is named right away from
   * the first request alone, as Claude Code does, so the title shows up while
   * the agent is still working on its reply.
   */
  onPrompt(ctx: ExtensionContext, prompt: string): Promise<void> {
    if (this.auto && !this.autoIsFallback) return Promise.resolve();
    const branch = collectInput(ctx.sessionManager.getBranch());
    const first = branch?.first ?? clip(stripInjected(prompt), FIRST_REQUEST_CHARS);
    if (!first) return Promise.resolve();
    return this.maybeGenerate(ctx, false, { first, recent: [], assistant: "" });
  }

  onSettled(ctx: ExtensionContext): Promise<void> {
    this.applyTitle(ctx);
    return this.maybeGenerate(ctx, false);
  }

  /** `/autoname regen`: unlock and name the session from the conversation now. */
  regenerate(ctx: ExtensionContext): Promise<void> {
    this.manual = false;
    this.failures = 0;
    this.gaveUp = false;
    return this.maybeGenerate(ctx, true);
  }

  /** Settings changed: re-apply title and push the name where it now belongs. */
  onConfigChanged(ctx: ExtensionContext): void {
    const cfg = this.deps.config();
    if (cfg.enabled && cfg.target !== "title" && this.auto && !this.manual && hasSessionFile(ctx)) {
      if (this.deps.getSessionName() !== this.auto) this.pushSessionName(this.auto);
    }
    this.applyTitle(ctx);
  }

  status(): AutonameStatus {
    const name = this.displayName();
    return {
      name,
      source: !name ? "none" : this.manual ? "manual" : this.autoIsFallback ? "fallback" : "auto",
      locked: this.manual,
      busy: this.job !== undefined,
      failures: this.failures,
      gaveUp: this.gaveUp,
    };
  }

  // ─────────────────────────────────────────────────────── naming ──

  private displayName(): string | undefined {
    return this.manual ? this.deps.getSessionName() : this.auto;
  }

  private async maybeGenerate(ctx: ExtensionContext, force: boolean, override?: NamingInput): Promise<void> {
    const cfg = this.deps.config();
    if (!ctx.hasUI) return;
    if (!force) {
      if (!cfg.enabled || this.manual || this.gaveUp || this.job) return;
      if (cfg.mode === "first" && this.auto && !this.autoIsFallback) return;
    }

    const input = override ?? collectInput(ctx.sessionManager.getBranch());
    if (!input) {
      if (force) this.deps.toast("info", "autoname: nothing to name yet");
      return;
    }

    const lookup = (this.deps.resolveModel ?? resolveModel)(ctx, cfg.model);
    if (!lookup.ok) {
      this.warnOnce(`model:${cfg.model}`, `autoname: ${lookup.error}`);
      if (cfg.fallback && !this.auto) this.applyFallback(ctx, input.first);
      return;
    }

    this.job?.abort();
    const job = new AbortController();
    this.job = job;
    const epoch = this.epoch;
    const current = !force && cfg.mode === "auto" && this.auto && !this.autoIsFallback ? this.auto : undefined;

    const result = await (this.deps.generate ?? generateName)(ctx, {
      model: lookup.model,
      thinking: cfg.thinking,
      maxLength: cfg.maxLength,
      input,
      current,
      signal: job.signal,
    });

    if (this.job === job) this.job = undefined;
    if (epoch !== this.epoch || job.signal.aborted) return;
    if (this.manual) return; // named by hand while we were waiting

    if (!result.ok) {
      if (result.aborted) return;
      this.failures++;
      if (cfg.fallback && !this.auto) this.applyFallback(ctx, input.first);
      if (this.failures >= MAX_FAILURES) {
        this.gaveUp = true;
        this.deps.toast("warning", `autoname: gave up after ${MAX_FAILURES} failures (${result.error}); /autoname regen to retry`);
      } else {
        this.warnOnce("generate", `autoname: naming failed (${result.error})`);
      }
      return;
    }

    this.failures = 0;
    if (result.name === KEEP) return;
    if (result.name === this.auto && !this.autoIsFallback) return;
    this.setName(ctx, result.name, false);
  }

  private applyFallback(ctx: ExtensionContext, first: string): void {
    const name = fallbackName(first, this.deps.config().maxLength);
    if (name) this.setName(ctx, name, true);
  }

  private setName(ctx: ExtensionContext, name: string, fallback: boolean): void {
    const cfg = this.deps.config();
    this.auto = name;
    this.autoIsFallback = fallback;
    if (cfg.target !== "title" && hasSessionFile(ctx)) this.pushSessionName(name);
    try {
      this.deps.appendEntry(ENTRY_TYPE, fallback ? { name, fallback } : { name });
    } catch {
      // Persisting the marker is best effort.
    }
    this.applyTitle(ctx);
  }

  private pushSessionName(name: string): void {
    this.own.add(name);
    this.deps.setSessionName(name);
  }

  // ──────────────────────────────────────────────── terminal title ──

  private titleFor(ctx: ExtensionContext): string | undefined {
    const cfg = this.deps.config();
    if (!cfg.enabled || cfg.target === "session") return undefined;
    const name = this.displayName();
    if (!name) return undefined;
    return renderTitle(cfg.titleTemplate, { name, cwd: basename(ctx.cwd) });
  }

  private applyTitle(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const title = this.titleFor(ctx);
    if (!title) {
      if (this.titled) {
        this.titled = false;
        safe(() => ctx.ui.setTitle(piDefaultTitle(this.deps.getSessionName(), basename(ctx.cwd))));
      }
      return;
    }
    this.titled = true;
    safe(() => ctx.ui.setTitle(title));
    const epoch = this.epoch;
    const schedule = this.deps.schedule ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms));
    for (const ms of REASSERT_DELAYS) {
      schedule(() => {
        if (epoch !== this.epoch) return;
        const again = this.titleFor(ctx);
        if (again) safe(() => ctx.ui.setTitle(again));
      }, ms);
    }
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.deps.toast("warning", message);
  }
}

function lastEntry(entries: readonly unknown[]): AutonameEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as { type?: string; customType?: string; data?: unknown };
    if (e?.type !== "custom" || e.customType !== ENTRY_TYPE) continue;
    const data = e.data as Partial<AutonameEntry> | undefined;
    if (data && typeof data.name === "string" && data.name) return { name: data.name, fallback: data.fallback === true };
  }
  return undefined;
}

function hasSessionFile(ctx: ExtensionContext): boolean {
  try {
    return Boolean(ctx.sessionManager.getSessionFile());
  } catch {
    return false;
  }
}

/** A stale ctx (session replaced) throws; the next event re-applies. */
function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    // ignore
  }
}
