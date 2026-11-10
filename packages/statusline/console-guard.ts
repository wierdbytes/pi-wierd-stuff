/**
 * @wierdbytes/pi-statusline — keeps stray console output off the TUI.
 *
 * While pi's TUI owns the terminal, anything written to the TTY behind
 * its back lands at the hardware cursor and pi-tui never learns about
 * it. In fullscreen mode the prompt is the terminal's last row
 * (editor-dock.ts), so the trailing newline scrolls the whole alt
 * screen up a row; pi-tui then repaints only the rows it believes
 * changed and every other row keeps its shifted copy — duplicated
 * statusline, "Working…" and subagent rows. The regular-screen
 * renderer loses its cursor bookkeeping the same way.
 *
 * Real-world trigger: pi-langfuse `console.log`s "Tracing enabled" from
 * its extension factory, which runs again for every in-process
 * subagent session.
 *
 * While the TUI is running, `console.*` and `process.stderr.write` go
 * to a log file instead; `console.warn` / `console.error` also reach
 * the caller-provided toast sink. Once the TUI stops (exit, crash,
 * external editor) output passes through untouched, so crash reports
 * printed after `ui.stop()` stay visible.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { format } from "node:util";

/** Console methods the guard intercepts. */
export const GUARDED_METHODS = ["log", "info", "debug", "warn", "error", "trace"] as const;
export type GuardedMethod = (typeof GUARDED_METHODS)[number];

export type ConsoleGuardToastLevel = "warning" | "error";

export interface ConsoleGuardOptions {
  /** True while the TUI owns the terminal; otherwise output passes through. */
  isTuiActive: () => boolean;
  /** Log file for intercepted output. */
  logPath: string;
  /** Called for intercepted `console.warn` / `console.error`. */
  onToast?: (level: ConsoleGuardToastLevel, text: string) => void;
}

export interface ConsoleGuardTargets {
  console?: Console;
  stderr?: { write: (...args: any[]) => boolean };
}

/** Rotate the log once it grows past this size (checked on install). */
export const CONSOLE_LOG_MAX_BYTES = 1024 * 1024;

const STATE_KEY = Symbol.for("@wierdbytes/pi-statusline/console-guard");

interface GuardState {
  options: ConsoleGuardOptions;
  originals: Partial<Record<GuardedMethod, (...args: unknown[]) => void>>;
  originalStderrWrite?: (...args: any[]) => boolean;
  /** Set while handling an intercepted call: a toast sink that logs
   *  must not recurse into another toast. */
  busy: boolean;
}

type Slot = { [STATE_KEY]?: GuardState };

function isActive(options: ConsoleGuardOptions): boolean {
  try {
    return options.isTuiActive();
  } catch {
    return false;
  }
}

function appendLog(path: string, tag: string, text: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const body = text.endsWith("\n") ? text : `${text}\n`;
    appendFileSync(path, `[${new Date().toISOString()}] [${tag}] ${body}`);
  } catch {
    // Nowhere safe to report a logging failure while the TUI is up.
  }
}

function rotateIfLarge(path: string): void {
  try {
    if (statSync(path).size > CONSOLE_LOG_MAX_BYTES) renameSync(path, `${path}.1`);
  } catch {
    // Missing file or unwritable directory: nothing to rotate.
  }
}

function chunkToText(chunk: unknown, encoding: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk).toString(typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8");
  }
  return String(chunk);
}

/**
 * Install the guard on `targets` (defaults: global `console` and
 * `process.stderr`). Idempotent per target: a second install swaps in
 * the new options. Returns a disposer that restores the originals,
 * unless a later install has taken ownership since.
 */
export function installConsoleGuard(
  options: ConsoleGuardOptions,
  targets: ConsoleGuardTargets = {},
): () => void {
  const target = (targets.console ?? console) as Console & Slot;
  const stderr = targets.stderr ?? process.stderr;

  const existing = target[STATE_KEY];
  if (existing) {
    existing.options = options;
    return () => {
      if (target[STATE_KEY] === existing && existing.options === options) uninstall(target, stderr, existing);
    };
  }

  rotateIfLarge(options.logPath);

  const state: GuardState = { options, originals: {}, busy: false };

  for (const method of GUARDED_METHODS) {
    const original = target[method] as ((...args: unknown[]) => void) | undefined;
    if (typeof original !== "function") continue;
    state.originals[method] = original;
    target[method] = ((...args: unknown[]) => {
      const opts = state.options;
      if (!isActive(opts)) {
        original.apply(target, args);
        return;
      }
      let text = format(...args);
      if (method === "trace") {
        const stack = new Error().stack?.split("\n").slice(2).join("\n");
        text = `Trace: ${text}${stack ? `\n${stack}` : ""}`;
      }
      appendLog(opts.logPath, method, text);
      if (state.busy || !opts.onToast || (method !== "warn" && method !== "error")) return;
      state.busy = true;
      try {
        opts.onToast(method === "warn" ? "warning" : "error", text);
      } catch {
        // A failing toast sink must not break the caller.
      } finally {
        state.busy = false;
      }
    }) as Console[typeof method];
  }

  const originalStderrWrite = stderr.write;
  if (typeof originalStderrWrite === "function") {
    state.originalStderrWrite = originalStderrWrite;
    stderr.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
      if (!isActive(state.options)) {
        return originalStderrWrite.call(stderr, chunk, encoding, callback);
      }
      appendLog(state.options.logPath, "stderr", chunkToText(chunk, encoding));
      const done = typeof encoding === "function" ? encoding : callback;
      if (typeof done === "function") queueMicrotask(() => (done as (err?: Error | null) => void)(null));
      return true;
    }) as typeof stderr.write;
  }

  target[STATE_KEY] = state;
  return () => {
    if (target[STATE_KEY] === state && state.options === options) uninstall(target, stderr, state);
  };
}

function uninstall(
  target: Console & Slot,
  stderr: { write: (...args: any[]) => boolean },
  state: GuardState,
): void {
  for (const method of GUARDED_METHODS) {
    const original = state.originals[method];
    if (original) target[method] = original as Console[typeof method];
  }
  if (state.originalStderrWrite) stderr.write = state.originalStderrWrite;
  delete target[STATE_KEY];
}

/** First non-empty line, collapsed and truncated — toast-sized. */
export function toastSummary(text: string, max = 200): string {
  const line =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
