/**
 * EventsTracker — subscribes to `notify:toast` / `notify:status` on the
 * shared `pi.events` bus and maintains the in-memory state the
 * statusline renderer reads on every paint.
 *
 * Public surface:
 *   - `new EventsTracker(pi, getConfig)`
 *   - `tracker.start()`         — subscribe (returns nothing)
 *   - `tracker.dispose()`       — unsubscribe + stop the tick timer
 *   - `tracker.onChange(fn)`    — register a render-trigger callback
 *   - `tracker.getSnapshot()`   — frozen view consumed by the renderer
 *   - `tracker.getLog()`        — last 32 toasts for `events log`
 *   - `tracker.clearAll()`      — wipe chips + active toast (not log)
 *
 * The tracker is intentionally framework-free: it only needs the
 * `events.on` shape from the host plus a getter for the current
 * `EventsConfig`.
 */

import {
  PI_WIERD_EVENTS,
  type NotifyStatusEvent,
  type NotifyToastEvent,
} from "@wierdbytes/pi-events";

import type { EventsConfig } from "./events-config.ts";

/** Stable key for the chips map. `id` collapses `undefined` and `""`. */
function chipKey(source: string, id?: string): string {
  return `${source}:${id ?? ""}`;
}

/** Maximum entries kept in the toast log ring buffer. */
const LOG_LIMIT = 32;

/** How often we wake to expire active toasts, in ms.
 *  (Chips are never auto-expired — only new events can mutate them.) */
const TICK_INTERVAL_MS = 500;

/** Active toast slot tracked alongside its calculated expiry. */
export interface ActiveToast {
  /** The original event payload. */
  event: NotifyToastEvent;
  /** Epoch ms after which the toast should be cleared. `Infinity` for sticky. */
  expiresAt: number;
}

/** Snapshot consumed by the statusline renderer on every paint. */
export interface EventsSnapshot {
  /** Active chips ordered by emit timestamp ascending (stable rendering). */
  chips: NotifyStatusEvent[];
  /** Active toast or null. */
  toast: ActiveToast | null;
  /** Monotonic version counter — bumps on every state mutation. */
  version: number;
}

/** Callback invoked on every state change so the host can re-render. */
export type EventsChangeListener = () => void;

/** Minimal shape of the host pi extension API the tracker needs. */
interface TrackerHost {
  events: {
    on(channel: string, handler: (data: unknown) => void): () => void;
  };
}

export class EventsTracker {
  private readonly pi: TrackerHost;
  private readonly getConfig: () => EventsConfig;

  private statuses: Map<string, NotifyStatusEvent> = new Map();
  private toast: ActiveToast | null = null;
  private log: NotifyToastEvent[] = [];
  private version = 0;

  private listeners: Set<EventsChangeListener> = new Set();
  private unsubscribers: Array<() => void> = [];
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  /** True once the bus subscriptions are live and the tick timer is
   *  running. `dispose()` flips this back to false so `start()` can
   *  re-attach later (e.g. when the user toggles
   *  `/statusline off` then `on`). */
  private running = false;

  constructor(pi: TrackerHost, getConfig: () => EventsConfig) {
    this.pi = pi;
    this.getConfig = getConfig;
  }

  /** Subscribe to the bus and start the tick timer. Idempotent — safe
   *  to call repeatedly. After a previous `dispose()` it re-attaches
   *  cleanly, preserving any registered onChange listeners. */
  start(): void {
    if (this.running) return;
    this.running = true;

    this.unsubscribers.push(
      this.pi.events.on(PI_WIERD_EVENTS.TOAST, (data) => this.handleToast(data)),
    );
    this.unsubscribers.push(
      this.pi.events.on(PI_WIERD_EVENTS.STATUS, (data) => this.handleStatus(data)),
    );

    this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    // Don't keep the event loop alive solely for our tick timer.
    if (typeof this.tickTimer === "object" && this.tickTimer && "unref" in this.tickTimer) {
      try {
        (this.tickTimer as { unref: () => void }).unref();
      } catch {
        // Some runtimes don't expose unref; ignore.
      }
    }
  }

  /** Unsubscribe + stop the tick timer + clear chip / toast state.
   *  Listeners are kept so a follow-up `start()` resumes painting.
   *  Use this when the statusline is temporarily disabled. */
  dispose(): void {
    if (!this.running) {
      // Even if we were already stopped, make sure transient state is
      // cleared so a fresh start() begins from a clean slate.
      this.statuses.clear();
      this.toast = null;
      return;
    }
    this.running = false;

    for (const off of this.unsubscribers) {
      try {
        off();
      } catch {
        // Unsubscribe should never throw, but be defensive.
      }
    }
    this.unsubscribers = [];

    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }

    this.statuses.clear();
    this.toast = null;
    // Keep `listeners` intact so a subsequent start() resumes
    // delivering changes to the same renderer.
  }

  /** Register a render-trigger callback. Returns an unsubscribe fn. */
  onChange(listener: EventsChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Frozen snapshot for the renderer. Re-issue on every render call —
   *  the version counter is the cheap way to know if anything changed. */
  getSnapshot(): EventsSnapshot {
    const chips = Array.from(this.statuses.values()).sort(
      (a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0),
    );
    return {
      chips,
      toast: this.toast,
      version: this.version,
    };
  }

  /** Recent toasts (newest first) — used by `/statusline events log`. */
  getLog(): NotifyToastEvent[] {
    // Return a copy newest-first so callers can render directly.
    return [...this.log].reverse();
  }

  /** Wipe all chips + the active toast (does not affect the log). */
  clearAll(): void {
    let mutated = false;
    if (this.statuses.size > 0) {
      this.statuses.clear();
      mutated = true;
    }
    if (this.toast !== null) {
      this.toast = null;
      mutated = true;
    }
    if (mutated) this.bump();
  }

  // ───────────────────────── handlers ─────────────────────────

  private handleToast(data: unknown): void {
    if (!this.running) return;
    const event = this.coerceToast(data);
    if (!event) return;

    // Append to log first (always — even sticky, even dedupe-replaced).
    this.log.push(event);
    if (this.log.length > LOG_LIMIT) this.log.shift();

    const config = this.getConfig();
    const level = event.level ?? "info";
    const timeoutMs = config.toastTimeouts[level] ?? config.toastTimeouts.info ?? 3000;
    const expiresAt = timeoutMs <= 0 ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;

    this.toast = { event, expiresAt };
    this.bump();
  }

  private handleStatus(data: unknown): void {
    if (!this.running) return;
    const event = this.coerceStatus(data);
    if (!event) return;

    const key = chipKey(event.source, event.id);
    const before = this.statuses.size;

    if (event.state === "done" || event.state === "cleared") {
      const had = this.statuses.delete(key);
      if (had) this.bump();
      return;
    }

    // "active" or "error" — set/replace the chip.
    this.statuses.set(key, event);
    if (this.statuses.size !== before || this.statuses.get(key) !== event) {
      // size changed OR an existing entry was replaced
      this.bump();
    } else {
      this.bump();
    }
  }

  // ───────────────────── periodic maintenance ─────────────────────

  private tick(): void {
    if (!this.running) return;

    // Toasts are the only thing the timer can mutate. Chips persist
    // until the emitter sends a new event — never auto-expire them.
    if (this.toast && this.toast.expiresAt <= Date.now()) {
      this.toast = null;
      this.bump();
    }
  }

  // ───────────────────────── helpers ─────────────────────────

  /**
   * Bump the version counter and notify listeners. Wraps each listener
   * in a try/catch so one buggy subscriber can't break the others.
   */
  private bump(): void {
    this.version++;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Listeners must never bring down the tracker.
      }
    }
  }

  /**
   * Validate / coerce a raw payload from the bus into a
   * `NotifyToastEvent`. Returns null on malformed input so we silently
   * drop garbage instead of rendering it.
   */
  private coerceToast(data: unknown): NotifyToastEvent | null {
    if (!data || typeof data !== "object") return null;
    const d = data as Partial<NotifyToastEvent>;
    if (typeof d.source !== "string" || d.source.length === 0) return null;
    if (typeof d.message !== "string") return null;
    return {
      source: d.source,
      title: typeof d.title === "string" ? d.title : undefined,
      message: d.message,
      icon: typeof d.icon === "string" ? d.icon : undefined,
      level: this.coerceLevel(d.level),
      id: typeof d.id === "string" ? d.id : undefined,
      timestamp: typeof d.timestamp === "number" ? d.timestamp : Date.now(),
    };
  }

  /**
   * Validate / coerce a raw payload into a `NotifyStatusEvent`.
   * Returns null on malformed input.
   */
  private coerceStatus(data: unknown): NotifyStatusEvent | null {
    if (!data || typeof data !== "object") return null;
    const d = data as Partial<NotifyStatusEvent>;
    if (typeof d.source !== "string" || d.source.length === 0) return null;
    if (
      d.state !== "active" &&
      d.state !== "done" &&
      d.state !== "error" &&
      d.state !== "cleared"
    ) {
      return null;
    }
    if (typeof d.label !== "string") return null;
    return {
      source: d.source,
      id: typeof d.id === "string" ? d.id : undefined,
      state: d.state,
      label: d.label,
      icon: typeof d.icon === "string" ? d.icon : undefined,
      detail: typeof d.detail === "string" ? d.detail : undefined,
      progress: this.coerceProgress(d.progress),
      level: this.coerceLevel(d.level),
      timestamp: typeof d.timestamp === "number" ? d.timestamp : Date.now(),
    };
  }

  private coerceLevel(value: unknown): NotifyStatusEvent["level"] {
    if (
      value === "debug" ||
      value === "info" ||
      value === "success" ||
      value === "warning" ||
      value === "error"
    ) {
      return value;
    }
    return undefined;
  }

  private coerceProgress(value: unknown): NotifyStatusEvent["progress"] {
    if (!value || typeof value !== "object") return undefined;
    const p = value as Partial<NonNullable<NotifyStatusEvent["progress"]>>;
    if (typeof p.current !== "number" || !Number.isFinite(p.current)) return undefined;
    return {
      current: p.current,
      total:
        typeof p.total === "number" && Number.isFinite(p.total) ? p.total : undefined,
      unit: typeof p.unit === "string" ? p.unit : undefined,
    };
  }
}
