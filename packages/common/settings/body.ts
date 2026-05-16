/**
 * `SettingsModalBody` — the renderable+inputtable component that
 * `createSettingsModal` and `openSettingsModal` mount inside an
 * overlay. Owns:
 *
 *   - Tab strip across the top (when `tabs` is non-empty).
 *   - Optional fuzzy search bar (when `enableSearch` is true).
 *   - The list of rows, with one focused at a time.
 *   - Per-row inline-edit state (string/number/secret/path).
 *   - Submenu mounting (enum long-list, model widget, custom openSubmenu).
 *   - Auto-generated footer hint reflecting the focused row's keybindings.
 *
 * The modal is **stateless about disk** — it calls `onChange` on every
 * commit and lets the caller persist however they like.
 */

import type {
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import type {
  Field,
  FieldKeyHint,
  FieldRenderContext,
  FieldRow,
  SettingsModalOptions,
  Tab,
} from "./types.ts";
import { RENDERERS } from "./fields/index.ts";
import {
  divider,
  formatHintLine,
  frame,
  frameContentWidth,
  pad,
  responsiveInnerRows,
  wrapLine,
  type FrameOptions,
} from "./frame.ts";
import type { InlineEditState } from "./inline-edit.ts";

const PREFERRED_INNER_ROWS = 30;
const LABEL_PAD_TARGET = 28;

interface InternalRow {
  field: Field;
  /** Live displayed value, written back through `onChange`. */
  value: unknown;
  /** Inline-edit toggle for editable types. */
  isEditing: boolean;
}

/**
 * Build the body component. The factory is independent of overlay
 * lifecycle — `createSettingsModal` (in modal.ts) wraps it for the
 * `ctx.ui.custom` shape; advanced callers can mount the body directly.
 */
export function createSettingsModalBody<F extends Field>(
  options: SettingsModalOptions<F>,
  args: {
    tui: TUI;
    theme: Theme;
    ctx: ExtensionContext;
    /** Called when the user closes (Esc / ctrl+c / outer dismissal). */
    close: () => void;
  },
): Component {
  const tabs: Tab[] = options.tabs ?? [];
  const fields: Field[] = options.fields as Field[];

  // Per-row state lives in this array, indexed parallel to a snapshot
  // of `fields`. We never reorder it — search filters use a separate
  // `filteredIndices` view.
  const rows: InternalRow[] = fields.map((field) => ({
    field,
    value: extractInitialValue(field),
    isEditing: false,
  }));

  // Inline-edit state registry: keyed by field.key. Renderers reach
  // into this through `ctx.editStates` (see fields/string.ts).
  const editStates: Map<string, InlineEditState> = new Map();

  let activeTabId: string | undefined = options.initialTab ?? tabs[0]?.id;
  let search = "";
  let selected = 0;
  let scroll = 0;
  let submenu: Component | undefined;
  let submenuKey: string | undefined;

  const fieldRenderContext: FieldRenderContext & {
    editStates: Map<string, InlineEditState>;
  } = {
    theme: args.theme,
    tui: args.tui,
    ctx: args.ctx,
    requestRender: () => args.tui.requestRender(),
    editStates,
  };

  function visibleRowIndices(): number[] {
    const query = search.trim().toLowerCase();
    const out: number[] = [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]!;
      if (activeTabId !== undefined && tabs.length > 0) {
        // When tabs are configured, fields without an explicit `tab` id
        // surface only on the first tab — same convention as a default
        // landing tab in browser-style chrome.
        const fallbackTab = tabs[0]!.id;
        const rowTab = row.field.tab ?? fallbackTab;
        if (rowTab !== activeTabId) continue;
      }
      if (!query) {
        out.push(i);
        continue;
      }
      const hay = `${row.field.label}\n${row.field.description ?? ""}\n${row.field.key}`;
      if (hay.toLowerCase().includes(query)) out.push(i);
    }
    return out;
  }

  function clampSelection(visibleRows: number): void {
    const indices = visibleRowIndices();
    selected = Math.max(0, Math.min(selected, Math.max(0, indices.length - 1)));
    if (selected < scroll) scroll = selected;
    else if (selected >= scroll + visibleRows) scroll = selected - visibleRows + 1;
    scroll = Math.max(0, Math.min(scroll, Math.max(0, indices.length - visibleRows)));
  }

  function focusedIndex(): number | undefined {
    const indices = visibleRowIndices();
    if (indices.length === 0) return undefined;
    // Defensively clamp `selected` against the visible-row count.
    // The arrow-key handlers below also clamp, but a fresh render
    // can run between an out-of-bounds bump and the next clamp
    // (e.g. tabs switching, search filter applying), so we do it
    // here too — the alternative is a footer that briefly drops
    // its row-specific hints whenever `selected` is out of bounds.
    const safe = Math.max(0, Math.min(selected, indices.length - 1));
    return indices[safe];
  }

  function focusedRow(): InternalRow | undefined {
    const idx = focusedIndex();
    return idx === undefined ? undefined : rows[idx];
  }

  function commitValue(row: InternalRow, value: unknown): void {
    const previous = row.value;
    row.value = value;
    try {
      const ret = options.onChange?.(row.field.key as never, value as never, row.field as never);
      if (ret && typeof (ret as Promise<void>).then === "function") {
        (ret as Promise<void>).catch((err) => {
          row.value = previous;
          notifyError(args.ctx, err);
          args.tui.requestRender();
        });
      }
    } catch (err) {
      row.value = previous;
      notifyError(args.ctx, err);
    }
  }

  function mountSubmenu(factory: NonNullable<ReturnType<typeof RENDERERS[Field["type"]]["handleKey"]>["submenu"]>, row: InternalRow): void {
    submenu = factory((value) => {
      submenu = undefined;
      submenuKey = undefined;
      if (value !== undefined) commitValue(row, value);
      args.tui.requestRender();
    });
    submenuKey = row.field.key;
    args.tui.requestRender();
  }

  function setEditing(row: InternalRow, value: boolean): void {
    row.isEditing = value;
  }

  function rendererFor(field: Field) {
    return RENDERERS[field.type];
  }

  function dispatchKey(data: string): void {
    const row = focusedRow();
    if (!row) return;
    const renderer = rendererFor(row.field);
    try {
      const result = renderer.handleKey(
        { field: row.field as never, value: row.value as never },
        data,
        {
          isEditing: row.isEditing,
          ctx: fieldRenderContext,
          setEditing: (v) => setEditing(row, v),
        },
      );
      if (result.commit !== undefined) commitValue(row, result.commit);
      if (result.submenu) mountSubmenu(result.submenu, row);
    } catch (err) {
      notifyError(args.ctx, err);
    }
  }

  /**
   * Apply an alt+↑ / alt+↓ reorder request originating from `handleInput`.
   *
   * Returns `true` when the reorder consumed the keystroke (success
   * or graceful no-op at an edge); `false` when the focused row isn't
   * `reorderable` and the modal should fall through to the default
   * alt-arrow handling (which is currently nothing — alt-arrows are
   * inert in non-reorderable contexts).
   *
   * Reorder is restricted to swaps with the immediate `reorderable`
   * neighbour in `visibleRowIndices` order. We do NOT skip over
   * intervening non-reorderable rows: callers are expected to group
   * reorderable rows contiguously, which keeps the visual behaviour
   * predictable.
   */
  function handleReorder(direction: -1 | 1): boolean {
    const focusedIdx = focusedIndex();
    if (focusedIdx === undefined) return false;
    const focusedRowInternal = rows[focusedIdx];
    if (!focusedRowInternal?.field.reorderable) return false;

    const indices = visibleRowIndices();
    const visiblePos = indices.indexOf(focusedIdx);
    const targetVisiblePos = visiblePos + direction;
    if (targetVisiblePos < 0 || targetVisiblePos >= indices.length) {
      // At the edge — still consume the keystroke so it doesn't bleed
      // into the bare up/down handler below.
      return true;
    }
    const targetIdx = indices[targetVisiblePos]!;
    const targetRow = rows[targetIdx];
    if (!targetRow?.field.reorderable) {
      // Adjacent neighbour isn't reorderable — treat as edge.
      return true;
    }

    // Compute the from/to indices counting ONLY reorderable peers so
    // callers that interleave non-reorderable rows (e.g. a Separator
    // field at the bottom of a Layout tab) still receive contiguous
    // 0..N-1 positions matching their own data structure.
    const reorderablePeerIdxs = indices.filter((i) => rows[i]?.field.reorderable);
    const fromPeerPos = reorderablePeerIdxs.indexOf(focusedIdx);
    const toPeerPos = reorderablePeerIdxs.indexOf(targetIdx);

    // Swap the two rows in-place.
    rows[focusedIdx] = targetRow;
    rows[targetIdx] = focusedRowInternal;

    // Update `selected` so focus follows the moved row. `selected`
    // indexes into the visible-rows view; the row we swapped to
    // `targetIdx` is at visible position `targetVisiblePos`.
    selected = targetVisiblePos;

    try {
      options.onReorder?.({
        fieldKey: focusedRowInternal.field.key,
        fromIndex: fromPeerPos,
        toIndex: toPeerPos,
      });
    } catch (err) {
      notifyError(args.ctx, err);
    }

    args.tui.requestRender();
    return true;
  }

  function handleInput(data: string): void {
    if (submenu) {
      submenu.handleInput?.(data);
      return;
    }
    const row = focusedRow();
    if (row?.isEditing) {
      // While editing, only the renderer (and esc/enter) gets to see
      // input — cursor & nav keys are reserved for the inline editor.
      dispatchKey(data);
      args.tui.requestRender();
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      args.close();
      return;
    }
    if (matchesKey(data, "tab") && tabs.length > 1) {
      cycleTab(1);
      return;
    }
    if (matchesKey(data, "shift+tab") && tabs.length > 1) {
      cycleTab(-1);
      return;
    }
    // Alt+↑ / Alt+↓ reorders the focused row among its `reorderable`
    // peers. Has to run before the bare up/down handlers so the
    // modifier prefix is what dispatches — otherwise `matchesKey(data,
    // "up")` could match the alt-modified variant first depending on
    // the terminal's escape sequence.
    if (matchesKey(data, "alt+up")) {
      if (handleReorder(-1)) return;
    }
    if (matchesKey(data, "alt+down")) {
      if (handleReorder(1)) return;
    }
    // Clamp against the visible-row count up front so `selected`
    // never overshoots. Without this, the footer can momentarily
    // lose its row-specific hints (focusedRow() returns undefined)
    // until the next render reaches `clampSelection`.
    const visibleCount = visibleRowIndices().length;
    const lastIndex = Math.max(0, visibleCount - 1);
    if (matchesKey(data, "up")) {
      selected = Math.max(0, selected - 1);
      args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      selected = Math.min(lastIndex, selected + 1);
      args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "pageUp")) {
      selected = Math.max(0, selected - 5);
      args.tui.requestRender();
      return;
    }
    if (matchesKey(data, "pageDown")) {
      selected = Math.min(lastIndex, selected + 5);
      args.tui.requestRender();
      return;
    }
    if (options.enableSearch) {
      if (matchesKey(data, "backspace")) {
        search = search.slice(0, -1);
        selected = 0;
        args.tui.requestRender();
        return;
      }
      if (matchesKey(data, "ctrl+u")) {
        search = "";
        selected = 0;
        args.tui.requestRender();
        return;
      }
    }

    // Enter / value-key falls through to the renderer.
    dispatchKey(data);
    if (options.enableSearch && data.length === 1 && data >= " " && data !== "\x7f" && !row?.isEditing) {
      // Plain printable input that the renderer didn't claim joins the
      // search query. Booleans / enums never claim it (their
      // handleKey returns `consumed:false` for non-Enter), so users
      // can still type to filter.
      // We detect "renderer didn't claim it" by checking the row state
      // didn't change to editing — a heuristic that works for every
      // built-in. Custom renderers that want to swallow letters should
      // mark the row as editing first.
      if (row && !row.isEditing) {
        search += data;
        selected = 0;
      }
    }
    args.tui.requestRender();
  }

  function cycleTab(delta: number): void {
    if (tabs.length === 0) return;
    const idx = tabs.findIndex((t) => t.id === activeTabId);
    const nextIdx = ((idx === -1 ? 0 : idx) + delta + tabs.length) % tabs.length;
    activeTabId = tabs[nextIdx]!.id;
    selected = 0;
    scroll = 0;
    args.tui.requestRender();
  }

  function renderTabBar(width: number): string {
    if (tabs.length === 0) return "";
    const cells: string[] = [];
    for (const tab of tabs) {
      const padded = ` ${tab.label} `;
      if (tab.id === activeTabId) {
        cells.push(args.theme.fg("accent", args.theme.inverse(args.theme.bold(padded))));
      } else {
        cells.push(args.theme.bg("selectedBg", args.theme.fg("accent", padded)));
      }
    }
    return pad(cells.join(" "), width);
  }

  function renderSearchBar(width: number): string {
    const cursor = args.theme.inverse(" ");
    const text = ` > ${search}${cursor}`;
    return args.theme.bg("toolPendingBg", pad(text, width));
  }

  function renderFooter(width: number): string[] {
    const row = focusedRow();
    let rowHints: FieldKeyHint[] = [];
    if (row) {
      const renderer = rendererFor(row.field);
      rowHints = renderer.hints(
        { field: row.field as never, value: row.value as never },
        { isEditing: row.isEditing },
      );
    }
    // Composition (left → right):
    //   1. tab strip nav (only when tabs are configured)
    //   2. row navigation (`↑↓ move`) — always shown so the user knows
    //      arrow keys are safe even when the focused row claims Enter.
    //   3. row-specific hints from `FieldRenderer.hints`
    //   4. `esc close` — always last
    const hints: FieldKeyHint[] = [];
    if (tabs.length > 1) hints.push({ key: "tab", label: "next tab" });
    // While inline-editing a value, arrow keys belong to the editor
    // (cursor movement) — don't advertise them as row navigation.
    if (!row?.isEditing) hints.push({ key: "↑↓", label: "move" });
    // Surface the reorder hint only when the focused row opts in.
    if (!row?.isEditing && row?.field.reorderable) {
      hints.push({ key: "alt+↑↓", label: "reorder" });
    }
    hints.push(...rowHints);
    hints.push({ key: "esc", label: "close" });
    return wrapLine(formatHintLine(hints, args.theme), width);
  }

  function renderRow(row: InternalRow, width: number, isSelected: boolean): string {
    const labelText = truncateToWidth(row.field.label, LABEL_PAD_TARGET, "…");
    // Per-field `dim` overrides the default focus-based coloring. The
    // override is binary — fields that opt in are saying "this row is
    // semantically active / inactive, color me regardless of focus".
    // Selection background still applies on top either way, so a
    // focused dimmed row stays visibly highlighted via the prefix
    // chip + selectedBg, just with a muted label.
    const dimRaw = row.field.dim;
    const dimFlag = typeof dimRaw === "function" ? dimRaw() : dimRaw;
    const labelColor =
      dimFlag === true
        ? "muted"
        : dimFlag === false
          ? "text"
          : isSelected
            ? "text"
            : "muted";
    const label = args.theme.fg(labelColor, labelText);
    const renderer = rendererFor(row.field);
    const valueText = renderer.renderValue(
      { field: row.field as never, value: row.value as never },
      {
        width: Math.max(1, width - LABEL_PAD_TARGET - 4),
        selected: isSelected,
        isEditing: row.isEditing,
        ctx: fieldRenderContext,
      },
    );
    const padding = " ".repeat(Math.max(1, LABEL_PAD_TARGET - visibleWidth(labelText)));
    const prefix = isSelected ? args.theme.fg("accent", "▌ ") : "  ";
    const composed = `${prefix}${label}${padding}${valueText}`;
    if (isSelected) return args.theme.bg("selectedBg", pad(composed, width));
    return truncateToWidth(composed, width, "…");
  }

  function renderBody(width: number, innerRows: number): string[] {
    const lines: string[] = [];
    if (tabs.length > 0) {
      lines.push(renderTabBar(width));
    }
    if (options.enableSearch) {
      if (lines.length > 0) lines.push("");
      lines.push(renderSearchBar(width));
    }
    if (lines.length > 0) {
      lines.push("");
      lines.push(divider(width, args.theme));
    }

    const indices = visibleRowIndices();
    const footerRows = renderFooter(width);
    const visibleListRows = Math.max(
      3,
      innerRows - lines.length - footerRows.length - 2 - estimateDescriptionRows(),
    );
    clampSelection(visibleListRows);

    const slice = indices.slice(scroll, scroll + visibleListRows);
    if (slice.length === 0) {
      lines.push(args.theme.fg("muted", "  No matching settings."));
    } else {
      if (scroll > 0) lines.push(args.theme.fg("dim", `  ↑ ${scroll} earlier`));
      for (const [visIdx, idx] of slice.entries()) {
        const realIdx = scroll + visIdx;
        const row = rows[idx]!;
        lines.push(renderRow(row, width, realIdx === selected));
      }
      const hidden = Math.max(0, indices.length - (scroll + visibleListRows));
      if (hidden > 0) lines.push(args.theme.fg("dim", `  ↓ ${hidden} more`));
    }

    // Description for the focused row (rendered under the list, like
    // pi-tui's SettingsList).
    const focused = focusedRow();
    if (focused?.field.description) {
      lines.push("");
      for (const line of wrapLine(focused.field.description, Math.max(1, width - 4))) {
        lines.push(args.theme.fg("muted", `  ${line}`));
      }
    }

    // Pad to fill the body so the footer always lands at the bottom.
    while (lines.length + footerRows.length + 1 < innerRows) lines.push("");
    lines.push(divider(width, args.theme));
    lines.push(...footerRows);
    return lines;
  }

  /** Tiny heuristic so renderBody knows roughly how much room the
   *  description block will eat. Real content is recomputed per render
   *  but we want the list to start scrolling before that math kicks in. */
  function estimateDescriptionRows(): number {
    const focused = focusedRow();
    if (!focused?.field.description) return 0;
    return 2;
  }

  return {
    render(width: number): string[] {
      const inner = responsiveInnerRows(args.tui.terminal.rows ?? 24, PREFERRED_INNER_ROWS, 14);
      if (submenu) {
        // Render the submenu inside the same frame so the popup chrome
        // doesn't change shape mid-flow.
        const lines = submenu.render(frameContentWidth(width));
        const opts: FrameOptions = {
          title: submenuTitle(submenuKey),
          fixedInnerRows: inner,
        };
        return frame(lines, width, args.theme, opts);
      }
      const bodyLines = renderBody(frameContentWidth(width), inner);
      return frame(bodyLines, width, args.theme, {
        title: options.title,
        fixedInnerRows: inner,
      });
    },
    invalidate(): void {
      submenu?.invalidate();
    },
    handleInput,
  };
}

function submenuTitle(key: string | undefined): string | undefined {
  return key ? `${key} →` : undefined;
}

function notifyError(ctx: ExtensionContext, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  try {
    ctx.ui.notify(message, "error");
  } catch {
    // Defensive: never let a bad notify call break the modal loop.
  }
}

function extractInitialValue(field: Field): unknown {
  if (field.type === "action") return undefined;
  return (field as { value: unknown }).value;
}
