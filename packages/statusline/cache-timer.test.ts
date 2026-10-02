import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyInflight,
  CacheCountdownTicker,
  cacheRemainingMs,
  type CacheTimelineEntry,
  envRetention,
  findLastCacheTouch,
  formatCountdown,
  type PromptCacheLookup,
} from "./cache-timer.ts";

const T0 = Date.parse("2026-10-02T12:00:00.000Z");
const lookup: PromptCacheLookup = (provider) =>
  provider === "anthropic" ? { short: 300, long: 3600 } : undefined;

function assistant(
  at: number,
  usage: Partial<{ input: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number }>,
  provider = "anthropic",
): CacheTimelineEntry {
  return {
    type: "message",
    message: {
      role: "assistant",
      provider,
      model: "claude-opus-5-5",
      timestamp: at,
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, ...usage },
    },
  };
}

function warm(at: number, cacheRead = 50_000): CacheTimelineEntry {
  return {
    type: "usage",
    kind: "cache_warm",
    provider: "anthropic",
    model: "claude-opus-5-5",
    timestamp: new Date(at).toISOString(),
    usage: { input: 0, cacheRead, cacheWrite: 0 },
  };
}

const user: CacheTimelineEntry = { type: "message", message: { role: "user" } };

describe("findLastCacheTouch", () => {
  it("returns null when the branch never touched the cache", () => {
    expect(findLastCacheTouch([], lookup, "short")).toBeNull();
    expect(findLastCacheTouch([user, assistant(T0, { input: 500 })], lookup, "short")).toBeNull();
  });

  it("uses the latest assistant request with cache activity and the short tier", () => {
    const touch = findLastCacheTouch(
      [assistant(T0, { cacheWrite: 10_000 }), user, assistant(T0 + 60_000, { cacheRead: 10_000 }), user],
      lookup,
      "short",
    );
    expect(touch).toMatchObject({ at: T0 + 60_000, ttlMs: 300_000, retention: "short" });
  });

  it("skips later requests that did not touch the cache", () => {
    const touch = findLastCacheTouch(
      [assistant(T0, { cacheRead: 10_000 }), assistant(T0 + 5_000, { input: 300 })],
      lookup,
      "short",
    );
    expect(touch?.at).toBe(T0);
  });

  it("is refreshed by cache-warming entries", () => {
    const touch = findLastCacheTouch(
      [assistant(T0, { cacheWrite: 10_000 }), warm(T0 + 270_000), warm(T0 + 540_000)],
      lookup,
      "short",
    );
    expect(touch?.at).toBe(T0 + 540_000);
  });

  it("switches to the long tier when the request reported 1h writes", () => {
    const touch = findLastCacheTouch(
      [assistant(T0, { cacheWrite: 10_000, cacheWrite1h: 10_000 })],
      lookup,
      "short",
    );
    expect(touch).toMatchObject({ ttlMs: 3_600_000, retention: "long" });
  });

  it("honours the default retention (PI_CACHE_RETENTION=long)", () => {
    const touch = findLastCacheTouch([assistant(T0, { cacheRead: 10_000 })], lookup, "long");
    expect(touch?.ttlMs).toBe(3_600_000);
  });

  it("returns null when the model has no known cache lifetime", () => {
    expect(
      findLastCacheTouch([assistant(T0, { cacheRead: 10_000 }, "mystery")], lookup, "short"),
    ).toBeNull();
  });
});

describe("applyInflight", () => {
  const touch = { at: T0, ttlMs: 300_000, retention: "short" as const, provider: "anthropic", model: "m" };

  it("moves the refresh to a newer in-flight request", () => {
    const next = applyInflight(touch, { at: T0 + 30_000, provider: "anthropic", model: "m" }, lookup);
    expect(next?.at).toBe(T0 + 30_000);
    expect(next?.ttlMs).toBe(300_000);
  });

  it("ignores in-flight requests when nothing is cached yet", () => {
    expect(applyInflight(null, { at: T0, provider: "anthropic", model: "m" }, lookup)).toBeNull();
  });

  it("ignores in-flight requests older than the persisted touch", () => {
    expect(applyInflight(touch, { at: T0 - 1, provider: "anthropic", model: "m" }, lookup)).toBe(touch);
  });
});

describe("countdown helpers", () => {
  it("computes the remaining time and clamps at zero", () => {
    const touch = { at: T0, ttlMs: 300_000, retention: "short" as const, provider: "p", model: "m" };
    expect(cacheRemainingMs(touch, T0 + 39_000)).toBe(261_000);
    expect(cacheRemainingMs(touch, T0 + 999_000)).toBe(0);
  });

  it("formats m:ss rounding up", () => {
    expect(formatCountdown(300_000)).toBe("5:00");
    expect(formatCountdown(261_000)).toBe("4:21");
    expect(formatCountdown(260_001)).toBe("4:21");
    expect(formatCountdown(1)).toBe("0:01");
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(3_600_000)).toBe("60:00");
  });

  it("reads the retention from PI_CACHE_RETENTION", () => {
    expect(envRetention({ PI_CACHE_RETENTION: "long" })).toBe("long");
    expect(envRetention({})).toBe("short");
  });
});

describe("CacheCountdownTicker", () => {
  afterEach(() => vi.useRealTimers());

  it("ticks on the next whole-second boundary and stops at zero", () => {
    vi.useFakeTimers();
    const onTick = vi.fn();
    const ticker = new CacheCountdownTicker(onTick);
    ticker.sync(2_300);
    vi.advanceTimersByTime(299);
    expect(onTick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10);
    expect(onTick).toHaveBeenCalledTimes(1);

    ticker.sync(0);
    vi.advanceTimersByTime(5_000);
    expect(onTick).toHaveBeenCalledTimes(1);
  });

  it("does not stack timers across repeated renders", () => {
    vi.useFakeTimers();
    const onTick = vi.fn();
    const ticker = new CacheCountdownTicker(onTick);
    ticker.sync(5_000);
    ticker.sync(5_000);
    ticker.sync(4_900);
    vi.advanceTimersByTime(1_010);
    expect(onTick).toHaveBeenCalledTimes(1);
    ticker.stop();
  });
});
