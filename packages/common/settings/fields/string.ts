/**
 * Renderer for inline-edit text fields: `string`, `number`, `secret`,
 * `path`. They share a single state machine — the only differences are:
 *
 *   - `number`  parses + validates in `commitFromBuffer`.
 *   - `secret`  masks the displayed value when not editing.
 *   - `path`    is identical to `string` today (kept distinct so future
 *               completion / validation can hang off the type without
 *               another flag).
 *
 * Editing flow:
 *   1. User presses Enter on the row → `setEditing(true)` and seed the
 *      buffer from the current value.
 *   2. Subsequent keystrokes are routed to `handleInlineEditInput`.
 *   3. Enter commits, Esc cancels, both call `setEditing(false)`.
 *   4. The modal re-reads the buffer on every render, so the user sees
 *      live feedback as they type.
 *
 * The buffer state is stored on the modal side (one InlineEditState per
 * row keyed by `field.key`) so renderers stay stateless.
 */

import { matchesKey } from "@earendil-works/pi-tui";
import {
  handleInlineEditInput,
  renderInlineEditValue,
  type InlineEditState,
} from "../inline-edit.ts";
import type {
  FieldKeyResult,
  FieldRenderer,
  NumberField,
  PathField,
  SecretField,
  StringField,
} from "../types.ts";

/**
 * The modal stores one InlineEditState per editable row. Renderers
 * access it through this lookup, set by the modal in `FieldRenderContext`.
 *
 * We intentionally don't bake the lookup into `FieldRenderContext` to
 * keep the public type surface clean — instead, the modal mutates a
 * weak-keyed registry passed via `(ctx as any).editStates`. The
 * renderers below pull it out in a single helper to keep the cast
 * isolated.
 */
function getEditState(args: { ctx: unknown }, key: string): InlineEditState | undefined {
  const registry = (args.ctx as { editStates?: Map<string, InlineEditState> }).editStates;
  return registry?.get(key);
}

function setEditState(
  args: { ctx: unknown },
  key: string,
  state: InlineEditState | undefined,
): void {
  const registry = (args.ctx as { editStates?: Map<string, InlineEditState> }).editStates;
  if (!registry) return;
  if (state === undefined) registry.delete(key);
  else registry.set(key, state);
}

function maskedSecret(value: string): string {
  if (!value) return "(unset)";
  return "••••••";
}

function placeholderOrEmpty(field: StringField | PathField, value: string, dim: (s: string) => string): string {
  if (value) return value;
  const placeholder = (field as StringField).placeholder;
  if (placeholder) return dim(placeholder);
  return dim("(unset)");
}

// ─────────────────────────────────────────────────────────────────────
// String
// ─────────────────────────────────────────────────────────────────────

export const stringRenderer: FieldRenderer<StringField, string> = {
  type: "string",
  renderValue(row, args) {
    const dim = (s: string) => args.ctx.theme.fg("dim", s);
    if (args.isEditing) {
      const state = getEditState(args, row.field.key);
      if (state) {
        return args.ctx.theme.fg("accent", renderInlineEditValue(state));
      }
    }
    const text = placeholderOrEmpty(row.field, row.value, dim);
    return args.selected ? args.ctx.theme.fg("text", text) : args.ctx.theme.fg("muted", text);
  },
  hints(_row, { isEditing }) {
    if (isEditing) {
      return [
        { key: "enter", label: "save" },
        { key: "esc", label: "cancel" },
        { key: "←/→", label: "move" },
      ];
    }
    return [{ key: "enter", label: "edit" }];
  },
  handleKey(row, data, args) {
    return handleStringLikeKey<string>(row.field.key, row.value, data, args, (buf) => buf);
  },
};

// ─────────────────────────────────────────────────────────────────────
// Path
// ─────────────────────────────────────────────────────────────────────

export const pathRenderer: FieldRenderer<PathField, string> = {
  type: "path",
  renderValue(row, args) {
    // Reuse the string renderer's body — `StringField` and `PathField`
    // share identical render shape today; we cross the variant boundary
    // via an `unknown` cast to satisfy TS's nominal discriminator.
    return (stringRenderer.renderValue as unknown as FieldRenderer<PathField, string>["renderValue"])(row, args);
  },
  hints(row, args) {
    return (stringRenderer.hints as unknown as FieldRenderer<PathField, string>["hints"])(row, args);
  },
  handleKey(row, data, args) {
    return handleStringLikeKey<string>(row.field.key, row.value, data, args, (buf) => buf);
  },
};

// ─────────────────────────────────────────────────────────────────────
// Secret
// ─────────────────────────────────────────────────────────────────────

export const secretRenderer: FieldRenderer<SecretField, string> = {
  type: "secret",
  renderValue(row, args) {
    if (args.isEditing) {
      const state = getEditState(args, row.field.key);
      if (state) {
        // Mask in place: render the buffer through the cursor block but
        // replace every non-cursor char with `•` so over-the-shoulder
        // viewers can't see the secret as it's being typed.
        const masked = "•".repeat(state.buffer.length);
        const view: { buffer: string; cursor: number } = {
          buffer: masked,
          cursor: state.cursor,
        };
        return args.ctx.theme.fg("accent", renderInlineEditValue(view as InlineEditState));
      }
    }
    const display = maskedSecret(row.value);
    return args.selected
      ? args.ctx.theme.fg("text", display)
      : args.ctx.theme.fg(row.value ? "success" : "muted", display);
  },
  hints(row, args) {
    return (stringRenderer.hints as unknown as FieldRenderer<SecretField, string>["hints"])(row, args);
  },
  handleKey(row, data, args) {
    return handleStringLikeKey<string>(row.field.key, row.value, data, args, (buf) => buf);
  },
};

// ─────────────────────────────────────────────────────────────────────
// Number
// ─────────────────────────────────────────────────────────────────────

export const numberRenderer: FieldRenderer<NumberField, number> = {
  type: "number",
  renderValue(row, args) {
    if (args.isEditing) {
      const state = getEditState(args, row.field.key);
      if (state) {
        return args.ctx.theme.fg("accent", renderInlineEditValue(state));
      }
    }
    const text = String(row.value);
    return args.selected ? args.ctx.theme.fg("text", text) : args.ctx.theme.fg("muted", text);
  },
  hints(row, args) {
    return (stringRenderer.hints as unknown as FieldRenderer<NumberField, number>["hints"])(row, args);
  },
  handleKey(row, data, args) {
    return handleStringLikeKey<number>(row.field.key, String(row.value), data, args, (buffer) => {
      const trimmed = buffer.trim();
      if (trimmed === "") throw new Error("Expected a number");
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) throw new Error(`Not a number: '${buffer}'`);
      if (row.field.integer && !Number.isInteger(parsed)) throw new Error("Expected an integer");
      if (typeof row.field.min === "number" && parsed < row.field.min)
        throw new Error(`Must be ≥ ${row.field.min}`);
      if (typeof row.field.max === "number" && parsed > row.field.max)
        throw new Error(`Must be ≤ ${row.field.max}`);
      return parsed;
    });
  },
};

// ─────────────────────────────────────────────────────────────────────
// Shared edit-key state machine
// ─────────────────────────────────────────────────────────────────────

interface StringLikeArgs {
  isEditing: boolean;
  ctx: unknown;
  setEditing: (v: boolean) => void;
}

function handleStringLikeKey<V>(
  key: string,
  initialBuffer: string,
  data: string,
  args: StringLikeArgs,
  parse: (buffer: string) => V,
): FieldKeyResult<V> {
  if (!args.isEditing) {
    if (matchesKey(data, "enter") || matchesKey(data, "return")) {
      // Begin editing — seed the buffer from the current value.
      setEditState(args, key, { buffer: initialBuffer, cursor: initialBuffer.length });
      args.setEditing(true);
      return { consumed: true };
    }
    return {};
  }

  // Editing mode: Enter commits, Esc cancels.
  if (matchesKey(data, "enter") || matchesKey(data, "return")) {
    const state = getEditState(args, key);
    if (!state) {
      args.setEditing(false);
      return { consumed: true };
    }
    try {
      const value = parse(state.buffer);
      setEditState(args, key, undefined);
      args.setEditing(false);
      return { consumed: true, commit: value };
    } catch (error) {
      // Re-throw so the modal can surface via ctx.ui.notify; keep
      // editing mode active so the user can correct the value.
      throw error;
    }
  }
  if (matchesKey(data, "escape")) {
    setEditState(args, key, undefined);
    args.setEditing(false);
    return { consumed: true };
  }

  const state = getEditState(args, key);
  if (!state) {
    // Defensive: if the registry got out of sync, fall back to a
    // fresh buffer so the user isn't stuck in editing mode with no
    // way to type.
    setEditState(args, key, { buffer: initialBuffer, cursor: initialBuffer.length });
    return { consumed: true };
  }
  if (handleInlineEditInput(state, data)) {
    return { consumed: true };
  }
  return { consumed: true }; // swallow stray keys while editing
}
