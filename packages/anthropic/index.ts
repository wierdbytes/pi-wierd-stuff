import { existsSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { loginAnthropic, refreshAnthropicToken } from "./auth.ts";
import { streamAnthropicOAuth } from "./stream.ts";

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

export default function (pi: ExtensionAPI) {
  ensureClaudeCodeSymlink();

  // Intentionally omit `models` so pi keeps its built-in Anthropic model
  // registry. We only attach the OAuth login flow and the custom streamer
  // that adds Claude-Code-compatible headers/betas.
  pi.registerProvider("anthropic", {
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    oauth: {
      name: "Claude Pro/Max",
      login: loginAnthropic,
      refreshToken: refreshAnthropicToken,
      getApiKey: (credentials: OAuthCredentials) => credentials.access,
    },
    streamSimple: streamAnthropicOAuth,
  });
}
