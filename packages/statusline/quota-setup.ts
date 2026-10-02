import type { Theme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import { formatHintLine, responsiveInnerRows, wrapLine } from "@wierdbytes/pi-common";

export interface QuotaSetupState {
  enabled: boolean;
  statuslineEnabled: boolean;
  footerHidden: boolean;
  hasSettingsCommand: boolean;
  hasStatus: boolean;
}

/** Availability is separate from the user's visibility preference. */
export function quotaAvailability(state: QuotaSetupState): { label: string; description: string } {
  if (!state.hasSettingsCommand && !state.hasStatus) {
    return {
      label: "Setup needed",
      description: "No pi-quotas status or settings command detected. This block needs pi-quotas loaded; enabling it alone does not fetch quotas.",
    };
  }
  if (!state.statuslineEnabled) {
    return { label: "Statusline off", description: "Enable Statusline enabled in /statusline > Display to show the custom row." };
  }
  if (!state.enabled) {
    return { label: "Off", description: "The quota block is hidden. Press Space on its Layout row to enable it." };
  }
  if (!state.footerHidden) {
    return { label: "Enable footer hiding", description: "Enable Hide pi footer in /statusline > Display to move quota status into the custom row." };
  }
  if (state.hasStatus) {
    return { label: "Shown", description: "Displaying the status published by pi-quotas, including any usage-unavailable message." };
  }
  return {
    label: "Waiting for data",
    description: "pi-quotas settings are available, but no status has arrived. Enable Usage footer status in /quotas:settings and check your provider login.",
  };
}

export const QUOTA_SETUP_INSTRUCTIONS = [
  "This block displays pi-quotas data; it does not fetch quotas itself.",
  "",
  "1. Install pi-quotas in your shell, if needed:",
  "   pi install npm:@latentminds/pi-quotas",
  "2. In Pi, run /reload to load the extension.",
  "3. Open /quotas:settings and enable Usage footer status.",
  "4. In /statusline > Display, enable Statusline enabled and Hide pi footer.",
  "5. In /statusline > Layout, enable Quota remaining with Space.",
  "",
  "If data is still missing, select a supported provider and check its login with /login. A missing status alone does not prove pi-quotas is uninstalled.",
];

/** Read-only setup help inside the existing settings frame, scrollable on small terminals. */
export function createQuotaSetupSubmenu(args: {
  getState: () => QuotaSetupState;
  theme: Theme;
  tui: TUI;
  done: () => void;
}): Component {
  let offset = 0;
  let maxOffset = 0;
  let pageRows = 1;
  return {
    invalidate() {},
    render(width: number): string[] {
      const safeWidth = Math.max(1, width);
      const availability = quotaAvailability(args.getState());
      const content = [
        args.theme.fg("accent", availability.label),
        availability.description,
        "",
        ...QUOTA_SETUP_INSTRUCTIONS,
      ].flatMap((line) => wrapLine(line, safeWidth));
      const footer = wrapLine(formatHintLine([
        { key: "↑↓", label: "scroll" },
        { key: "esc", label: "back" },
      ], args.theme), safeWidth);
      // Match the parent settings frame's body height; do not create a nested frame.
      pageRows = Math.max(1, responsiveInnerRows(args.tui.terminal.rows ?? 24, 30, 14) - footer.length - 1);
      maxOffset = Math.max(0, content.length - pageRows);
      offset = Math.min(offset, maxOffset);
      const page = content.slice(offset, offset + pageRows);
      while (page.length < pageRows) page.push("");
      const progress = maxOffset > 0 ? `Lines ${offset + 1}-${Math.min(offset + pageRows, content.length)} of ${content.length}` : "";
      return [...page, ...wrapLine(progress, safeWidth).slice(0, 1), ...footer];
    },
    handleInput(data: string): void {
      if (isKeyRelease(data)) return;
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
        args.done();
        return;
      }
      if (matchesKey(data, "up") || data === "k") offset -= 1;
      else if (matchesKey(data, "down") || data === "j") offset += 1;
      else if (matchesKey(data, "pageup")) offset -= pageRows;
      else if (matchesKey(data, "pagedown")) offset += pageRows;
      else if (matchesKey(data, "home")) offset = 0;
      else if (matchesKey(data, "end")) offset = maxOffset;
      else return;
      offset = Math.max(0, Math.min(maxOffset, offset));
      args.tui.requestRender();
    },
  };
}
