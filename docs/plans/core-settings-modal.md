# `@wierdbytes/pi-common` — Settings Modal (Feature #1)

## Context

The repo currently has five sibling extension packages (`anthropic`, `events`, `statusline`, `voice`, `web`). Several of them have grown their own *config picker* overlays — e.g. `packages/voice/config-picker.ts` (full SettingsList with submenus, including a two-axis model + reasoning-effort widget) and `packages/web/model-picker.ts` (the same two-axis widget for the fetch model). They all reinvent the same things:

- `ctx.ui.custom<T>(…, { overlay: true, overlayOptions: { anchor, width, maxHeight } })` boilerplate.
- A bordered frame, a list of rows, a footer hint line.
- Boolean / enum cycling, inline string editing, submenu pickers.
- A `SelectList`-of-models combined with a `←/→` reasoning-effort axis (voice's `pickFetchModel`).
- Persistence to a per-extension JSON file under `~/.pi/agent/<extension>/config.json`.

Plus the reference at `~/me/dev/vstack/pi-extensions/pi-extension-manager/extensions/extension-manager.ts` shows a polished take on the same idea — package-scoped tabs, search, state/scope filters, inline editing, a heavyweight ratatui-style frame (`┏━┓ ┃ ┗━┛`).

We want a new package `@wierdbytes/pi-common` that owns these "common features for other packages in this repo". The first feature is a **settings modal**: a one-call API that any extension can invoke to surface a popup window for tweaking its own settings, with ratatui-flavoured aesthetics, low-ceremony API, but extensible enough to host custom fields when an extension needs more than the built-ins.

Goal one-liner:

```ts
import { openSettingsModal } from "@wierdbytes/pi-common";

await openSettingsModal(ctx, {
  title: "@wierdbytes/pi-voice",
  fields: [
    { key: "muted",  type: "boolean", label: "Muted",  value: cfg.muted },
    { key: "voice",  type: "enum",    label: "Voice",  value: cfg.voice, options: PREBUILT_VOICES },
    { key: "scope",  type: "enum",    label: "Scope",  value: cfg.scope, options: ["last", "sinceUser"] },
    { key: "model",  type: "model",   label: "Summarizer model",
      value: { id: cfg.summarizerModel, thinking: cfg.summarizerThinkingLevel } },
  ],
  onChange: (key, value) => { cfg[key] = value; saveConfig(cfg); },
});
```

## Approach

Create `packages/common/` (`@wierdbytes/pi-common`) with a single first-feature entry point: a settings-modal renderer built on top of pi-tui primitives + the host theme. The package stays **runtime-only / no peer state** — callers own their config storage; we own the UI.

Layered API, three usage levels (every higher level is sugar on top of the lower one):

1. **High-level**: `openSettingsModal(ctx, opts)` — async function that opens a centered popup (anchor center, ~92% width, ~85% maxHeight), renders a list of declared fields, persists changes through the caller's `onChange` callback, returns when the user closes the modal. The intended one-line entry point for the four existing extensions.
2. **Mid-level**: `createSettingsModal(opts)` — returns a `Component` factory matching `ctx.ui.custom`'s factory shape, so callers that already manage their own overlay lifecycle (e.g. statusline's stash overlay) can mount the body themselves.
3. **Low-level**: `SettingsModalBody`, `frame()`, `Field`, `FieldRenderer`, `SettingsTheme` — exported pieces for callers that want to embed the body inside a larger layout (e.g. a tabbed multi-extension settings window built later in `common` itself).

Built-in field types (mirroring the reference + voice picker needs):

- `boolean` — Enter/Space toggles, renders `on`/`off`.
- `enum<T extends string>` — Enter/Space cycles through `options` when the list is short (≤ `cycleThreshold`, default 4); longer lists open a `SelectList` submenu so users don't have to mash Enter through 20+ entries.
- `string` — inline-editable buffer, `←/→`, word jumps, `home/end`, `backspace/delete`, `ctrl+u`.
- `number` — same as string but typed parsing rejects non-numeric values; surfaces validation errors via `ctx.ui.notify`.
- `secret` — same as string but masked with `••••••` until you press Enter to edit; rendered as `(unset)` when empty.
- `path` — same as string with future room for completion.
- `action` — non-storing row; Enter triggers `onActivate(ctx)`. Useful for "Open log".
- `model` — built-in two-axis widget that ports voice's `pickFetchModel` and web's `pickFetchModel`. Value shape: `{ id: string; thinking?: ModelThinkingLevel }`. Submenu has `↑/↓` over a `SelectList` of models, `←/→` over the reasoning-effort ladder filtered to `model.thinkingLevelMap`. Enter saves both axes atomically; Esc abandons. **Discovery: by default, models come from the host `pi.modelRegistry` (filtered to entries the user has authed, matching voice today).** Caller can narrow via `filter: (model) => boolean` (e.g. "reasoning-capable only") or replace the list entirely via `models?: ModelOption[]` for fully-custom inventories.
- `custom` — caller passes a `FieldRenderer` (render row, handle input, optional submenu component). This is the extensibility seam — anything more exotic than `model` belongs here.

Aesthetics — "ratatui-style":

- **Light rounded box-drawing border** (`╭─╮ │ ╰─╯`), title pill rendered inline in the top edge (`╭── Title ─────╮`).
- Inner padding `2 cols × 1 row`, mirroring extension-manager.
- Optional tab strip across the top (active = inverse pill, inactive = `selectedBg`-tinted), shown only when `tabs` is provided. Tabs scope the visible field list and switch via `tab` / `shift+tab`.
- Optional search bar (`> query▌`) when `enableSearch: true` (default `false` so single-tab modals stay quiet); fuzzy-filters by label / description / current value.
- Auto-generated footer hint that reflects the *currently focused row's* keybindings — boolean rows show `enter toggle`, string rows show `enter edit`, model rows show `enter open · ↑↓ model · ←→ effort`, etc. Falls back to `↑↓ navigate · esc close` when nothing is focused.
- Theming: pull colours from the host `Theme` (`fg("dim"|"muted"|"accent"|…)`, `bg("selectedBg"|"toolPendingBg")`) so the modal blends with whatever theme pi is using. Provide an optional `SettingsTheme` override for callers that want a fixed-palette look (e.g. statusline's Tokyo-Night ANSI).
- Responsive layout: pull terminal rows from the TUI handle, shrink the visible-row count using the same `responsiveInnerRows` math as the reference, never render past the popup.

Persistence model: the modal is **stateless** about disk. The caller passes `value` for each field at open time. On change, we call `onChange(key, newValue)` and let the caller decide whether to write to disk, emit events, etc. We *do* keep the field's currently-displayed value in modal state so the row updates immediately; we re-read from `value` only when the modal is reopened. This keeps `pi-common` from prescribing a JSON layout and works for extensions whose config lives in arbitrary places.

Reset-to-default is **not** in v1 — fields may carry an optional `default?: T` for future use, but no `delete`/`alt+x` shortcut is wired yet. Tracked as a follow-up note in the README.

Error handling:

- Typed parsers (`number`, `enum`) throw → we catch, surface via `ctx.ui.notify(error.message, "error")`, leave the editor open so the user can correct.
- All terminal-input handlers swallow exceptions to match the safety pattern already in `packages/events/helpers.ts`.

## Files to modify / create

- `packages/common/package.json` — new workspace package `@wierdbytes/pi-common`, `peerDependencies` on `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@earendil-works/pi-ai` (the last for `Model<Api>` / `ModelThinkingLevel` shared by the `model` field). Mirror `packages/events/package.json` shape.
- `packages/common/index.ts` — public entry, re-exports the high/mid/low API.
- `packages/common/settings/index.ts` — public re-export wall for the settings feature.
- `packages/common/settings/types.ts` — `Field`, `FieldRenderer`, `SettingsModalOptions`, `SettingsTheme`, `Tab`.
- `packages/common/settings/modal.ts` — `openSettingsModal`, `createSettingsModal`, internal `SettingsModalBody` component (search bar, tab strip, list, footer).
- `packages/common/settings/fields/{boolean,enum,string,number,secret,path,action,model,custom}.ts` — per-type renderers, each implementing `FieldRenderer`.
- `packages/common/settings/frame.ts` — rounded-light frame (`╭─╮ │ ╰─╯`) with title pill + padding; plus `pad`, `wrapLine` lifted from the reference.
- `packages/common/settings/inline-edit.ts` — port of the `InlineEditState` helpers from `extension-manager.ts` (cursor, word jumps, char arithmetic). Tested in isolation.
- `packages/common/settings/inline-edit.test.ts` — bun-test unit tests for the inline-edit helpers.
- `packages/common/README.md` — quickstart, API table, ASCII-art preview of the modal.
- `README.md` — add a `packages/common` entry.
- `packages/voice/config-picker.ts` — **delete**. Voice's settings UI moves directly into `packages/voice/index.ts` as a small inline call to `openSettingsModal` with the `Field[]` schema (booleans, voice enum w/ submenu, scope enum, summarizer `model` field). Exported helpers still needed by tests (e.g. `SESSION_MODEL_LABEL`, `ALL_THINKING_LEVELS` if any test imports them) move to `packages/voice/config.ts` next to the rest of the config types.
- `packages/voice/index.ts` — update the `/wierd-voice config` command handler to call `openSettingsModal` directly; drop the now-stale `import { pickWierdVoiceConfig } from "./config-picker.ts"`.
- `packages/voice/package.json` — add `@wierdbytes/pi-common` as a dependency and bump to a new minor version.

## Reuse

- `@earendil-works/pi-tui`:
  - `truncateToWidth`, `visibleWidth`, `wrapTextWithAnsi` — used by the reference for layout maths; no need to reinvent.
  - `SelectList` — submenu picker for long enum lists / `custom` fields that just need a list, including for `voice`/`anthropic`/`web` model pickers.
  - `SettingsList` — actually almost good enough; we re-implement only because we need ratatui-style framing, optional tabs, and inline editing for `string`/`number`/`secret` (SettingsList only does cycle/submenu).
  - `matchesKey`, `keys` — for portable key matching.
- `@earendil-works/pi-coding-agent`:
  - `Theme`, `getSelectListTheme`, `getSettingsListTheme` — host theme handles. Default `SettingsTheme` derives from these so the modal honours the user's pi theme.
  - `ExtensionContext.ui.custom` + `OverlayOptions` — overlay plumbing; we never go below this.
- Inside this repo:
  - `packages/events/helpers.ts` — pattern of "swallow listener exceptions, never crash siblings". Copy that style for input handlers.
  - `packages/voice/config-picker.ts` — already implements the SettingsList + submenu pattern; the new core lib should subsume this. Use it as the cross-check for "did we keep enough surface for the voice case?".
  - `~/me/dev/vstack/pi-extensions/pi-extension-manager/extensions/extension-manager.ts` — visual + key-handling reference, especially `frame`, `renderInspector`, `handleInlineEditInput`, `formatSettingValue`, `parseSettingInput`, `nextSettingValue`. We are porting these specific helpers — not the package-discovery / inventory logic, which belongs to extension-manager.
- `packages/voice/config-picker.ts` — current host of the model + reasoning-effort widget (`pickFetchModel`-style submenu) that the new `model` field type ports nearly verbatim. Also informs the API ergonomics — anything voice does today must still be expressible after migration.
- `packages/web/model-picker.ts` — the second copy of the same model + effort widget. Not migrated in this PR but kept as a sanity check that the `model` field type is reusable.

## Steps

- [ ] Bootstrap `packages/common` workspace package (mirror `packages/events/package.json` shape, `main: ./index.ts`, ESM, peer deps on pi-coding-agent + pi-tui + pi-ai).
- [ ] Port and unit-test `inline-edit.ts` (pure logic, no TUI; mirrors the helpers in extension-manager.ts).
- [ ] Implement `frame.ts` (rounded-light border + title pill, padding, divider, wrap helpers).
- [ ] Define `Field` discriminated union and `FieldRenderer` interface in `types.ts`, including `Tab`, `SettingsModalOptions`, `SettingsTheme`.
- [ ] Implement built-in field renderers: boolean, enum (with cycle-vs-submenu threshold), string, number, secret, path, action.
- [ ] Implement the `model` field type: SelectList over models, `←/→` over `model.thinkingLevelMap` reasoning levels, atomic save on Enter.
- [ ] Implement `custom` field type — caller provides `render(row)`, `handleInput(data)`, optional `openSubmenu(done)`.
- [ ] Implement `SettingsModalBody` component (tab strip → search → list → row description → auto footer hint).
- [ ] Implement `createSettingsModal(opts)` factory returning the `(tui, theme, kb, done) => Component` shape.
- [ ] Implement `openSettingsModal(ctx, opts)` thin wrapper that calls `ctx.ui.custom(createSettingsModal(opts), { overlay: true, overlayOptions })` with sensible defaults (anchor center, width "92%", maxHeight "85%").
- [ ] Write `packages/common/README.md` with quickstart, full API reference, and an ASCII-art preview of the modal.
- [ ] Add a `packages/common` row to the root `README.md`.
- [ ] **Migrate `packages/voice` off the bespoke picker:** delete `packages/voice/config-picker.ts`, move any still-needed exports (`SESSION_MODEL_LABEL`, `ALL_THINKING_LEVELS`) into `packages/voice/config.ts`, and rewrite the `/wierd-voice config` command in `packages/voice/index.ts` to call `openSettingsModal` directly.
- [ ] Run voice's existing test suite (`packages/voice/voice.test.ts`) and update any imports that referenced the deleted file. Add a small modal smoke test that walks the `Field[]` API end-to-end.

## Verification

- Bun unit tests for `inline-edit.ts` (`bun test packages/common/settings/inline-edit.test.ts`): cursor moves, word jumps, multi-byte chars (CJK / emoji), backspace/delete edges.
- Bun unit tests for the typed parsers in `fields/{number,enum}.ts`: valid + invalid inputs return parsed value or throw with a readable message.
- Manual TUI smoke test inside `packages/voice` after migration: run pi, `/wierd-voice config`, toggle `muted`, change `voice` (cycle since list >4 → submenu), edit summarizer model + effort via the new `model` widget, hit Esc, then `cat ~/.pi/agent/wierd-voice/config.json` and confirm every change round-tripped.
- Visual regression: side-by-side compare today's `/wierd-voice config` against the migrated version; the row layout and submenu behaviour should be visibly equivalent (modulo the new rounded-light frame replacing the old square-edged one).
- `packages/voice/voice.test.ts` continues to pass with no changes (config-picker is exercised indirectly).
- Workspace type-check: `bun install` then `bun --filter '*' tsc --noEmit` (or whatever the repo's existing check is — confirm in the bootstrap step) passes with the new peer deps wired.
