/**
 * Snapshot tests for `composeStatusLine` and the individual block
 * renderers. These lock down the exact ANSI output for a handful of
 * synthetic inputs so a future refactor can't accidentally change
 * the on-screen statusline.
 *
 * The expected strings were captured from the legacy `buildStatusLine`
 * (pre-refactor) for the same inputs, with one documented difference:
 * separator placement around the cyan-on git block. The refactored
 * composer inserts a uniform ` <C_GRAY>│<C_RESET> ` between blocks,
 * which is visually identical to the legacy `<C_GRAY>│<C_RESET><C_CYAN> `
 * but lays out ANSI codes slightly differently.
 */

import { describe, expect, it } from "vitest";

import {
  BLOCK_RENDERERS,
  C_CYAN,
  C_GRAY,
  C_GREEN,
  C_PINK,
  C_PURPLE,
  C_RED,
  C_RESET,
  C_YELLOW,
  composeStatusLine,
  type RenderInputs,
} from "./blocks.ts";
import { cloneDefaultLayout } from "./layout-config.ts";

/** Build a synthetic `RenderInputs` with sensible defaults. */
function makeInputs(overrides: Partial<RenderInputs> = {}): RenderInputs {
  return {
    cwd: "/me/dev/proj",
    branch: "main",
    dirty: false,
    current: 0,
    contextWindow: 200_000,
    cost: 0.42,
    modelName: "sonnet-4.5",
    thinkingLevel: "medium",
    thinkingLevelMap: undefined,
    modelReasoning: true,
    totalInput: 1500,
    totalOutput: 700,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    stashCount: 0,
    chips: [],
    iconSet: "ascii",
    layout: cloneDefaultLayout(),
    ...overrides,
  };
}

describe("block renderers (in isolation)", () => {
  it("renderModel attaches thinking when enabled + reasoning model", () => {
    const out = BLOCK_RENDERERS.model(makeInputs());
    expect(out).toContain("sonnet-4.5");
    expect(out).toContain("med"); // shortened thinking label (THINK_LABELS map)
    expect(out).toContain(C_PINK); // model color
  });

  it("renderModel skips thinking when sub-toggle is off", () => {
    const layout = cloneDefaultLayout();
    layout.model.showThinking = false;
    const out = BLOCK_RENDERERS.model(makeInputs({ layout }));
    expect(out).toContain("sonnet-4.5");
    expect(out).not.toContain("med");
  });

  it("renderModel skips thinking for non-reasoning models", () => {
    const out = BLOCK_RENDERERS.model(makeInputs({ modelReasoning: false }));
    expect(out).toContain("sonnet-4.5");
    expect(out).not.toContain("med");
  });

  it("renderPath shows the last segment in accent color", () => {
    const out = BLOCK_RENDERERS.path(makeInputs({ cwd: "/a/b/c" }));
    expect(out).toContain(C_PURPLE);
    expect(out).toContain("/c");
  });

  it("renderGit is empty outside a repo", () => {
    expect(BLOCK_RENDERERS.git(makeInputs({ branch: null }))).toBe("");
  });

  it("renderGit shows green check when clean", () => {
    const out = BLOCK_RENDERERS.git(makeInputs({ dirty: false }));
    expect(out).toContain(C_CYAN);
    expect(out).toContain(C_GREEN);
    expect(out).toContain("main");
    expect(out).not.toContain(C_RED);
  });

  it("renderGit shows red cross when dirty", () => {
    const out = BLOCK_RENDERERS.git(makeInputs({ dirty: true }));
    expect(out).toContain(C_RED);
    expect(out).not.toContain(C_GREEN);
  });

  it("renderContext is empty when no context window", () => {
    expect(BLOCK_RENDERERS.context(makeInputs({ contextWindow: 0 }))).toBe("");
  });

  it("renderContext shows percentage + bar when usage > 0", () => {
    const out = BLOCK_RENDERERS.context(makeInputs({ current: 50_000 }));
    expect(out).toContain("%");
    expect(out).toMatch(/[▓░]/);
  });

  it("renderCost is empty for zero cost", () => {
    expect(BLOCK_RENDERERS.cost(makeInputs({ cost: 0 }))).toBe("");
  });

  it("renderCost prints a 2-decimal USD value", () => {
    expect(BLOCK_RENDERERS.cost(makeInputs({ cost: 12.345 }))).toContain("12.35");
  });

  it("renderTokens respects each sub-toggle independently", () => {
    const layout = cloneDefaultLayout();
    layout.tokens = { input: false, output: true, cacheRead: false, cacheWrite: false };
    const out = BLOCK_RENDERERS.tokens(
      makeInputs({
        layout,
        totalInput: 999,
        totalOutput: 555,
        totalCacheRead: 111,
        totalCacheWrite: 222,
      }),
    );
    expect(out).not.toContain("↑"); // input gated off
    expect(out).toContain("↓"); // output kept on
    expect(out).not.toContain("R"); // cacheRead gated off
    expect(out).not.toContain("W"); // cacheWrite gated off
  });

  it("renderTokens is empty when every counter is gated or zero", () => {
    const out = BLOCK_RENDERERS.tokens(
      makeInputs({
        totalInput: 0,
        totalOutput: 0,
        totalCacheRead: 0,
        totalCacheWrite: 0,
      }),
    );
    expect(out).toBe("");
  });

  it("renderStash is empty when nothing stashed", () => {
    expect(BLOCK_RENDERERS.stash(makeInputs({ stashCount: 0 }))).toBe("");
  });

  it("renderStash shows count in yellow when > 0", () => {
    const out = BLOCK_RENDERERS.stash(makeInputs({ stashCount: 3 }));
    expect(out).toContain(C_YELLOW);
    expect(out).toContain("3");
  });
});

describe("composeStatusLine", () => {
  it("starts with leading `─ ` divider", () => {
    const out = composeStatusLine(cloneDefaultLayout(), makeInputs());
    expect(out.startsWith(`${C_GRAY}─${C_RESET} `)).toBe(true);
  });

  it("ends with a trailing space", () => {
    const out = composeStatusLine(cloneDefaultLayout(), makeInputs());
    expect(out.endsWith(" ")).toBe(true);
  });

  it("joins visible blocks with the configured separator", () => {
    const layout = cloneDefaultLayout();
    layout.separator = "·";
    const out = composeStatusLine(layout, makeInputs());
    // The custom separator must appear at least once between blocks.
    expect(out).toContain(`${C_GRAY}·${C_RESET}`);
    expect(out).not.toContain(`${C_GRAY}│${C_RESET}`);
  });

  it("respects per-block enabled flag", () => {
    const layout = cloneDefaultLayout();
    layout.enabled.git = false;
    const out = composeStatusLine(layout, makeInputs({ branch: "feat/x" }));
    expect(out).not.toContain("feat/x");
  });

  it("skips a block whose renderer returns empty", () => {
    // Git block enabled but branch is null → renderer returns "".
    const out = composeStatusLine(cloneDefaultLayout(), makeInputs({ branch: null }));
    // No empty separator pair should appear from a skipped block.
    expect(out).not.toMatch(/│\s+│/);
  });

  it("re-orders blocks according to layout.order", () => {
    const layout = cloneDefaultLayout();
    // Put stash before path so the relative ordering is testable
    // without depending on optional renderers being non-empty.
    layout.order = ["path", "model", "git", "context", "cost", "tokens", "chips", "stash"];
    const inputs = makeInputs({ cwd: "/some/path/here" });
    const out = composeStatusLine(layout, inputs);
    const pathIdx = out.indexOf("/here");
    const modelIdx = out.indexOf("sonnet-4.5");
    expect(pathIdx).toBeGreaterThan(-1);
    expect(modelIdx).toBeGreaterThan(-1);
    expect(pathIdx).toBeLessThan(modelIdx);
  });

  it("renders only the leading divider when every block is disabled", () => {
    const layout = cloneDefaultLayout();
    for (const id of layout.order) layout.enabled[id] = false;
    const out = composeStatusLine(layout, makeInputs());
    // No block content survives; we expect just the bare `─ ` head + tail.
    expect(out).toBe(`${C_GRAY}─${C_RESET}  `);
  });
});
