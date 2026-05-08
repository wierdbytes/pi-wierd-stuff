/**
 * @wierdbytes/pi-web extension entry point.
 *
 * Registers two tools:
 *  - `web_search`: Anthropic-server-side web_search_20250305 wrapper
 *  - `web_fetch`:  headless-Chrome fetch + trafilatura extraction + optional
 *                  pi sub-agent distillation (ported from pi-web-fetch)
 *
 * Settings persist in ~/.pi/agent/wierd-web.json (see config.ts). The
 * `/wierd-web` slash command opens an interactive settings overlay
 * (powered by `@wierdbytes/pi-common`); imperative `status` and `reset`
 * remain as text-mode subcommands for non-interactive sessions and
 * scripts.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { openSettingsModal, type Field } from "@wierdbytes/pi-common";
import {
  envDefaults,
  getConfigPath,
  loadOrInitConfig,
  saveConfig,
  type WierdWebConfig,
} from "./config.ts";
import { createWebSearchTool } from "./search.ts";
import { createWebFetchTool, shutdownWebFetch, startCacheCleanup } from "./fetch.ts";
import { detectPythonRunner } from "./extract.ts";

function describeAuthSource(): string {
  if (process.env.PI_WIERD_WEB_API_KEY) return "PI_WIERD_WEB_API_KEY env";
  if (process.env.ANTHROPIC_API_KEY) return "ANTHROPIC_API_KEY env (fallback)";
  return "modelRegistry / auth.json";
}

/**
 * The `searchModel` value on disk is a bare Anthropic id like
 * `claude-haiku-4-5` (no provider prefix), but the modal's `model` field
 * stores `<provider>/<id>`. These two helpers bridge the formats so the
 * field round-trips cleanly.
 */
function searchIdToFieldId(bareId: string): string {
  if (!bareId) return "";
  return bareId.includes("/") ? bareId : `anthropic/${bareId}`;
}

function fieldIdToSearchId(fieldId: string): string {
  if (!fieldId) return "";
  // Strip the `anthropic/` prefix so disk format stays unchanged.
  return fieldId.startsWith("anthropic/") ? fieldId.slice("anthropic/".length) : fieldId;
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

  function persist(ctx?: ExtensionContext): void {
    try {
      saveConfig(config);
    } catch (err) {
      const message = `@wierdbytes/pi-web: failed to save config to ${getConfigPath()}: ${
        err instanceof Error ? err.message : String(err)
      }`;
      if (ctx?.hasUI) ctx.ui.notify(message, "error");
      else console.error(message);
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

  // ───────────────────────────────────────────────── slash command ────

  const showStatus = (ctx: ExtensionContext): void => {
    const lines = [
      `config: ${getConfigPath()}`,
      `search model: ${getSearchModel()}${cliSearchModelOverride ? " (CLI flag override)" : ""}`,
      `fetch model:  ${config.fetchModel ?? "(session model)"}`,
      `fetch thinking: ${config.fetchThinkingLevel ?? "(session level)"}`,
      `auth source: ${describeAuthSource()}`,
    ];
    ctx.ui.notify(lines.join("\n"), "info");
  };

  const reset = (ctx: ExtensionContext): void => {
    config = envDefaults();
    cliSearchModelOverride = undefined;
    persist(ctx);
    ctx.ui.notify(
      `@wierdbytes/pi-web reset (search model: ${config.searchModel}, fetch model: ${
        config.fetchModel ?? "session"
      })`,
      "info",
    );
  };

  const openConfigOverlay = async (ctx: ExtensionContext): Promise<void> => {
    if (!ctx.hasUI) {
      // Non-interactive sessions can't host the overlay. Show the same
      // text dump as `status` so callers (CI scripts, RPC mode) still see
      // the current state.
      showStatus(ctx);
      return;
    }

    const fields: Field[] = [
      {
        key: "searchModel",
        type: "model",
        label: "Search model",
        description:
          "Anthropic model used by the server-side `web_search` tool. Only Anthropic models are eligible — other providers don't expose web_search.",
        value: { id: searchIdToFieldId(getSearchModel()) },
        filter: (m) => m.provider === "anthropic",
        hideSession: true,
        hideEffort: true,
      },
      {
        key: "fetch",
        type: "model",
        label: "Fetch sub-agent",
        description:
          "Model + reasoning effort used by the `web_fetch` distillation sub-agent. Empty model means inherit the session model.",
        value: {
          id: config.fetchModel ?? "",
          thinking: config.fetchThinkingLevel as ModelThinkingLevel | undefined,
        },
      },
    ];

    await openSettingsModal(ctx, {
      title: "@wierdbytes/pi-web",
      fields,
      onChange: (key, value) => {
        if (key === "searchModel") {
          const v = value as { id: string };
          const nextId = fieldIdToSearchId(v.id);
          if (!nextId) return; // shouldn't happen — Anthropic list is non-empty
          config = { ...config, searchModel: nextId };
          cliSearchModelOverride = undefined;
          persist(ctx);
          return;
        }
        if (key === "fetch") {
          const v = value as { id: string; thinking?: string };
          const next: WierdWebConfig = { ...config };
          if (!v.id) delete next.fetchModel;
          else next.fetchModel = v.id;
          if (v.thinking) next.fetchThinkingLevel = v.thinking;
          else delete next.fetchThinkingLevel;
          config = next;
          persist(ctx);
          return;
        }
      },
    });
  };

  pi.registerCommand("wierd-web", {
    description:
      "Open the @wierdbytes/pi-web settings overlay (no args). Action subcommands: status | reset",
    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim();
      const tokens = trimmed.split(/\s+/).filter(Boolean);
      const cmd = tokens[0]?.toLowerCase() ?? "";

      // Bare `/wierd-web` opens the configuration overlay (or falls back
      // to `status` when there's no UI). Other subcommands are
      // imperative actions — they stay text-only.
      if (!cmd) return openConfigOverlay(ctx);
      if (cmd === "status") return showStatus(ctx);
      if (cmd === "reset") return reset(ctx);

      ctx.ui.notify(
        "Usage: /wierd-web [status|reset]  (no args ⇒ open settings overlay)",
        "info",
      );
    },
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      // Only `status` and `reset` survive as imperative subcommands —
      // everything else lives behind the overlay now.
      const subs = ["status", "reset"];
      const tokens = prefix.split(/\s+/);
      const firstToken = tokens[0] ?? "";
      const subcommandFinished = subs.includes(firstToken) && /\s/.test(prefix);
      if (subcommandFinished) return null;
      const lc = prefix.toLowerCase();
      return subs
        .filter((s) => s.toLowerCase().startsWith(lc))
        .map((s) => ({ value: s, label: s }));
    },
  });
}
