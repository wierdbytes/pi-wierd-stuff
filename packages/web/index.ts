/**
 * pi-wierd-web extension entry point.
 *
 * Registers two tools:
 *  - `web_search`: Anthropic-server-side web_search_20250305 wrapper
 *  - `web_fetch`:  headless-Chrome fetch + trafilatura extraction + optional
 *                  pi sub-agent distillation (ported from pi-web-fetch)
 *
 * Settings persist in ~/.pi/agent/wierd-web.json (see config.ts). The
 * `/wierd-web` slash command reads/writes this file.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  envDefaults,
  getConfigPath,
  loadOrInitConfig,
  saveConfig,
  type WierdWebConfig,
} from "./config.ts";
import { createWebSearchTool } from "./search.ts";
import { createWebFetchTool } from "./fetch.ts";
import { shutdownWebFetch, startCacheCleanup } from "./fetch.ts";
import { detectPythonRunner } from "./extract.ts";

function describeAuthSource(): string {
  if (process.env.PI_WIERD_WEB_API_KEY) return "PI_WIERD_WEB_API_KEY env";
  if (process.env.ANTHROPIC_API_KEY) return "ANTHROPIC_API_KEY env (fallback)";
  return "modelRegistry / auth.json";
}

export default function piWierdWeb(pi: ExtensionAPI) {
  // Initial load — file is created on first run if missing (seeded from env).
  let config: WierdWebConfig = loadOrInitConfig();

  // CLI flag overrides (boot-time only).
  let cliSearchModelOverride: string | undefined;

  pi.registerFlag("wierd-web-model", {
    description: "Override the Anthropic model used for web_search.",
    type: "string",
  });

  const getSearchModel = (): string => cliSearchModelOverride ?? config.searchModel;
  const getFetchModel = (_ctx: ExtensionContext): string | undefined => config.fetchModel;
  const getFetchThinkingLevel = (): string | undefined => config.fetchThinkingLevel;

  pi.registerTool(createWebSearchTool({ getModel: getSearchModel }));

  pi.registerTool(
    createWebFetchTool({
      getFetchModel,
      getFetchThinkingLevel,
      getSessionThinkingLevel: () => pi.getThinkingLevel(),
    }),
  );

  function persist(): void {
    try {
      saveConfig(config);
    } catch (err) {
      // Surface to the next /wierd-web status invocation; not fatal.
      console.error(
        `pi-wierd-web: failed to save config to ${getConfigPath()}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    // Refresh from disk in case the user edited it between sessions.
    config = loadOrInitConfig();

    const flagOverride = pi.getFlag("wierd-web-model");
    cliSearchModelOverride =
      typeof flagOverride === "string" && flagOverride ? flagOverride : undefined;

    // Detect Python runner for trafilatura. Notify on failure but don't
    // block the session — web_fetch will surface a clear error if invoked.
    const runner = await detectPythonRunner(pi.exec.bind(pi));
    if (!runner) {
      ctx.ui.notify(
        "web_fetch: no Python tool runner found. Install one of: uv (recommended), pipx, or pip-run",
        "error",
      );
    }

    // Cache cleanup interval for web_fetch.
    startCacheCleanup();
  });

  pi.on("session_shutdown", async () => {
    await shutdownWebFetch();
  });

  pi.registerCommand("wierd-web", {
    description:
      "Configure pi-wierd-web. Subcommands: status | model <id> | fetch-model <id> | fetch-thinking <level> | reset",
    handler: async (args, ctx) => {
      const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const cmd = tokens[0]?.toLowerCase() ?? "status";

      if (cmd === "status") {
        const lines = [
          `config: ${getConfigPath()}`,
          `search model: ${getSearchModel()}${cliSearchModelOverride ? " (CLI flag override)" : ""}`,
          `fetch model:  ${config.fetchModel ?? "(session model)"}`,
          `fetch thinking: ${config.fetchThinkingLevel ?? "(session level)"}`,
          `auth source: ${describeAuthSource()}`,
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (cmd === "model" || cmd === "search-model") {
        const id = tokens.slice(1).join(" ").trim();
        if (!id) {
          ctx.ui.notify(`Usage: /wierd-web ${cmd} <model-id>`, "warning");
          return;
        }
        config = { ...config, searchModel: id };
        cliSearchModelOverride = undefined;
        persist();
        ctx.ui.notify(`pi-wierd-web search model set to ${id}`, "info");
        return;
      }

      if (cmd === "fetch-model") {
        const id = tokens.slice(1).join(" ").trim();
        if (!id) {
          ctx.ui.notify("Usage: /wierd-web fetch-model <provider/model-id>", "warning");
          return;
        }
        config = { ...config, fetchModel: id };
        persist();
        ctx.ui.notify(`pi-wierd-web fetch model set to ${id}`, "info");
        return;
      }

      if (cmd === "fetch-thinking") {
        const level = tokens.slice(1).join(" ").trim();
        if (!level) {
          ctx.ui.notify("Usage: /wierd-web fetch-thinking <level>", "warning");
          return;
        }
        config = { ...config, fetchThinkingLevel: level };
        persist();
        ctx.ui.notify(`pi-wierd-web fetch thinking level set to ${level}`, "info");
        return;
      }

      if (cmd === "reset") {
        config = envDefaults();
        cliSearchModelOverride = undefined;
        persist();
        ctx.ui.notify(
          `pi-wierd-web reset (search model: ${config.searchModel}, fetch model: ${config.fetchModel ?? "session"})`,
          "info",
        );
        return;
      }

      ctx.ui.notify(
        "Usage: /wierd-web <status | model <id> | fetch-model <id> | fetch-thinking <level> | reset>",
        "info",
      );
    },
  });
}
