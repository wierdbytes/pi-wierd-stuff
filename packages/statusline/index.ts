import {
  copyToClipboard,
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";

type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { Component, EditorTheme, SelectItem, TUI } from "@earendil-works/pi-tui";
import { isKeyRelease, matchesKey, SelectList, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { NotifyLevel, NotifyStatusEvent } from "@wierdbytes/pi-events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { getGitStatus, invalidateGitStatus } from "./git-status.ts";
import {
  type EventsConfig,
  loadEventsConfig,
  setDisplayConfig,
  setLayoutConfig,
  setSubagentsConfig,
  setToastTimeout,
} from "./events-config.ts";
import {
  ICON_SET_DESCRIPTIONS,
  ICON_SET_LABELS,
  type IconSet,
  isIconSet,
  VALID_ICON_SETS,
} from "./icons.ts";
import {
  C_BLUE,
  C_GRAY,
  C_GREEN,
  C_RED,
  C_RESET,
  C_YELLOW,
  composeStatusLine,
  type BlockId,
  KNOWN_BLOCK_IDS,
  levelColor,
  levelIcon,
  oneLine,
  shortenModelName,
  type RenderInputs,
} from "./blocks.ts";
import {
  type LayoutConfig,
  SEPARATOR_LABELS,
  SEPARATOR_OPTIONS,
  type SeparatorOption,
} from "./layout-config.ts";
import { blockHasSubSettings, createBlockSettingsSubmenu } from "./block-settings-submenu.ts";
import { openSettingsModal, type Field } from "@wierdbytes/pi-common";
import { type ActiveToast, EventsTracker } from "./events-tracker.ts";
import { SubagentsTracker } from "./subagents-tracker.ts";
import { renderFixedEditorCluster } from "./fixed-editor/cluster.ts";
import { emergencyTerminalModeReset, TerminalSplitCompositor } from "./fixed-editor/terminal-split.ts";

const PROMPT_PADDING = 0;

/**
 * Render the toast row. Returns a width-padded line so it occupies a
 * full terminal row.
 *
 * Layout: `<icon> <colored source>:<reset> <title> [— <message>]`
 *   - `source` is always shown as the colored prefix so the user
 *     immediately knows which extension fired the toast.
 *   - `title` is the primary content (when present).
 *   - `message` is appended after a gray `—` separator when both are
 *     set; if `title` is omitted, `message` becomes the headline.
 *
 * The optional `×` hint is appended for sticky toasts (lifetime 0)
 * so the user knows the toast stays until dismissed.
 */
function buildToastLine(active: ActiveToast, width: number, set: IconSet): string {
  const event = active.event;
  const level = event.level ?? "info";
  const color = levelColor(level);
  const icon = event.icon || levelIcon(set, level);
  const sticky = !Number.isFinite(active.expiresAt);
  const hint = sticky ? ` ${C_GRAY}×${C_RESET}` : "";

  // Sanitize free-form payload fields before composition: a stray
  // newline would otherwise survive `truncateToWidth` and corrupt
  // the single-row toast layout. Source is also collapsed defensively
  // even though it's almost always a package name.
  const safeSource = oneLine(event.source);
  const safeTitle = event.title ? oneLine(event.title) : "";
  const safeMessage = oneLine(event.message);

  const head = `${color}${safeSource}${C_RESET}${C_GRAY}:${C_RESET}`;
  let tail: string;
  if (safeTitle && safeMessage) {
    tail = `${safeTitle} ${C_GRAY}—${C_RESET} ${safeMessage}`;
  } else if (safeTitle) {
    tail = safeTitle;
  } else {
    tail = safeMessage;
  }

  const body = `${icon} ${head} ${tail}${hint}`;
  const truncated = truncateToWidth(body, width, "…");
  const fillWidth = Math.max(0, width - visibleWidth(truncated));
  return truncated + " ".repeat(fillWidth);
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

function renderStatusContent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  width: number,
  stashCount: number,
  events: { chips: NotifyStatusEvent[]; toast: ActiveToast | null },
  iconSet: IconSet,
  layout: LayoutConfig,
): string[] {
  const stats = gatherStats(ctx);
  const contextWindow =
    ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const current = stats.lastAssistant
    ? stats.lastAssistant.usage.input +
      stats.lastAssistant.usage.cacheRead +
      stats.lastAssistant.usage.cacheWrite
    : 0;
  const git = getGitStatus(ctx.cwd);

  const model = ctx.model as Model<any> | undefined;
  const inputs: RenderInputs = {
    cwd: ctx.cwd,
    branch: git.branch,
    dirty: git.dirty,
    current,
    contextWindow,
    cost: stats.cost,
    modelName: shortenModelName(ctx.model),
    thinkingLevel: pi.getThinkingLevel?.() ?? "off",
    thinkingLevelMap: model?.thinkingLevelMap,
    modelReasoning: ctx.model?.reasoning ?? false,
    totalInput: stats.totalInput,
    totalOutput: stats.totalOutput,
    totalCacheRead: stats.totalCacheRead,
    totalCacheWrite: stats.totalCacheWrite,
    stashCount,
    chips: events.chips,
    iconSet,
    layout,
  };
  const status = composeStatusLine(layout, inputs);

  const truncated = truncateToWidth(status, width);
  const fillWidth = Math.max(0, width - visibleWidth(truncated));
  const statusLine = truncated + `${C_GRAY}${"─".repeat(fillWidth)}${C_RESET}`;

  if (events.toast) {
    return [buildToastLine(events.toast, width, iconSet), statusLine];
  }
  return [statusLine];
}

function makeEditorFactory(
  ctx: ExtensionContext,
  setActiveTui: (tui: TUI | undefined) => void,
  setCurrentEditor: (editor: any) => void,
  onEditorMounted: (editor: any) => void,
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

        return lines;
      }
    }

    const editor = new WierdStatuslineEditor();
    const originalRender = editor.render.bind(editor);
    editor.render = (width: number): string[] => {
      const lines = originalRender(width);
      onEditorMounted(editor);
      return lines;
    };
    setCurrentEditor(editor);
    return editor;
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

function installStatusWidget(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  getStashCount: () => number,
  getEventsSnapshot: () => { chips: NotifyStatusEvent[]; toast: ActiveToast | null },
  getIconSet: () => IconSet,
  getLayout: () => LayoutConfig,
) {
  ctx.ui.setWidget(
    "wierd-statusline",
    () => ({
      dispose() {},
      invalidate() {},
      render(width: number): string[] {
        return renderStatusContent(
          pi,
          ctx,
          width,
          getStashCount(),
          getEventsSnapshot(),
          getIconSet(),
          getLayout(),
        );
      },
    }),
    { placement: "aboveEditor" },
  );
}

function isStashShortcutInput(data: string): boolean {
  if (isKeyRelease(data)) return false;
  return (
    data === "ß" ||
    data === "\x1bs" ||
    data === "\x1bS" ||
    /^\x1b\[(?:83|115)(?::\d*)?(?::\d*)?;3(?::\d+)?u$/.test(data) ||
    data === "\x1b[27;3;115~" ||
    data === "\x1b[27;3;83~" ||
    matchesKey(data, "alt+s")
  );
}

function isStashHistoryShortcutInput(data: string): boolean {
  if (isKeyRelease(data)) return false;
  return (
    matchesKey(data, "ctrl+alt+s") ||
    /^\x1b\[(?:115|83)(?::\d*)?(?::\d*)?;7(?::\d+)?u$/.test(data) ||
    data === "\x1b[27;7;115~" ||
    data === "\x1b[27;7;83~"
  );
}

function hasNonWhitespaceText(text: string): boolean {
  return text.trim().length > 0;
}

const STASH_HISTORY_LIMIT = 12;
const STASH_PREVIEW_WIDTH = 72;

function getStashHistoryPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
  return join(homeDir, ".pi", "agent", "wierd-statusline", "stash-history.json");
}

function normalizeStashHistoryEntries(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const history: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    if (!hasNonWhitespaceText(entry)) continue;
    if (history[history.length - 1] === entry) continue;
    history.push(entry);
    if (history.length >= STASH_HISTORY_LIMIT) break;
  }
  return history;
}

function readPersistedStashHistory(): string[] {
  const path = getStashHistoryPath();
  try {
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return normalizeStashHistoryEntries((parsed as { history?: unknown }).history);
  } catch {
    return [];
  }
}

function persistStashHistory(history: string[]): void {
  const path = getStashHistoryPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ version: 1, history: history.slice(0, STASH_HISTORY_LIMIT) }, null, 2) + "\n",
    );
  } catch {
    // Stash history persistence is best-effort.
  }
}

function pushStashHistoryEntry(history: string[], text: string): boolean {
  if (!hasNonWhitespaceText(text)) return false;
  if (history[0] === text) return false;
  const existingIndex = history.indexOf(text);
  if (existingIndex >= 0) history.splice(existingIndex, 1);
  history.unshift(text);
  if (history.length > STASH_HISTORY_LIMIT) history.length = STASH_HISTORY_LIMIT;
  return true;
}

function buildStashPreview(text: string, maxWidth: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "(empty)";
  return truncateToWidth(compact, maxWidth, "…");
}

function overlaySelectListTheme(theme: Theme) {
  return {
    selectedPrefix: (text: string) => theme.fg("accent", text),
    selectedText: (text: string) => theme.fg("accent", text),
    description: (text: string) => theme.fg("muted", text),
    scrollInfo: (text: string) => theme.fg("dim", text),
    noMatch: (text: string) => theme.fg("warning", text),
  };
}

async function showStashHistoryOverlay(
  ctx: ExtensionContext,
  history: string[],
  onDelete: (text: string) => void,
): Promise<string | null> {
  const entries = [...history];
  const buildItems = (): SelectItem[] =>
    entries.map((entry, index) => ({
      value: String(index),
      label: `#${index + 1} ${buildStashPreview(entry, STASH_PREVIEW_WIDTH)}`,
    }));

  const selected = await ctx.ui.custom<SelectItem | null>(
    (tui, theme, _keybindings, done) => {
      const maxVisible = Math.min(Math.max(entries.length, 1), 10);
      let selectList = new SelectList(buildItems(), maxVisible, overlaySelectListTheme(theme));
      selectList.onSelect = (item) => done(item);
      selectList.onCancel = () => done(null);

      const border = (text: string) => theme.fg("dim", text);
      const wrapRow = (text: string, innerWidth: number): string =>
        `${border("│")}${truncateToWidth(text, innerWidth, "…", true)}${border("│")}`;

      const rebuild = (focusIndex: number) => {
        if (entries.length === 0) {
          done(null);
          return;
        }
        const next = new SelectList(buildItems(), Math.min(entries.length, 10), overlaySelectListTheme(theme));
        next.onSelect = (item) => done(item);
        next.onCancel = () => done(null);
        next.setSelectedIndex(Math.max(0, Math.min(focusIndex, entries.length - 1)));
        selectList = next;
        tui.requestRender();
      };

      return {
        render(width: number): string[] {
          const innerWidth = Math.max(1, width - 2);
          const lines: string[] = [];
          lines.push(border(`╭${"─".repeat(innerWidth)}╮`));
          lines.push(wrapRow(theme.fg("accent", theme.bold("Stash history")), innerWidth));
          lines.push(border(`├${"─".repeat(innerWidth)}┤`));
          for (const line of selectList.render(innerWidth)) lines.push(wrapRow(line, innerWidth));
          lines.push(border(`├${"─".repeat(innerWidth)}┤`));
          lines.push(
            wrapRow(theme.fg("dim", "↑↓ navigate • enter insert • d delete • esc cancel"), innerWidth),
          );
          lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
          return lines;
        },
        invalidate(): void {
          selectList.invalidate();
        },
        handleInput(data: string): void {
          if (data === "d" || data === "D") {
            const item = selectList.getSelectedItem();
            if (!item) return;
            const idx = Number.parseInt(item.value, 10);
            const text = entries[idx];
            if (text === undefined) return;
            entries.splice(idx, 1);
            onDelete(text);
            rebuild(idx);
            return;
          }
          selectList.handleInput(data);
          tui.requestRender();
        },
      };
    },
    {
      overlay: true,
      overlayOptions: () => ({ anchor: "center" }),
    },
  );

  if (!selected) return null;
  const i = Number.parseInt(selected.value, 10);
  return entries[i] ?? null;
}

async function insertStashHistoryEntry(ctx: ExtensionContext, selected: string): Promise<boolean> {
  const currentText = ctx.ui.getEditorText();
  if (!hasNonWhitespaceText(currentText)) {
    ctx.ui.setEditorText(selected);
    ctx.ui.notify("Inserted prompt", "info");
    return true;
  }

  const action = await ctx.ui.select("Insert prompt", ["Replace", "Append", "Cancel"]);
  if (action === "Replace") {
    ctx.ui.setEditorText(selected);
    ctx.ui.notify("Replaced editor with prompt", "info");
    return true;
  }
  if (action === "Append") {
    const separator = currentText.endsWith("\n") || selected.startsWith("\n") ? "" : "\n";
    ctx.ui.setEditorText(`${currentText}${separator}${selected}`);
    ctx.ui.notify("Appended prompt", "info");
    return true;
  }
  return false;
}

function findContainerWithChild(tui: any, child: any): { container: any; index: number } | null {
  const children = Array.isArray(tui?.children) ? tui.children : [];
  const index = children.findIndex(
    (candidate: any) => Array.isArray(candidate?.children) && candidate.children.includes(child),
  );
  if (index === -1) return null;
  return { container: children[index], index };
}

export default function (pi: ExtensionAPI) {
  let activeTui: TUI | undefined;
  const setActiveTui = (tui: TUI | undefined) => {
    activeTui = tui;
  };

  let currentEditor: any = null;
  const setCurrentEditor = (editor: any) => {
    currentEditor = editor;
  };

  const tryInstallFixedEditor = () => {
    if (!statuslineEnabled || !fixedEditorEnabled) return;
    if (fixedEditorCompositor) return;
    if (!activeTui || !currentCtx || !currentEditor) return;
    if (!findContainerWithChild(activeTui, currentEditor)) return;
    installFixedEditorCompositor(currentCtx, activeTui);
  };

  let fixedEditorCompositor: TerminalSplitCompositor | null = null;
  let fixedEditorContainer: any = null;
  let fixedStatusContainer: any = null;
  let fixedWidgetContainerAbove: any = null;
  let fixedWidgetContainerBelow: any = null;
  let fixedFooterComponent: any = null;
  let currentCtx: ExtensionContext | undefined;

  // Persistent config + the events tracker need to be initialized before
  // the session-local toggle mirrors below, since those mirrors read
  // their initial values from `eventsConfig.display`.
  let eventsConfig: EventsConfig = loadEventsConfig();

  // Session-local mirrors of the persisted display config. Initialized
  // from disk so user preferences survive a restart; mutated only via
  // applyDisplayChange() below so the persistence + side-effects stay
  // in lockstep.
  let footerHidden = eventsConfig.display.footerHidden;
  let statuslineEnabled = eventsConfig.display.statuslineEnabled;
  let fixedEditorEnabled = eventsConfig.display.fixedEditorEnabled;
  let mouseScrollEnabled = eventsConfig.display.mouseScrollEnabled;

  let stashedEditorText: string | null = null;
  let stashedPromptHistory: string[] = readPersistedStashHistory();
  let stashShortcutUnsubscribe: (() => void) | null = null;

  const getStashCount = () => stashedPromptHistory.length;

  // ───────────────────────── events tracker ─────────────────────────
  //
  // The tracker subscribes **eagerly at extension load time** — not
  // from `enableStatusline` — so we don't miss `notify:*` events that
  // sibling extensions emit from their own `session_start` handlers
  // when they happen to be loaded before us. Otherwise we'd race the
  // load order and the statusline could come up showing no chips even
  // though voice / web / etc. already announced their state.
  //
  // Rendering (`onChange → activeTui.requestRender()`) is still bound
  // to the statusline being mounted, since there's nothing to repaint
  // when the user has run `/statusline off`.

  const eventsTracker = new EventsTracker(pi, () => eventsConfig);
  eventsTracker.start();
  let eventsTrackerOff: (() => void) | null = null;

  // ───────────────────────── subagents bridge ─────────────────────────
  //
  // Same eager-subscribe rationale as `eventsTracker`: pi-subagents
  // emits `subagents:created` / `started` etc. from its own session_start
  // handler, and depending on extension load order those can fire
  // before our `session_start` hook runs. Subscribing at extension
  // load means we never miss the very first agent of a session.
  //
  // The tracker doesn't render anything itself — it re-emits
  // `notify:status` (chip) and `notify:toast` events back onto the bus,
  // and the existing `eventsTracker` above picks them up and feeds the
  // chip / toast into the statusline like any other notify-event
  // emitter.
  const subagentsTracker = new SubagentsTracker(
    pi,
    () => eventsConfig.subagents,
    () => eventsConfig.display.iconSet,
  );
  subagentsTracker.start();

  const getEventsSnapshot = () => {
    const snap = eventsTracker.getSnapshot();
    return { chips: snap.chips, toast: snap.toast };
  };

  const removeStashEntry = (text: string) => {
    const idx = stashedPromptHistory.indexOf(text);
    if (idx >= 0) {
      stashedPromptHistory.splice(idx, 1);
      persistStashHistory(stashedPromptHistory);
    }
    if (stashedEditorText === text) stashedEditorText = null;
  };

  const popLatestStash = (): string | null => {
    const text = stashedEditorText ?? stashedPromptHistory[0] ?? null;
    if (text !== null) removeStashEntry(text);
    return text;
  };

  const stashOrRestoreEditorText = (ctx: ExtensionContext) => {
    const rawText = ctx.ui.getEditorText();

    if (!hasNonWhitespaceText(rawText)) {
      const popped = popLatestStash();
      if (popped === null) {
        ctx.ui.notify("Nothing to stash", "info");
        return;
      }
      ctx.ui.setEditorText(popped);
      ctx.ui.notify("Stash restored", "info");
      activeTui?.requestRender();
      return;
    }

    const hadStash = stashedEditorText !== null;
    stashedEditorText = rawText;
    if (pushStashHistoryEntry(stashedPromptHistory, rawText)) {
      persistStashHistory(stashedPromptHistory);
    }
    ctx.ui.setEditorText("");
    ctx.ui.notify(hadStash ? "Stash updated" : "Text stashed", "info");
    activeTui?.requestRender();
  };

  const openStashHistoryPicker = async (ctx: ExtensionContext) => {
    if (stashedPromptHistory.length === 0) {
      ctx.ui.notify("No stashed prompts yet", "info");
      return;
    }
    const selected = await showStashHistoryOverlay(
      ctx,
      [...stashedPromptHistory],
      removeStashEntry,
    );
    if (selected && (await insertStashHistoryEntry(ctx, selected))) {
      removeStashEntry(selected);
    }
    activeTui?.requestRender();
  };

  function teardownFixedEditorCompositor(options?: { resetExtendedKeyboardModes?: boolean }) {
    const hadCompositor = fixedEditorCompositor !== null;
    fixedEditorCompositor?.dispose(options);
    if (!hadCompositor && options?.resetExtendedKeyboardModes) {
      try {
        process.stdout.write(emergencyTerminalModeReset());
      } catch {
        // Shutdown cleanup cannot surface useful terminal write failures.
      }
    }
    fixedEditorCompositor = null;
    fixedEditorContainer = null;
    fixedStatusContainer = null;
    fixedWidgetContainerAbove = null;
    fixedWidgetContainerBelow = null;
    fixedFooterComponent = null;
  }

  function installFixedEditorCompositor(ctx: ExtensionContext, tui: any) {
    teardownFixedEditorCompositor();

    if (!ctx.hasUI || !fixedEditorEnabled) return;
    if (!tui?.terminal || typeof tui.terminal.write !== "function") return;
    if (!currentEditor) return;

    const editorContainerMatch = findContainerWithChild(tui, currentEditor);
    if (!editorContainerMatch) return;

    const tuiChildren = Array.isArray(tui.children) ? tui.children : [];
    fixedEditorContainer = editorContainerMatch.container;
    const statusContainerCandidate = tuiChildren[editorContainerMatch.index - 2] ?? null;
    fixedStatusContainer =
      statusContainerCandidate && typeof statusContainerCandidate.render === "function"
        ? statusContainerCandidate
        : null;
    fixedWidgetContainerAbove = tuiChildren[editorContainerMatch.index - 1] ?? null;
    fixedWidgetContainerBelow = tuiChildren[editorContainerMatch.index + 1] ?? null;
    const footerCandidate = tuiChildren[editorContainerMatch.index + 2] ?? null;
    fixedFooterComponent =
      footerCandidate && typeof footerCandidate.render === "function" ? footerCandidate : null;

    const compositor: TerminalSplitCompositor = new TerminalSplitCompositor({
      tui,
      terminal: tui.terminal,
      mouseScroll: mouseScrollEnabled,
      onCopySelection: (text) => {
        void copyToClipboard(text).catch(() => {});
      },
      getShowHardwareCursor: () =>
        typeof tui.getShowHardwareCursor === "function" && tui.getShowHardwareCursor(),
      renderCluster: (width, terminalRows) => {
        const statusContainerLines = fixedStatusContainer
          ? compositor.renderHidden(fixedStatusContainer, width).filter((line) => visibleWidth(line) > 0)
          : [];
        const aboveWidgetLines = fixedWidgetContainerAbove
          ? compositor.renderHidden(fixedWidgetContainerAbove, width)
          : [];
        const belowWidgetLines = fixedWidgetContainerBelow
          ? compositor.renderHidden(fixedWidgetContainerBelow, width)
          : [];
        const footerLines = fixedFooterComponent
          ? compositor.renderHidden(fixedFooterComponent, width).filter((line) => visibleWidth(line) > 0)
          : [];
        return renderFixedEditorCluster({
          width,
          terminalRows,
          statusLines: [...statusContainerLines, ...aboveWidgetLines],
          editorLines: fixedEditorContainer ? compositor.renderHidden(fixedEditorContainer, width) : [],
          secondaryLines: [...belowWidgetLines, ...footerLines],
        });
      },
    });

    fixedEditorCompositor = compositor;
    if (fixedStatusContainer?.render) compositor.hideRenderable(fixedStatusContainer);
    if (fixedWidgetContainerAbove?.render) compositor.hideRenderable(fixedWidgetContainerAbove);
    compositor.hideRenderable(fixedEditorContainer);
    if (fixedWidgetContainerBelow?.render) compositor.hideRenderable(fixedWidgetContainerBelow);
    if (fixedFooterComponent?.render) compositor.hideRenderable(fixedFooterComponent);
    compositor.install();
    tui.requestRender(true);
  }

  pi.on("thinking_level_select", async () => {
    activeTui?.requestRender();
  });

  pi.on("tool_result", async () => {
    invalidateGitStatus();
    activeTui?.requestRender();
  });

  pi.on("session_shutdown", async () => {
    teardownFixedEditorCompositor({ resetExtendedKeyboardModes: true });
    stashShortcutUnsubscribe?.();
    stashShortcutUnsubscribe = null;
    // Drop only the render hook — do NOT dispose the events tracker.
    //
    // pi can run multiple sessions inside one extension-host process
    // (`session_shutdown` followed by another `session_start`).
    // Disposing here would tear down the bus subscription too, and a
    // subsequent session_start only re-attaches the render hook — so
    // chips and toasts would silently stop arriving for every session
    // after the first. The tracker is process-scoped on purpose; its
    // tick timer is `unref`'d so it never blocks process exit.
    eventsTrackerOff?.();
    eventsTrackerOff = null;
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    if (stashedEditorText === null) return;
    if (ctx.ui.getEditorText().trim() === "") {
      const popped = popLatestStash();
      if (popped !== null) {
        ctx.ui.setEditorText(popped);
        ctx.ui.notify("Stash restored", "info");
        activeTui?.requestRender();
      }
    } else {
      ctx.ui.notify("Stash preserved — clear editor then Alt+S to restore", "info");
    }
  });

  const enableStatusline = (ctx: ExtensionContext) => {
    currentCtx = ctx;
    installStatusWidget(
      pi,
      ctx,
      getStashCount,
      getEventsSnapshot,
      () => eventsConfig.display.iconSet,
      () => eventsConfig.layout,
    );
    ctx.ui.setEditorComponent(makeEditorFactory(ctx, setActiveTui, setCurrentEditor, tryInstallFixedEditor));
    if (footerHidden) hidePiFooter(ctx);
    else restorePiFooter(ctx);

    // The tracker is already collecting events (started eagerly at
    // extension load); here we only attach the render hook so chip /
    // toast changes repaint the statusline. Calling `requestRender()`
    // once now also flushes any state the tracker accumulated before
    // the UI was mounted.
    eventsTrackerOff?.();
    eventsTrackerOff = eventsTracker.onChange(() => {
      activeTui?.requestRender();
    });
    activeTui?.requestRender();

    stashShortcutUnsubscribe?.();
    stashShortcutUnsubscribe =
      typeof ctx.ui.onTerminalInput === "function"
        ? ctx.ui.onTerminalInput((data) => {
            if (!statuslineEnabled || !ctx.hasUI || activeTui?.hasOverlay?.()) return undefined;
            if (isStashShortcutInput(data)) {
              stashOrRestoreEditorText(ctx);
              activeTui?.requestRender();
              return { consume: true };
            }
            if (isStashHistoryShortcutInput(data)) {
              void openStashHistoryPicker(ctx);
              return { consume: true };
            }
            return undefined;
          })
        : null;
  };

  const disableStatusline = (ctx: ExtensionContext) => {
    teardownFixedEditorCompositor();
    ctx.ui.setWidget("wierd-statusline", undefined);
    ctx.ui.setEditorComponent(undefined);
    restorePiFooter(ctx);
    stashShortcutUnsubscribe?.();
    stashShortcutUnsubscribe = null;
    // Detach the render hook only; keep the tracker subscribed to the
    // bus so we don't miss events while the statusline is hidden —
    // when it comes back, the latest chip / toast state is already
    // there waiting to be rendered.
    eventsTrackerOff?.();
    eventsTrackerOff = null;
    currentEditor = null;
  };

  pi.on("session_start", async (_event, ctx) => {
    if (statuslineEnabled) enableStatusline(ctx);
  });

  // ────────────────────────── display-side-effect bus ───────────────────────
  //
  // Every Display field's `onChange` routes here so persistence + UI
  // side-effects fire together. The same code path runs for both the
  // settings modal and the imperative `on/off/toggle` subcommand.
  const applyDisplayChange = (
    ctx: ExtensionContext,
    patch: Partial<typeof eventsConfig.display>,
  ): void => {
    eventsConfig = setDisplayConfig(eventsConfig, patch);
    const next = eventsConfig.display;

    // statusline master switch flips the whole widget on or off.
    if ("statuslineEnabled" in patch && patch.statuslineEnabled !== statuslineEnabled) {
      statuslineEnabled = next.statuslineEnabled;
      if (statuslineEnabled) enableStatusline(ctx);
      else disableStatusline(ctx);
    }

    if ("footerHidden" in patch && patch.footerHidden !== footerHidden) {
      footerHidden = next.footerHidden;
      if (statuslineEnabled) {
        if (footerHidden) hidePiFooter(ctx);
        else restorePiFooter(ctx);
        // Footer toggle replaces the component in tui.children, so the
        // compositor's captured reference is stale; reinstall to capture
        // the new footer (or EmptyFooter) and render it under the editor.
        if (fixedEditorEnabled && activeTui) installFixedEditorCompositor(ctx, activeTui);
      }
    }

    if ("fixedEditorEnabled" in patch && patch.fixedEditorEnabled !== fixedEditorEnabled) {
      fixedEditorEnabled = next.fixedEditorEnabled;
      if (statuslineEnabled && activeTui) {
        if (fixedEditorEnabled) installFixedEditorCompositor(ctx, activeTui);
        else {
          teardownFixedEditorCompositor();
          activeTui.requestRender(true);
        }
      }
    }

    if ("mouseScrollEnabled" in patch && patch.mouseScrollEnabled !== mouseScrollEnabled) {
      mouseScrollEnabled = next.mouseScrollEnabled;
      // Compositor captures the flag at install time; reinstall to pick up.
      if (statuslineEnabled && fixedEditorEnabled && activeTui) {
        installFixedEditorCompositor(ctx, activeTui);
      }
    }

    // Icon set is read by the renderer + subagents tracker on every
    // paint via the closures we passed in, so persistence is enough
    // — just nudge the TUI to repaint so the new glyphs land.
    if ("iconSet" in patch) {
      activeTui?.requestRender();
    }
  };

  // Layout has no extra side-effects beyond persistence + repaint:
  // the composer reads `eventsConfig.layout` from the closure on
  // every render so a fresh paint is enough to show changes.
  const applyLayoutChange = (
    _ctx: ExtensionContext,
    patch: Partial<LayoutConfig>,
  ): void => {
    eventsConfig = setLayoutConfig(eventsConfig, patch);
    activeTui?.requestRender();
  };

  // Per-block field builder for the Layout tab.
  //
  // The Layout tab is rendered as one custom row per block, listed in
  // the snapshot order at modal-open time. The row's value cell
  // reads `eventsConfig.layout` on every paint so reorder / toggle
  // mutations from the per-block submenu show up immediately. Press
  // Enter to open the block's sub-menu — see `block-settings-submenu.ts`.

  const BLOCK_LABELS: Record<BlockId, string> = {
    model: "Model & thinking",
    path: "Working directory",
    git: "Git branch",
    context: "Context usage",
    cost: "Session cost",
    tokens: "Token counters",
    chips: "Notification chips",
    stash: "Stash count",
  };

  const BLOCK_DESCRIPTIONS: Record<BlockId, string> = {
    model: "`🤖 <model>` plus the optional inline `🧠 <level>` thinking segment. Enter to open submenu (visibility, show-thinking toggle, move actions). CLI id: `model`.",
    path: "Last three path segments of `cwd`. CLI id: `path`.",
    git: "Branch name plus a clean/dirty marker. CLI id: `git`.",
    context: "Percentage of usable context window (33k autocompact buffer reserved) with colored bar. CLI id: `context`.",
    cost: "Session total in USD when greater than zero. CLI id: `cost`.",
    tokens: "Cumulative `↑input ↓output R{cacheRead} W{cacheWrite}` counters. Enter to open submenu and toggle each one independently. CLI id: `tokens`.",
    chips: "Notify-status lane fed by `@wierdbytes/pi-events` consumers. CLI id: `chips`.",
    stash: "`📦 N` showing how many prompts are saved. CLI id: `stash`.",
  };

  /** Right-hand value cell for one block row: just the checkbox.
   *  Color of the surrounding row is driven by `field.dim` (see
   *  buildBlockField below), so the checkbox glyph itself stays
   *  uncoloured here and inherits whichever shade the modal applies. */
  const formatBlockValueCell = (id: BlockId): string => {
    return eventsConfig.layout.enabled[id] ? "[✓]" : "[ ]";
  };

  /** Build the per-block custom Field for the Layout tab. */
  const buildBlockField = (id: BlockId, ctx: ExtensionContext): Field => {
    const hasSubSettings = blockHasSubSettings(id);
    return {
      key: `layout.block.${id}`,
      type: "custom",
      tab: "layout",
      label: BLOCK_LABELS[id],
      description: BLOCK_DESCRIPTIONS[id],
      // Opt into alt+↑/alt+↓ reorder. The modal swaps rows internally
      // and fires `onReorder` so we can persist the new order.
      reorderable: true,
      // Drive the row label color from the block's visibility flag:
      // enabled ⇒ `text` (white), disabled ⇒ `muted` (gray),
      // regardless of focus state.
      dim: () => !eventsConfig.layout.enabled[id],
      // Dummy value — render() reads from eventsConfig directly so the
      // checkbox stays in sync with live state from the per-block
      // submenu / imperative `/statusline layout toggle <id>`.
      value: id,
      render: () => formatBlockValueCell(id),
      // `space` toggles visibility right here on the Layout tab.
      // Returning `true` consumes the keystroke so the modal's default
      // navigation handlers (and the custom renderer's `space-opens-
      // submenu` branch) never see it.
      handleInput: (data) => {
        if (data === " " || matchesKey(data, "space")) {
          applyLayoutChange(ctx, {
            enabled: { ...eventsConfig.layout.enabled, [id]: !eventsConfig.layout.enabled[id] },
          });
          return true;
        }
        return false;
      },
      // Footer-hint override. The default `enter edit` heuristic
      // would fire (because `handleInput` is present) and lie about
      // what Enter does — the actual binding is `space toggle` plus
      // optionally `enter settings` only for blocks that have a
      // submenu.
      hints: hasSubSettings
        ? [
            { key: "space", label: "toggle" },
            { key: "enter", label: "settings" },
          ]
        : [{ key: "space", label: "toggle" }],
      // Only blocks with at least one block-specific knob get a
      // submenu. For the rest (path, git, context, cost, chips,
      // stash) Enter is a no-op — visibility lives on `space`,
      // reorder lives on `alt+↑↓`, and there's nothing else to
      // configure.
      openSubmenu: hasSubSettings
        ? ({ theme, tui, done }) =>
            createBlockSettingsSubmenu({
              blockId: id,
              getLayout: () => eventsConfig.layout,
              title: BLOCK_LABELS[id],
              theme,
              tui,
              onChange: (patch) => applyLayoutChange(ctx, patch),
              done: () => done(),
            })
        : undefined,
    };
  };

  // ────────────────────────── settings modal ─────────────────────────────────
  //
  // Owns every persisted knob across four tabs: Display, Layout,
  // Toasts, Subagents. Imperative subcommands (`on/off/toggle`,
  // `layout ...`, `events log`, `events clear`) survive on the side
  // because they're either single-keystroke shortcuts or print-only
  // utilities.
  const openConfigOverlay = async (ctx: ExtensionContext): Promise<void> => {
    if (!ctx.hasUI) {
      // Non-interactive sessions can't host the overlay; print a
      // structured status dump so callers (RPC, --print) still see
      // the live state.
      printStatusDump(ctx);
      return;
    }

    const display = eventsConfig.display;
    const toasts = eventsConfig.toastTimeouts;
    const subagents = eventsConfig.subagents;
    const layout = eventsConfig.layout;

    const fields: Field[] = [
      // ── Display ─────────────────────────────────────────────────────
      {
        key: "statuslineEnabled",
        type: "boolean",
        tab: "display",
        label: "Statusline enabled",
        description: "Master switch for the wierd statusline widget.",
        value: display.statuslineEnabled,
      },
      {
        key: "footerHidden",
        type: "boolean",
        tab: "display",
        label: "Hide pi footer",
        description: "Hide pi's built-in footer (we render our own statusline row).",
        value: display.footerHidden,
      },
      {
        key: "fixedEditorEnabled",
        type: "boolean",
        tab: "display",
        label: "Fixed editor",
        description: "Pin the editor to the bottom of the terminal via the split compositor.",
        value: display.fixedEditorEnabled,
      },
      {
        key: "mouseScrollEnabled",
        type: "boolean",
        tab: "display",
        label: "Mouse scroll",
        description: "Let the fixed-editor compositor handle mouse-scroll events.",
        value: display.mouseScrollEnabled,
      },
      {
        key: "iconSet",
        type: "enum",
        tab: "display",
        label: "Icon set",
        description:
          "Glyphs used for model / thinking / stash / toast levels and the subagents chip. " +
          ICON_SET_DESCRIPTIONS[display.iconSet],
        value: display.iconSet,
        options: VALID_ICON_SETS,
        optionLabels: ICON_SET_LABELS,
      },
      // ── Layout (per-block rows + separator) ───────────────────────
      //
      // Each block is its own row, listed in the snapshot order at
      // modal-open time. Enter on a block opens its per-block
      // sub-menu (visibility toggle, move actions, plus the inline
      // sub-toggles for model→thinking and tokens→counters). The
      // value cell reads `eventsConfig.layout` on every render so the
      // position number (`#N`) and on/off state stay in sync with
      // live mutations.
      ...layout.order.map((id) => buildBlockField(id, ctx)),
      {
        key: "layout.separator",
        type: "enum",
        tab: "layout",
        label: "Separator",
        description:
          "Glyph rendered between visible blocks. Hand-edit `events.json` for anything outside this list.",
        // Force the row to render with the `text` (white) label color
        // so it doesn't fade into the disabled block rows above it.
        // It's a normal active setting, not a per-block visibility row.
        dim: false,
        value: (SEPARATOR_OPTIONS as readonly string[]).includes(layout.separator)
          ? (layout.separator as SeparatorOption)
          : SEPARATOR_OPTIONS[0],
        options: SEPARATOR_OPTIONS,
        optionLabels: SEPARATOR_LABELS,
      },
      // ── Toasts (per-level lifetime in ms; 0 = sticky) ──────────────
      {
        key: "toast.debug",
        type: "number",
        tab: "toasts",
        label: "Debug (ms)",
        description: "Toast lifetime for `debug`-level events. 0 means sticky-until-dismissed.",
        value: toasts.debug,
        min: 0,
        integer: true,
      },
      {
        key: "toast.info",
        type: "number",
        tab: "toasts",
        label: "Info (ms)",
        description: "Toast lifetime for `info`-level events. 0 means sticky-until-dismissed.",
        value: toasts.info,
        min: 0,
        integer: true,
      },
      {
        key: "toast.success",
        type: "number",
        tab: "toasts",
        label: "Success (ms)",
        description: "Toast lifetime for `success`-level events. 0 means sticky-until-dismissed.",
        value: toasts.success,
        min: 0,
        integer: true,
      },
      {
        key: "toast.warning",
        type: "number",
        tab: "toasts",
        label: "Warning (ms)",
        description: "Toast lifetime for `warning`-level events. 0 means sticky-until-dismissed.",
        value: toasts.warning,
        min: 0,
        integer: true,
      },
      {
        key: "toast.error",
        type: "number",
        tab: "toasts",
        label: "Error (ms)",
        description: "Toast lifetime for `error`-level events. 0 means sticky-until-dismissed (recommended).",
        value: toasts.error,
        min: 0,
        integer: true,
      },
      // ── Subagents bridge ───────────────────────────────────────────
      {
        key: "sub.enabled",
        type: "boolean",
        tab: "subagents",
        label: "Subagents bridge",
        description:
          "Master switch. When off the tracker stays subscribed but silently drops every event from pi-subagents.",
        value: subagents.enabled,
      },
      {
        key: "sub.longCompletionMs",
        type: "number",
        tab: "subagents",
        label: "Long-completion threshold (ms)",
        description:
          "Minimum duration before a successful completion produces a toast. Failures still toast regardless.",
        value: subagents.longCompletionMs,
        min: 0,
        integer: true,
      },
      {
        key: "sub.toastOnFailure",
        type: "boolean",
        tab: "subagents",
        label: "Toast on failure",
        description: "Surface a toast for terminal-error states (failed / stopped / aborted).",
        value: subagents.toastOnFailure,
      },
      {
        key: "sub.toastOnLongCompletion",
        type: "boolean",
        tab: "subagents",
        label: "Toast on long completion",
        description: "Surface a toast when a non-error completion's duration exceeds the threshold above.",
        value: subagents.toastOnLongCompletion,
      },
      {
        key: "sub.toastOnScheduled",
        type: "boolean",
        tab: "subagents",
        label: "Toast on scheduled",
        description:
          "Audit-trail toasts when a subagent is scheduled (cron / interval / one-shot). Off by default to avoid noise.",
        value: subagents.toastOnScheduled,
      },
    ];

    await openSettingsModal(ctx, {
      title: "@wierdbytes/pi-statusline",
      tabs: [
        { id: "display", label: "Display" },
        { id: "layout", label: "Layout" },
        { id: "toasts", label: "Toasts" },
        { id: "subagents", label: "Subagents" },
      ],
      initialTab: "display",
      fields,
      // Alt+↑ / Alt+↓ on a block row swaps it with the immediate
      // neighbour. The modal already moved its internal row and focus
      // by the time we get here; we just mirror the change into
      // `layout.order` so the swap persists. `fieldKey` is the moved
      // block's `layout.block.<id>` key; `toIndex` is its new 0-based
      // position among the reorderable peers (= the eight block rows).
      onReorder: ({ fieldKey, fromIndex, toIndex }) => {
        if (!fieldKey.startsWith("layout.block.")) return;
        const id = fieldKey.slice("layout.block.".length) as BlockId;
        if (!(KNOWN_BLOCK_IDS as readonly string[]).includes(id)) return;
        const order = [...eventsConfig.layout.order];
        const cur = order.indexOf(id);
        if (cur < 0 || cur !== fromIndex) {
          // Defensive: the modal's notion of `fromIndex` and our
          // own `layout.order` are usually in lockstep, but a stale
          // snapshot (e.g. the modal opened before a `/statusline
          // layout move` ran) could put them out of sync. Recompute
          // from the canonical `layout.order`.
        }
        const actualFrom = cur >= 0 ? cur : fromIndex;
        const safeTo = Math.max(0, Math.min(order.length - 1, toIndex));
        if (actualFrom === safeTo) return;
        order.splice(actualFrom, 1);
        order.splice(safeTo, 0, id);
        applyLayoutChange(ctx, { order });
      },
      onChange: (key, value) => {
        // Display-tab fields all share the same side-effect bus.
        if (key === "statuslineEnabled") return applyDisplayChange(ctx, { statuslineEnabled: value as boolean });
        if (key === "footerHidden") return applyDisplayChange(ctx, { footerHidden: value as boolean });
        if (key === "fixedEditorEnabled") return applyDisplayChange(ctx, { fixedEditorEnabled: value as boolean });
        if (key === "mouseScrollEnabled") return applyDisplayChange(ctx, { mouseScrollEnabled: value as boolean });
        if (key === "iconSet") return applyDisplayChange(ctx, { iconSet: value as IconSet });

        // Layout-tab fields all route through `applyLayoutChange`.
        //
        // The per-block custom rows (`layout.block.<id>`) commit their
        // mutations eagerly from inside the per-block submenu — the
        // modal's commit path is never reached because we call
        // `done()` without a value. The separator enum is the only
        // top-level Layout field that flows through this onChange.
        if (key === "layout.separator") {
          return applyLayoutChange(ctx, { separator: value as string });
        }
        if (typeof key === "string" && key.startsWith("layout.block.")) {
          // Defensive no-op: a per-block submenu only ever calls
          // `done()` (no value), so this branch shouldn't fire. Kept
          // so an accidental `done(value)` future regression is
          // caught silently rather than throwing through the modal.
          return;
        }

        // Toast-tab fields are pure persistence — the events tracker
        // pulls timeouts via the closure each time a toast lifetime is
        // computed.
        if (typeof key === "string" && key.startsWith("toast.")) {
          const level = key.slice("toast.".length) as NotifyLevel;
          eventsConfig = setToastTimeout(eventsConfig, level, value as number);
          return;
        }

        // Subagents-tab fields go through setSubagentsConfig (which
        // clamps numeric values and persists). Disabling the bridge
        // also resets the tracker so a re-enable starts clean — same
        // as the old `subagents off` subcommand.
        if (key === "sub.enabled") {
          const next = value as boolean;
          eventsConfig = setSubagentsConfig(eventsConfig, { enabled: next });
          if (!next) subagentsTracker.reset();
          return;
        }
        if (key === "sub.longCompletionMs") {
          eventsConfig = setSubagentsConfig(eventsConfig, { longCompletionMs: value as number });
          return;
        }
        if (key === "sub.toastOnFailure") {
          eventsConfig = setSubagentsConfig(eventsConfig, { toastOnFailure: value as boolean });
          return;
        }
        if (key === "sub.toastOnLongCompletion") {
          eventsConfig = setSubagentsConfig(eventsConfig, { toastOnLongCompletion: value as boolean });
          return;
        }
        if (key === "sub.toastOnScheduled") {
          eventsConfig = setSubagentsConfig(eventsConfig, { toastOnScheduled: value as boolean });
          return;
        }
      },
    });
  };

  // ────────────────────────── imperative helpers ────────────────────────────

  /** Render the active layout as a single inline line, e.g.
   *  `model > path > git! > context > ... (6/8 visible)` where `!`
   *  marks a disabled block. Shared by `printStatusDump` and the
   *  imperative `/statusline layout` printout. */
  const formatLayoutLine = (): string => {
    const { order, enabled } = eventsConfig.layout;
    const total = KNOWN_BLOCK_IDS.length;
    const visible = order.filter((id) => enabled[id]).length;
    const pieces = order.map((id) => (enabled[id] ? id : `${id}!`));
    return `${pieces.join(" > ")} (${visible}/${total} visible)`;
  };

  const isKnownBlockId = (value: string | undefined): value is BlockId =>
    typeof value === "string" && (KNOWN_BLOCK_IDS as readonly string[]).includes(value);

  /** Read-only structured dump used by callers that can't host the
   *  overlay (RPC, `--print` mode). */
  const printStatusDump = (ctx: ExtensionContext): void => {
    const snap = eventsTracker.getSnapshot();
    const display = eventsConfig.display;
    const subagents = eventsConfig.subagents;
    const layout = eventsConfig.layout;
    const counts = subagentsTracker.getCounts();
    const lines = [
      `statusline:    ${display.statuslineEnabled ? "on" : "off"}`,
      `footer:        ${display.footerHidden ? "hidden" : "shown"}`,
      `fixed editor:  ${display.fixedEditorEnabled ? "on" : "off"}`,
      `mouse scroll:  ${display.mouseScrollEnabled ? "on" : "off"}`,
      `icon set:      ${display.iconSet}`,
      `chips:         ${snap.chips.length}`,
      `toast:         ${snap.toast ? `${snap.toast.event.level ?? "info"} — ${snap.toast.event.message}` : "(none)"}`,
      `events log:    ${eventsTracker.getLog().length} entries`,
      `toast timeouts: ${Object.entries(eventsConfig.toastTimeouts)
        .map(([level, ms]) => `${level}=${ms === 0 ? "sticky" : `${ms}ms`}`)
        .join(" ")}`,
      `layout:        ${formatLayoutLine()}`,
      `  separator:   ${JSON.stringify(layout.separator)}`,
      `  model.think: ${layout.model.showThinking ? "yes" : "no"}`,
      `  tokens:      ${[
        layout.tokens.input ? "in" : "-in",
        layout.tokens.output ? "out" : "-out",
        layout.tokens.cacheRead ? "R" : "-R",
        layout.tokens.cacheWrite ? "W" : "-W",
      ].join(" ")}`,
      `subagents:     ${subagents.enabled ? "on" : "off"} (${counts.running} running / ${counts.created} queued / ${counts.total} total)`,
      `  long-ms:     ${subagents.longCompletionMs}`,
      `  on failure: ${subagents.toastOnFailure ? "yes" : "no"}`,
      `  on long:    ${subagents.toastOnLongCompletion ? "yes" : "no"}`,
      `  on schedule: ${subagents.toastOnScheduled ? "yes" : "no"}`,
    ];
    ctx.ui.notify(lines.join("\n"), "info");
  };

  /** Imperative `/statusline layout` dispatcher: prints / resets /
   *  toggles / moves blocks via the same `applyLayoutChange` bus the
   *  modal uses. */
  const handleLayoutCommand = (ctx: ExtensionContext, tokens: string[]): void => {
    const sub = tokens[0];
    if (!sub || sub === "status" || sub === "print") {
      ctx.ui.notify(`layout: ${formatLayoutLine()}`, "info");
      return;
    }
    if (sub === "reset") {
      applyLayoutChange(ctx, {
        order: [...KNOWN_BLOCK_IDS],
        enabled: KNOWN_BLOCK_IDS.reduce(
          (acc, id) => {
            acc[id] = true;
            return acc;
          },
          {} as Record<BlockId, boolean>,
        ),
        model: { showThinking: true },
        tokens: { input: true, output: true, cacheRead: true, cacheWrite: true },
      });
      ctx.ui.notify("layout: reset to defaults", "info");
      return;
    }
    if (sub === "toggle") {
      const id = tokens[1];
      if (!isKnownBlockId(id)) {
        ctx.ui.notify(
          `Unknown block: ${id ?? "(none)"}. Valid: ${KNOWN_BLOCK_IDS.join(", ")}`,
          "warning",
        );
        return;
      }
      const next = !eventsConfig.layout.enabled[id];
      applyLayoutChange(ctx, { enabled: { ...eventsConfig.layout.enabled, [id]: next } });
      ctx.ui.notify(`layout: ${id} ${next ? "enabled" : "disabled"}`, "info");
      return;
    }
    if (sub === "move") {
      const id = tokens[1];
      const direction = tokens[2];
      if (!isKnownBlockId(id)) {
        ctx.ui.notify(
          `Unknown block: ${id ?? "(none)"}. Valid: ${KNOWN_BLOCK_IDS.join(", ")}`,
          "warning",
        );
        return;
      }
      const order = [...eventsConfig.layout.order];
      const idx = order.indexOf(id);
      if (idx < 0) return;
      const target =
        direction === "up"
          ? Math.max(0, idx - 1)
          : direction === "down"
          ? Math.min(order.length - 1, idx + 1)
          : direction === "top"
          ? 0
          : direction === "bottom"
          ? order.length - 1
          : -1;
      if (target < 0) {
        ctx.ui.notify("Usage: /statusline layout move <block> <up|down|top|bottom>", "warning");
        return;
      }
      order.splice(idx, 1);
      order.splice(target, 0, id);
      applyLayoutChange(ctx, { order });
      ctx.ui.notify(`layout: moved ${id} → position ${target + 1}`, "info");
      return;
    }
    ctx.ui.notify(
      "Usage: /statusline layout [status|reset|toggle <block>|move <block> <up|down|top|bottom>]",
      "info",
    );
  };

  /** Print the most recent 16 entries from the events log. */
  const printEventsLog = (ctx: ExtensionContext): void => {
    const log = eventsTracker.getLog().slice(0, 16);
    if (log.length === 0) {
      ctx.ui.notify("events: log is empty", "info");
      return;
    }
    const formatted = log
      .map((e) => {
        const ts = e.timestamp ? new Date(e.timestamp).toISOString().slice(11, 19) : "--:--:--";
        const level = e.level ?? "info";
        const title = e.title || e.source;
        return `${ts} [${level}] ${title}: ${e.message}`;
      })
      .join("\n");
    ctx.ui.notify(formatted, "info");
  };

  pi.registerCommand("statusline", {
    description:
      "Open the @wierdbytes/pi-statusline settings overlay (no args). Action subcommands: on | off | toggle | status | icons [set] | layout [...] | events log | events clear",
    handler: async (args, ctx) => {
      currentCtx = ctx;
      const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const cmd = tokens[0];

      // Bare `/statusline` opens the overlay.
      if (!cmd) return openConfigOverlay(ctx);

      // Imperative master-switch shortcuts — single keystroke beats
      // navigating the modal.
      if (cmd === "on" || cmd === "off" || cmd === "toggle") {
        const next = cmd === "toggle" ? !statuslineEnabled : cmd === "on";
        applyDisplayChange(ctx, { statuslineEnabled: next });
        ctx.ui.notify(`wierd statusline ${next ? "enabled" : "disabled"}`, "info");
        return;
      }

      if (cmd === "status") {
        printStatusDump(ctx);
        return;
      }

      // Quick imperative switch for the icon set. `/statusline icons`
      // (no args) prints the current set + lists the valid choices;
      // `/statusline icons <set>` flips it via the same side-effect
      // bus the modal uses.
      if (cmd === "icons") {
        const sub = tokens[1];
        if (!sub || sub === "status") {
          const lines = [
            `current: ${eventsConfig.display.iconSet}`,
            `available:`,
            ...VALID_ICON_SETS.map(
              (s) => `  ${s === eventsConfig.display.iconSet ? "*" : " "} ${s.padEnd(10)} — ${ICON_SET_LABELS[s]}`,
            ),
          ];
          ctx.ui.notify(lines.join("\n"), "info");
          return;
        }
        if (!isIconSet(sub)) {
          ctx.ui.notify(
            `Unknown icon set: ${sub}. Valid: ${VALID_ICON_SETS.join(" | ")}`,
            "warning",
          );
          return;
        }
        applyDisplayChange(ctx, { iconSet: sub });
        ctx.ui.notify(`icon set: ${sub} (${ICON_SET_LABELS[sub]})`, "info");
        return;
      }

      // Imperative layout dispatch — mirrors the Layout tab in the
      // modal but stays usable from RPC / scripted sessions.
      if (cmd === "layout") {
        handleLayoutCommand(ctx, tokens.slice(1));
        return;
      }

      // Read/clear utilities for the events log live outside the modal
      // because they print or mutate runtime state, not config.
      if (cmd === "events") {
        const sub = tokens[1];
        if (sub === "log") return printEventsLog(ctx);
        if (sub === "clear") {
          eventsTracker.clearAll();
          ctx.ui.notify("events: cleared chips and toast", "info");
          return;
        }
        ctx.ui.notify("Usage: /statusline events [log|clear]", "info");
        return;
      }

      ctx.ui.notify(
        "Usage: /statusline [on|off|toggle|status|icons [set]|layout [status|reset|toggle <block>|move <block> <dir>]|events log|events clear]  (no args ⇒ open settings overlay)",
        "info",
      );
    },
  });
}
