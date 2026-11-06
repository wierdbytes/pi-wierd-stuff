/**
 * When the prompt cache of the session's current branch expires, and how long
 * it lives from a refresh, as `agent.cache_until` / `agent.cache_ttl`, so herdr
 * can show how much of a pi's cache lifetime is left.
 *
 * Same reading as pi-statusline's countdown (`statusline/cache-timer.ts`),
 * so the agent list and pi's footer agree. A cache entry's lifetime restarts
 * every time a request reads or writes it:
 *
 *   - assistant messages: `message.timestamp` is the request start, when the
 *     provider refreshes the entry;
 *   - pi's cache warming: `usage` entries with `kind: "cache_warm"`;
 *   - a real request still streaming (not persisted yet), tracked by
 *     `index.ts` from `message_start`.
 *
 * Only requests that reported cache activity (`cacheRead + cacheWrite > 0`)
 * count. The lifetime is the model's `promptCache` tier for the retention pi
 * asks for (`PI_CACHE_RETENTION`); a request that wrote 1h entries
 * (`cacheWrite1h > 0`) is known to use the long tier.
 *
 * Pure functions, plus the small poll that catches a warming refresh landing.
 */

export type CacheRetention = "short" | "long";

/** Model `promptCache` tiers in seconds (pi-ai's `ModelPromptCache`). */
export type PromptCacheTiers = Partial<Record<CacheRetention, number>>;

/** A model's prompt-cache tiers by provider and model id. */
export type PromptCacheLookup = (provider: string, modelId: string) => PromptCacheTiers | undefined;

interface UsageLike {
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
}

/** The part of a session entry this reads. */
export type CacheEntry =
  | {
      type: "message";
      message: { role: string; provider?: string; model?: string; timestamp?: number; usage?: UsageLike };
    }
  | { type: "usage"; kind: string; provider: string; model: string; timestamp: string; usage: UsageLike }
  | { type: string };

/** A real request that is still streaming. */
export interface InflightRequest {
  at: number;
  provider: string;
  model: string;
}

/** The retention pi requests by default (`PI_CACHE_RETENTION=long` ⇒ long). */
export function envRetention(env: Record<string, string | undefined> = process.env): CacheRetention {
  return env.PI_CACHE_RETENTION === "long" ? "long" : "short";
}

function ttlMs(lookup: PromptCacheLookup, provider: string, model: string, retention: CacheRetention): number | undefined {
  const seconds = lookup(provider, model)?.[retention];
  return typeof seconds === "number" && seconds > 0 ? seconds * 1000 : undefined;
}

/** The branch's cache entry: when it expires (epoch ms) and its lifetime from a refresh. */
export interface CacheWindow {
  until: number;
  ttlMs: number;
}

/**
 * The branch's cache entry; undefined when the branch never touched the
 * cache or the model's cache lifetime is unknown. An expired entry still
 * answers with its (past) expiry: readers compare with now.
 */
export function cacheWindow(
  entries: readonly CacheEntry[],
  lookup: PromptCacheLookup,
  retention: CacheRetention,
  inflight?: InflightRequest,
): CacheWindow | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as CacheEntry;
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

    if (!usage || usage.cacheRead + usage.cacheWrite <= 0 || !provider || !model) continue;
    if (typeof at !== "number" || !Number.isFinite(at)) continue;

    const tier: CacheRetention = (usage.cacheWrite1h ?? 0) > 0 ? "long" : retention;
    const ttl = ttlMs(lookup, provider, model, tier);
    if (ttl === undefined) return undefined;
    // A streaming request refreshes the entry at its start; without an entry
    // it only writes one, and its own usage tells once it lands.
    if (inflight && inflight.at > at) {
      const next = ttlMs(lookup, inflight.provider, inflight.model, tier) ?? ttl;
      return { until: inflight.at + next, ttlMs: next };
    }
    return { until: at + ttl, ttlMs: ttl };
  }
  return undefined;
}

/**
 * pi says when it is about to warm the cache (`cache_warming_decision`), not
 * when the refresh landed: its usage entry is appended a moment later. After
 * each decision this polls `check` once a second until the expiry it reports
 * moves, or `tries` run out (the warm was skipped or failed).
 */
export class WarmWatch {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly check: () => number | undefined,
    private readonly tries = 20,
    private readonly everyMs = 1000,
  ) {}

  start(): void {
    this.stop();
    const before = this.check();
    let left = this.tries;
    this.timer = setInterval(() => {
      if (this.check() !== before || --left <= 0) this.stop();
    }, this.everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
