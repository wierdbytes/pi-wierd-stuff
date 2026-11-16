/**
 * Wires `HcBash` into pi: the `bash` tool and `!` / `!!` commands run in
 * herdr-core terminals under pi's. The tool is drawn in pi-facelift's frame
 * (shared through pi-common); `!` commands keep pi's own look.
 *
 * pi refuses to start when two extensions register the same tool at load
 * (pi-facelift registers `bash`), so the tool is registered late, at session
 * start, and only over pi's built-in one. When another extension owns `bash`,
 * the model's commands stay in pi's process (pi-herdr says so once); `!`
 * commands still run in herdr terminals.
 */

import { basename } from "node:path";
import {
  type BashOperations,
  createBashToolDefinition,
  createLocalBashOperations,
  type ExtensionAPI,
  getShellConfig,
} from "@earendil-works/pi-coding-agent";
import { createBashRenderers } from "@wierdbytes/pi-common/tool-frame/bash";
import { type BashSource, HcBash } from "./bash.ts";
import type { HcTarget } from "./hc.ts";

interface ShellSettings {
  shellPath?: string;
  shellCommandPrefix?: string;
}

export function registerHcBash(pi: ExtensionAPI, target: HcTarget): HcBash {
  const hc = new HcBash(target);
  // Read at every command: settings.json may change while pi runs.
  const shellSettings = (): ShellSettings => {
    try {
      return (pi.getSettings?.() ?? {}) as ShellSettings;
    } catch {
      return {};
    }
  };

  const operations = (source: BashSource, settings: ShellSettings): BashOperations => {
    const local = createLocalBashOperations({ shellPath: settings.shellPath });
    let shell: string;
    try {
      const config = getShellConfig(settings.shellPath);
      if (config.commandTransport === "stdin") return local;
      shell = config.shell;
    } catch {
      // A shellPath that doesn't exist: pi's own backend reports it.
      return local;
    }
    // The script around the command is bash.
    if (basename(shell) !== "bash") return local;
    return hc.operations({ shell, local, source, commandPrefix: settings.shellCommandPrefix });
  };

  pi.on("user_bash", () => ({ operations: operations("user", shellSettings()) }));

  let registered = false;
  let warned = false;
  pi.on("session_start", (_event, ctx) => {
    if (registered) return;
    let owner: { source: string; path: string } | undefined;
    try {
      owner = pi.getAllTools?.().find((tool) => tool.name === "bash")?.sourceInfo;
    } catch {
      return;
    }
    // No bash at all (`--no-builtin-tools`): nothing to run through herdr.
    if (!owner) return;
    if (owner.source !== "builtin") {
      if (!warned && ctx.hasUI) {
        warned = true;
        const fix = owner.path.includes("pi-facelift") ? " Turn bash off in /facelift → Tools and /reload to run them there." : "";
        ctx.ui.notify(
          `pi-herdr: bash comes from ${owner.path}, so the model's commands run in pi, not in herdr terminals (! commands still do).${fix}`,
          "warning",
        );
      }
      return;
    }
    registered = true;
    const cwd = process.cwd();
    pi.registerTool({
      ...createBashToolDefinition(cwd),
      ...createBashRenderers(),
      async execute(toolCallId, params, signal, onUpdate, toolCtx) {
        const settings = shellSettings();
        const tool = createBashToolDefinition(cwd, {
          operations: operations("tool", settings),
          commandPrefix: settings.shellCommandPrefix,
          shellPath: settings.shellPath,
        });
        return tool.execute(toolCallId, params, signal, onUpdate, toolCtx);
      },
    });
  });

  return hc;
}
