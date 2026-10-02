/**
 * @wierdbytes/pi-statusline — prompt-cache expiry countdown.
 *
 * Feeds the timer segment of the `cache` block: how long until the
 * provider evicts the prompt cache entry of the current branch.
 *
 * A cache entry's lifetime restarts every time a request reads or
 * writes it. On the current branch that happens on:
 *
 *   - assistant messages (real requests) — `message.timestamp` is the
 *     request start, which is when the provider refreshes the entry;
 *   - pi's cache warming (`usage` entries with `kind: "cache_warm"`) —
 *     one-token replays pi sends shortly before expiry. Their entry
 *     timestamp is taken right after the (tiny) response, i.e. within a
 *     second or two of the refresh;
 *   - a real request that is still streaming (not persisted yet) —
 *     tracked in memory by `index.ts` via `message_start` / `message_end`.
 *
 * Only requests where the provider actually reported cache activity
 * (`cacheRead + cacheWrite > 0`) count: a prompt below the provider's
 * minimum cacheable length never creates an entry, so there is nothing
 * to count down.
 *
 * The lifetime comes from the model's `promptCache` tiers, picking the
 * retention the same way pi's cache warmer does (`PI_CACHE_RETENTION`),
 * with one improvement: a request that reported 1h cache writes
 * (`usage.cacheWrite1h > 0`) is known to use the long tier.
 */

export type CacheRetentionTier = "short" | "long";

/** Model `promptCache` tiers in seconds (pi-ai's `ModelPromptCache`). */
export type PromptCacheTiers = Partial<Record<CacheRetentionTier, number>>;

/** Resolve a model's prompt-cache tiers by provider + model id. */
export type PromptCacheLookup = (provider: string, modelId: string) => PromptCacheTiers | undefined;

interface UsageLike {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
}

/** Subset of a session entry the scanner understands. */
export type CacheTimelineEntry =
  | {
      type: "message";
      message: { role: string; provider?: string; model?: string; timestamp?: number; usage?: UsageLike };
    }
  | { type: "usage"; kind: string; provider: string; model: string; timestamp: string; usage: UsageLike }
  | { type: string };

/** Last moment the branch's cache entry was refreshed, plus its lifetime. */
export interface CacheTouch {
  /** Epoch ms of the refresh. */
  at: number;
  ttlMs: number;
  retention: CacheRetentionTier;
  provider: string;
  model: string;
}

/** A real request that is still streaming (not yet persisted). */
export interface InflightRequest {
  at: number;
  provider: string;
  model: string;
}

/** Retention tier pi requests by default (`PI_CACHE_RETENTION=long` ⇒ long). */
export function envRetention(env: Record<string, string | undefined> = process.env): CacheRetentionTier {
  return env.PI_CACHE_RETENTION === "long" ? "long" : "short";
}

function touchedCache(usage: UsageLike | undefined): usage is UsageLike {
  return !!usage && usage.cacheRead + usage.cacheWrite > 0;
}

function ttlFor(
  lookup: PromptCacheLookup,
  provider: string,
  model: string,
  retention: CacheRetentionTier,
): number | undefined {
  const seconds = lookup(provider, model)?.[retention];
  return typeof seconds === "number" && seconds > 0 ? seconds * 1000 : undefined;
}

/**
 * Walk the branch backwards and return the latest cache refresh, or
 * `null` when the cache was never touched or the model has no known
 * cache lifetime.
 */
export function findLastCacheTouch(
  entries: readonly CacheTimelineEntry[],
  lookup: PromptCacheLookup,
  defaultRetention: CacheRetentionTier,
): CacheTouch | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as CacheTimelineEntry;
    let at: number | undefined;
    let provider: string | undefined;
    let model: string | undefined;
    let usage: UsageLike | undefined;

    if (entry.type === "message" && "message" in entry && entry.message.role === "assistant") {
      ({ provider, model, usage } = entry.message);
      at = entry.message.timestamp;
    } else if (entry.type === "usage" && "kind" in entry && entry.kind === "cache_warm") {
      ({ provider, model, usage } = entry);
      at = Date.parse(entry.timestamp);
    } else {
      continue;
    }

    if (!touchedCache(usage) || !provider || !model) continue;
    if (typeof at !== "number" || !Number.isFinite(at)) continue;

    const retention: CacheRetentionTier = (usage.cacheWrite1h ?? 0) > 0 ? "long" : defaultRetention;
    const ttlMs = ttlFor(lookup, provider, model, retention);
    if (ttlMs === undefined) return null;
    return { at, ttlMs, retention, provider, model };
  }
  return null;
}

/**
 * Fold a still-streaming request into the persisted touch. A request
 * only refreshes an entry that exists, so without a prior touch the
 * in-flight request is ignored (its own usage will tell once it lands).
 */
export function applyInflight(
  touch: CacheTouch | null,
  inflight: InflightRequest | null,
  lookup: PromptCacheLookup,
): CacheTouch | null {
  if (!touch || !inflight || inflight.at <= touch.at) return touch;
  const ttlMs = ttlFor(lookup, inflight.provider, inflight.model, touch.retention) ?? touch.ttlMs;
  return { ...touch, at: inflight.at, ttlMs, provider: inflight.provider, model: inflight.model };
}

/** Milliseconds until the entry expires (never negative). */
export function cacheRemainingMs(touch: CacheTouch, now: number): number {
  return Math.max(0, touch.at + touch.ttlMs - now);
}

/** `m:ss` countdown, rounded up so `0:00` only shows once the entry is gone. */
export function formatCountdown(remainingMs: number): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Re-renders the statusline once per displayed second while a
 * countdown is running. Each tick is aligned to the next whole-second
 * boundary of the remaining time so the display never skips or
 * repeats a second. Stops on its own once the countdown hits zero.
 */
export class CacheCountdownTicker {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onTick: () => void) {}

  /** Call on every render with the current remaining time (or null when no timer is shown). */
  sync(remainingMs: number | null): void {
    if (remainingMs === null || remainingMs <= 0) {
      this.stop();
      return;
    }
    if (this.timer) return;
    const delay = (remainingMs % 1000 || 1000) + 5;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onTick();
    }, delay);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
