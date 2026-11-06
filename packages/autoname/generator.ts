/**
 * The naming model call. Runs in-process through `ctx.modelRegistry`, so it
 * uses pi's configured providers and credentials (API keys and OAuth,
 * including providers registered by other extensions) without spawning a
 * sub-agent.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "./config.ts";
import type { NamingInput } from "./conversation.ts";
import { parseAnswer, systemPrompt, userPrompt } from "./prompt.ts";

export const TIMEOUT_MS = 20_000;

export type GenerateResult =
  | { ok: true; name: string } // a name, or KEEP
  | { ok: false; error: string; aborted?: boolean };

export type ModelLookup =
  | { ok: true; model: Model<Api>; label: string }
  | { ok: false; error: string };

/** Resolve `<provider>/<id>` (or `""` for the session model) to a usable model. */
export function resolveModel(ctx: ExtensionContext, id: string): ModelLookup {
  if (!id) {
    if (!ctx.model) return { ok: false, error: "no session model" };
    return { ok: true, model: ctx.model, label: `${ctx.model.provider}/${ctx.model.id}` };
  }
  const slash = id.indexOf("/");
  if (slash <= 0) return { ok: false, error: `invalid model id "${id}" (want provider/id)` };
  const model = ctx.modelRegistry.find(id.slice(0, slash), id.slice(slash + 1));
  if (!model) return { ok: false, error: `model ${id} not found` };
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) return { ok: false, error: `no credentials for ${id}` };
  return { ok: true, model, label: id };
}

export interface GenerateOptions {
  model: Model<Api>;
  thinking: ThinkingLevel;
  maxLength: number;
  input: NamingInput;
  /** Present for `auto` mode: the model may answer KEEP. */
  current?: string;
  signal: AbortSignal;
}

export async function generateName(ctx: ExtensionContext, opts: GenerateOptions): Promise<GenerateResult> {
  const signal = AbortSignal.any([opts.signal, AbortSignal.timeout(TIMEOUT_MS)]);
  const thinking = opts.model.reasoning && opts.thinking !== "off" ? opts.thinking : undefined;
  try {
    const stream = ctx.modelRegistry.streamSimple(
      opts.model,
      {
        systemPrompt: systemPrompt(opts.maxLength, opts.current),
        messages: [{ role: "user", content: userPrompt(opts.input), timestamp: Date.now() }],
      },
      {
        signal,
        maxTokens: thinking ? 4096 : 128,
        ...(thinking ? { reasoning: thinking } : {}),
      },
    );
    const message = await stream.result();
    if (message.stopReason === "aborted") {
      const timedOut = !opts.signal.aborted;
      return { ok: false, error: timedOut ? `timed out after ${TIMEOUT_MS / 1000}s` : "aborted", aborted: !timedOut };
    }
    if (message.stopReason === "error") return { ok: false, error: message.errorMessage ?? "model error" };
    const text = message.content
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text)
      .join("\n");
    const name = parseAnswer(text, opts.maxLength);
    if (!name) return { ok: false, error: "empty answer" };
    return { ok: true, name };
  } catch (err) {
    if (opts.signal.aborted) return { ok: false, error: "aborted", aborted: true };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
