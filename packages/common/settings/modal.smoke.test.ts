/**
 * Smoke test for the settings modal: walks the public `Field[]` API
 * end-to-end with a hand-rolled `tui`/`theme`/`ctx` triple. Verifies:
 *
 *   - The body renders without throwing for every built-in field type.
 *   - Enter on a boolean toggles its value.
 *   - Enter on a short enum cycles to the next option.
 *   - Enter on a long enum opens a submenu.
 *   - Esc closes the modal (calls the supplied `close()`).
 *
 * The test stubs the host pi APIs to the absolute minimum the modal
 * touches; nothing in this file imports the real Pi runtime.
 */

import { describe, expect, it, vi, beforeAll } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

// SelectList renders via getSelectListTheme(), which requires the host
// theme to be initialized. We call this once globally so submenu render
// paths don't blow up in isolation.
beforeAll(() => {
  initTheme();
});
import { createSettingsModalBody } from "./body.ts";
import type { Field } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────
// Stubs
// ─────────────────────────────────────────────────────────────────────

function fakeTheme(): Theme {
  // We only call the colour helpers, all of which are passthroughs in
  // the test (the modal never inspects the wrapped string).
  const passthrough = (_color: string, text: string): string => text;
  return {
    fg: passthrough,
    bg: passthrough,
    bold: (t: string) => t,
    italic: (t: string) => t,
    underline: (t: string) => t,
    inverse: (t: string) => t,
    strikethrough: (t: string) => t,
    getFgAnsi: () => "",
    getBgAnsi: () => "",
    getColorMode: () => "truecolor",
    getThinkingBorderColor: () => (s: string) => s,
    getBashModeBorderColor: () => (s: string) => s,
  } as unknown as Theme;
}

function fakeTui(): TUI {
  // The modal touches `tui.terminal.rows` and `tui.requestRender()`.
  // Anything else trips the test on purpose.
  return {
    terminal: { rows: 40, columns: 100 },
    requestRender: vi.fn(),
  } as unknown as TUI;
}

function fakeCtx(): ExtensionContext {
  return {
    ui: {
      notify: vi.fn(),
    },
    modelRegistry: {
      getAvailable: () => [],
    },
  } as unknown as ExtensionContext;
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe("createSettingsModalBody — happy paths", () => {
  it("renders every built-in field type without throwing", () => {
    const fields: Field[] = [
      { key: "bool", type: "boolean", label: "Bool", value: false },
      { key: "short_enum", type: "enum", label: "Short", value: "a", options: ["a", "b", "c"] },
      {
        key: "long_enum",
        type: "enum",
        label: "Long",
        value: "1",
        options: ["1", "2", "3", "4", "5", "6", "7", "8"],
      },
      { key: "str", type: "string", label: "Str", value: "hello" },
      { key: "num", type: "number", label: "Num", value: 42 },
      { key: "secret", type: "secret", label: "Sec", value: "shh" },
      { key: "path", type: "path", label: "Path", value: "/tmp" },
      {
        key: "model",
        type: "model",
        label: "Model",
        value: { id: "", thinking: "medium" },
      },
      {
        key: "action",
        type: "action",
        label: "Run",
        onActivate: () => {},
      },
      {
        key: "custom",
        type: "custom",
        label: "Custom",
        value: 7,
        render: (a) => `value=${String(a.value)}`,
      },
    ];

    const close = vi.fn();
    const body = createSettingsModalBody(
      { title: "test", fields },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    const lines = body.render(80);
    expect(lines.length).toBeGreaterThan(0);
    // Frame top line includes the rounded corner glyphs.
    expect(lines[0]).toContain("╭");
    expect(lines[0]).toContain("test");
    expect(lines[lines.length - 1]).toContain("╰");
  });

  it("Enter on a boolean field toggles its value via onChange", () => {
    const onChange = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [
      { key: "muted", type: "boolean", label: "Muted", value: false },
    ];
    const body = createSettingsModalBody(
      { fields, onChange },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80); // mount
    body.handleInput?.("\r"); // Enter

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("muted", true, expect.objectContaining({ key: "muted" }));
  });

  it("Enter on a short enum cycles to the next option", () => {
    const onChange = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [
      { key: "scope", type: "enum", label: "Scope", value: "last", options: ["last", "sinceUser"] },
    ];
    const body = createSettingsModalBody(
      { fields, onChange },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80);
    body.handleInput?.("\r");

    expect(onChange).toHaveBeenCalledWith("scope", "sinceUser", expect.objectContaining({ key: "scope" }));
  });

  it("Esc closes the modal (no value commit)", () => {
    const onChange = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [
      { key: "x", type: "boolean", label: "X", value: false },
    ];
    const body = createSettingsModalBody(
      { fields, onChange },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80);
    body.handleInput?.("\x1b"); // ESC

    expect(close).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Model field with hideEffort renders without an effort row", () => {
    const onChange = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [
      {
        key: "searchModel",
        type: "model",
        label: "Search model",
        value: { id: "" },
        hideSession: true,
        hideEffort: true,
        // Skip registry discovery so the test stays self-contained.
        models: [
          { value: "anthropic/claude-haiku-4-5", label: "Haiku" },
          { value: "anthropic/claude-sonnet-4-7", label: "Sonnet" },
        ],
      },
    ];
    const body = createSettingsModalBody(
      { fields, onChange },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80);
    body.handleInput?.("\r"); // open submenu
    const lines = body.render(80).join("\n");
    // The effortless variant's submenu footer drops the `←→ effort` hint
    // and the in-row effort indicator.
    expect(lines).toContain("↑↓ model");
    expect(lines).not.toContain("←→ effort");
  });

  it("footer hints survive cursor overshoot past the last row", () => {
    // Regression: pressing down on the last row used to leave
    // `selected` out of bounds for one render, dropping the
    // row-specific footer hint until the next render clamped it.
    const fields: Field[] = [
      { key: "a", type: "boolean", label: "A", value: false },
      { key: "b", type: "boolean", label: "B", value: true },
    ];
    const body = createSettingsModalBody(
      { fields },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    body.render(80);
    body.handleInput?.("\x1b[B"); // Down
    body.handleInput?.("\x1b[B"); // Down (would overshoot — only 2 rows)
    body.handleInput?.("\x1b[B"); // Down (more overshoot)
    const lines = body.render(80).join("\n");
    // Footer must still contain the focused row's Enter hint.
    expect(lines).toMatch(/enter\/space/);
  });

  it("model effort row uses thinkingLevelMap overrides when present", () => {
    // Regression: the picker used to show the canonical pi level name
    // (`xhigh`) where statusline shows the model-supplied override
    // (e.g. `60000` token budget for Anthropic xhigh).
    const fakeModel = {
      id: "claude-fake",
      name: "Fake",
      provider: "anthropic",
      thinkingLevelMap: { xhigh: "60000", high: "30000" },
    } as unknown as import("@earendil-works/pi-ai").Model<
      import("@earendil-works/pi-ai").Api
    >;
    const fields: Field[] = [
      {
        key: "m",
        type: "model",
        label: "M",
        value: { id: "anthropic/claude-fake", thinking: "xhigh" },
        models: [
          {
            value: "anthropic/claude-fake",
            label: "Fake",
            model: fakeModel,
          },
        ],
      },
    ];
    const body = createSettingsModalBody(
      { fields },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close: vi.fn() },
    );

    // Main-window row label honours the override (e.g. `·  60000`).
    expect(body.render(80).join("\n")).toMatch(/60000/);

    body.handleInput?.("\r"); // open submenu
    const submenu = body.render(80).join("\n");
    // Submenu effort row shows the override + the canonical name in
    // dim parens for power users.
    expect(submenu).toMatch(/60000/);
    expect(submenu).toMatch(/\(xhigh\)/);
  });

  it("Enter on a long enum mounts a submenu instead of cycling", () => {
    const onChange = vi.fn();
    const close = vi.fn();
    const fields: Field[] = [
      {
        key: "voice",
        type: "enum",
        label: "Voice",
        value: "Zephyr",
        options: ["Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda"],
      },
    ];
    const body = createSettingsModalBody(
      { fields, onChange },
      { tui: fakeTui(), theme: fakeTheme(), ctx: fakeCtx(), close },
    );

    body.render(80);
    body.handleInput?.("\r"); // open submenu

    // No commit yet — submenu was opened.
    expect(onChange).not.toHaveBeenCalled();

    // Re-render: the submenu is now mounted, so the body's frame title
    // changes to `<key> →`.
    const lines = body.render(80);
    const titleLine = lines[0] ?? "";
    expect(titleLine).toContain("voice");
  });
});
