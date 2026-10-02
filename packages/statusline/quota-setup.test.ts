import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createQuotaSetupSubmenu, quotaAvailability, type QuotaSetupState } from "./quota-setup.ts";

function state(overrides: Partial<QuotaSetupState> = {}): QuotaSetupState {
  return { enabled: true, statuslineEnabled: true, footerHidden: true, hasSettingsCommand: false, hasStatus: false, ...overrides };
}

const theme = { fg: (_color: string, text: string) => text } as Theme;

function help(initial = state(), terminalRows = 28) {
  let current = initial;
  const done = vi.fn();
  const requestRender = vi.fn();
  const component = createQuotaSetupSubmenu({
    getState: () => current,
    theme,
    tui: { terminal: { rows: terminalRows }, requestRender } as unknown as TUI,
    done,
  });
  return { component, done, requestRender, update: (next: QuotaSetupState) => { current = next; } };
}

describe("quota setup availability", () => {
  it("distinguishes a visibility preference from an available source", () => {
    expect(quotaAvailability(state()).label).toBe("Setup needed");
    expect(quotaAvailability(state({ enabled: false })).label).toBe("Setup needed");
    expect(quotaAvailability(state()).description).toContain("enabling it alone does not fetch quotas");
  });

  it("does not call a loaded but silent extension missing", () => {
    const result = quotaAvailability(state({ hasSettingsCommand: true }));
    expect(result.label).toBe("Waiting for data");
    expect(result.description).toContain("/quotas:settings");
    expect(result.description).toContain("provider login");
  });

  it("accepts published status even without the settings command", () => {
    expect(quotaAvailability(state({ hasStatus: true })).label).toBe("Shown");
  });

  it("explains each visibility prerequisite without claiming live quota data", () => {
    expect(quotaAvailability(state({ hasSettingsCommand: true, footerHidden: false })).label).toBe("Enable footer hiding");
    expect(quotaAvailability(state({ hasSettingsCommand: true, statuslineEnabled: false })).label).toBe("Statusline off");
    expect(quotaAvailability(state({ hasSettingsCommand: true, enabled: false })).label).toBe("Off");
  });
});

describe("quota setup help component", () => {
  it("renders actionable installation and setup instructions", () => {
    const { component } = help(state(), 40);
    const output = component.render(100).join("\n");
    for (const instruction of [
      "Setup needed", "pi install npm:@latentminds/pi-quotas", "/reload", "/quotas:settings",
      "Usage footer status", "Hide pi footer", "Quota remaining", "/login",
    ]) expect(output).toContain(instruction);
    expect(output).not.toContain("is not installed");
  });

  it("scrolls all instructions into view at narrow widths without overflowing", () => {
    const { component, requestRender } = help(state(), 20);
    const pages: string[] = [];
    for (let n = 0; n < 40; n++) {
      const lines = component.render(36);
      expect(lines.length).toBeLessThanOrEqual(14);
      expect(lines.every((line) => visibleWidth(line) <= 36)).toBe(true);
      pages.push(lines.join("\n"));
      component.handleInput?.("\x1b[B");
    }
    const seen = pages.join("\n");
    expect(seen).toContain("pi install");
    expect(seen).toContain("npm:@latentminds/pi-quotas");
    expect(seen).toContain("Usage footer status");
    expect(seen).toMatch(/check its\s+login/);
    expect(seen).toContain("esc back");
    expect(requestRender).toHaveBeenCalled();
  });

  it("reflects availability changes and clamps scroll after resize", () => {
    const { component, update } = help(state(), 24);
    component.render(36);
    component.handleInput?.("\x1b[F");
    update(state({ hasStatus: true }));
    component.render(120);
    component.handleInput?.("\x1b[H");
    const output = component.render(120).join("\n");
    expect(output).toContain("Shown");
    expect(output).not.toContain("Setup needed");
    expect(output).toContain("↑↓ scroll");
  });

  it("is read-only and closes with Escape", () => {
    const { component, done } = help();
    const before = component.render(100);
    component.handleInput?.("\r");
    component.handleInput?.(" ");
    expect(component.render(100)).toEqual(before);
    expect(done).not.toHaveBeenCalled();
    component.handleInput?.("\x1b");
    expect(done).toHaveBeenCalledOnce();
  });
});
