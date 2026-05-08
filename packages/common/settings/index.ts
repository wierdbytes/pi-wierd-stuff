/**
 * @wierdbytes/pi-common/settings — public entry point for the settings
 * modal feature.
 *
 * High-level: `openSettingsModal(ctx, opts)` opens a centered popup,
 * persists changes via `opts.onChange`, and resolves on close.
 *
 * Mid-level: `createSettingsModal(ctx, opts)` returns a `ctx.ui.custom`
 * factory for callers that manage their own overlay lifecycle.
 *
 * Low-level: `createSettingsModalBody`, `frame`, `inline-edit` helpers,
 * built-in `RENDERERS` map, and the full `Field` discriminated union
 * are all exported for callers building bespoke layouts on top of the
 * same primitives.
 */

export {
  createSettingsModal,
  openSettingsModal,
} from "./modal.ts";

export { createSettingsModalBody } from "./body.ts";

export {
  divider,
  formatHintLine,
  frame,
  frameContentWidth,
  pad,
  responsiveInnerRows,
  wrapLine,
  type FrameOptions,
  type KeyHint,
} from "./frame.ts";

export {
  clampInlineCursor,
  handleInlineEditInput,
  insertInlineText,
  renderInlineEditValue,
  type InlineEditState,
} from "./inline-edit.ts";

export { RENDERERS } from "./fields/index.ts";

export type {
  ActionField,
  BooleanField,
  CustomField,
  CustomFieldRenderArgs,
  CustomFieldSubmenuArgs,
  EnumField,
  Field,
  FieldBase,
  FieldKeyHint,
  FieldKeyResult,
  FieldRenderContext,
  FieldRenderer,
  FieldRow,
  ModelField,
  ModelOption,
  ModelValue,
  NumberField,
  PathField,
  SecretField,
  SettingsModalFactory,
  SettingsModalOptions,
  SettingsTheme,
  StringField,
  SubmenuFactory,
  Tab,
  ValueOfField,
} from "./types.ts";
