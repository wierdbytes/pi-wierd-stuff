/**
 * @wierdbytes/pi-statusline — per-block settings sub-menu.
 *
 * Mounted from the Layout tab when the user presses Enter on a block
 * row that has block-specific knobs. Two blocks need this:
 *
 *   - `model` \xb7 a single `Show thinking level` toggle.
 *   - `tokens` \xb7 four counter toggles (`input` / `output` /
 *     `cacheRead` / `cacheWrite`).
 *
 * Other blocks (`path`, `git`, `context`, `cost`, `chips`, `stash`)
 * have nothing to configure inside themselves \u2014 visibility lives on
 * the Layout tab via `space` and reorder via `alt+\u2191\u2193`. For those
 * blocks the Layout tab field is built without `openSubmenu` so Enter
 * is a no-op.
 *
 * Footer hint highlighting reuses `formatHintLine` from
 * `@wierdbytes/pi-common` so the submenu's `enter`/`space` keys glow
 * with the same accent / dim styling the main settings modal uses.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  isKeyRelease,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { formatHintLine, type KeyHint } from "@wierdbytes/pi-common";

import type { BlockId } from "./blocks.ts";
import type { LayoutConfig } from "./layout-config.ts";

/** A toggleable row in the per-block submenu. */
export interface BlockSettingsToggleRow {
  /** Stable id for the test seam. */
  id: string;
  label: string;
  /** Current value derived from the live layout snapshot. */
  value: boolean;
  /** Patch builder: returns the LayoutConfig slice to apply when flipped. */
  toggle: (current: LayoutConfig) => Partial<LayoutConfig>;
}

/**
 * Build the toggle rows for `blockId` against the current layout. Pure;
 * unit-tested without a TUI. Returns an empty array for blocks with
 * no block-specific knobs \u2014 the Layout tab uses that to decide
 * whether to register an `openSubmenu` factory at all.
 */
export function buildBlockSettingsRows(
  blockId: BlockId,
  layout: LayoutConfig,
): BlockSettingsToggleRow[] {
  if (blockId === "model") {
    return [
      {
        id: "model.showThinking",
        label: "Show thinking level",
        value: layout.model.showThinking,
        toggle: (current) => ({
          model: { ...current.model, showThinking: !current.model.showThinking },
        }),
      },
    ];
  }

  if (blockId === "tokens") {
    return [
      {
        id: "tokens.input",
        label: "Show input (\u2191)",
        value: layout.tokens.input,
        toggle: (current) => ({ tokens: { ...current.tokens, input: !current.tokens.input } }),
      },
      {
        id: "tokens.output",
        label: "Show output (\u2193)",
        value: layout.tokens.output,
        toggle: (current) => ({ tokens: { ...current.tokens, output: !current.tokens.output } }),
      },
      {
        id: "tokens.cacheRead",
        label: "Show cache read (R)",
        value: layout.tokens.cacheRead,
        toggle: (current) => ({
          tokens: { ...current.tokens, cacheRead: !current.tokens.cacheRead },
        }),
      },
      {
        id: "tokens.cacheWrite",
        label: "Show cache write (W)",
        value: layout.tokens.cacheWrite,
        toggle: (current) => ({
          tokens: { ...current.tokens, cacheWrite: !current.tokens.cacheWrite },
        }),
      },
    ];
  }

  return [];
}

/** True when `blockId` has at least one block-specific knob \u2014 used by
 *  `index.ts` to decide whether to register an `openSubmenu`. */
export function blockHasSubSettings(blockId: BlockId): boolean {
  return blockId === "model" || blockId === "tokens";
}

export interface CreateBlockSettingsSubmenuArgs {
  blockId: BlockId;
  /** Live read of the current layout (so submenu auto-refreshes after
   *  every eager commit). */
  getLayout: () => LayoutConfig;
  /** Friendly title used in the submenu's frame caption. */
  title: string;
  theme: Theme;
  tui: TUI;
  /** Apply a partial layout patch (live commit). */
  onChange: (patch: Partial<LayoutConfig>) => void;
  /** Close the submenu (no commit). */
  done: () => void;
}

/**
 * Render the per-block submenu. State (cursor) is clamped against the
 * live row count derived from `getLayout()` on every render so external
 * mutations (e.g. another extension changing the order) stay in sync.
 */
export function createBlockSettingsSubmenu(args: CreateBlockSettingsSubmenuArgs): Component & {
  /** Test seam: read cursor index. */
  getCursor(): number;
} {
  let cursor = 0;

  function rowsNow(): BlockSettingsToggleRow[] {
    return buildBlockSettingsRows(args.blockId, args.getLayout());
  }

  function moveCursor(delta: number): void {
    const rows = rowsNow();
    if (rows.length === 0) return;
    cursor = Math.max(0, Math.min(rows.length - 1, cursor + delta));
    args.tui.requestRender();
  }

  function activateFocusedRow(): void {
    const rows = rowsNow();
    const row = rows[cursor];
    if (!row) return;
    args.onChange(row.toggle(args.getLayout()));
    args.tui.requestRender();
  }

  function handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (matchesKey(data, "up") || data === "k") {
      moveCursor(-1);
      return;
    }
    if (matchesKey(data, "down") || data === "j") {
      moveCursor(1);
      return;
    }
    if (matchesKey(data, "home")) {
      cursor = 0;
      args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "end")) {
      cursor = Math.max(0, rowsNow().length - 1);
      args.tui.requestRender();
      return;
    }
    if (
      matchesKey(data, "enter") ||
      matchesKey(data, "return") ||
      data === " " ||
      matchesKey(data, "space")
    ) {
      activateFocusedRow();
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      args.done();
      return;
    }
  }

  function renderToggleRow(row: BlockSettingsToggleRow, focused: boolean): string {
    const checkbox = row.value ? "[\u2713]" : "[ ]";
    const body = `  ${checkbox}  ${row.label}`;
    if (focused) return args.theme.fg("accent", body);
    if (!row.value) return args.theme.fg("muted", body);
    return body;
  }

  return {
    getCursor: () => cursor,
    invalidate() {},
    handleInput,
    render(width: number): string[] {
      const innerWidth = Math.max(20, width - 2);
      const border = (text: string) => args.theme.fg("dim", text);
      const wrap = (text: string): string => {
        const truncated = truncateToWidth(text, innerWidth, "\u2026", true);
        const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
        return `${border("\u2502")}${truncated}${pad}${border("\u2502")}`;
      };

      const rows = rowsNow();
      // Clamp cursor in case the row count shrank (defensive \u2014
      // currently no block ever changes its row count, but a future
      // refactor might).
      if (rows.length > 0 && cursor >= rows.length) cursor = rows.length - 1;

      const lines: string[] = [];
      lines.push(border(`\u256d${"\u2500".repeat(innerWidth)}\u256e`));
      lines.push(wrap(args.theme.fg("accent", args.theme.bold(`Block: ${args.title}`))));
      lines.push(border(`\u251c${"\u2500".repeat(innerWidth)}\u2524`));

      if (rows.length === 0) {
        // Defensive: shouldn't happen because the Layout tab gates
        // `openSubmenu` on `blockHasSubSettings`, but render robustly.
        lines.push(wrap(args.theme.fg("muted", "  (no settings for this block)")));
      } else {
        for (let i = 0; i < rows.length; i += 1) {
          lines.push(wrap(renderToggleRow(rows[i]!, i === cursor)));
        }
      }

      lines.push(border(`\u251c${"\u2500".repeat(innerWidth)}\u2524`));
      // Footer hints rendered with the same accent/dim styling as the
      // main settings modal's footer.
      const hints: KeyHint[] = [
        { key: "\u2191\u2193", label: "navigate" },
        { key: "space/enter", label: "toggle" },
        { key: "esc", label: "back" },
      ];
      lines.push(wrap(formatHintLine(hints, args.theme)));
      lines.push(border(`\u2570${"\u2500".repeat(innerWidth)}\u256f`));
      return lines;
    },
  };
}
