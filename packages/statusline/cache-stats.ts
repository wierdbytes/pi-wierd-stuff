/**
 * @wierdbytes/pi-statusline — prompt-cache efficiency math.
 *
 * Feeds the `cache` block: cumulative cache hit rate and the money
 * saved (or overspent) by prompt caching across the current session
 * branch.
 *
 * Per assistant message (pi normalises `usage.input` to exclude cached
 * tokens on every provider):
 *
 *   T       = input + cacheRead + cacheWrite        (whole prompt)
 *   actual  = cost.input + cost.cacheRead + cost.cacheWrite
 *   nocache = T · p_in
 *   Δ       = actual − nocache                      (< 0 ⇒ saving)
 *
 * `actual` comes straight from pi-ai's `calculateCost`, which already
 * prices 5m vs 1h cache writes (`usage.cacheWrite1h` at 2× input) and
 * request-wide pricing tiers. Output tokens are identical in both
 * scenarios and cancel out, so they're ignored.
 *
 * pi's cache warming (`usage` entries with `kind: "cache_warm"`) only
 * exists because of caching, so its full cost (`cost.total`) is added
 * to Δ as pure overhead. Warm reads are NOT counted towards the hit
 * rate — they would inflate it without serving any real request.
 *
 * `p_in` (per-token input price) is derived from the message itself
 * (`cost.input / input`) so the hypothetical uses exactly the rate pi
 * billed that request with — including the tier. When `input` is 0 we
 * fall back to the model registry, picking the same tier
 * `calculateCost` would.
 */

/** Subset of pi-ai's `ModelCost` we need for the registry fallback. */
export interface InputPricing {
  input: number;
  tiers?: ReadonlyArray<{ input: number; inputTokensAbove: number }>;
}

/** Subset of pi-ai's `AssistantMessage` the accumulator reads. */
export interface CacheMessageLike {
  provider?: string;
  model?: string;
  usage: {
    input: number;
    cacheRead: number;
    cacheWrite: number;
    cost: { input: number; cacheRead: number; cacheWrite: number };
  };
}

/** Resolve a model's pricing by provider + model id (e.g. `ctx.modelRegistry.find`). */
export type PricingLookup = (provider: string, modelId: string) => InputPricing | undefined;

export interface CacheStats {
  /** Σ cacheRead — tokens served from cache. */
  cacheRead: number;
  /** Σ (input + cacheWrite) — tokens NOT served from cache. */
  uncached: number;
  /** Σ cacheWrite — used to detect "cache in use" when nothing was read yet. */
  cacheWrite: number;
  /** Σ cost of pi's cache-warming requests in USD (already included in `delta`). */
  warmCost: number;
  /** Σ Δ in USD across priced messages plus warming overhead. Negative = saving. `null` when nothing could be priced. */
  delta: number | null;
}

/** Subset of a `cache_warm` usage entry the accumulator reads. */
export interface CacheWarmLike {
  usage: { cost: { total: number } };
}

export const EMPTY_CACHE_STATS: CacheStats = Object.freeze({
  cacheRead: 0,
  uncached: 0,
  cacheWrite: 0,
  warmCost: 0,
  delta: null,
});

/** Per-million input price for a request of `totalInput` tokens, mirroring
 *  pi-ai's tier selection (highest matching `inputTokensAbove` wins). */
export function resolveInputRate(pricing: InputPricing, totalInput: number): number {
  let rate = pricing.input;
  let matched = -1;
  for (const tier of pricing.tiers ?? []) {
    if (totalInput > tier.inputTokensAbove && tier.inputTokensAbove > matched) {
      rate = tier.input;
      matched = tier.inputTokensAbove;
    }
  }
  return rate;
}

/** Δ (USD) for a single message, or `null` when it can't be priced. */
export function messageCacheDelta(
  message: CacheMessageLike,
  lookup?: PricingLookup,
): number | null {
  const u = message.usage;
  const total = u.input + u.cacheRead + u.cacheWrite;
  if (total <= 0) return null;

  const actual = u.cost.input + u.cost.cacheRead + u.cost.cacheWrite;
  // Provider didn't bill anything — there is nothing to compare against.
  if (!(actual > 0)) return null;

  let perToken: number | undefined;
  if (u.input > 0) {
    perToken = u.cost.input / u.input;
  } else if (lookup && message.provider && message.model) {
    const pricing = lookup(message.provider, message.model);
    if (pricing) perToken = resolveInputRate(pricing, total) / 1_000_000;
  }
  if (perToken === undefined || !Number.isFinite(perToken)) return null;

  return actual - total * perToken;
}

/** Fold every assistant message's usage (plus cache-warming overhead) into session-level cache stats. */
export function accumulateCacheStats(
  messages: Iterable<CacheMessageLike>,
  lookup?: PricingLookup,
  warms: Iterable<CacheWarmLike> = [],
): CacheStats {
  let cacheRead = 0;
  let uncached = 0;
  let cacheWrite = 0;
  let delta: number | null = null;

  for (const m of messages) {
    const u = m.usage;
    if (!u) continue;
    cacheRead += u.cacheRead;
    cacheWrite += u.cacheWrite;
    uncached += u.input + u.cacheWrite;
    const d = messageCacheDelta(m, lookup);
    if (d !== null) delta = (delta ?? 0) + d;
  }

  let warmCost = 0;
  for (const w of warms) {
    const total = w.usage?.cost?.total;
    if (typeof total === "number" && Number.isFinite(total)) warmCost += total;
  }
  if (warmCost > 0) delta = (delta ?? 0) + warmCost;

  return { cacheRead, uncached, cacheWrite, warmCost, delta };
}

/** Cache hit rate in percent (0–100), or `null` when there is no input yet. */
export function cacheHitPercent(stats: CacheStats): number | null {
  const total = stats.cacheRead + stats.uncached;
  if (total <= 0) return null;
  return (stats.cacheRead * 100) / total;
}
