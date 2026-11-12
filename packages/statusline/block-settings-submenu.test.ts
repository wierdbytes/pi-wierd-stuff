/**
 * Unit tests for the pure helpers behind the per-block settings
 * submenu. The full Component needs a live TUI handle so it stays
 * untested at this layer; the row builder + `blockHasSubSettings`
 * predicate carry all the behaviour-bearing logic.
 */

import { describe, expect, it } from "vitest";

import { KNOWN_BLOCK_IDS, type BlockId } from "./blocks.ts";
import { blockHasSubSettings, buildBlockSettingsRows } from "./block-settings-submenu.ts";
import { CACHE_SEGMENT_IDS, cloneDefaultLayout } from "./layout-config.ts";

describe("buildBlockSettingsRows", () => {
  it("returns one row for the model block: Show thinking", () => {
    const layout = cloneDefaultLayout();
    const rows = buildBlockSettingsRows("model", layout);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("model.showThinking");
  });

  it("returns hit-rate, tokens, savings and timer toggles for the cache block", () => {
    const layout = cloneDefaultLayout();
    const rows = buildBlockSettingsRows("cache", layout);
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(["cache.hitRate", "cache.tokens", "cache.savings", "cache.timer"]);
  });

  it("returns no rows for blocks without sub-settings", () => {
    const layout = cloneDefaultLayout();
    for (const id of KNOWN_BLOCK_IDS) {
      if (id === "model" || id === "cache") continue;
      expect(buildBlockSettingsRows(id, layout)).toEqual([]);
    }
  });

  it("model showThinking toggle flips just that flag", () => {
    const layout = cloneDefaultLayout();
    const [row] = buildBlockSettingsRows("model", layout);
    const patch = row!.toggle(layout);
    expect(patch.model?.showThinking).toBe(false);
    // No other slice touched.
    expect(patch.enabled).toBeUndefined();
    expect(patch.cache).toBeUndefined();
  });

  it("cache.savings toggle only flips that segment, preserving hit rate", () => {
    const layout = cloneDefaultLayout();
    const row = buildBlockSettingsRows("cache", layout).find((r) => r.id === "cache.savings");
    expect(row).toBeTruthy();
    const patch = row!.toggle(layout);
    expect(patch.cache).toEqual({ order: [...CACHE_SEGMENT_IDS], hitRate: true, tokens: true, savings: false, timer: true });
  });

  it("lists cache rows in layout.cache.order", () => {
    const layout = cloneDefaultLayout();
    layout.cache.order = ["timer", "hitRate", "savings", "tokens"];
    const ids = buildBlockSettingsRows("cache", layout).map((r) => r.id);
    expect(ids).toEqual(["cache.timer", "cache.hitRate", "cache.savings", "cache.tokens"]);
  });

  it("cache row move swaps with its neighbour and stops at the edges", () => {
    const layout = cloneDefaultLayout();
    const rows = buildBlockSettingsRows("cache", layout);
    const tokens = rows.find((r) => r.id === "cache.tokens")!;
    expect(tokens.move!(layout, -1)?.cache?.order).toEqual(["tokens", "hitRate", "savings", "timer"]);
    expect(tokens.move!(layout, 1)?.cache?.order).toEqual(["hitRate", "savings", "tokens", "timer"]);
    expect(rows[0]!.move!(layout, -1)).toBeNull();
    expect(rows[3]!.move!(layout, 1)).toBeNull();
    // Moving never touches the flags.
    expect(tokens.move!(layout, 1)?.cache?.tokens).toBe(true);
  });

  it("model rows are not reorderable", () => {
    const [row] = buildBlockSettingsRows("model", cloneDefaultLayout());
    expect(row!.move).toBeUndefined();
  });
});

describe("blockHasSubSettings", () => {
  it("returns true for model and cache", () => {
    expect(blockHasSubSettings("model")).toBe(true);
    expect(blockHasSubSettings("cache")).toBe(true);
  });

  it("returns false for every other known block", () => {
    for (const id of KNOWN_BLOCK_IDS as readonly BlockId[]) {
      if (id === "model" || id === "cache") continue;
      expect(blockHasSubSettings(id)).toBe(false);
    }
  });
});
