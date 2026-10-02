/**
 * Unit tests for the pure helpers behind the per-block settings
 * submenu. The full Component needs a live TUI handle so it stays
 * untested at this layer; the row builder + `blockHasSubSettings`
 * predicate carry all the behaviour-bearing logic.
 */

import { describe, expect, it } from "vitest";

import { KNOWN_BLOCK_IDS, type BlockId } from "./blocks.ts";
import { blockHasSubSettings, buildBlockSettingsRows } from "./block-settings-submenu.ts";
import { cloneDefaultLayout } from "./layout-config.ts";

describe("buildBlockSettingsRows", () => {
  it("returns one row for the model block: Show thinking", () => {
    const layout = cloneDefaultLayout();
    const rows = buildBlockSettingsRows("model", layout);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("model.showThinking");
  });

  it("returns hit-rate, savings and timer toggles for the cache block", () => {
    const layout = cloneDefaultLayout();
    const rows = buildBlockSettingsRows("cache", layout);
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(["cache.hitRate", "cache.savings", "cache.timer"]);
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
    expect(patch.cache).toEqual({ hitRate: true, savings: false, timer: true });
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
