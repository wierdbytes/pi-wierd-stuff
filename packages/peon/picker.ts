/**
 * Random sound selector with no-repeat + debounce, per the CESP spec.
 *
 * Two pieces of per-category state:
 *
 *   - `lastChosen` — index of the last sound we played, so subsequent
 *     picks exclude it (only when `>1` sound is available; otherwise
 *     we'd skip *every* play). Keeps things from sounding too repetitive.
 *   - `lastPlayedAt` — wall-clock ms of the last play, used to debounce
 *     rapid fire (default 500 ms per the spec).
 *
 * Both maps are keyed by `<packName>::<category>` so switching packs
 * mid-session doesn't accidentally suppress brand-new sounds.
 */

import type { ResolvedSound } from "./pack.ts";

export interface PickerState {
  /** Map of `pack::cat` → last index played. */
  lastChosen: Map<string, number>;
  /** Map of `pack::cat` → last play timestamp (ms). */
  lastPlayedAt: Map<string, number>;
}

export function createPickerState(): PickerState {
  return { lastChosen: new Map(), lastPlayedAt: new Map() };
}

export interface PickOptions {
  /** Minimum gap between two plays in the same category. Spec
   *  recommends 500 ms. */
  debounceMs?: number;
  /** Override the random source for tests. Must return `[0, 1)`. */
  random?: () => number;
  /** Override the clock for tests. */
  now?: () => number;
}

/**
 * Pick a sound from `candidates`, respecting no-repeat and the
 * per-category debounce.
 *
 * Returns `null` when:
 *   - `candidates` is empty (caller should skip silently);
 *   - the category was played `< debounceMs` ago (rapid-fire suppression).
 */
export function pickSound(
  state: PickerState,
  packName: string,
  category: string,
  candidates: ResolvedSound[],
  opts: PickOptions = {},
): ResolvedSound | null {
  if (candidates.length === 0) return null;
  const debounceMs = opts.debounceMs ?? 500;
  const now = opts.now ? opts.now() : Date.now();
  const random = opts.random ?? Math.random;
  const key = `${packName}::${category}`;

  const previous = state.lastPlayedAt.get(key);
  if (previous !== undefined && now - previous < debounceMs) {
    return null;
  }

  let pool = candidates;
  const lastIdx = state.lastChosen.get(key);
  if (
    candidates.length > 1 &&
    typeof lastIdx === "number" &&
    lastIdx >= 0 &&
    lastIdx < candidates.length
  ) {
    pool = candidates.filter((_, i) => i !== lastIdx);
  }

  const idx = Math.min(Math.floor(random() * pool.length), pool.length - 1);
  const chosen = pool[idx]!;
  // Update state *with the original-candidates index* so the next call
  // can correctly exclude it regardless of what `pool` looked like.
  const originalIdx = candidates.indexOf(chosen);
  state.lastChosen.set(key, originalIdx);
  state.lastPlayedAt.set(key, now);
  return chosen;
}
