/**
 * @wierdbytes/pi-statusline — forced prompt-cache warming (`/warmer`).
 *
 * pi decides each cache-warming refresh from its expected savings:
 * `p * missCost - warmCost >= $0.05`, where `p` is the chance a real
 * request arrives before the cache entry expires (1 while the agent
 * runs, 0.15 while idle). `/warmer` toggles a session-local override
 * that assumes the next request always arrives (`p = 1`) and lowers
 * the threshold to `CACHE_WARMER_MIN_SAVINGS`.
 *
 * pi's own limits still apply: warming only runs for models with a
 * known cache lifetime, idle warming needs `cacheWarming: "idle"`, and
 * pi stops after 30 minutes idle / 60 minutes streaming.
 */

import type { CacheWarmingDecisionEvent, CacheWarmingDecisionEventResult } from "@earendil-works/pi-coding-agent";

/** Minimum net savings of one refresh while forced warming is on. */
export const CACHE_WARMER_MIN_SAVINGS = 0.01;

/**
 * Forced decision for one refresh: warm when the avoided cache miss
 * exceeds the refresh cost by at least `CACHE_WARMER_MIN_SAVINGS`.
 * Returns `undefined` when forcing is off so pi's decision stands.
 */
export function forcedWarmingDecision(
  forced: boolean,
  event: Pick<CacheWarmingDecisionEvent, "missCost" | "warmCost">,
): CacheWarmingDecisionEventResult | undefined {
  if (!forced) return undefined;
  return { action: event.missCost - event.warmCost >= CACHE_WARMER_MIN_SAVINGS ? "warm" : "stop" };
}
