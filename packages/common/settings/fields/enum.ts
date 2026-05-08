/**
 * Renderer for `type: "enum"` rows.
 *
 * Short option lists (≤ `cycleThreshold`, default 4) cycle in place via
 * Enter / Space; longer lists open a `SelectList` submenu so users
 * don't have to mash Enter to scroll through 20+ entries.
 */

import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  SelectList,
  type Component,
  type SelectItem,
  type TUI,
} from "@earendil-works/pi-tui";
import type { EnumField, FieldRenderer, SubmenuFactory } from "../types.ts";

const DEFAULT_CYCLE_THRESHOLD = 4;
const MAX_VISIBLE_ROWS = 12;

function labelFor(field: EnumField, value: string): string {
  return field.optionLabels?.[value] ?? value;
}

function nextCycleValue(field: EnumField, current: string): string {
  if (field.options.length === 0) return current;
  const idx = field.options.indexOf(current as never);
  const nextIdx = (idx + 1 + field.options.length) % field.options.length;
  return field.options[nextIdx]!;
}

/** Build a submenu factory the modal can mount with its own `done`. */
function makeEnumSubmenu(
  field: EnumField,
  current: string,
  tui: TUI,
): SubmenuFactory<string> {
  return (done) => {
    const items: SelectItem[] = field.options.map((value) => ({
      value,
      label: labelFor(field, value),
    }));
    const list = new SelectList(
      items,
      Math.min(items.length, MAX_VISIBLE_ROWS),
      getSelectListTheme(),
    );
    const idx = items.findIndex((i) => i.value === current);
    list.setSelectedIndex(idx >= 0 ? idx : 0);
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done();

    const component: Component = {
      render(width: number): string[] {
        return list.render(width);
      },
      invalidate(): void {
        list.invalidate();
      },
      handleInput(data: string): void {
        list.handleInput(data);
        tui.requestRender();
      },
    };
    return component;
  };
}

export const enumRenderer: FieldRenderer<EnumField, string> = {
  type: "enum",
  renderValue(row, { selected, ctx }) {
    const text = labelFor(row.field, row.value);
    return ctx.theme.fg(selected ? "accent" : "muted", text);
  },
  hints(row) {
    if (row.field.disabled) return [];
    const threshold = row.field.cycleThreshold ?? DEFAULT_CYCLE_THRESHOLD;
    if (row.field.options.length > threshold) {
      return [{ key: "enter", label: "open list" }];
    }
    return [{ key: "enter/space", label: "cycle" }];
  },
  handleKey(row, data, { ctx }) {
    if (row.field.disabled) return {};
    const isActivate =
      matchesKey(data, "enter") || matchesKey(data, "return") || data === " ";
    if (!isActivate) return {};

    const threshold = row.field.cycleThreshold ?? DEFAULT_CYCLE_THRESHOLD;
    if (row.field.options.length > threshold) {
      return {
        consumed: true,
        submenu: makeEnumSubmenu(row.field, row.value, ctx.tui),
      };
    }
    return { consumed: true, commit: nextCycleValue(row.field, row.value) };
  },
};
