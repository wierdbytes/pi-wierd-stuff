import { describe, expect, it } from "vitest";

import {
  accumulateCacheStats,
  cacheHitPercent,
  type CacheMessageLike,
  messageCacheDelta,
  type PricingLookup,
  resolveInputRate,
} from "./cache-stats.ts";

/** Opus 5.5-like rates per million: input 4, cacheRead 0.2, cacheWrite(5m) 5, 1h = 2×input. */
const P_IN = 4;
const P_READ = 0.2;
const P_W5 = 5;

function msg(
  input: number,
  cacheRead: number,
  cacheWrite: number,
  cacheWrite1h = 0,
  extra: Partial<CacheMessageLike> = {},
): CacheMessageLike {
  const short = cacheWrite - cacheWrite1h;
  return {
    provider: "anthropic",
    model: "claude-opus-5-5",
    usage: {
      input,
      cacheRead,
      cacheWrite,
      cost: {
        input: (P_IN * input) / 1e6,
        cacheRead: (P_READ * cacheRead) / 1e6,
        cacheWrite: (P_W5 * short + P_IN * 2 * cacheWrite1h) / 1e6,
      },
    },
    ...extra,
  };
}

describe("messageCacheDelta", () => {
  it("is negative (saving) for a cache hit", () => {
    // 100k read: paid 100k·0.2, would have paid 100k·4 → Δ = −0.38
    expect(messageCacheDelta(msg(10, 100_000, 0))).toBeCloseTo(-0.38, 10);
  });

  it("charges the 5m write premium (1.25×)", () => {
    // 100k written 5m: paid 100k·5, would have paid 100k·4 → Δ = +0.10
    expect(messageCacheDelta(msg(10, 0, 100_000))).toBeCloseTo(0.1, 10);
  });

  it("charges the 1h write premium (2×)", () => {
    // 100k written 1h: paid 100k·8, would have paid 100k·4 → Δ = +0.40
    expect(messageCacheDelta(msg(10, 0, 100_000, 100_000))).toBeCloseTo(0.4, 10);
  });

  it("handles mixed 5m / 1h writes and reads", () => {
    // read 200k (−0.76) + 5m 40k (+0.04) + 1h 10k (+0.04)
    expect(messageCacheDelta(msg(5, 200_000, 50_000, 10_000))).toBeCloseTo(-0.68, 10);
  });

  it("falls back to the registry rate when input is 0", () => {
    const lookup: PricingLookup = () => ({ input: P_IN });
    expect(messageCacheDelta(msg(0, 100_000, 0), lookup)).toBeCloseTo(-0.38, 10);
  });

  it("returns null when input is 0 and the model is unknown", () => {
    expect(messageCacheDelta(msg(0, 100_000, 0))).toBeNull();
    expect(messageCacheDelta(msg(0, 100_000, 0), () => undefined)).toBeNull();
  });

  it("returns null when the provider billed nothing", () => {
    const m = msg(10, 100_000, 0);
    m.usage.cost = { input: 0, cacheRead: 0, cacheWrite: 0 };
    expect(messageCacheDelta(m)).toBeNull();
  });

  it("returns null for an empty usage record", () => {
    expect(messageCacheDelta(msg(0, 0, 0))).toBeNull();
  });
});

describe("resolveInputRate", () => {
  it("picks the highest matching tier like pi-ai's calculateCost", () => {
    const pricing = {
      input: 3,
      tiers: [
        { input: 6, inputTokensAbove: 200_000 },
        { input: 9, inputTokensAbove: 500_000 },
      ],
    };
    expect(resolveInputRate(pricing, 100_000)).toBe(3);
    expect(resolveInputRate(pricing, 200_000)).toBe(3);
    expect(resolveInputRate(pricing, 200_001)).toBe(6);
    expect(resolveInputRate(pricing, 900_000)).toBe(9);
  });
});

describe("accumulateCacheStats", () => {
  it("sums read / uncached / write and the delta across messages", () => {
    const stats = accumulateCacheStats([
      msg(4, 0, 14_000), // first turn: everything written (5m)
      msg(2, 14_000, 1_000),
      msg(2, 15_000, 800),
    ]);
    expect(stats.cacheRead).toBe(29_000);
    expect(stats.cacheWrite).toBe(15_800);
    expect(stats.uncached).toBe(4 + 14_000 + 2 + 1_000 + 2 + 800);
    // Δ = Σ R·(0.2−4) + Σ W5·(5−4), per million
    const expected = (29_000 * (P_READ - P_IN) + 15_800 * (P_W5 - P_IN)) / 1e6;
    expect(stats.delta).toBeCloseTo(expected, 10);
  });

  it("adds cache-warming cost to delta as pure overhead, not to hit rate", () => {
    const real = [msg(2, 100_000, 0)]; // Δ = −0.38
    const warm = { usage: { cost: { total: 0.02 } } };
    const stats = accumulateCacheStats(real, undefined, [warm, warm]);
    expect(stats.warmCost).toBeCloseTo(0.04, 10);
    expect(stats.delta).toBeCloseTo(-0.34, 10);
    expect(stats.cacheRead).toBe(100_000);
    expect(stats.uncached).toBe(2);
  });

  it("reports warming overhead even when no message could be priced", () => {
    const stats = accumulateCacheStats([], undefined, [{ usage: { cost: { total: 0.01 } } }]);
    expect(stats.delta).toBeCloseTo(0.01, 10);
  });

  it("returns a null delta when nothing could be priced", () => {
    const stats = accumulateCacheStats([msg(0, 500, 0)]);
    expect(stats.cacheRead).toBe(500);
    expect(stats.delta).toBeNull();
  });

  it("is empty for no messages", () => {
    expect(accumulateCacheStats([])).toEqual({
      cacheRead: 0,
      uncached: 0,
      cacheWrite: 0,
      warmCost: 0,
      delta: null,
    });
  });
});

describe("cacheHitPercent", () => {
  it("is cacheRead over the whole prompt input", () => {
    expect(cacheHitPercent({ cacheRead: 200_000, uncached: 200, cacheWrite: 150, warmCost: 0, delta: null }))
      .toBeCloseTo(99.9001, 3);
  });

  it("is null without any input", () => {
    expect(cacheHitPercent({ cacheRead: 0, uncached: 0, cacheWrite: 0, warmCost: 0, delta: null })).toBeNull();
  });
});
