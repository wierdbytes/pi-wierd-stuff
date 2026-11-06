/**
 * @wierdbytes/pi-autoname — names pi sessions and the terminal title with a
 * short summary from a cheap model, so herdr, tmux and terminal tabs show
 * what each pi is working on (like Claude Code and Codex do).
 *
 * Wiring only; the naming rules live in `autoname.ts`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notifyToast } from "@wierdbytes/pi-events";
import { Autonamer } from "./autoname.ts";
import { type AutonameConfig, configPath, loadConfig, saveConfig } from "./config.ts";
import { resolveModel } from "./generator.ts";
import { openAutonameSettings } from "./settings.ts";

const EVENT_SOURCE = "@wierdbytes/pi-autoname";
const SUBCOMMANDS = [
  { value: "regen", label: "regen", description: "Name this session from the conversation now" },
  { value: "status", label: "status", description: "Show the current name, model and config path" },
  { value: "on", label: "on", description: "Enable auto-naming" },
  { value: "off", label: "off", description: "Disable auto-naming" },
];

export default function piAutoname(pi: ExtensionAPI) {
  let config: AutonameConfig = loadConfig();

  const namer = new Autonamer({
    config: () => config,
    getSessionName: () => pi.getSessionName(),
    setSessionName: (name) => pi.setSessionName(name),
    appendEntry: (type, data) => pi.appendEntry(type, data),
    toast: (level, message) => notifyToast(pi, { source: EVENT_SOURCE, level, message }),
  });

  const update = (ctx: ExtensionContext, next: AutonameConfig): void => {
    config = next;
    try {
      saveConfig(config);
    } catch (err) {
      ctx.ui.notify(`autoname: failed to save ${configPath()}: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
    namer.onConfigChanged(ctx);
  };

  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig();
    namer.reset(ctx);
  });
  pi.on("session_shutdown", async () => namer.stop());
  pi.on("session_info_changed", async (event, ctx) => namer.onNameChanged(ctx, event.name));
  pi.on("agent_start", async (_event, ctx) => namer.onAgentStart(ctx));
  // Fire and forget: naming never delays the next turn.
  pi.on("agent_settled", async (_event, ctx) => void namer.onSettled(ctx));

  const showStatus = (ctx: ExtensionContext): void => {
    const s = namer.status();
    const model = resolveModel(ctx, config.model);
    const lines = [
      `name:     ${s.name ?? "(none)"}${s.name ? ` (${s.source})` : ""}${s.busy ? " · naming…" : ""}`,
      `enabled:  ${config.enabled}${s.locked ? " · locked by a manual name" : ""}${s.gaveUp ? " · gave up, /autoname regen" : ""}`,
      `apply to: ${config.target}`,
      `update:   ${config.mode}`,
      `model:    ${config.model || "(session model)"} · ${config.thinking}${model.ok ? "" : ` — ${model.error}`}`,
      `title:    ${config.titleTemplate}`,
      `config:   ${configPath()}`,
    ];
    ctx.ui.notify(lines.join("\n"), "info");
  };

  pi.registerCommand("autoname", {
    description: "Auto session name & terminal title: settings, regen, status, on, off",
    getArgumentCompletions: (prefix) => {
      const p = prefix.trim().toLowerCase();
      const items = SUBCOMMANDS.filter((c) => c.value.startsWith(p));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const cmd = (args ?? "").trim().toLowerCase();
      if (!cmd) {
        if (!ctx.hasUI || ctx.mode !== "tui") return showStatus(ctx);
        return openAutonameSettings(ctx, {
          config: () => config,
          update: (next) => update(ctx, next),
          regenerate: (c) => void namer.regenerate(c),
        });
      }
      if (cmd === "status") return showStatus(ctx);
      if (cmd === "regen") {
        await namer.regenerate(ctx);
        const name = namer.status().name;
        if (name) ctx.ui.notify(`autoname: ${name}`, "info");
        return;
      }
      if (cmd === "on" || cmd === "off") {
        update(ctx, { ...config, enabled: cmd === "on" });
        ctx.ui.notify(`autoname: ${cmd}`, "info");
        return;
      }
      ctx.ui.notify("Usage: /autoname [regen|status|on|off]  (no args ⇒ settings)", "info");
    },
  });
}
