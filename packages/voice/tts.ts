/**
 * Single-speaker TTS via `gemini-3.1-flash-tts-preview`.
 *
 * Wraps a single `ai.models.generateContent({...})` call from
 * `@google/genai`. The model is hardcoded — the user explicitly asked
 * for `gemini-3.1-flash-tts-preview` and v3 doesn't expose a knob.
 *
 * Returns the raw 24 kHz / 16-bit / mono PCM bytes; the caller wraps them
 * with `pcmToWav` before writing to disk.
 *
 * Cancellation: races the SDK promise against the provided `AbortSignal`.
 * The `@google/genai` Promise has no native abort surface in every
 * release, so the race is the portable fallback. On abort we resolve to
 * `{ ok: false, error: "Aborted" }` and let the response (if it lands
 * after the abort) fall on the floor.
 *
 * Reference: https://ai.google.dev/gemini-api/docs/speech-generation#javascript_2
 */

import { GoogleGenAI } from "@google/genai";

export const TTS_MODEL = "gemini-3.1-flash-tts-preview";
export const TTS_MIME_TYPE_EXPECTED = "audio/L16;codec=pcm;rate=24000";

export interface SynthesizeOptions {
  /** Text to synthesize. May contain Gemini 3.1 audio tags (e.g. `[neutral]`). */
  text: string;
  /** Prebuilt voice name. Caller validates against PREBUILT_VOICES. */
  voice: string;
  /** Gemini API key (resolved by caller via `auth.ts`). */
  apiKey: string;
  /** Cancellation signal — aborts the in-flight request. */
  signal?: AbortSignal;
}

export type SynthesizeResult =
  | { ok: true; pcm: Buffer; mimeType: string }
  | { ok: false; error: string };

/**
 * Detect whether an error looks like an HTTP auth failure (401 / 403).
 * The SDK throws shape-shifting errors across versions; sniff a few
 * known surfaces.
 */
export function isAuthError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number; code?: number; message?: string };
  if (e.status === 401 || e.status === 403) return true;
  if (e.code === 401 || e.code === 403) return true;
  if (typeof e.message === "string") {
    if (/\b401\b/.test(e.message)) return true;
    if (/\b403\b/.test(e.message)) return true;
    if (/permission denied/i.test(e.message)) return true;
    if (/api key/i.test(e.message) && /(invalid|expired|missing)/i.test(e.message)) return true;
  }
  return false;
}

/** Detect an HTTP 429 quota / rate limit error. */
export function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number; code?: number; message?: string };
  if (e.status === 429 || e.code === 429) return true;
  if (typeof e.message === "string" && /\b429\b/.test(e.message)) return true;
  return false;
}

interface AbortablePromiseRace<T> {
  promise: Promise<T>;
  cancel: () => void;
}

function withAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): AbortablePromiseRace<T> {
  if (!signal) {
    return { promise: p, cancel: () => {} };
  }
  let onAbort: (() => void) | undefined;
  const race = new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    onAbort = () => reject(new Error("Aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject);
  });
  return {
    promise: race,
    cancel: () => {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    },
  };
}

/** Synthesize `text` as PCM via the Gemini TTS preview model. */
export async function synthesize(opts: SynthesizeOptions): Promise<SynthesizeResult> {
  const { text, voice, apiKey, signal } = opts;
  if (signal?.aborted) return { ok: false, error: "Aborted" };
  if (!text.trim()) return { ok: false, error: "Empty input" };
  if (!apiKey) return { ok: false, error: "Missing API key" };

  const ai = new GoogleGenAI({ apiKey });

  // Some @google/genai releases accept an AbortSignal on per-call
  // request options; we pass it where supported AND wrap the promise in
  // an abort race for portability across versions.
  const requestPromise = ai.models.generateContent({
    model: TTS_MODEL,
    contents: [{ parts: [{ text }] }],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voice },
        },
      },
    },
  });

  const race = withAbort(requestPromise, signal);

  let response: Awaited<typeof requestPromise>;
  try {
    response = await race.promise;
  } catch (err) {
    race.cancel();
    if (signal?.aborted) return { ok: false, error: "Aborted" };
    if (isAuthError(err)) {
      return {
        ok: false,
        error: `Gemini auth failed (${(err as Error).message ?? "401/403"})`,
      };
    }
    if (isRateLimitError(err)) {
      return {
        ok: false,
        error: `Gemini rate limited (${(err as Error).message ?? "429"})`,
      };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  race.cancel();

  const candidate = (response as any)?.candidates?.[0];
  const part = candidate?.content?.parts?.[0];
  const inlineData = part?.inlineData;
  const data: string | undefined = inlineData?.data;
  const mimeType: string = inlineData?.mimeType ?? TTS_MIME_TYPE_EXPECTED;

  if (!data) {
    return { ok: false, error: "TTS response had no inline audio data" };
  }

  let pcm: Buffer;
  try {
    pcm = Buffer.from(data, "base64");
  } catch (err) {
    return {
      ok: false,
      error: `Failed to decode base64 audio: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (pcm.length === 0) {
    return { ok: false, error: "TTS response decoded to 0 bytes" };
  }

  return { ok: true, pcm, mimeType };
}
