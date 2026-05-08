/**
 * Built-in field renderers. The modal's `RENDERERS` lookup is
 * constructed from these so user-supplied `type: "custom"` fields can
 * coexist with built-ins without any registration ceremony.
 */

import type { Field, FieldRenderer } from "../types.ts";
import { actionRenderer } from "./action.ts";
import { booleanRenderer } from "./boolean.ts";
import { customRenderer } from "./custom.ts";
import { enumRenderer } from "./enum.ts";
import { modelRenderer } from "./model.ts";
import { numberRenderer, pathRenderer, secretRenderer, stringRenderer } from "./string.ts";

export {
  actionRenderer,
  booleanRenderer,
  customRenderer,
  enumRenderer,
  modelRenderer,
  numberRenderer,
  pathRenderer,
  secretRenderer,
  stringRenderer,
};

/** Map of field discriminator → renderer. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const RENDERERS: Record<Field["type"], FieldRenderer<any, any>> = {
  boolean: booleanRenderer,
  enum: enumRenderer,
  string: stringRenderer,
  number: numberRenderer,
  secret: secretRenderer,
  path: pathRenderer,
  action: actionRenderer,
  model: modelRenderer,
  custom: customRenderer,
};
