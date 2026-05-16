/**
 * @wierdbytes/pi-statusline — block layout helpers.
 *
 * Pure functional helpers for manipulating the `LayoutConfig` order +
 * enabled slices. The original file shipped a `createBlockListEditor`
 * Component too, but the Layout tab now uses one row per block plus a
 * per-block sub-menu (see `block-settings-submenu.ts`), so the
 * Component has been removed. The helpers stay here because:
 *
 *   - `normaliseBlockLayoutValue` defends against hand-edited
 *     `events.json` files.
 *   - `moveBlock` / `toggleBlock` / `defaultBlockLayoutValue` are
 *     small and pure; they're imported by the unit tests and by the
 *     imperative `/statusline layout` dispatcher in `index.ts`.
 *
 * The filename is kept stable to avoid spurious diff churn for
 * package consumers.
 */

import { type BlockId, KNOWN_BLOCK_IDS } from "./blocks.ts";
import { cloneDefaultLayout } from "./layout-config.ts";

/** Subset of `LayoutConfig` covered by the helpers in this file. */
export interface BlockLayoutValue {
  order: BlockId[];
  enabled: Record<BlockId, boolean>;
}

/**
 * Swap the entry at `index` with its neighbour. `direction` is `-1`
 * for "move up" and `+1` for "move down". Returns the original array
 * (defensively cloned) untouched when the move would fall off either
 * edge.
 */
export function moveBlock(
  order: readonly BlockId[],
  index: number,
  direction: -1 | 1,
): BlockId[] {
  if (index < 0 || index >= order.length) return [...order];
  const target = index + direction;
  if (target < 0 || target >= order.length) return [...order];
  const next = [...order];
  const tmp = next[index]!;
  next[index] = next[target]!;
  next[target] = tmp;
  return next;
}

/** Flip a single block's enabled flag without mutating the input. */
export function toggleBlock(
  enabled: Record<BlockId, boolean>,
  id: BlockId,
): Record<BlockId, boolean> {
  return { ...enabled, [id]: !enabled[id] };
}

/** Reset to defaults (order from `KNOWN_BLOCK_IDS`, every block enabled). */
export function defaultBlockLayoutValue(): BlockLayoutValue {
  const defaults = cloneDefaultLayout();
  return { order: defaults.order, enabled: defaults.enabled };
}

/**
 * Defensive normalisation for hand-edited JSON or external callers.
 * Drops unknown ids, appends missing known ids to the tail, and
 * defaults missing `enabled` keys to `true`.
 */
export function normaliseBlockLayoutValue(value: BlockLayoutValue): BlockLayoutValue {
  const seen = new Set<BlockId>();
  const order: BlockId[] = [];
  for (const id of value.order) {
    if (!KNOWN_BLOCK_IDS.includes(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  for (const id of KNOWN_BLOCK_IDS) {
    if (!seen.has(id)) order.push(id);
  }
  const enabled: Record<BlockId, boolean> = { ...value.enabled };
  for (const id of KNOWN_BLOCK_IDS) {
    if (typeof enabled[id] !== "boolean") enabled[id] = true;
  }
  return { order, enabled };
}
