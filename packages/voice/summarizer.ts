/**
 * Summarizer sub-agent for @wierdbytes/pi-voice.
 *
 * Spawns `pi --mode json -p --no-session --no-tools [--model <id>] <prompt>`
 * and parses the streaming JSON event protocol exactly the way
 * `packages/web/subagent.ts` does. Captures the final `message_end`
 * assistant text and:
 *
 *   1. Returns the literal `"SKIP"` sentinel verbatim if the model
 *      decides there's nothing to summarise — the caller skips TTS.
 *   2. Otherwise validates the model's output against the audio-tag
 *      whitelist (see tags.ts), drops bracketed tokens it doesn't know,
 *      then truncates the result so the *spoken* portion stays
 *      ≤ 220 chars (tag text doesn't count against the budget).
 *
 * Cancellation:
 *   - 30 second hard timeout (subagent stuck on a slow provider, etc.).
 *   - `signal.abort()` → SIGTERM with a 1 s SIGKILL fallback. Same shape
 *     as `web/extract.ts:killProcess` but with a tighter timeout because
 *     the summarizer is a fast turn-end pipeline, not a long fetch.
 */

import { spawn, type ChildProcess } from "node:child_process";

const SUBAGENT_TIMEOUT_MS = 30_000;
const SIGKILL_FALLBACK_MS = 1_000;
const SPOKEN_BUDGET_CHARS = 220;

import { truncateToSpokenBudget, validateTags } from "./tags.ts";

export const SUMMARIZER_PROMPT_TEMPLATE = `You are summarizing what a coding assistant just said to its user, so the
summary can be read aloud by a TTS engine. The TTS model is
Gemini 3.1 Flash TTS, which understands inline audio tags wrapped in
square brackets (e.g. [neutral], [short pause], [fast]). Use them
sparingly to make playback feel natural, not theatrical.

Rules:
- One or two sentences.
- Plain spoken language, no code, no markdown, no file paths, no bullet points.
- Use last used language on assistant output for whole reuslting summarization.
- Do not mention Assistant, just tell concrete text from first person.
- ≤ 220 characters total *excluding* audio tags (tags are free).
- If the assistant only asked a clarifying question, repeat the question briefly.
- If the assistant produced nothing meaningful, output exactly: SKIP

Audio tags (use 0–3 per output, only when they help):
- Pacing:    [slow] [fast]
- Pauses:    [short pause] [long pause] [pause=0.5]
- Tone:      [neutral] [positive] [curious] [enthusiasm] [seriousness]
             [hope] [amusement] [confusion] [frustration]
- Effects:   [whispers] [laughs]
Formula:    [pacing?] text [expressive?] text [pause?] text
Rules for tags:
- Always inside square brackets, English only, lower-case.
- Never put two tags directly next to each other; always separate by text or punctuation.
- Open the line with a tone tag when the mood matters (e.g. [neutral] for routine status, [positive] for success, [confusion] for clarifying questions).
- Don't narrate the tag ("with enthusiasm I report…") — just emit the tag.

Assistant output to summarize:
---
{TEXT}
---`;

export interface SummarizerOptions {
  /** The slice of conversation to summarise (already built by messages.ts). */
  text: string;
  /** Optional `<provider>/<id>` for `pi --model`. Unset → session model. */
  model?: string;
  /**
   * Optional reasoning effort for `pi --thinking <level>`. Same shape as
   * `packages/web/subagent.ts` — forwarded verbatim, validated by pi at
   * startup. Unset → inherit pi's default for the chosen model.
   */
  thinkingLevel?: string;
  /** AbortSignal — abort kills the subprocess. */
  signal?: AbortSignal;
}

export type SummarizerResult =
  | { ok: true; kind: "summary"; text: string; droppedTags: string[] }
  | { ok: true; kind: "skip" }
  | { ok: false; error: string };

function killProcess(proc: ChildProcess): void {
  try {
    proc.kill("SIGTERM");
  } catch {
    // already exited
  }
  setTimeout(() => {
    if (!proc.killed) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // best effort
      }
    }
  }, SIGKILL_FALLBACK_MS);
}

function buildPrompt(text: string): string {
  return SUMMARIZER_PROMPT_TEMPLATE.replace("{TEXT}", text);
}

/**
 * Run the summarizer sub-agent. Caller is responsible for short-circuiting
 * on empty `text` (selectSummaryInput already does that — empty input here
 * resolves to `{ ok: true, kind: "skip" }` defensively).
 */
export function runSummarizer(opts: SummarizerOptions): Promise<SummarizerResult> {
  const { text, model, thinkingLevel, signal } = opts;
  if (!text.trim()) {
    return Promise.resolve({ ok: true, kind: "skip" });
  }
  if (signal?.aborted) {
    return Promise.resolve({ ok: false, error: "Aborted" });
  }

  // Order matches `packages/web/subagent.ts` so logs from the two
  // sub-agents are visually consistent.
  const args = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-tools",
    ...(model ? ["--model", model] : []),
    ...(thinkingLevel ? ["--thinking", thinkingLevel] : []),
    buildPrompt(text),
  ];

  return new Promise<SummarizerResult>((resolve) => {
    const proc = spawn("pi", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buffer = "";
    let lastAssistantText = "";
    let stderr = "";
    let resolved = false;

    const settle = (value: SummarizerResult) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };

    const onAbort = () => {
      killProcess(proc);
      settle({ ok: false, error: "Aborted" });
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const timeoutHandle = setTimeout(() => {
      killProcess(proc);
      settle({ ok: false, error: `Summarizer timed out after ${SUBAGENT_TIMEOUT_MS / 1000}s` });
    }, SUBAGENT_TIMEOUT_MS);

    const processLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (event.type === "message_end" && event.message?.role === "assistant") {
          for (const part of event.message.content ?? []) {
            if (part?.type === "text" && typeof part.text === "string") {
              lastAssistantText = part.text;
            }
          }
        }
      } catch {
        // non-JSON line — ignore
      }
    };

    proc.stdout?.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("error", (err) => {
      settle({ ok: false, error: `Failed to spawn pi sub-agent: ${err.message}` });
    });

    proc.on("close", (code) => {
      if (resolved) return;
      if (buffer.trim()) processLine(buffer);

      const raw = lastAssistantText.trim();
      if (!raw) {
        if (code !== 0) {
          settle({
            ok: false,
            error: `Summarizer exited ${code}: ${stderr.trim() || "(no output)"}`,
          });
        } else {
          settle({ ok: true, kind: "skip" });
        }
        return;
      }

      // Detect the SKIP sentinel before any tag processing — the model
      // is instructed to emit it bare.
      if (raw === "SKIP" || /^SKIP[.!?]?$/i.test(raw)) {
        settle({ ok: true, kind: "skip" });
        return;
      }

      const { text: cleaned, dropped } = validateTags(raw);
      const truncated = truncateToSpokenBudget(cleaned.trim(), SPOKEN_BUDGET_CHARS);
      if (!truncated.trim()) {
        settle({ ok: true, kind: "skip" });
        return;
      }
      settle({ ok: true, kind: "summary", text: truncated, droppedTags: dropped });
    });
  });
}
