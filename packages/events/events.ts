/**
 * @wierdbytes/pi-events — public event-name constants and payload types.
 *
 * The package defines exactly **two** public event channels on
 * `pi.events`:
 *
 *   `notify:toast`  — one-shot transient notification. Renders as a
 *                     toast row above the statusline; statusline owns
 *                     the per-level lifetime map (emitters cannot
 *                     override).
 *   `notify:status` — long-running status update. Renders as a chip
 *                     inside the statusline; identified per
 *                     (`source`, `id`) pair and cleared by a
 *                     `state: "done" | "cleared"` follow-up.
 *
 * Everything else (icons, urgency, progress, dedupe) lives in the
 * payload, so the public surface stays tiny and external authors can
 * integrate by emitting one of these two events with a well-typed body.
 */

/** Public event-name constants. Use these instead of bare strings. */
export const PI_WIERD_EVENTS = {
  /** One-shot transient notification (`notify:toast`). */
  TOAST: "notify:toast",
  /** Long-running status update (`notify:status`). */
  STATUS: "notify:status",
} as const;

/** Type-level union of every public event name. */
export type PiWierdEventName =
  (typeof PI_WIERD_EVENTS)[keyof typeof PI_WIERD_EVENTS];

/**
 * Severity / color hint, shared by both event types.
 *
 * The statusline maps each level to:
 *   - a default icon (when `icon` is omitted)
 *   - an ANSI color
 *   - a toast lifetime (in `events-config.toastTimeouts`)
 */
export type NotifyLevel = "debug" | "info" | "success" | "warning" | "error";

/**
 * `notify:toast` payload — one-shot transient notification.
 *
 * Toast lifetime is **owned by the statusline**, derived from the
 * configured `toastTimeouts[level]`. Emitters cannot override.
 */
export interface NotifyToastEvent {
  /** Emitting module id (typically the npm package name, e.g.
   *  `"@wierdbytes/pi-voice"`). Required so the UI can group / filter. */
  source: string;

  /** Short headline. Rendered bold in the toast. Optional — falls back
   *  to `source` when omitted. */
  title?: string;

  /** Body text. May be multi-line; the statusline renders one line and
   *  the events log keeps the full text. */
  message: string;

  /** Single emoji / glyph rendered before the title. Defaults to a
   *  level-derived icon when omitted. */
  icon?: string;

  /** Severity. Drives color, default icon, **and lifetime** (the
   *  statusline owns the per-level timeout map — emitters cannot
   *  override). Defaults to `"info"` when omitted. */
  level?: NotifyLevel;

  /** Optional dedupe key. A newer toast with the same `id` replaces an
   *  older one in-place instead of stacking. Useful for "still
   *  loading…" style updates. */
  id?: string;

  /** Auto-filled with `Date.now()` if missing. */
  timestamp?: number;
}

/**
 * `notify:status` payload — long-running status, rendered as a chip in
 * the statusline.
 *
 * One chip per `(source, id)` pair. The `state` field drives the
 * lifecycle:
 *
 *   `"active"`  — show or update the chip.
 *   `"done"`    — remove the chip (success).
 *   `"error"`   — keep the chip but render in error color until
 *                 explicitly replaced (next emit from same source) or
 *                 cleared via `/wierd-status events clear`.
 *   `"cleared"` — remove the chip with no success/failure semantics.
 */
export interface NotifyStatusEvent {
  /** Emitting module id (typically the npm package name, e.g.
   *  `"@wierdbytes/pi-voice"`). One chip per `(source, id)` pair. */
  source: string;

  /** Sub-key when one source has multiple concurrent statuses (e.g. a
   *  module running several loops). Omit if the source only ever has
   *  one chip; both `undefined` and `""` collapse to the same chip
   *  slot. */
  id?: string;

  /** Lifecycle marker. See interface JSDoc for semantics. */
  state: "active" | "done" | "error" | "cleared";

  /** Short text shown in the chip. The statusline truncates labels to
   *  ~16 visible chars. */
  label: string;

  /** Optional emoji / glyph rendered before the label. Defaults from
   *  level when omitted. */
  icon?: string;

  /** Optional longer description. Surfaced in `/wierd-status events
   *  log` and any future tooltip — not shown on the chip itself. */
  detail?: string;

  /** Optional progress hint. If `total` is set the statusline appends
   *  `current/total` (or a tiny progress bar when width permits). */
  progress?: {
    /** Current units processed. */
    current: number;
    /** Total units expected. Omit for indeterminate progress. */
    total?: number;
    /** Optional unit label, e.g. `"files"`, `"tokens"`. */
    unit?: string;
  };

  /** Color hint. Defaults: `"info"` for active, `"success"` for done,
   *  `"error"` for error. */
  level?: NotifyLevel;

  /** Auto-filled with `Date.now()` if missing. */
  timestamp?: number;
}

/**
 * Discriminated union of every public event payload, keyed by event
 * name. Useful for generic handlers that want to switch on `event`.
 */
export type NotifyEventPayload =
  | { event: typeof PI_WIERD_EVENTS.TOAST; payload: NotifyToastEvent }
  | { event: typeof PI_WIERD_EVENTS.STATUS; payload: NotifyStatusEvent };

/**
 * Payload-type-by-event-name lookup. Used by the typed `emit` / `on`
 * helpers in `helpers.ts` so callers get full IntelliSense.
 */
export interface PiWierdEventPayloadMap {
  [PI_WIERD_EVENTS.TOAST]: NotifyToastEvent;
  [PI_WIERD_EVENTS.STATUS]: NotifyStatusEvent;
}
