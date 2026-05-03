/**
 * pi-wierd-web extension entry point.
 *
 * Registers an LLM-callable web_search tool backed by Anthropic's
 * `web_search_20250305` server-side tool.
 *
 * Auth flows through ctx.modelRegistry.getApiKeyForProvider("anthropic"),
 * with PI_WIERD_WEB_API_KEY / ANTHROPIC_API_KEY as fallbacks. The tool is a
 * one-shot /v1/messages call; nothing changes the agent loop or main turn
 * stream.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createWebSearchTool } from "./search.ts";

const STATE_TYPE = "wierd-web-config";
const DEFAULT_MODEL = "claude-haiku-4-5";

interface WierdWebState {
  model: string;
}

interface WierdWebConfigEntry extends WierdWebState {}

function envDefaults(): WierdWebState {
  return {
    model: process.env.PI_WIERD_WEB_MODEL?.trim() || DEFAULT_MODEL,
  };
}

function describeAuthSource(): string {
  if (process.env.PI_WIERD_WEB_API_KEY) return "PI_WIERD_WEB_API_KEY env";
  if (process.env.ANTHROPIC_API_KEY) return "ANTHROPIC_API_KEY env (fallback)";
  return "modelRegistry / auth.json";
}

export default function piWierdWeb(pi: ExtensionAPI) {
  let state: WierdWebState = envDefaults();
  let cliModelOverride: string | undefined;

  pi.registerFlag("wierd-web-model", {
    description: "Override the Anthropic model used for web_search.",
    type: "string",
  });

  const getModel = () => cliModelOverride ?? state.model ?? DEFAULT_MODEL;

  pi.registerTool(createWebSearchTool({ getModel }));

  // Restore persisted model override from the current branch on session boot
  // and after tree navigation. Mirrors examples/extensions/tools.ts so a
  // /wierd-web model selection survives reloads/forks.
  function restoreFromBranch(ctx: ExtensionContext): void {
    const flagOverride = pi.getFlag("wierd-web-model");
    cliModelOverride = typeof flagOverride === "string" && flagOverride ? flagOverride : undefined;

    const branch = ctx.sessionManager.getBranch();
    let restored: WierdWebConfigEntry | undefined;
    for (const entry of branch) {
      if (entry.type === "custom" && entry.customType === STATE_TYPE) {
        const data = entry.data as WierdWebConfigEntry | undefined;
        if (data?.model) restored = data;
      }
    }

    state = restored ? { model: restored.model } : envDefaults();
  }

  function persist(): void {
    pi.appendEntry<WierdWebConfigEntry>(STATE_TYPE, { model: state.model });
  }

  pi.on("session_start", async (_event, ctx) => {
    restoreFromBranch(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreFromBranch(ctx);
  });

  pi.registerCommand("wierd-web", {
    description:
      "Configure pi-wierd-web. Subcommands: status | model <id> | reset",
    handler: async (args, ctx) => {
      const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const cmd = tokens[0]?.toLowerCase() ?? "status";

      if (cmd === "status") {
        const lines = [
          `model: ${getModel()}${cliModelOverride ? " (CLI flag override)" : ""}`,
          `auth source: ${describeAuthSource()}`,
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (cmd === "model") {
        const id = tokens.slice(1).join(" ").trim();
        if (!id) {
          ctx.ui.notify("Usage: /wierd-web model <model-id>", "warning");
          return;
        }
        state = { ...state, model: id };
        cliModelOverride = undefined;
        persist();
        ctx.ui.notify(`pi-wierd-web model set to ${id}`, "info");
        return;
      }

      if (cmd === "reset") {
        state = envDefaults();
        cliModelOverride = undefined;
        persist();
        ctx.ui.notify(`pi-wierd-web reset (model: ${state.model})`, "info");
        return;
      }

      ctx.ui.notify("Usage: /wierd-web <status | model <id> | reset>", "info");
    },
  });
}
