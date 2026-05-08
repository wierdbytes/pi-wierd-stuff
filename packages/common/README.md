# `@wierdbytes/pi-common`

Shared TUI building blocks for [pi coding agent](https://github.com/badlogic/pi-mono) extensions inside this monorepo.

## Features

Two independent submodules ship today, each behind its own subpath
export:

- `@wierdbytes/pi-common/settings` — a centred **settings modal** for
  letting users tweak an extension's persisted config from inside pi.
- `@wierdbytes/pi-common/tool-frame` — the open-right rounded
  **tool-frame** primitives used by `@wierdbytes/pi-facelift` and
  `@wierdbytes/pi-web` to wrap `renderShell: "self"` tool output.

### Settings modal

```text
╭── @wierdbytes/pi-voice ─────────────────────────────────-────────╮
│                                                                  │
│ ▌ Muted                          off                             │
│   Voice                          Umbriel                         │
│   Summary scope                  last                            │
│   Summarizer model               (session model)  ·  medium      │
│                                                                  │
│   What to feed the summarizer: just the final assistant          │
│   message (last) or everything since the last user turn.         │
│                                                                  │
│  ────────────────────────────────────────────────────────────    │
│   enter turn on · esc close                                      │
╰──────────────────────────────────────────────────────────────────╯
```

The modal:

- Renders inside a centered popup (anchor center, 92% width, 85% maxHeight by default).
- Uses a rounded-light frame with the title pill embedded in the top border (ratatui-style).
- Themes itself via the host pi `Theme` so it blends with whatever palette the user is running.
- Auto-generates a footer hint that reflects the **focused** row's keybindings (`enter toggle`, `enter open`, `←/→ effort`, …).
- Stays **stateless about disk** — your `onChange` callback owns persistence.

## Install

The package is a workspace dependency inside this monorepo. Add it to your extension's `package.json`:

```json
{
  "dependencies": {
    "@wierdbytes/pi-common": "^0.1.0"
  }
}
```

Outside this repo, the package depends (peer-deps) on:

- `@earendil-works/pi-coding-agent` ≥ 0.74
- `@earendil-works/pi-tui`           ≥ 0.74
- `@earendil-works/pi-ai`            ≥ 0.74 (only consumed by the `model` field type)

## Quickstart

```ts
import { openSettingsModal } from "@wierdbytes/pi-common";

pi.registerCommand("voice", {
  description: "Voice settings",
  handler: async (_args, ctx) => {
    await openSettingsModal(ctx, {
      title: "@wierdbytes/pi-voice",
      fields: [
        { key: "muted", type: "boolean", label: "Muted",
          value: cfg.muted },
        { key: "voice", type: "enum",    label: "Voice",
          value: cfg.voice, options: PREBUILT_VOICES },
        { key: "scope", type: "enum",    label: "Summary scope",
          value: cfg.scope, options: ["last", "sinceUser"] },
        { key: "summarizer", type: "model", label: "Summarizer model",
          value: { id: cfg.summarizerModel ?? "",
                   thinking: cfg.summarizerThinkingLevel } },
      ],
      onChange: (key, value) => {
        // Caller owns persistence — write whatever way you like.
        if (key === "summarizer") {
          cfg.summarizerModel = (value as { id: string }).id || undefined;
          cfg.summarizerThinkingLevel = (value as { thinking?: string }).thinking;
        } else {
          (cfg as Record<string, unknown>)[key] = value;
        }
        saveConfig(cfg);
      },
    });
  },
});
```

That's it. Re-opening the modal re-reads the current config, so the
caller doesn't need to track an "open/closed" lifetime — push state into
`fields[i].value` at call time and you're done.

## API reference

### High-level — `openSettingsModal(ctx, options)`

```ts
function openSettingsModal<F extends Field>(
  ctx: ExtensionContext,
  options: SettingsModalOptions<F>,
): Promise<void>;
```

Opens a centered overlay and resolves when the user presses Esc /
Ctrl+C. Defaults: `anchor: "center"`, `width: "92%"`, `maxHeight: "85%"`.

### Mid-level — `createSettingsModal(ctx, options)`

```ts
function createSettingsModal<F extends Field>(
  ctx: ExtensionContext,
  options: SettingsModalOptions<F>,
): SettingsModalFactory<void>;
```

Returns the `(tui, theme, kb, done) => Component` factory shape that
`ctx.ui.custom` expects. Use this if you already manage your own
overlay (e.g. a multi-overlay stack with custom anchoring).

### Low-level — `createSettingsModalBody(options, args)`

Builds just the renderable body. The caller owns the overlay
lifecycle and the `tui`/`theme`/`ctx` plumbing. Useful for embedding
the modal inside a larger custom layout.

### `SettingsModalOptions<F>`

| Field             | Type                                                                | Default                | Notes                                                                                  |
| ----------------- | ------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------- |
| `title`           | `string`                                                            | —                      | Inline title pill in the top border.                                                   |
| `fields`          | `F[]`                                                               | required               | Discriminated-union array. See `Field` below.                                          |
| `tabs`            | `Tab[]`                                                             | —                      | When set, shows a tab strip; each `field.tab` matches a `Tab.id`.                      |
| `initialTab`      | `string`                                                            | first tab              | Initial active tab.                                                                    |
| `enableSearch`    | `boolean`                                                           | `false`                | Show a fuzzy search bar above the list. Filters by `label` / `description` / `key`.    |
| `theme`           | `SettingsTheme`                                                     | host theme             | Optional palette overrides.                                                            |
| `overlayOptions`  | `OverlayOptions \| () => OverlayOptions`                            | center / 92% / 85%     | Passed straight to `ctx.ui.custom`.                                                    |
| `onChange`        | `(key, value, field) => void \| Promise<void>`                      | —                      | Called on every commit. Throwing rolls back the row and surfaces via `ctx.ui.notify`.  |
| `onClose`         | `() => void`                                                        | —                      | Called once on dismissal.                                                              |

### `Field` variants

Every variant carries `key: string`, `label: string`, optional `description`, optional `tab`, optional `disabled`. The remaining shape is type-specific.

| `type`   | `value` | Notes                                                                                                                                          |
| -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `boolean`| `boolean` | Enter / Space toggles.                                                                                                                        |
| `enum`   | `string`  | Cycles options if `options.length ≤ cycleThreshold` (default 4); opens a `SelectList` submenu otherwise. `optionLabels` for display overrides. |
| `string` | `string`  | Inline-edit on Enter. Supports placeholder, full readline-style cursor (←/→, word jumps via alt+←/→, home/end, backspace/delete, ctrl+u).      |
| `number` | `number`  | Inline-edit with typed parsing; `min`/`max`/`integer` validators surface via `ctx.ui.notify`.                                                 |
| `secret` | `string`  | Same as `string`; rendered as `••••••` when not editing, masked while editing too.                                                            |
| `path`   | `string`  | Same as `string`; reserved for future path-completion.                                                                                        |
| `action` | —         | Non-storing row; Enter calls `onActivate(ctx)`. Useful for "Open log", "Reload now", etc.                                                     |
| `model`  | `ModelValue` | Two-axis "model + reasoning effort" submenu. Defaults to `pi.modelRegistry.getAvailable()`; narrow with `filter`, replace with `models`.   |
| `custom` | any       | Caller-supplied `render` / optional `handleInput` / optional `openSubmenu`. Escape hatch for anything else.                                    |

The full type definitions live in [`./settings/types.ts`](./settings/types.ts).

### `ModelValue`

```ts
interface ModelValue {
  id: string;                    // "<provider>/<id>", or "" for "session model"
  thinking?: ModelThinkingLevel; // pi-ai's "off"|"minimal"|"low"|"medium"|"high"|"xhigh"
}
```

### Built-in keys

| Where           | Key                              | Action                                               |
| --------------- | -------------------------------- | ---------------------------------------------------- |
| Always          | `↑ / ↓`                          | Move focus.                                          |
| Always          | `pageUp / pageDown`              | Jump 5 rows.                                         |
| Always          | `esc / ctrl+c`                   | Close the modal.                                     |
| With tabs       | `tab / shift+tab`                | Switch tabs.                                         |
| With search     | typing                           | Append to query.                                     |
| With search     | `backspace / ctrl+u`             | Trim / clear query.                                  |
| Per row         | `enter` / `space`                | Toggle / cycle / open submenu / start editing.       |
| While editing   | `enter`                          | Commit (with validation).                            |
| While editing   | `esc`                            | Cancel.                                              |
| While editing   | `←/→ alt+←/→ home/end ctrl+u`    | Cursor / word / line edits.                          |
| Model submenu   | `↑↓` over models · `←→` over effort | Both axes saved atomically on Enter.              |

## Embedding the body into your own layout

```ts
import { createSettingsModalBody } from "@wierdbytes/pi-common";

ctx.ui.custom((tui, theme, _keybindings, done) => {
  const body = createSettingsModalBody(opts, {
    tui, theme, ctx,
    close: () => done(),
  });
  return body;
}, { overlay: true, overlayOptions: { anchor: "center" } });
```

## Tool-frame

The open-right rounded box used by extensions that draw their own
tool output (`renderShell: "self"`):

```text
╭── read /some/file.ext ─────
│   12 lines
│ 535 │ const x = 1;
│ 536 │ const y = 2;
╰─────────────────────────
```

- The right side is intentionally open so long lines fade out
  naturally instead of being clipped by a closing rail.
- Status colour is sourced from host theme tokens — `success` for
  finished tools, `warning` while still streaming, `error` on
  failure — so the chrome inherits the user's palette.
- Multi-line titles render as a sub-tree, useful for batch shapes
  (`web_fetch 5 pages` with one URL per continuation row) and shell
  line continuations (`bash cd /tmp && \` followed by `│ echo …`).

### Quickstart

```ts
import {
  frameTop,
  frameResult,
  frameResultWithBottomLabel,
  getDefaultFrameWidth,
  getFrameStatus,
  renderToolError,
} from "@wierdbytes/pi-common/tool-frame";

pi.registerTool({
  name: "my_tool",
  // ...
  renderShell: "self",

  renderCall(args, theme, ctx) {
    const w = getDefaultFrameWidth();
    const title = `${theme.fg("toolTitle", theme.bold("my_tool"))} ${theme.fg(
      "accent",
      args.target,
    )}`;
    return new Text(frameTop(title, getFrameStatus(ctx), theme, w), 0, 0);
  },

  renderResult(result, options, theme, ctx) {
    const w = getDefaultFrameWidth();
    const status = getFrameStatus(ctx);
    if (ctx.isError)  return new Text(renderToolError(text, theme, w), 0, 0);
    if (options.isPartial)
      return new Text(frameResult("working…", "pending", theme, w), 0, 0);
    if (!options.expanded)
      return new Text(
        frameResultWithBottomLabel(
          preview,
          theme.fg("dim", "ctrl+o to expand"),
          status,
          theme,
          w,
        ),
        0,
        0,
      );
    return new Text(frameResult(body, status, theme, w), 0, 0);
  },
});
```

### API summary

| Helper                              | Returns                                                              |
| ----------------------------------- | -------------------------------------------------------------------- |
| `frameTop(title, status, theme, w)` | top border `╭── title ───`, multi-line titles render as a sub-tree |
| `frameBottom(status, theme, w)`     | bottom border `╰─────────`                                       |
| `frameBottomWithLabel(label, ...)`  | `╰── label ──────` (use for inline summaries / hints)              |
| `frameBodyLines(text, ...)`         | rail-prefixes each line, terminal-style `\r` collapsing              |
| `frameResult(body, ...)`            | `frameBodyLines` + `frameBottom`                                     |
| `frameResultWithBottomLabel(...)`   | `frameBodyLines` + `frameBottomWithLabel`                            |
| `renderToolError(message, theme, w)`| sugar for `frameResult(theme.fg("error", …), "error", …)`             |
| `getFrameStatus(ctx)`               | `"pending" \| "success" \| "error"` from `ctx.isError`/`ctx.isPartial` |
| `getDefaultFrameWidth(maxCap?)`     | `process.stdout.columns` (or fallbacks) clamped to optional cap      |

## License

MIT — see [LICENSE](./LICENSE).
