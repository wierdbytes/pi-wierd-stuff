/**
 * Gemini API key resolution for @wierdbytes/pi-voice.
 *
 * Resolution order (first non-empty, trimmed value wins):
 *
 *   1. PI_VOICE_GEMINI_API_KEY        — package-specific override
 *   2. pi's modelRegistry → "google"  — covers a key stored in pi's
 *                                       auth.json (e.g. via `/login`
 *                                       flows that register a Google
 *                                       credential, custom-provider
 *                                       configs in models.json) AND
 *                                       the `GEMINI_API_KEY` env var
 *                                       that pi-ai falls back on.
 *   3. GOOGLE_API_KEY                 — last-resort env fallback that
 *                                       pi's registry does NOT cover
 *                                       (pi-ai only maps GEMINI_API_KEY
 *                                       to the `google` provider).
 *
 * Hot paths (chip rendering, `isExtensionActive` checks) need a sync
 * answer, but `getApiKeyForProvider` is async. We bridge with a
 * module-level cache:
 *
 *   - Sync `resolveGeminiKey()` returns the cached pi:google value when
 *     present, falling back to the env vars otherwise.
 *   - Async `refreshFromRegistry(ctx)` populates the cache from
 *     `ctx.modelRegistry.getApiKeyForProvider("google")`. Call it from
 *     every lifecycle hook / command handler that already has `ctx`
 *     (session_start, /wierd-voice subcommands, before each TTS call).
 *
 * If the cache hasn't been primed yet (boot, tests, or pi without a
 * registry), resolution falls through to direct env reads, preserving
 * the v3 behaviour of "exporting GEMINI_API_KEY mid-session starts
 * working immediately" for pure-env users.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type GeminiKeySource =
  | "PI_VOICE_GEMINI_API_KEY"
  | "pi:google"
  | "GEMINI_API_KEY"
  | "GOOGLE_API_KEY";

export interface ResolvedGeminiKey {
  key: string;
  source: GeminiKeySource;
}

let cachedRegistryKey: ResolvedGeminiKey | undefined;

/**
 * Direct env-var fallback chain. Used when the registry cache is empty
 * (no `refreshFromRegistry` has run yet) and the per-package override
 * is unset.
 */
const DIRECT_ENV_CHAIN: Array<
  Exclude<GeminiKeySource, "PI_VOICE_GEMINI_API_KEY" | "pi:google">
> = ["GEMINI_API_KEY", "GOOGLE_API_KEY"];

function readEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Synchronous resolution. Suitable for the chip-rendering paths and any
 * other code that doesn't have an `ExtensionContext` to pass.
 *
 * The pi-registry credential is consulted via the cache populated by
 * `refreshFromRegistry`; this stays sync by design.
 */
export function resolveGeminiKey(): ResolvedGeminiKey | undefined {
  // 1. Explicit per-package override.
  const override = readEnv("PI_VOICE_GEMINI_API_KEY");
  if (override) return { key: override, source: "PI_VOICE_GEMINI_API_KEY" };

  // 2. Cached pi:google credential (if refreshFromRegistry has run).
  if (cachedRegistryKey) return cachedRegistryKey;

  // 3. Direct env fallback — used before refreshFromRegistry runs and
  //    for the GOOGLE_API_KEY case that the registry doesn't cover.
  for (const source of DIRECT_ENV_CHAIN) {
    const value = readEnv(source);
    if (value) return { key: value, source };
  }

  return undefined;
}

/**
 * Refresh the `pi:google` cache from `ctx.modelRegistry`. Idempotent
 * and safe to call from multiple hooks; a single call usually suffices
 * but doing it on every command keeps the chip / status output fresh
 * if the user rotates their stored credential mid-session.
 *
 * If the explicit override env var is set, the cache is cleared (since
 * the override always wins) so future sync resolutions short-circuit
 * without consulting the stale cached value.
 */
export async function refreshFromRegistry(
  ctx: ExtensionContext | undefined,
): Promise<void> {
  // Override always wins; don't waste a registry call.
  if (readEnv("PI_VOICE_GEMINI_API_KEY")) {
    cachedRegistryKey = undefined;
    return;
  }

  const registry = ctx?.modelRegistry;
  if (!registry || typeof registry.getApiKeyForProvider !== "function") {
    cachedRegistryKey = undefined;
    return;
  }

  try {
    const raw = await registry.getApiKeyForProvider("google");
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed) {
        cachedRegistryKey = { key: trimmed, source: "pi:google" };
        return;
      }
    }
  } catch {
    // Registry lookup failures fall through to env-only.
  }

  cachedRegistryKey = undefined;
}

/**
 * Test-only helper — drops the cached registry value so tests can
 * exercise the sync fallback path without leaking state across cases.
 */
export function clearRegistryCache(): void {
  cachedRegistryKey = undefined;
}
