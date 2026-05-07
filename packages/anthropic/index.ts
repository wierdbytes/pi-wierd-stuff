import { existsSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { loginAnthropic, refreshAnthropicToken } from "./auth.ts";
import { sanitizeSystemBlocksForClaudeCode } from "./prompt.ts";

function ensureClaudeCodeSymlink() {
  const target = join(homedir(), ".pi");
  const link = join(homedir(), ".Claude Code");
  if (existsSync(target) && !existsSync(link)) {
    try {
      symlinkSync(target, link);
    } catch {
      // best-effort; ignore failures (permissions, race, etc.)
    }
  }
}

/**
 * The Anthropic Messages payload shape we mutate. Only the fields we read or
 * write are typed; everything else passes through untouched.
 */
type AnthropicMessagesPayload = {
  model?: string;
  system?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  messages?: unknown[];
  [key: string]: unknown;
};

export default function (pi: ExtensionAPI) {
  ensureClaudeCodeSymlink();

  // Intentionally omit `models` and `streamSimple` so pi keeps its built-in
  // Anthropic registry AND its built-in streamer, which already handles OAuth
  // headers, the "You are Claude Code" identity block, Claude-Code tool name
  // mapping, adaptive thinking with output_config.effort for Opus 4.6/4.7 and
  // Sonnet 4.6, tool-use orphan repair and skipping aborted assistant turns.
  //
  // We layer two Claude-Code-only details on top via before_provider_request:
  //   1. Rewrite Pi-flavored paragraphs in system prompt blocks to Claude
  //      Code identity.
  //   2. Prepend the x-anthropic-billing-header system block.
  pi.registerProvider("anthropic", {
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    oauth: {
      name: "Claude Pro/Max",
      login: loginAnthropic,
      refreshToken: refreshAnthropicToken,
      getApiKey: (credentials: OAuthCredentials) => credentials.access,
    },
  });

  pi.on("before_provider_request", (event, ctx) => {
    // The hook fires for every provider. Use the model registry's typed
    // metadata as the gate instead of body-shape sniffing:
    //   - model.api === "anthropic-messages" means pi-ai is about to call
    //     the Anthropic /v1/messages endpoint (works for both `anthropic`
    //     and any future provider that reuses the Anthropic API shape).
    //   - model.provider === "anthropic" narrows further to the official
    //     anthropic.com endpoint, which is the only place the Pro/Max
    //     billing header belongs.
    const model = ctx.model;
    if (!model) return undefined;
    if (model.api !== "anthropic-messages") return undefined;
    if (model.provider !== "anthropic") return undefined;

    const payload = event.payload as AnthropicMessagesPayload | null;
    if (!payload || typeof payload !== "object") return undefined;

    // Shallow clone so we don't mutate the object pi-ai handed us.
    const next: AnthropicMessagesPayload = { ...payload };
    next.system = sanitizeSystemBlocksForClaudeCode(
      Array.isArray(next.system) ? next.system : [],
    );
    return next;
  });
}
