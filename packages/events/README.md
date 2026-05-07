# @wierdbytes/pi-events

Typed event bus for [pi](https://github.com/badlogic/pi-mono) extensions.
Defines exactly **two** public event names that any extension can emit
through pi's existing `pi.events` bus, and that
[`@wierdbytes/pi-statusline`](../statusline) (or anyone else) can subscribe to.

| Event           | Purpose                                                         | Statusline rendering             |
| --------------- | --------------------------------------------------------------- | -------------------------------- |
| `notify:toast`  | One-shot transient notification (errors, hints, completions).   | Toast row above the statusline.  |
| `notify:status` | Long-running status update keyed by `(source, id)`.             | Persistent chip in the statusline. |

The richness lives in the **payload** — title, message, icon, urgency,
progress, dedupe id, source — so the public API stays tiny and external
authors can integrate with one emit call.

## Install

```bash
npm install @wierdbytes/pi-events
```

`pi-coding-agent ≥ 0.72.0` is a peer dep — every pi extension already has it.

## Quick start (emitter)

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { notifyStatus, notifyToast } from "@wierdbytes/pi-events";

// Pass your own module id (typically your npm package name) as `source`
// on every emit. There's no central registry — the field is just a
// string, so first-party and external extensions follow the same path.
const SOURCE = "my-extension";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    // Persistent chip — visible until you emit a follow-up event for
    // the same `source` (and matching `id`, if any).
    notifyStatus(pi, {
      source: SOURCE,
      state: "active",
      icon: "🔊",
      label: "ready",
    });

    // Transient toast — auto-dismisses after the level's configured
    // lifetime (statusline owns the timeout map; emitters cannot
    // override).
    notifyToast(pi, {
      source: SOURCE,
      level: "info",
      title: "my-extension",
      message: "ready to go.",
    });
  });
}
```

## Quick start (listener)

Most extensions never need to listen — the statusline does that for you.
But if you do, the typed subscribers return an unsubscribe function:

```ts
import { onStatus, onToast } from "@wierdbytes/pi-events";

const offStatus = onStatus(pi, (event) => {
  // event is fully typed: NotifyStatusEvent
  console.log(event.source, event.state, event.label);
});

const offToast = onToast(pi, (event) => {
  console.log(event.level ?? "info", event.message);
});

// Later:
offStatus();
offToast();
```

Listener errors are swallowed inside the helper, so a buggy subscriber
in one extension can't break sibling listeners on the shared bus.

## Payload reference

### `notify:toast` — `NotifyToastEvent`

```ts
interface NotifyToastEvent {
  source: string;       // emitter id, typically the npm package name
  title?: string;       // bold prefix; falls back to source
  message: string;      // body (one line in the toast row)
  icon?: string;        // single emoji/glyph; defaults from level
  level?: NotifyLevel;  // "debug" | "info" | "success" | "warning" | "error"
  id?: string;          // dedupe key; new toasts with the same id replace older ones
  timestamp?: number;   // auto-filled with Date.now()
}
```

**Required:** `source`, `message`.
**Lifetime is owned by the statusline** — see
`/wierd-status events toast-ms <level> <ms>` to tune (`0` = sticky until
explicitly dismissed).

### `notify:status` — `NotifyStatusEvent`

```ts
interface NotifyStatusEvent {
  source: string;                       // one chip per (source, id) pair
  id?: string;                          // optional sub-key for sources with several chips
  state: "active" | "done" | "error" | "cleared";
  label: string;                        // shown on the chip (~16 chars)
  icon?: string;                        // single emoji/glyph
  detail?: string;                      // longer description; surfaced in events log only
  progress?: { current: number; total?: number; unit?: string };
  level?: NotifyLevel;
  timestamp?: number;
}
```

**Required:** `source`, `state`, `label`.

State semantics:

| `state`     | Effect                                                                            |
| ----------- | --------------------------------------------------------------------------------- |
| `"active"`  | Show / update the chip.                                                           |
| `"done"`    | Remove the chip (success).                                                        |
| `"error"`   | Keep the chip in error color until something else from the same source replaces it. **Never auto-cleared.** |
| `"cleared"` | Remove the chip (no success/failure semantics).                                   |

## Module ids (`source`)

`source` is just `string` — there is **no central registry**. Every
emitter passes its own identifier on every call, so first-party and
third-party extensions follow the exact same path. Convention: use your
npm package name (or any other stable identifier you'd be happy seeing
in the statusline / events log).

```ts
const SOURCE = "@wierdbytes/pi-voice"; // or your own package name

notifyStatus(pi, { source: SOURCE, state: "active", label: "ready", icon: "🔊" });
```

The statusline keys chips by `(source, id)`, so as long as your
extension uses a consistent `source` value its chip slot is private.

## FAQ

**Q: Why only two event names?**
We modelled this on `~/me/dev/UniPi/packages/core/events.ts` first, then
deliberately moved away from a closed catalogue of dozens of named
events. With just two names + rich payloads, the surface stays trivial
to learn, statusline rendering is uniform, and external authors don't
have to wait on a package release to ship a new event.

**Q: Can I override the toast timeout?**
No — by design. The statusline owns the `level → ms` map (configured
per-user) so toasts have predictable lifetimes regardless of which
extension emits them. Use `level` to express urgency.

**Q: Is `notify:status` debounced?**
No. The statusline collapses repeated emits with the same
`(source, id)` automatically — emit as often as you want.

**Q: What if I want to render events somewhere other than the statusline?**
Subscribe via `onToast` / `onStatus` and render however you like. The
events package has no UI of its own.

## License

MIT
