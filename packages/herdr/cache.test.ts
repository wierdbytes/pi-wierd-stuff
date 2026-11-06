import { afterEach, describe, expect, it, vi } from "vitest";
import { type CacheEntry, cacheWindow, envRetention, type PromptCacheLookup, WarmWatch } from "./cache.ts";

const T0 = Date.parse("2026-11-06T12:00:00.000Z");
const lookup: PromptCacheLookup = (provider) => (provider === "anthropic" ? { short: 300, long: 3600 } : undefined);

function assistant(
  at: number,
  usage: Partial<{ cacheRead: number; cacheWrite: number; cacheWrite1h: number }>,
  provider = "anthropic",
): CacheEntry {
  return {
    type: "message",
    message: { role: "assistant", provider, model: "claude-opus-5-5", timestamp: at, usage: { cacheRead: 0, cacheWrite: 0, ...usage } },
  };
}

function warm(at: number): CacheEntry {
  return {
    type: "usage",
    kind: "cache_warm",
    provider: "anthropic",
    model: "claude-opus-5-5",
    timestamp: new Date(at).toISOString(),
    usage: { cacheRead: 50_000, cacheWrite: 0 },
  };
}

const user: CacheEntry = { type: "message", message: { role: "user" } };

const until = (...args: Parameters<typeof cacheWindow>) => cacheWindow(...args)?.until;

describe("cacheWindow", () => {
  it("is unknown when the branch never touched the cache", () => {
    expect(until([], lookup, "short")).toBeUndefined();
    expect(until([user, assistant(T0, {})], lookup, "short")).toBeUndefined();
  });

  it("runs from the latest request with cache activity, on the short tier", () => {
    const entries = [assistant(T0, { cacheWrite: 10_000 }), user, assistant(T0 + 60_000, { cacheRead: 10_000 }), user];
    expect(until(entries, lookup, "short")).toBe(T0 + 60_000 + 300_000);
  });

  it("skips later requests that did not touch the cache", () => {
    expect(until([assistant(T0, { cacheRead: 1 }), assistant(T0 + 5_000, {})], lookup, "short")).toBe(T0 + 300_000);
  });

  it("is moved by cache warming", () => {
    const entries = [assistant(T0, { cacheWrite: 10_000 }), warm(T0 + 270_000), warm(T0 + 540_000)];
    expect(until(entries, lookup, "short")).toBe(T0 + 540_000 + 300_000);
  });

  it("uses the long tier when asked, or when the request wrote 1h entries", () => {
    expect(until([assistant(T0, { cacheRead: 1 })], lookup, "long")).toBe(T0 + 3_600_000);
    expect(cacheWindow([assistant(T0, { cacheWrite: 10, cacheWrite1h: 10 })], lookup, "short")).toEqual({
      until: T0 + 3_600_000,
      ttlMs: 3_600_000,
    });
  });

  it("is unknown when the model has no cache lifetime", () => {
    expect(until([assistant(T0, { cacheRead: 1 }, "opencode-go")], lookup, "short")).toBeUndefined();
  });

  it("counts a streaming request from its start, only over an existing entry", () => {
    const inflight = { at: T0 + 100_000, provider: "anthropic", model: "claude-opus-5-5" };
    expect(until([assistant(T0, { cacheRead: 1 })], lookup, "short", inflight)).toBe(T0 + 400_000);
    expect(until([user], lookup, "short", inflight)).toBeUndefined();
    // An older in-flight stamp never moves the expiry back.
    expect(until([assistant(T0, { cacheRead: 1 })], lookup, "short", { ...inflight, at: T0 - 1 })).toBe(T0 + 300_000);
  });
});

describe("envRetention", () => {
  it("is short unless PI_CACHE_RETENTION=long", () => {
    expect(envRetention({})).toBe("short");
    expect(envRetention({ PI_CACHE_RETENTION: "long" })).toBe("long");
  });
});

describe("WarmWatch", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls until the expiry moves", () => {
    vi.useFakeTimers();
    let expiry = 1;
    const check = vi.fn(() => expiry);
    const watch = new WarmWatch(check, 20, 1000);
    watch.start();
    expect(check).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(check).toHaveBeenCalledTimes(3);
    expiry = 2;
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(5000);
    expect(check).toHaveBeenCalledTimes(4);
  });

  it("gives up after its tries, and stops on demand", () => {
    vi.useFakeTimers();
    const check = vi.fn(() => 1);
    const watch = new WarmWatch(check, 3, 1000);
    watch.start();
    vi.advanceTimersByTime(10_000);
    expect(check).toHaveBeenCalledTimes(4);
    watch.start();
    watch.stop();
    vi.advanceTimersByTime(10_000);
    expect(check).toHaveBeenCalledTimes(5);
  });
});
