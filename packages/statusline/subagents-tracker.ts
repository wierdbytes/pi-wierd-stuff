/**
 * SubagentsTracker — bridges `subagents:*` lifecycle events emitted by
 * `@tintinweb/pi-subagents` (https://github.com/tintinweb/pi-subagents)
 * into the statusline's existing chip + toast pipeline.
 *
 * Strategy: subscribe to lifecycle events on `pi.events`, derive a
 * tiny state machine (`created` ≈ queued, `running` = started but not
 * yet terminal), and re-emit `notify:status` / `notify:toast` events
 * back onto the **same** bus. The existing `EventsTracker` then picks
 * those up and the chip / toast renders for free — no rendering code
 * changes required.
 *
 * Public surface mirrors EventsTracker:
 *   - `new SubagentsTracker(pi, getConfig)`
 *   - `tracker.start()`     — subscribe, idempotent
 *   - `tracker.dispose()`   — unsubscribe + clear state
 *   - `tracker.reset()`     — clear state but keep subscriptions
 *   - `tracker.getCounts()` — `{ running, created, total }` for tests / debug
 *
 * The tracker is intentionally framework-free: it only needs the
 * `events.on` / `events.emit` shape from the host plus a getter for
 * the current `EventsConfig.subagents` slice.
 */

import {
  PI_WIERD_EVENTS,
  type NotifyLevel,
  type NotifyStatusEvent,
  type NotifyToastEvent,
} from "@wierdbytes/pi-events";

import type { SubagentsConfig } from "./events-config.ts";
import { DEFAULT_ICON_SET, type IconSet, resolveIcon } from "./icons.ts";

/** Channel constants for the subagents lifecycle. Mirrors the names
 *  emitted by pi-subagents (see its src/index.ts). Keeping them as
 *  string literals avoids a hard dep on the upstream package. */
export const SUBAGENT_EVENTS = {
  CREATED: "subagents:created",
  STARTED: "subagents:started",
  COMPLETED: "subagents:completed",
  FAILED: "subagents:failed",
  SCHEDULED: "subagents:scheduled",
} as const;

/** Source string used for every chip / toast we emit. Matches the
 *  upstream npm package name so the user can recognise the origin. */
export const SUBAGENT_SOURCE = "pi-subagents";

/** Stable chip id for the aggregated summary chip. One chip per
 *  (source, id) — using a fixed id ensures we replace, not stack. */
const SUMMARY_CHIP_ID = "summary";

/** Statuses pi-subagents treats as terminal-error (mirrors its own
 *  `isError` rule in src/index.ts so our toast color matches the
 *  conversation's themed completion box). */
const ERROR_STATUSES = new Set(["error", "stopped", "aborted"]);

/** Minimal shape of the host pi extension API the tracker needs. */
interface TrackerHost {
  events: {
    emit(channel: string, data: unknown): void;
    on(channel: string, handler: (data: unknown) => void): () => void;
  };
}

/** Loose, defensively-coerced view of a pi-subagents lifecycle payload.
 *  Every field is optional because we don't trust the upstream contract
 *  to be stable forever. */
interface SubagentEventLike {
  id?: string;
  type?: string;
  description?: string;
  status?: string;
  result?: string;
  error?: string;
  durationMs?: number;
  toolUses?: number;
  isBackground?: boolean;
  /** Set on subagents:scheduled — informational, not a state change. */
  schedule?: string;
  /** Tokens object with `total` is sometimes present on completed events. */
  tokens?: { input?: number; output?: number; total?: number };
}

export class SubagentsTracker {
  private readonly pi: TrackerHost;
  private readonly getConfig: () => SubagentsConfig;
  /** Resolves the active icon set on every emit. Lets the user flip
   *  `iconSet` at runtime without restarting pi — the *next* chip /
   *  toast we emit picks up the new glyphs. Defaults to the current
   *  built-in set so older callers (smoke tests, etc.) don't have to
   *  pass it. */
  private readonly getIconSet: () => IconSet;

  /** Agents we've seen `subagents:created` for but no `started` yet. */
  private created = new Set<string>();
  /** Agents we've seen `subagents:started` for but no terminal yet. */
  private running = new Set<string>();

  /** Tracks the last emitted chip's `(running, total)` pair so we can
   *  avoid spamming `notify:status` with identical payloads. -1 sentinel
   *  on `total` means "no active chip currently emitted". Both have to
   *  be tracked because progress chips render `current/total` — a
   *  queued→running transition keeps `total` stable but flips `current`,
   *  and the user wants to see the change. */
  private lastEmittedRunning = -1;
  private lastEmittedTotal = -1;

  private unsubscribers: Array<() => void> = [];
  /** True once the bus subscriptions are live. `dispose()` flips it
   *  back to false so `start()` can re-attach later. */
  private active = false;

  constructor(
    pi: TrackerHost,
    getConfig: () => SubagentsConfig,
    getIconSet: () => IconSet = () => DEFAULT_ICON_SET,
  ) {
    this.pi = pi;
    this.getConfig = getConfig;
    this.getIconSet = getIconSet;
  }

  /** Subscribe to the bus. Idempotent — safe to call repeatedly.
   *  After a previous `dispose()` it re-attaches cleanly. */
  start(): void {
    if (this.active) return;
    this.active = true;

    this.unsubscribers.push(
      this.pi.events.on(SUBAGENT_EVENTS.CREATED, (data) => this.handleCreated(data)),
    );
    this.unsubscribers.push(
      this.pi.events.on(SUBAGENT_EVENTS.STARTED, (data) => this.handleStarted(data)),
    );
    this.unsubscribers.push(
      this.pi.events.on(SUBAGENT_EVENTS.COMPLETED, (data) => this.handleTerminal(data, false)),
    );
    this.unsubscribers.push(
      this.pi.events.on(SUBAGENT_EVENTS.FAILED, (data) => this.handleTerminal(data, true)),
    );
    this.unsubscribers.push(
      this.pi.events.on(SUBAGENT_EVENTS.SCHEDULED, (data) => this.handleScheduled(data)),
    );
  }

  /** Unsubscribe + clear state. */
  dispose(): void {
    if (!this.active) {
      this.reset();
      return;
    }
    this.active = false;

    for (const off of this.unsubscribers) {
      try {
        off();
      } catch {
        // Unsubscribe should never throw, but be defensive.
      }
    }
    this.unsubscribers = [];

    // Clear the chip if we still have one out there.
    this.reset();
  }

  /** Wipe the running / created sets and clear any active chip. Keeps
   *  bus subscriptions intact (use this on `session_shutdown` if you
   *  want to drain stale state from a previous session). */
  reset(): void {
    const hadAny = this.running.size > 0 || this.created.size > 0;
    this.running.clear();
    this.created.clear();
    if (hadAny || this.lastEmittedTotal > 0) {
      this.emitSummaryChip();
    }
    // Also forget the last emit so the next active state always pushes
    // a fresh chip even if the prior session ended on the same numbers.
    this.lastEmittedRunning = -1;
    this.lastEmittedTotal = -1;
  }

  /** Counts snapshot — primarily for tests / debug commands. */
  getCounts(): { running: number; created: number; total: number } {
    return {
      running: this.running.size,
      created: this.created.size,
      total: this.running.size + this.created.size,
    };
  }

  // ───────────────────────── handlers ─────────────────────────

  private handleCreated(data: unknown): void {
    if (!this.shouldRender()) return;
    const event = this.coerce(data);
    if (!event?.id) return;

    // `subagents:created` fires before `subagents:started`. The agent
    // may be queued or about to run — either way, count it under
    // "created" until we see `started`.
    if (this.running.has(event.id)) return; // already running, ignore stale
    if (!this.created.has(event.id)) {
      this.created.add(event.id);
      this.emitSummaryChip();
    }
  }

  private handleStarted(data: unknown): void {
    if (!this.shouldRender()) return;
    const event = this.coerce(data);
    if (!event?.id) return;

    // Move from created → running. If we missed the `created` event
    // (e.g. extension load order), `created.delete()` is a no-op and
    // we still add to `running`.
    const movedFromCreated = this.created.delete(event.id);
    const wasAlreadyRunning = this.running.has(event.id);
    this.running.add(event.id);

    if (movedFromCreated || !wasAlreadyRunning) {
      this.emitSummaryChip();
    }
  }

  private handleTerminal(data: unknown, isFailure: boolean): void {
    const event = this.coerce(data);
    if (!event?.id) return;

    // Drop from both sets — agent has reached terminal state.
    const wasTracked =
      this.created.delete(event.id) || this.running.delete(event.id);

    if (this.shouldRender() && wasTracked) {
      this.emitSummaryChip();
    }

    // Toasts are independent of `enabled` so the user still gets
    // failure visibility even when chips are muted? No — make
    // toasts honour `enabled` too. The full feature toggle should be
    // a single switch.
    if (!this.shouldRender()) return;

    // Determine final status (pi-subagents differentiates
    // error/stopped/aborted on the failed channel).
    const status = event.status ?? (isFailure ? "error" : "completed");
    const treatAsError = isFailure || ERROR_STATUSES.has(status);

    const config = this.getConfig();
    if (treatAsError) {
      if (config.toastOnFailure) this.emitFailureToast(event, status);
    } else {
      const duration = typeof event.durationMs === "number" ? event.durationMs : 0;
      if (
        config.toastOnLongCompletion &&
        duration >= Math.max(0, config.longCompletionMs)
      ) {
        this.emitCompletionToast(event, duration);
      }
    }
  }

  private handleScheduled(data: unknown): void {
    if (!this.shouldRender()) return;
    const config = this.getConfig();
    if (!config.toastOnScheduled) return;

    const event = this.coerce(data);
    if (!event) return;

    const title = event.type ? `${event.type} scheduled` : "agent scheduled";
    const message = [event.description, event.schedule]
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .join(" · ") || "scheduled";

    this.emitToast({
      title,
      message,
      icon: resolveIcon(this.getIconSet(), "scheduled"),
      level: "info",
      id: event.id ?? title,
    });
  }

  // ─────────────────────── emit helpers ───────────────────────

  /** Re-emit the aggregated summary chip onto pi.events. The existing
   *  EventsTracker picks it up and the renderer paints the chip in the
   *  chips segment. We dedupe on the `(running, total)` pair so that
   *  identical-snapshot bursts (e.g. multiple `created` for IDs we
   *  already track) don't spam the bus, but every visible-state change
   *  — including queued→running while `total` stays the same — still
   *  emits a fresh chip with the updated `current/total`. */
  private emitSummaryChip(): void {
    const running = this.running.size;
    const total = running + this.created.size;

    if (total === this.lastEmittedTotal && running === this.lastEmittedRunning) {
      return;
    }
    this.lastEmittedRunning = running;
    this.lastEmittedTotal = total;

    if (total === 0) {
      // Drop the chip via state:"done" — EventsTracker treats this as
      // a delete, so the chip vanishes from the row.
      const event: NotifyStatusEvent = {
        source: SUBAGENT_SOURCE,
        id: SUMMARY_CHIP_ID,
        state: "done",
        label: "agents",
        timestamp: Date.now(),
      };
      this.pi.events.emit(PI_WIERD_EVENTS.STATUS, event);
      return;
    }

    const event: NotifyStatusEvent = {
      source: SUBAGENT_SOURCE,
      id: SUMMARY_CHIP_ID,
      state: "active",
      label: "agents",
      icon: resolveIcon(this.getIconSet(), "agents"),
      level: "info",
      progress: { current: running, total },
      timestamp: Date.now(),
    };
    this.pi.events.emit(PI_WIERD_EVENTS.STATUS, event);
  }

  private emitFailureToast(event: SubagentEventLike, status: string): void {
    const typeLabel = event.type ?? "agent";
    const verb = status === "stopped" ? "stopped" : status === "aborted" ? "aborted" : "failed";
    const errorMsg = (event.error ?? event.description ?? "").trim();
    const truncated = errorMsg.length > 200 ? `${errorMsg.slice(0, 200)}…` : errorMsg;
    const message = truncated || `${typeLabel} ${verb}`;

    this.emitToast({
      title: `${typeLabel} ${verb}`,
      message,
      icon: resolveIcon(this.getIconSet(), "error"),
      level: "error",
      id: event.id ?? `${typeLabel}:${verb}`,
    });
  }

  private emitCompletionToast(event: SubagentEventLike, durationMs: number): void {
    const typeLabel = event.type ?? "agent";
    const description = (event.description ?? "").trim();
    const truncatedDesc = description.length > 80 ? `${description.slice(0, 80)}…` : description;
    const durationStr = `${(durationMs / 1000).toFixed(1)}s`;
    const message = truncatedDesc ? `${truncatedDesc} · ${durationStr}` : durationStr;

    this.emitToast({
      title: `${typeLabel} completed`,
      message,
      icon: resolveIcon(this.getIconSet(), "success"),
      level: "success",
      id: event.id ?? `${typeLabel}:completed`,
    });
  }

  /** Emit a toast on `notify:toast`. The existing EventsTracker
   *  validates the payload, applies the per-level lifetime, logs it,
   *  and triggers a render. */
  private emitToast(opts: {
    title: string;
    message: string;
    icon: string;
    level: NotifyLevel;
    id: string;
  }): void {
    const event: NotifyToastEvent = {
      source: SUBAGENT_SOURCE,
      title: opts.title,
      message: opts.message,
      icon: opts.icon,
      level: opts.level,
      id: opts.id,
      timestamp: Date.now(),
    };
    this.pi.events.emit(PI_WIERD_EVENTS.TOAST, event);
  }

  // ───────────────────────── helpers ─────────────────────────

  /** Master switch — when the user has run `/statusline subagents
   *  off`, every handler short-circuits before mutating state or
   *  emitting events. */
  private shouldRender(): boolean {
    return this.getConfig().enabled;
  }

  /** Defensive coercion: trust nothing about the payload shape. We
   *  silently drop entries that don't look like a lifecycle event. */
  private coerce(data: unknown): SubagentEventLike | null {
    if (!data || typeof data !== "object") return null;
    const d = data as Record<string, unknown>;
    return {
      id: typeof d.id === "string" ? d.id : undefined,
      type: typeof d.type === "string" ? d.type : undefined,
      description: typeof d.description === "string" ? d.description : undefined,
      status: typeof d.status === "string" ? d.status : undefined,
      result: typeof d.result === "string" ? d.result : undefined,
      error: typeof d.error === "string" ? d.error : undefined,
      durationMs:
        typeof d.durationMs === "number" && Number.isFinite(d.durationMs)
          ? d.durationMs
          : undefined,
      toolUses:
        typeof d.toolUses === "number" && Number.isFinite(d.toolUses)
          ? d.toolUses
          : undefined,
      isBackground: typeof d.isBackground === "boolean" ? d.isBackground : undefined,
      schedule: typeof d.schedule === "string" ? d.schedule : undefined,
      tokens:
        d.tokens && typeof d.tokens === "object"
          ? (d.tokens as SubagentEventLike["tokens"])
          : undefined,
    };
  }
}
