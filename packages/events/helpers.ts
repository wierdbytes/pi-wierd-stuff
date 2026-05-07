/**
 * @wierdbytes/pi-events — typed safe-emit / safe-on wrappers around the
 * `pi.events` event bus.
 *
 * Every helper:
 *   - validates required payload fields and silently no-ops on missing
 *     ones (so a malformed call from one extension never crashes a
 *     sibling listener);
 *   - auto-fills `timestamp` when omitted;
 *   - swallows transport-level errors (the underlying
 *     `pi.events.emit` is synchronous, but an `on` handler can still
 *     throw — we catch and ignore so subscribers stay isolated).
 *
 * The helpers are deliberately framework-agnostic: they only touch the
 * `events: { emit; on }` shape, so they work in unit tests with a
 * stubbed event bus too.
 */

import {
  PI_WIERD_EVENTS,
  type NotifyStatusEvent,
  type NotifyToastEvent,
} from "./events.ts";

/**
 * Minimal subset of the pi `ExtensionAPI` we actually need.
 *
 * Declared structurally so callers can pass a real `ExtensionAPI`, a
 * test stub, or anything that exposes the same `events.emit` / `events.on`
 * shape — without us taking a peer-dep import on
 * `@earendil-works/pi-coding-agent`'s deep types.
 */
export interface PiEventBusHost {
  events: {
    emit(channel: string, data: unknown): void;
    on(channel: string, handler: (data: unknown) => void): () => void;
  };
}

/** Internal: best-effort emit, swallowing any transport-level error. */
function safeEmit(pi: PiEventBusHost, channel: string, data: unknown): void {
  try {
    pi.events.emit(channel, data);
  } catch {
    // The event bus is shared by every extension — one buggy listener
    // must not be able to break sibling emit calls. Errors here are
    // intentionally dropped on the floor.
  }
}

/** Internal: best-effort subscribe — wraps the user handler so a thrown
 *  error in one consumer doesn't leak into the bus. */
function safeOn<T>(
  pi: PiEventBusHost,
  channel: string,
  handler: (data: T) => void,
): () => void {
  const wrapped = (data: unknown): void => {
    try {
      handler(data as T);
    } catch {
      // Same isolation principle as safeEmit — listener-side errors
      // stay inside the listener.
    }
  };
  try {
    return pi.events.on(channel, wrapped);
  } catch {
    // If subscription itself fails (shouldn't happen with the real
    // `pi.events`), return a no-op unsubscribe so call sites can still
    // safely store and invoke it later.
    return () => {};
  }
}

/**
 * Emit a `notify:toast` event.
 *
 * Required payload fields: `source`, `message`. Other fields are
 * optional; the statusline picks sensible defaults. `timestamp` is
 * auto-filled with `Date.now()` when missing.
 *
 * @example
 * ```ts
 * notifyToast(pi, {
 *   source: "@wierdbytes/pi-voice",
 *   level: "warning",
 *   title: "voice",
 *   message: "no GEMINI_API_KEY found",
 * });
 * ```
 */
export function notifyToast(pi: PiEventBusHost, payload: NotifyToastEvent): void {
  if (!pi || typeof pi !== "object" || !pi.events) return;
  if (!payload || typeof payload !== "object") return;
  if (typeof payload.source !== "string" || payload.source.length === 0) return;
  if (typeof payload.message !== "string") return;

  const enriched: NotifyToastEvent = {
    ...payload,
    timestamp: typeof payload.timestamp === "number" ? payload.timestamp : Date.now(),
  };
  safeEmit(pi, PI_WIERD_EVENTS.TOAST, enriched);
}

/**
 * Emit a `notify:status` event.
 *
 * Required payload fields: `source`, `state`, `label`. Other fields
 * are optional; the statusline derives defaults (color from `level`,
 * icon from level when missing). `timestamp` is auto-filled with
 * `Date.now()` when missing.
 *
 * One chip per `(source, id)` pair — emit again with the same
 * `(source, id)` to update; emit with `state: "done"` or
 * `state: "cleared"` to remove. `state: "error"` is **sticky** until
 * the next emit from the same source replaces it.
 *
 * @example
 * ```ts
 * notifyStatus(pi, {
 *   source: "@wierdbytes/pi-voice",
 *   state: "active",
 *   icon: "🔊",
 *   label: "speaking",
 * });
 * ```
 */
export function notifyStatus(pi: PiEventBusHost, payload: NotifyStatusEvent): void {
  if (!pi || typeof pi !== "object" || !pi.events) return;
  if (!payload || typeof payload !== "object") return;
  if (typeof payload.source !== "string" || payload.source.length === 0) return;
  if (
    payload.state !== "active" &&
    payload.state !== "done" &&
    payload.state !== "error" &&
    payload.state !== "cleared"
  ) {
    return;
  }
  if (typeof payload.label !== "string") return;

  const enriched: NotifyStatusEvent = {
    ...payload,
    timestamp: typeof payload.timestamp === "number" ? payload.timestamp : Date.now(),
  };
  safeEmit(pi, PI_WIERD_EVENTS.STATUS, enriched);
}

/**
 * Subscribe to `notify:toast`. Returns an unsubscribe function from
 * pi's event bus. Listener errors are swallowed so they can't pollute
 * sibling subscribers.
 */
export function onToast(
  pi: PiEventBusHost,
  handler: (event: NotifyToastEvent) => void,
): () => void {
  return safeOn<NotifyToastEvent>(pi, PI_WIERD_EVENTS.TOAST, handler);
}

/**
 * Subscribe to `notify:status`. Returns an unsubscribe function from
 * pi's event bus. Listener errors are swallowed so they can't pollute
 * sibling subscribers.
 */
export function onStatus(
  pi: PiEventBusHost,
  handler: (event: NotifyStatusEvent) => void,
): () => void {
  return safeOn<NotifyStatusEvent>(pi, PI_WIERD_EVENTS.STATUS, handler);
}
