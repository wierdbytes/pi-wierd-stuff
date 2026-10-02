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
  C_ORANGE,
  C_PINK,
  C_PURPLE,
  C_RED,
  C_RESET,
  C_YELLOW,
  composeStatusLine,
  type RenderInputs,
} from "./blocks.ts";
import { EMPTY_CACHE_STATS } from "./cache-stats.ts";
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
    cache: { ...EMPTY_CACHE_STATS },
    cacheRemainingMs: null,
    cacheWarmerForced: false,
    stashCount: 0,
    quotaStatus: "",
    chips: [],
    iconSet: "ascii",
    layout: cloneDefaultLayout(),
    ...overrides,
  };
}

describe("quota block", () => {
  it("is absent without a published status", () => {
    expect(BLOCK_RENDERERS.quotas(makeInputs())).toBe("");
    expect(BLOCK_RENDERERS.quotas(makeInputs({ quotaStatus: " \n\t " }))).toBe("");
  });

  it("preserves remaining percentages, labels, and severity colors", () => {
    const quotaStatus = `${C_GREEN}5h:91% left${C_RESET} ${C_RED}7d:12% left${C_RESET}`;
    expect(BLOCK_RENDERERS.quotas(makeInputs({ quotaStatus }))).toBe(quotaStatus + C_RESET);
  });

  it("keeps errors and multiline statuses on one row", () => {
    expect(BLOCK_RENDERERS.quotas(makeInputs({ quotaStatus: " usage\nunavailable\t " })))
      .toBe(`usage unavailable${C_RESET}`);
  });

  it("supports layout ordering and hiding without stray separators", () => {
    const layout = cloneDefaultLayout();
    layout.order = ["quotas", "cost"];
    const inputs = makeInputs({ quotaStatus: "7d:82% left", layout });
    const text = composeStatusLine(layout, inputs);
    expect(text.indexOf("7d:82% left")).toBeLessThan(text.indexOf("$0.42"));
    layout.enabled.quotas = false;
    const hidden = composeStatusLine(layout, inputs);
    expect(hidden).not.toContain("7d:");
    expect(hidden).not.toContain("│");
  });
});

describe("block renderers (in isolation)", () => {
  it("renderModel attaches thinking when enabled + reasoning model", () => {
    const out = BLOCK_RENDERERS.model(makeInputs());
    expect(out).toContain("sonnet-4.5");
    expect(out).toContain("med"); // shortened thinking label (THINK_LABELS map)
    expect(out).toContain(C_PINK); // model color
  });

  it("renderModel keeps minimal as min when the provider maps it to low", () => {
    const out = BLOCK_RENDERERS.model(
      makeInputs({ thinkingLevel: "minimal", thinkingLevelMap: { minimal: "low" } }),
    );
    expect(out).toContain(`${C_PURPLE}[t] min${C_RESET}`);
    expect(out).not.toContain("[t] low");
  });

  it("renderModel gradients the icon and label for mapped max effort", () => {
    const out = BLOCK_RENDERERS.model(
      makeInputs({ thinkingLevel: "xhigh", thinkingLevelMap: { xhigh: "max" } }),
    );
    expect(out).toContain(`${C_ORANGE}[`);
    expect(out).toContain(`${C_PURPLE}x${C_RESET}`);
    expect(out).not.toContain(`${C_RED}[t] max`);
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

  it("renderContext measures usage against the full model context window", () => {
    const out = BLOCK_RENDERERS.context(
      makeInputs({ current: 291_000, contextWindow: 324_000 }),
    );

    expect(out).toContain("89%");
    expect(out).not.toContain("100%");
    expect(out).toContain("291k");
    expect(out).toContain("33k");
    expect(out.match(/▓/g)).toHaveLength(8);
    expect(out.match(/░/g)).toHaveLength(2);
  });

  it("renderContext shows unknown values while post-compaction usage is unavailable", () => {
    const out = BLOCK_RENDERERS.context(makeInputs({ current: null }));

    expect(out).toContain("?%");
    expect(out).not.toContain("0%");
    expect(out.match(/▓/g)).toBeNull();
    expect(out.match(/░/g)).toHaveLength(10);
  });

  it("renderCost is empty for zero cost", () => {
    expect(BLOCK_RENDERERS.cost(makeInputs({ cost: 0 }))).toBe("");
  });

  it("renderCost prints a 2-decimal USD value", () => {
    expect(BLOCK_RENDERERS.cost(makeInputs({ cost: 12.345 }))).toContain("12.35");
  });

  it("renderCache shows hit rate, read/uncached and savings", () => {
    const out = BLOCK_RENDERERS.cache(
      makeInputs({
        iconSet: "nerd-font",
        cache: { cacheRead: 200_000, uncached: 200, cacheWrite: 150, warmCost: 0, delta: -0.861 },
      }),
    );
    expect(out).toBe(
      `${C_GREEN}\uf1c0 99.9%${C_RESET} ${C_GRAY}(200k/200)${C_RESET} ${C_GRAY}-$0.86${C_RESET}`,
    );
  });

  it("renderCache colors hit rate green >= 98.0, yellow 90.0–97.9, red < 90.0", () => {
    const at = (pct: number) =>
      BLOCK_RENDERERS.cache(
        makeInputs({ cache: { cacheRead: pct, uncached: 100 - pct, cacheWrite: 1, warmCost: 0, delta: null } }),
      );
    expect(at(99).startsWith(`${C_GREEN}99.0%`)).toBe(true);
    expect(at(98).startsWith(`${C_GREEN}98.0%`)).toBe(true);
    expect(at(97).startsWith(`${C_YELLOW}97.0%`)).toBe(true);
    const almost = BLOCK_RENDERERS.cache(
      makeInputs({ cache: { cacheRead: 979, uncached: 21, cacheWrite: 1, warmCost: 0, delta: null } }),
    );
    expect(almost.startsWith(`${C_YELLOW}97.9%`)).toBe(true);
    expect(at(90).startsWith(`${C_YELLOW}90.0%`)).toBe(true);
    expect(at(89).startsWith(`${C_RED}89.0%`)).toBe(true);
  });

  it("renderCache floors the percentage so 99.96% never reads 100.0%", () => {
    const out = BLOCK_RENDERERS.cache(
      makeInputs({ cache: { cacheRead: 9996, uncached: 4, cacheWrite: 4, warmCost: 0, delta: null } }),
    );
    expect(out).toContain("99.9%");
  });

  it("renderCache prints overspend in red and near-zero in gray", () => {
    const base = { cacheRead: 10, uncached: 90, cacheWrite: 90, warmCost: 0 };
    expect(BLOCK_RENDERERS.cache(makeInputs({ cache: { ...base, delta: 0.15 } }))).toContain(
      `${C_RED}+$0.15${C_RESET}`,
    );
    expect(BLOCK_RENDERERS.cache(makeInputs({ cache: { ...base, delta: 0.004 } }))).toContain(
      `${C_GRAY}$0.00${C_RESET}`,
    );
  });

  it("renderCache omits the icon for non nerd-font sets", () => {
    const out = BLOCK_RENDERERS.cache(
      makeInputs({
        iconSet: "plain",
        cache: { cacheRead: 99, uncached: 1, cacheWrite: 1, warmCost: 0, delta: null },
      }),
    );
    expect(out.startsWith(`${C_GREEN}99.0%${C_RESET}`)).toBe(true);
  });

  it("renderCache respects each sub-toggle independently", () => {
    const cache = { cacheRead: 99, uncached: 1, cacheWrite: 1, warmCost: 0, delta: -1 };
    const noHit = cloneDefaultLayout();
    noHit.cache = { hitRate: false, savings: true, timer: true };
    expect(BLOCK_RENDERERS.cache(makeInputs({ layout: noHit, cache }))).toBe(
      `${C_GRAY}-$1.00${C_RESET}`,
    );
    const noSavings = cloneDefaultLayout();
    noSavings.cache = { hitRate: true, savings: false, timer: true };
    expect(BLOCK_RENDERERS.cache(makeInputs({ layout: noSavings, cache }))).not.toContain("$");
    const none = cloneDefaultLayout();
    none.cache = { hitRate: false, savings: false, timer: false };
    expect(BLOCK_RENDERERS.cache(makeInputs({ layout: none, cache }))).toBe("");
  });

  it("renderCache appends the expiry countdown with the nerd-font hourglass", () => {
    const layout = cloneDefaultLayout();
    layout.cache = { hitRate: false, savings: false, timer: true };
    const cache = { cacheRead: 99, uncached: 1, cacheWrite: 1, warmCost: 0, delta: null };
    const render = (ms: number) =>
      BLOCK_RENDERERS.cache(makeInputs({ iconSet: "nerd-font", layout, cache, cacheRemainingMs: ms }));
    expect(render(261_000)).toBe(`${C_GRAY}\u{F051F} 4:21${C_RESET}`);
    expect(render(120_000)).toBe(`${C_GRAY}\u{F051F} 2:00${C_RESET}`);
    expect(render(31_000)).toBe(`${C_GRAY}\u{F051F} 0:31${C_RESET}`);
    expect(render(30_000)).toBe(`${C_YELLOW}\u{F051F} 0:30${C_RESET}`);
    expect(render(30_400)).toBe(`${C_GRAY}\u{F051F} 0:31${C_RESET}`);
    expect(render(300)).toBe(`${C_YELLOW}\u{F051F} 0:01${C_RESET}`);
    expect(render(0)).toBe(`${C_RED}\u{F06AD} 0:00${C_RESET}`);
  });

  it("renderCache appends the warmer icon after the countdown while forced warming is on", () => {
    const layout = cloneDefaultLayout();
    layout.cache = { hitRate: false, savings: false, timer: true };
    const cache = { cacheRead: 99, uncached: 1, cacheWrite: 1, warmCost: 0, delta: null };
    const render = (iconSet: RenderInputs["iconSet"], cacheWarmerForced: boolean) =>
      BLOCK_RENDERERS.cache(
        makeInputs({ iconSet, layout, cache, cacheRemainingMs: 292_000, cacheWarmerForced }),
      );
    expect(render("nerd-font", true)).toBe(`${C_GRAY}\u{F051F} 4:52 \uf2f1${C_RESET}`);
    expect(render("nerd-font", false)).toBe(`${C_GRAY}\u{F051F} 4:52${C_RESET}`);
    expect(render("plain", true)).toBe(`${C_GRAY}4:52 *${C_RESET}`);
  });

  it("renderCache hides the countdown when unknown or toggled off", () => {
    const cache = { cacheRead: 99, uncached: 1, cacheWrite: 1, warmCost: 0, delta: null };
    expect(BLOCK_RENDERERS.cache(makeInputs({ cache, cacheRemainingMs: null }))).not.toContain(":");
    const layout = cloneDefaultLayout();
    layout.cache.timer = false;
    expect(
      BLOCK_RENDERERS.cache(makeInputs({ layout, cache, cacheRemainingMs: 60_000 })),
    ).not.toContain("1:00");
  });

  it("renderCache is empty when the cache was never read or written", () => {
    const out = BLOCK_RENDERERS.cache(
      makeInputs({ cache: { cacheRead: 0, uncached: 5000, cacheWrite: 0, warmCost: 0, delta: null } }),
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
    layout.order = ["path", "model", "git", "context", "cost", "cache", "chips", "stash"];
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
