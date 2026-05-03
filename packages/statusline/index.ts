import {
  CustomEditor,
  type EditorFactory,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
} from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { Component, EditorTheme, TUI } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { basename, dirname } from "node:path";

import { getGitStatus, invalidateGitStatus } from "./git-status.ts";

const C_RED = "\x1b[38;2;247;118;142m";
const C_YELLOW = "\x1b[38;2;224;175;104m";
const C_GREEN = "\x1b[38;2;158;206;106m";
const C_CYAN = "\x1b[38;2;125;207;255m";
const C_BLUE = "\x1b[38;2;122;162;247m";
const C_PURPLE = "\x1b[38;2;187;154;247m";
const C_PINK = "\x1b[38;2;215;135;175m";
const C_ORANGE = "\x1b[38;2;255;158;100m";
const C_GRAY = "\x1b[38;2;86;95;137m";
const C_RESET = "\x1b[0m";

const THINK_COLORS: Record<string, string> = {
  off: C_GRAY,
  minimal: C_GRAY,
  low: C_BLUE,
  medium: C_CYAN,
  high: C_ORANGE,
  xhigh: C_RED,
};

const THINK_LABELS: Record<string, string> = {
  off: "off",
  minimal: "min",
  low: "low",
  medium: "med",
  high: "high",
  xhigh: "xhigh",
};

const AUTOCOMPACT_BUFFER = 33000;
const BAR_WIDTH = 10;
const PROMPT_GLYPH = "❯";
const PROMPT_PADDING = 2;

function shortenPath(cwd: string): string {
  const segments = cwd.split("/");
  if (segments.length <= 3) return cwd;
  const n = segments.length;
  return `…/${segments[n - 3]}/${segments[n - 2]}/${segments[n - 1]}`;
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
  return `${Math.round(n / 1000000)}M`;
}

function formatCost(cost: number): string {
  return cost.toFixed(2);
}

function buildBar(pct: number, pctColor: string): string {
  const clamped = Math.max(0, Math.min(100, pct));
  let filled = Math.floor((clamped * BAR_WIDTH) / 100);
  if (filled > BAR_WIDTH) filled = BAR_WIDTH;
  if (filled < 0) filled = 0;
  const empty = BAR_WIDTH - filled;
  return `${pctColor}${"▓".repeat(filled)}${C_GRAY}${"░".repeat(empty)}${C_RESET}`;
}

function pctColorFor(pct: number): string {
  if (pct > 80) return C_RED;
  if (pct > 60) return C_YELLOW;
  return C_GREEN;
}

function shortenModelName(model: { id?: string; name?: string } | undefined): string {
  let name = model?.name || model?.id || "no-model";
  if (name.startsWith("Claude ")) name = name.slice(7);
  if (name.startsWith("anthropic/")) name = name.slice("anthropic/".length);
  return name;
}

function buildStatusLine(opts: {
  cwd: string;
  branch: string | null;
  dirty: boolean;
  current: number;
  contextWindow: number;
  cost: number;
  modelName: string;
  thinkingLevel: string;
  modelReasoning: boolean;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
}): string {
  const {
    cwd,
    branch,
    dirty,
    current,
    contextWindow,
    cost,
    modelName,
    thinkingLevel,
    modelReasoning,
    totalInput,
    totalOutput,
    totalCacheRead,
    totalCacheWrite,
  } = opts;

  const modelPart = `🤖 ${C_PINK}${modelName}${C_RESET}`;

  let thinkPart = "";
  if (modelReasoning) {
    const label = THINK_LABELS[thinkingLevel] ?? thinkingLevel;
    const color = THINK_COLORS[thinkingLevel] ?? C_GRAY;
    thinkPart = ` 🧠 ${color}${label}${C_RESET}`;
  }

  const shortDir = shortenPath(cwd);
  const dirParent = dirname(shortDir);
  const dirName = basename(shortDir) || shortDir;
  const dirPart = `${C_GRAY}${dirParent}${C_RESET}${C_PURPLE}/${dirName}${C_RESET}`;

  let gitPart = "";
  if (branch) {
    const mark = dirty ? `${C_RED}✗${C_RESET}` : `${C_GREEN}✓${C_RESET}`;
    gitPart = ` ${C_GRAY}│${C_RESET}${C_CYAN} ${branch} ${mark}`;
  }

  let contextPart = "";
  if (contextWindow > 0) {
    const threshold = Math.max(1, contextWindow - AUTOCOMPACT_BUFFER);
    let pct = Math.floor((current * 100) / threshold);
    let remaining = threshold - current;
    if (remaining < 0) {
      remaining = 0;
      pct = 100;
    }
    if (pct < 0) pct = 0;
    const color = pctColorFor(pct);
    const bar = buildBar(pct, color);
    contextPart =
      ` ${C_GRAY}│${C_RESET} ${color}${pct}%${C_RESET}: ${formatTokens(current)}` +
      `${C_GRAY}[${C_RESET}${bar}${C_GRAY}]${C_RESET}${formatTokens(remaining)}`;
  }

  let costPart = "";
  if (cost > 0) {
    costPart = ` ${C_GRAY}│ \$${formatCost(cost)}${C_RESET}`;
  }

  const tokenSegments: string[] = [];
  if (totalInput) tokenSegments.push(`↑${formatTokens(totalInput)}`);
  if (totalOutput) tokenSegments.push(`↓${formatTokens(totalOutput)}`);
  if (totalCacheRead) tokenSegments.push(`R${formatTokens(totalCacheRead)}`);
  if (totalCacheWrite) tokenSegments.push(`W${formatTokens(totalCacheWrite)}`);
  const tokensPart = tokenSegments.length
    ? ` ${C_GRAY}│ ${tokenSegments.join(" ")}${C_RESET}`
    : "";

  return `${C_GRAY}─${C_RESET} ${modelPart}${thinkPart} ${C_GRAY}│${C_RESET} ${dirPart}${gitPart}${contextPart}${costPart}${tokensPart} `;
}

function gatherStats(ctx: ExtensionContext) {
  let cost = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let lastAssistant: AssistantMessage | undefined;

  for (const e of ctx.sessionManager.getBranch()) {
    if (e.type === "message" && e.message.role === "assistant") {
      const m = e.message as AssistantMessage;
      cost += m.usage.cost.total;
      totalInput += m.usage.input;
      totalOutput += m.usage.output;
      totalCacheRead += m.usage.cacheRead;
      totalCacheWrite += m.usage.cacheWrite;
      if (
        m.usage.input + m.usage.output + m.usage.cacheRead + m.usage.cacheWrite > 0
      ) {
        lastAssistant = m;
      }
    }
  }

  return { cost, totalInput, totalOutput, totalCacheRead, totalCacheWrite, lastAssistant };
}

function renderStatusContent(pi: ExtensionAPI, ctx: ExtensionContext, width: number): string {
  const stats = gatherStats(ctx);
  const contextWindow =
    ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const current = stats.lastAssistant
    ? stats.lastAssistant.usage.input +
      stats.lastAssistant.usage.cacheRead +
      stats.lastAssistant.usage.cacheWrite
    : 0;
  const git = getGitStatus(ctx.cwd);

  const status = buildStatusLine({
    cwd: ctx.cwd,
    branch: git.branch,
    dirty: git.dirty,
    current,
    contextWindow,
    cost: stats.cost,
    modelName: shortenModelName(ctx.model),
    thinkingLevel: pi.getThinkingLevel?.() ?? "off",
    modelReasoning: ctx.model?.reasoning ?? false,
    totalInput: stats.totalInput,
    totalOutput: stats.totalOutput,
    totalCacheRead: stats.totalCacheRead,
    totalCacheWrite: stats.totalCacheWrite,
  });

  const truncated = truncateToWidth(status, width);
  const fillWidth = Math.max(0, width - visibleWidth(truncated));
  return truncated + `${C_GRAY}${"─".repeat(fillWidth)}${C_RESET}`;
}

function makeEditorFactory(
  ctx: ExtensionContext,
  setActiveTui: (tui: TUI | undefined) => void,
): EditorFactory {
  return (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
    setActiveTui(tui);

    class WierdStatuslineEditor extends CustomEditor {
      constructor() {
        super(tui, theme, keybindings, { paddingX: PROMPT_PADDING });
      }

      setPaddingX(_value: number): void {
        super.setPaddingX(PROMPT_PADDING);
      }

      render(width: number): string[] {
        const lines = super.render(width);
        if (lines.length === 0) return lines;

        const stripAnsi = (s: string) =>
          s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x07]*\x07/g, "");
        const isBorder = (s: string) => /^[─━]+\s*$/.test(s);

        if (isBorder(stripAnsi(lines[0]))) lines.shift();

        for (let i = lines.length - 1; i >= 0; i--) {
          if (isBorder(stripAnsi(lines[i]))) {
            lines.splice(i, 1);
            break;
          }
        }

        if (lines.length > 0 && lines[0].startsWith("  ")) {
          const replacement = `${C_GRAY}${PROMPT_GLYPH}${C_RESET} ` + lines[0].slice(2);
          lines[0] = truncateToWidth(replacement, width);
        }

        return lines;
      }
    }

    return new WierdStatuslineEditor();
  };
}

class EmptyFooter implements Component {
  render(): string[] {
    return [];
  }
  invalidate(): void {}
}

function hidePiFooter(ctx: ExtensionContext): void {
  ctx.ui.setFooter(() => new EmptyFooter());
}

function restorePiFooter(ctx: ExtensionContext): void {
  ctx.ui.setFooter(undefined);
}

function installStatusWidget(pi: ExtensionAPI, ctx: ExtensionContext) {
  ctx.ui.setWidget(
    "wierd-statusline",
    () => ({
      dispose() {},
      invalidate() {},
      render(width: number): string[] {
        return [renderStatusContent(pi, ctx, width)];
      },
    }),
    { placement: "aboveEditor" },
  );
}

export default function (pi: ExtensionAPI) {
  let activeTui: TUI | undefined;
  const setActiveTui = (tui: TUI | undefined) => {
    activeTui = tui;
  };

  pi.on("thinking_level_select", async () => {
    activeTui?.requestRender();
  });

  pi.on("tool_result", async () => {
    invalidateGitStatus();
    activeTui?.requestRender();
  });

  let footerHidden = true;
  let statuslineEnabled = true;

  const enableStatusline = (ctx: ExtensionContext) => {
    installStatusWidget(pi, ctx);
    ctx.ui.setEditorComponent(makeEditorFactory(ctx, setActiveTui));
    if (footerHidden) hidePiFooter(ctx);
    else restorePiFooter(ctx);
  };

  const disableStatusline = (ctx: ExtensionContext) => {
    ctx.ui.setWidget("wierd-statusline", undefined);
    ctx.ui.setEditorComponent(undefined);
    restorePiFooter(ctx);
  };

  pi.on("session_start", async (_event, ctx) => {
    if (statuslineEnabled) enableStatusline(ctx);
  });

  pi.registerCommand("wierd-status", {
    description:
      "Wierd statusline controls. Subcommands: 'on' | 'off' | 'toggle' | 'footer on|off|toggle'",
    handler: async (args, ctx) => {
      const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const cmd = tokens[0];

      if (cmd === "on" || cmd === "off" || cmd === "toggle") {
        const next = cmd === "toggle" ? !statuslineEnabled : cmd === "on";
        statuslineEnabled = next;
        if (statuslineEnabled) enableStatusline(ctx);
        else disableStatusline(ctx);
        ctx.ui.notify(`wierd statusline ${statuslineEnabled ? "enabled" : "disabled"}`, "info");
        return;
      }

      if (cmd === "footer") {
        const action = tokens[1] ?? "toggle";
        if (action === "toggle") footerHidden = !footerHidden;
        else if (action === "on") footerHidden = false;
        else if (action === "off") footerHidden = true;
        else {
          ctx.ui.notify(`Unknown footer action: ${action}`, "warning");
          return;
        }
        if (statuslineEnabled) {
          if (footerHidden) hidePiFooter(ctx);
          else restorePiFooter(ctx);
        }
        ctx.ui.notify(`pi footer ${footerHidden ? "hidden" : "shown"}`, "info");
        return;
      }

      ctx.ui.notify(
        "Usage: /wierd-status <on|off|toggle> | /wierd-status footer <on|off|toggle>",
        "info",
      );
    },
  });
}
