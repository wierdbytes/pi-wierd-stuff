import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { Component, TUI, Theme } from "@mariozechner/pi-tui";
import { truncateToWidth } from "@mariozechner/pi-tui";
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
  const bar = `${pctColor}${"▓".repeat(filled)}${C_GRAY}${"░".repeat(empty)}${C_RESET}`;
  return bar;
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
  const parentPart = `${C_GRAY}${dirParent}${C_RESET}`;
  const dirPart = `${parentPart}${C_PURPLE}/${dirName}${C_RESET}`;

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

  return `${modelPart}${thinkPart} ${C_GRAY}│${C_RESET} ${dirPart}${gitPart}${contextPart}${costPart}${tokensPart}`;
}

function makeFooter(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  setActiveTui: (tui: TUI | undefined) => void,
) {
  return (tui: TUI, _theme: Theme, footerData: ReadonlyFooterDataProvider): Component & { dispose?(): void } => {
    setActiveTui(tui);
    const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

    return {
      dispose() {
        unsubBranch();
        setActiveTui(undefined);
      },
      invalidate() {},
      render(width: number): string[] {
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

        const contextWindow =
          ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow ?? 0;
        const current = lastAssistant
          ? lastAssistant.usage.input +
            lastAssistant.usage.cacheRead +
            lastAssistant.usage.cacheWrite
          : 0;

        const branch = footerData.getGitBranch();
        const git = getGitStatus(ctx.cwd);

        const line = buildStatusLine({
          cwd: ctx.cwd,
          branch: branch ?? git.branch,
          dirty: git.dirty,
          current,
          contextWindow,
          cost,
          modelName: shortenModelName(ctx.model),
          thinkingLevel: pi.getThinkingLevel?.() ?? "off",
          modelReasoning: ctx.model?.reasoning ?? false,
          totalInput,
          totalOutput,
          totalCacheRead,
          totalCacheWrite,
        });

        return [truncateToWidth(line, width)];
      },
    };
  };
}

export default function (pi: ExtensionAPI) {
  let activeTui: TUI | undefined;
  const setActiveTui = (tui: TUI | undefined) => {
    activeTui = tui;
  };

  pi.on("thinking_level_select", async () => {
    activeTui?.requestRender();
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setFooter(makeFooter(pi, ctx, setActiveTui));
  });

  pi.on("tool_result", async () => {
    invalidateGitStatus();
  });

  pi.registerCommand("statusline-off", {
    description: "Disable wierd statusline (restore default footer)",
    handler: async (_args, ctx) => {
      ctx.ui.setFooter(undefined);
      ctx.ui.notify("wierd statusline disabled", "info");
    },
  });

  pi.registerCommand("statusline-on", {
    description: "Enable wierd statusline",
    handler: async (_args, ctx) => {
      ctx.ui.setFooter(makeFooter(pi, ctx, setActiveTui));
      ctx.ui.notify("wierd statusline enabled", "info");
    },
  });
}
