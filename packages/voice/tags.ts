/**
 * Audio-tag whitelist for `gemini-3.1-flash-tts-preview`.
 *
 * Gemini 3.1 Flash TTS recognises 200+ inline audio tags
 * (https://cloud.google.com/blog/products/ai-machine-learning/gemini-3-1-flash-tts-on-google-cloud).
 * The summarizer prompt teaches the model a curated subset to keep
 * playback expressive without going theatrical, and `validateTags()`
 * strips bracketed tokens that aren't on the whitelist before TTS so the
 * model can't smuggle in unsupported or odd tags.
 *
 * Two helpers (`stripTags`, `countCharsExcludingTags`) support the
 * 220-char post-truncation guard: we count the *spoken* portion only, so
 * a heavily tagged response isn't penalised against the budget.
 */

/**
 * Static whitelist of tags. Each entry is the bracket-inner literal —
 * the string between `[` and `]` — lower-cased. `pause=N` is special:
 * `validateTags` accepts any non-negative numeric value after `pause=`.
 */
export const AUDIO_TAGS: readonly string[] = [
  // Pacing
  "slow",
  "fast",
  // Pauses (parametric variant handled separately)
  "short pause",
  "long pause",
  // Tone
  "neutral",
  "positive",
  "curious",
  "enthusiasm",
  "seriousness",
  "hope",
  "amusement",
  "confusion",
  "frustration",
  // Effects
  "whispers",
  "laughs",
] as const;

const TAG_SET: ReadonlySet<string> = new Set(AUDIO_TAGS);
const PAUSE_PARAMETRIC = /^pause=(?:\d+(?:\.\d+)?|\.\d+)$/;

/**
 * Match any bracketed token. Greedy on inner content but disallows
 * embedded `[` / `]` so we don't accidentally swallow real prose like
 * `[brackets within brackets]` (which the model shouldn't produce
 * anyway).
 */
const BRACKET_RE = /\[([^\[\]]+)\]/g;

/** True iff `inner` (without the surrounding brackets) is a recognised tag. */
export function isKnownTag(inner: string): boolean {
  const lc = inner.trim().toLowerCase();
  if (TAG_SET.has(lc)) return true;
  if (PAUSE_PARAMETRIC.test(lc)) return true;
  return false;
}

/**
 * Remove every bracketed token from `text`, preserving the spaces around
 * it. The output is what the TTS engine would actually *speak* once tags
 * are stripped.
 */
export function stripTags(text: string): string {
  return text.replace(BRACKET_RE, "");
}

/**
 * Count characters in `text` excluding bracketed tags. Used to keep the
 * spoken portion of a tag-rich summary within the 220-char budget.
 *
 * Note: this also strips unknown bracketed tokens, matching the actual
 * pre-TTS sanitisation. It's the right metric for the "spoken length"
 * budget because the model never sees unknown tags — they're dropped
 * before synthesis.
 */
export function countCharsExcludingTags(text: string): number {
  return stripTags(text).length;
}

/**
 * Drop bracketed tokens that aren't on the whitelist, leaving recognised
 * tags in place. Whitespace around dropped tokens is collapsed so we
 * don't leave double spaces in the spoken text.
 *
 * Returns the cleaned text plus the list of dropped tokens (for logging
 * / `/voice status` debugging).
 */
export function validateTags(text: string): { text: string; dropped: string[] } {
  const dropped: string[] = [];
  const cleaned = text.replace(BRACKET_RE, (match, inner) => {
    if (isKnownTag(inner)) return match;
    dropped.push(match);
    return "";
  });
  // Collapse runs of whitespace introduced by tag removal, but leave
  // a single space between adjacent words. Don't trim — caller handles
  // leading/trailing whitespace explicitly.
  const collapsed = cleaned.replace(/[ \t]{2,}/g, " ");
  return { text: collapsed, dropped };
}

/**
 * Truncate `text` so the *spoken* portion (tags excluded) is at most
 * `maxSpokenChars` long. Cut at the last sentence boundary that fits;
 * if no sentence boundary fits, hard-cut at the character limit.
 *
 * Tags are preserved verbatim — they don't count against the budget
 * and a tag at the very end of the kept range is retained.
 */
export function truncateToSpokenBudget(text: string, maxSpokenChars: number): string {
  if (countCharsExcludingTags(text) <= maxSpokenChars) return text;

  // Walk the source text and accumulate a "spoken length" counter that
  // ignores characters inside `[...]` runs. Track the latest sentence
  // boundary (`.`, `!`, `?`) we've seen while still under budget.
  let spoken = 0;
  let inTag = false;
  let lastSentenceEnd = -1; // exclusive index in `text`
  let hardCut = -1;         // exclusive index in `text`

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inTag) {
      if (ch === "]") inTag = false;
      continue;
    }
    if (ch === "[") {
      inTag = true;
      continue;
    }

    if (spoken + 1 > maxSpokenChars) {
      hardCut = i;
      break;
    }
    spoken += 1;
    if (ch === "." || ch === "!" || ch === "?") {
      lastSentenceEnd = i + 1;
    }
  }

  if (hardCut < 0) return text; // unreachable given the early-return above

  if (lastSentenceEnd > 0) return text.slice(0, lastSentenceEnd).trimEnd();
  return text.slice(0, hardCut).trimEnd();
}
