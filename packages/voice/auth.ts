/**
 * Gemini API key resolution for pi-wierd-voice.
 *
 * Resolution order (first non-empty, trimmed value wins):
 *
 *   1. PI_VOICE_GEMINI_API_KEY  — package-specific override
 *   2. GEMINI_API_KEY           — Google's documented default env var
 *   3. GOOGLE_API_KEY           — broader Google AI Platform fallback
 *
 * If none is set, `resolveGeminiKey()` returns `undefined` and the
 * extension stays cold — every `agent_end` is a no-op until the user
 * exports a key (re-resolved on every call so a mid-session export
 * starts working immediately).
 *
 * v3 deliberately does NOT consult `ctx.modelRegistry` — pi-mono does
 * not yet expose a stable Google provider entry. Revisit when it does
 * (see voice-v3.md §10).
 */

export type GeminiKeySource =
  | "PI_VOICE_GEMINI_API_KEY"
  | "GEMINI_API_KEY"
  | "GOOGLE_API_KEY";

export interface ResolvedGeminiKey {
  key: string;
  source: GeminiKeySource;
}

const ENV_CHAIN: GeminiKeySource[] = [
  "PI_VOICE_GEMINI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
];

export function resolveGeminiKey(): ResolvedGeminiKey | undefined {
  for (const source of ENV_CHAIN) {
    const raw = process.env[source];
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    return { key: trimmed, source };
  }
  return undefined;
}
