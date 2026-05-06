/**
 * pi-wierd-events — public entry point.
 *
 * Two events, sized for any extension that wants to surface state in
 * `pi-wierd-statusline` (or any future consumer of the same event
 * names):
 *
 *   `notify:toast`  — one-shot transient notification.
 *   `notify:status` — long-running status, rendered as a chip.
 *
 * See `events.ts` for the payload shapes and `helpers.ts` for the
 * typed `notifyToast` / `notifyStatus` / `onToast` / `onStatus`
 * wrappers around `pi.events.emit` / `.on`.
 */

export {
  PI_WIERD_EVENTS,
  type PiWierdEventName,
  type NotifyLevel,
  type NotifyToastEvent,
  type NotifyStatusEvent,
  type NotifyEventPayload,
  type PiWierdEventPayloadMap,
} from "./events.ts";

export {
  notifyToast,
  notifyStatus,
  onToast,
  onStatus,
  type PiEventBusHost,
} from "./helpers.ts";
