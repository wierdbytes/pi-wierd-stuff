# `@wierdbytes/pi-statusline` — Modular Block Layout

## Context

`packages/statusline/index.ts` currently composes the statusline row inside a single function `buildStatusLine()` that string-concatenates a fixed sequence of blocks:

1. Leading `─` divider (always)
2. **Model** — icon + display name (always), with an attached **thinking** segment (`icon + level`, only when `ctx.model.reasoning`)
3. **Path** — `…/parent/dir` (always)
4. **Git** — `branch ✓/✗` (when in a repo)
5. **Context** — `pct%: used[bar]remaining` (when `contextWindow > 0`)
6. **Cost** — `$0.12` (when `cost > 0`)
7. **Tokens** — `↑in ↓out R W` (each counter shown only when > 0)
8. **Chips** — notify-status lane (from `EventsTracker` + subagents bridge)
9. **Stash** — `📦 N` (when `stashCount > 0`)

Block separators (`│`) are hardcoded into each substring, and the order can't be changed without editing the source. The user wants:

- per-block enable/disable
- arbitrary ordering (`model` is a single block carrying the optional thinking sub-segment; `tokens`, `chips`, `stash` are independent blocks; leading `─` divider is the only fixed prefix)
- a sub-toggle slice for the four token counters (`input` / `output` / `cacheRead` / `cacheWrite`) so the `tokens` block stays a single position but its contents are tunable
- a symmetric sub-toggle on the `model` block to show/hide the inline thinking-level segment
- a Layout tab in the existing settings modal (`openSettingsModal` from `@wierdbytes/pi-common`) with toggle + reorder UI
- a configurable separator glyph (default `│`, alternatives `·` / `▎` / ` `)

Persistence already flows through `packages/statusline/events-config.ts` (`~/.pi/agent/wierd-statusline/events.json`) — we'll extend the schema and add a `version: 2` migration so existing users land on the new defaults transparently.

Goal one-liner — after this PR, a user can edit Layout in `/statusline` and end up with, e.g.:

```
─ /me/dev/proj │ master ✓ │ 56%: 71k[▓▓▓▓▓▓░░░░]56k │ sonnet-4.5 🧠 medium │ ↑12k ↓4.2k
```

(`sonnet-4.5 🧠 medium` is the single `model` block with `model.showThinking` enabled — thinking stays attached to its model, exactly like today.)

…without touching JSON.

## Approach

### 1. Refactor `buildStatusLine` into a sequence of named block renderers

Replace the monolithic function with a small registry. Each block renderer takes a shared `RenderInputs` bundle and returns a "clean" string (no leading/trailing separator, no leading space). An empty string means "skip me".

```ts
// packages/statusline/blocks.ts
export type BlockId =
  | "model" | "path" | "git" | "context"
  | "cost" | "tokens" | "chips" | "stash";

export interface RenderInputs { /* cwd, branch, dirty, current, contextWindow,
  cost, modelName, thinkingLevel, thinkingLevelMap, modelReasoning,
  totalInput, totalOutput, totalCacheRead, totalCacheWrite,
  stashCount, chips, iconSet, layout */ }

export type BlockRenderer = (inputs: RenderInputs) => string;

export const BLOCK_RENDERERS: Record<BlockId, BlockRenderer> = {
  model:    renderModel,    // consults layout.model.showThinking
  path:     renderPath,
  git:      renderGit,
  context:  renderContext,
  cost:     renderCost,
  tokens:   renderTokens,    // consults layout.tokens.{input,output,cacheRead,cacheWrite}
  chips:    renderChips,
  stash:    renderStash,
};
```

Each renderer is the exact code currently inside `buildStatusLine` for that section, minus the leading `${C_GRAY}│${C_RESET} ` glue. The `chips` and `tokens` renderers lose their internal separator prep — they just produce the rendered chip lane / counter list.

`renderModel` keeps the current visual contract: model name immediately followed by an attached thinking segment when (a) the active model is reasoning-capable, *and* (b) `layout.model.showThinking === true`. The thinking segment never gets its own `│` — it's intentionally part of the same block, identical to today's output.

A composer assembles the final line:

```ts
function composeStatusLine(layout, inputs): string {
  const parts: string[] = [];
  for (const id of layout.order) {
    if (!layout.enabled[id]) continue;
    const piece = BLOCK_RENDERERS[id](inputs);
    if (piece.length === 0) continue;        // self-skipped (e.g. git outside repo)
    parts.push(piece);
  }
  const sep = ` ${C_GRAY}${layout.separator}${C_RESET} `;
  // Leading `─ ` is always first; closing trailing space matches today's output.
  return `${C_GRAY}─${C_RESET} ${parts.join(sep)} `;
}
```

Sub-toggle handling lives inside the owning block renderer:

- `renderModel` inspects `layout.model.showThinking` and appends the thinking suffix when enabled.
- `renderTokens` inspects `layout.tokens.*` and emits only the enabled counters, returning `""` when none are present or all four are zero.

This refactor is the load-bearing change. Once blocks render in isolation, every other feature (reorder, toggle, custom separator) is a 5-line config read.

### 2. Extend `events-config.ts` with a `layout` slice + version 2

Add `LayoutConfig` to `EventsConfig` and bump `version` to `2`:

```ts
export interface LayoutConfig {
  /** Ordered list of block ids. Unknown ids are dropped on load;
   *  missing ids are appended to the tail so a future version that
   *  adds a new block still surfaces it. */
  order: BlockId[];
  /** Per-block visibility. Defaults to `true` for every known id. */
  enabled: Record<BlockId, boolean>;
  /** Sub-toggles inside the `model` block. Independent of `enabled.model`. */
  model: { showThinking: boolean };
  /** Sub-toggles inside the `tokens` block. Independent of `enabled.tokens`. */
  tokens: { input: boolean; output: boolean; cacheRead: boolean; cacheWrite: boolean };
  /** Separator glyph rendered between visible blocks. Single char. */
  separator: string;
}

export const DEFAULT_LAYOUT_CONFIG: LayoutConfig = Object.freeze({
  order: ["model", "path", "git", "context", "cost", "tokens", "chips", "stash"],
  enabled: { model: true, path: true, git: true, context: true,
             cost: true, tokens: true, chips: true, stash: true },
  model: { showThinking: true },
  tokens: { input: true, output: true, cacheRead: true, cacheWrite: true },
  separator: "│",
});
```

Migration in `loadEventsConfig`:

- `version` missing or `=== 1`: keep all other slices; inject `DEFAULT_LAYOUT_CONFIG`; rewrite the file with `version: 2`.
- `version === 2`: read full layout, drop unknown block ids, append missing ones to the order so the user keeps every block they'd see on a fresh install (controlled by `enabled` after the merge — missing-then-appended ids land `enabled: true`).
- `version` newer or anything weird: log a `notify:toast` debug-level warning, fall back to defaults (existing pattern in `mergeWithDefaults` already swallows unknown values silently — we extend it for `layout`).

Persist via a new helper `setLayoutConfig(config, patch)` mirroring `setSubagentsConfig` / `setDisplayConfig`. Clamp the separator to length 1 (1-2 visible columns) and drop unknown block ids on the way in.

### 3. Wire the side-effect bus for layout changes

In `index.ts`, the existing `applyDisplayChange` is the canonical place where persistence + UI side-effects fan out. Add a parallel `applyLayoutChange`:

```ts
const applyLayoutChange = (ctx: ExtensionContext, patch: Partial<LayoutConfig>) => {
  eventsConfig = setLayoutConfig(eventsConfig, patch);
  activeTui?.requestRender();     // composer reads eventsConfig.layout on next paint
};
```

The composer doesn't need to be told what changed — it reads from `eventsConfig.layout` (passed via closure into `renderStatusContent`) on every call.

### 4. Layout tab in the settings modal

Add a fourth tab to `openSettingsModal({...})` after `display`/`toasts`/`subagents`:

```ts
tabs: [
  { id: "display",   label: "Display"   },
  { id: "layout",    label: "Layout"    },  // NEW
  { id: "toasts",    label: "Toasts"    },
  { id: "subagents", label: "Subagents" },
],
```

Fields on the Layout tab:

- `Block order & visibility` — **custom** field. Display value: `"7/8 blocks visible"`. `openSubmenu` mounts a list editor (see §5 below). Each commit calls `applyLayoutChange(ctx, { order, enabled })` so the statusline live-updates while the modal is open.
- `Model: show thinking level` — boolean → `applyLayoutChange(ctx, { model: { ...current, showThinking: v } })`. Description notes that the segment only renders for reasoning-capable models.
- `Token: input` — boolean → `applyLayoutChange(ctx, { tokens: { ...current, input: v } })`
- `Token: output` — boolean
- `Token: cache read` — boolean
- `Token: cache write` — boolean
- `Separator` — enum over `["│", "·", "▎", ":", " "]` with `optionLabels` describing each (`"│ — bar (default)"`, `"· — middle dot"`, …). Cycle since count ≤ 4… actually 5, so submenu kicks in for one extra option. Fine either way.

The `onChange` switch in the modal dispatches to `applyLayoutChange` for every layout-tab key.

### 5. Block-list editor (the reorder/toggle widget)

A small custom component mounted as a submenu from the Layout tab. State: `BlockId[]` order + `Record<BlockId, boolean>` enabled. Renders a vertical list:

```
╭── Block order & visibility ──────────────────────────╮
│  [✓]  ↕ model                                          │
│  [✓]    path                                           │
│  [✓]    git                                            │
│  [ ]    context                                        │
│  [✓]    cost                                           │
│  [✓]    tokens                                         │
│  [✓]    chips                                          │
│  [✓]    stash                                          │
│                                                        │
│ ↑↓ navigate · space toggle · alt+↑↓ move · enter done │
╰────────────────────────────────────────────────────────╯
```

Keys:

- `↑/↓` (and `j/k`) — move the cursor
- `space` — toggle `enabled[blockUnderCursor]`
- `alt+↑` / `alt+↓` — swap blockUnderCursor with the neighbour in `order`
- `enter` / `esc` — close the submenu (no rollback — every keystroke already committed via `done({ order, enabled })`)
- `r` — reset to `DEFAULT_LAYOUT_CONFIG.order` + all enabled

Implementation: small bespoke component, not `SelectList` (SelectList doesn't support the move-up/move-down semantics we want). Theme via the host `Theme` like the existing stash-history overlay. The submenu commits eagerly on every change (so the user sees the live statusline shift behind the modal), and `done(currentValue)` on Enter/Esc just confirms the latest state.

### 6. README + command help

- Update `packages/statusline/README.md`:
  - Add a "Layout" subsection under the Sections list explaining configurable order + visibility, with a screenshot or ASCII example.
  - Mention the new Layout tab in the Commands section.
  - Document the new sub-toggles for token counters and the model→thinking sub-toggle.
  - Document the configurable separator (with the four built-in glyph choices).
  - Clarify that `thinking` is not an independent block — it lives inside `model` (so reorder shifts the pair as a unit), mirroring the relationship between `tokens` and its counter sub-toggles.
- The `/statusline` command help string mentions `events log | events clear` etc. — keep it as-is; the modal already opens via the bare command. Add a short note in `printStatusDump` showing the active layout in machine-readable form (`layout: model > thinking > path > … (7/9 visible)`).

### 7. Imperative subcommand (optional but cheap)

While we're touching `printStatusDump`, also expose a minimal CLI for power users:

- `/statusline layout` — print current order + visibility
- `/statusline layout reset` — reset to defaults via `applyLayoutChange`
- `/statusline layout toggle <blockId>` — flip one block's `enabled`
- `/statusline layout move <blockId> <up|down|top|bottom>` — reorder one block

Single dispatcher inside the existing command handler; reuses `applyLayoutChange`. Not exposed in the modal — modal stays the primary UX.

## Files to modify / create

- `packages/statusline/blocks.ts` — **new**. Extract each block renderer into a pure function returning a clean string. Export `BLOCK_RENDERERS`, `BlockId`, `KNOWN_BLOCK_IDS`, `RenderInputs`.
- `packages/statusline/layout-config.ts` — **new**. `LayoutConfig` interface, `DEFAULT_LAYOUT_CONFIG`, helpers for normalising / merging order (drop unknown, append missing), separator clamping. Re-exported from `events-config.ts` so the modal/index imports look symmetric to today's `DisplayConfig`/`SubagentsConfig`.
- `packages/statusline/layout-config.test.ts` — **new**. Unit-test the merge / normalisation (`order` with unknown ids, missing ids, duplicate ids; tokens sub-flags; separator clamp).
- `packages/statusline/events-config.ts` — bump `version: 2`, add `layout: LayoutConfig` to `EventsConfig`, extend `DEFAULT_EVENTS_CONFIG`, add `setLayoutConfig`, extend `mergeWithDefaults` to migrate v1 → v2 with backward compatibility.
- `packages/statusline/index.ts` —
  - Replace `buildStatusLine` with `composeStatusLine` from `blocks.ts` + a thin wrapper.
  - Replace `buildChipsSegment` call-site: chips become block `chips` rendered via `BLOCK_RENDERERS`.
  - Add `applyLayoutChange` next to `applyDisplayChange`.
  - Add the `Layout` tab to the modal's `tabs` + `fields`, including the custom block-list editor submenu.
  - Extend the command dispatcher with `layout` subcommands.
  - Extend `printStatusDump` to print the current layout.
- `packages/statusline/block-list-editor.ts` — **new**. Custom component used as the modal submenu (keyboard-driven reorder + toggle list). Pure renderer + input handler; receives `theme`, `tui`, current `{ order, enabled }`, and a `done` callback.
- `packages/statusline/block-list-editor.test.ts` — **new**. Unit-test the input handling (move, toggle, reset, cursor bounds) via direct method calls. No TUI fixture needed.
- `packages/statusline/README.md` — Layout section + commands docs.
- `packages/statusline/package.json` — bump `version` (e.g. `0.7.0`, minor bump since user-facing feature). No new deps.

No changes outside `packages/statusline/` — `@wierdbytes/pi-common` already exposes everything we need (`openSettingsModal`, `Field` with `custom` variant, `openSubmenu`).

## Reuse

- `@wierdbytes/pi-common`:
  - `openSettingsModal` — the host modal, already wired for three tabs; we only add a fourth.
  - `Field` (esp. `CustomField`) — the block-list editor mounts via `openSubmenu`.
- `@earendil-works/pi-tui`:
  - `truncateToWidth`, `visibleWidth` — already in `composeStatusLine` paths.
  - Theme handles for the block-list editor (border, accent, dim — matches existing stash-history overlay code in `index.ts`).
- Inside `packages/statusline/`:
  - `icons.ts` — `resolveIcon(iconSet, key)` — every block renderer continues to use this. No changes.
  - `events-tracker.ts` — chip snapshot still feeds the `chips` renderer through `getEventsSnapshot`.
  - `events-config.ts` — `setDisplayConfig` / `setSubagentsConfig` / `setToastTimeout` are the template for the new `setLayoutConfig`.

## Steps

- [ ] Extract each section of `buildStatusLine` into pure block renderers in `packages/statusline/blocks.ts`. Verify by snapshotting the existing assembled line for a few synthetic inputs and asserting `composeStatusLine(defaultLayout, …)` produces the same output (regression guard before any UX change).
- [ ] Add `LayoutConfig`, `DEFAULT_LAYOUT_CONFIG`, `setLayoutConfig`, and the `mergeWithDefaults` v1→v2 migration in `events-config.ts` + `layout-config.ts`. Write `layout-config.test.ts` to lock the normalisation rules (drop unknown, append missing, clamp separator, idempotent migration).
- [ ] Update `loadEventsConfig` to rewrite the file with `version: 2` after a successful v1 read, so subsequent loads skip the migration branch.
- [ ] Rewire `renderStatusContent` in `index.ts` to call `composeStatusLine(eventsConfig.layout, inputs)` instead of `buildStatusLine`. Drop dead `buildChipsSegment` glue (now handled by the `chips` block renderer).
- [ ] Add `applyLayoutChange` alongside `applyDisplayChange`, wired to `setLayoutConfig` + `activeTui?.requestRender()`.
- [ ] Build `block-list-editor.ts` (component + input handler). Unit-test reorder / toggle / reset / bounds in `block-list-editor.test.ts`.
- [ ] Add the `Layout` tab to the modal in `openConfigOverlay`: custom field for block order/visibility, four boolean sub-toggles for token counters, enum for the separator glyph. Route every `onChange` key to `applyLayoutChange`.
- [ ] Extend the `/statusline` command dispatcher with `layout` / `layout reset` / `layout toggle <id>` / `layout move <id> <dir>` subcommands. Extend `printStatusDump` to print the active layout.
- [ ] Update `packages/statusline/README.md` (new Layout section, commands, sub-toggles, separator glyphs).
- [ ] Bump `packages/statusline/package.json` to a new minor version.

## Verification

- Bun unit tests:
  - `bun test packages/statusline/layout-config.test.ts` — covers migration, normalisation, separator clamp.
  - `bun test packages/statusline/block-list-editor.test.ts` — covers cursor bounds, move-up/down at edges, toggle, reset, eager-commit.
  - A new snapshot test in `packages/statusline/blocks.test.ts` (or extend the existing smoke tests) asserts `composeStatusLine` produces byte-identical output to the legacy `buildStatusLine` when `layout === DEFAULT_LAYOUT_CONFIG` — guards against regressions in the refactor.
- Manual smoke test:
  - Launch pi with the statusline extension, run `/statusline`, open the Layout tab, toggle/reorder a few blocks, observe live updates.
  - Quit and reopen pi; verify `~/.pi/agent/wierd-statusline/events.json` was rewritten with `version: 2` and that the new order persists across restarts.
  - Hand-edit `events.json` to add a bogus block id and a missing one; reopen — confirm graceful normalisation (notify-toast may surface the warning at debug-level).
  - Imperative: `/statusline layout move tokens top`, `/statusline layout toggle git`, `/statusline layout reset` — verify each round-trips through `printStatusDump` and the live row.
- Config migration:
  - Start from a saved v1 `events.json` (manually replicate a 0.6.x layout). On first load post-upgrade, file should rewrite with `version: 2` + the default layout. No user-visible regression.
- Visual regression:
  - Side-by-side compare the default layout before/after the refactor — the row should be **byte-identical** when every block is enabled in the original order. Because `thinking` is now a sub-segment of the `model` block, no separator is inserted between them and the current visual contract is preserved exactly.
