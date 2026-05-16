/**
 * Unit tests for the layout-config normalisation + migration rules.
 *
 * These run in isolation — no disk I/O, no `loadEventsConfig` —
 * because `normaliseLayoutConfig` is the only piece responsible for
 * the merge / clamp semantics. Disk migration is covered indirectly
 * through `setLayoutConfig`'s round-trip (tested by exercising the
 * exported helper in-memory).
 */

import { describe, expect, it } from "vitest";

import { KNOWN_BLOCK_IDS } from "./blocks.ts";
import {
  clampSeparator,
  cloneDefaultLayout,
  DEFAULT_LAYOUT_CONFIG,
  DEFAULT_SEPARATOR,
  normaliseLayoutConfig,
} from "./layout-config.ts";

describe("normaliseLayoutConfig", () => {
  it("returns a fresh defaults clone for undefined input", () => {
    const out = normaliseLayoutConfig(undefined);
    expect(out).toEqual(cloneDefaultLayout());
    // The result must be mutable.
    expect(() => {
      out.order.reverse();
    }).not.toThrow();
  });

  it("drops unknown block ids from order", () => {
    const out = normaliseLayoutConfig({
      // @ts-expect-error — exercising the bad-input branch.
      order: ["model", "frobulator", "path"],
    });
    expect(out.order).not.toContain("frobulator");
    expect(out.order[0]).toBe("model");
    expect(out.order).toContain("path");
  });

  it("appends missing known ids to the tail of order", () => {
    const out = normaliseLayoutConfig({
      order: ["tokens", "git"],
    });
    // The two ids the caller provided come first…
    expect(out.order.slice(0, 2)).toEqual(["tokens", "git"]);
    // …and every other known id is appended.
    for (const id of KNOWN_BLOCK_IDS) {
      expect(out.order).toContain(id);
    }
    expect(out.order.length).toBe(KNOWN_BLOCK_IDS.length);
  });

  it("de-duplicates repeated ids in order", () => {
    const out = normaliseLayoutConfig({
      // Hand-edited JSON can have duplicates — the type allows the
      // shape, the normaliser is what enforces uniqueness.
      order: ["model", "model", "path", "path", "git"],
    });
    const counts = new Map<string, number>();
    for (const id of out.order) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const [, c] of counts) expect(c).toBe(1);
    expect(out.order[0]).toBe("model");
  });

  it("treats missing enabled keys as true", () => {
    const out = normaliseLayoutConfig({
      // Only one key supplied — every other known id should be true.
      enabled: { git: false } as Record<string, boolean>,
    });
    expect(out.enabled.git).toBe(false);
    for (const id of KNOWN_BLOCK_IDS) {
      if (id === "git") continue;
      expect(out.enabled[id]).toBe(true);
    }
  });

  it("merges model sub-toggles", () => {
    const out = normaliseLayoutConfig({
      model: { showThinking: false },
    });
    expect(out.model.showThinking).toBe(false);
  });

  it("merges tokens sub-toggles independently", () => {
    const out = normaliseLayoutConfig({
      tokens: { input: false, output: true, cacheRead: false, cacheWrite: true },
    });
    expect(out.tokens).toEqual({
      input: false,
      output: true,
      cacheRead: false,
      cacheWrite: true,
    });
  });

  it("falls back to default separator for an empty string", () => {
    const out = normaliseLayoutConfig({ separator: "" });
    expect(out.separator).toBe(DEFAULT_SEPARATOR);
  });

  it("preserves valid separator glyphs", () => {
    for (const sep of ["│", "·", "▎", ":", " ", "::"]) {
      const out = normaliseLayoutConfig({ separator: sep });
      expect(out.separator).toBe(sep);
    }
  });

  it("truncates oversized separator strings", () => {
    const out = normaliseLayoutConfig({ separator: "xxxx" });
    expect(out.separator).toBe("xx");
  });

  it("strips newlines / tabs from separator", () => {
    const out = normaliseLayoutConfig({ separator: "\n│\t" });
    expect(out.separator).toBe("│");
  });

  it("is idempotent on its own output", () => {
    const first = normaliseLayoutConfig({
      order: ["chips", "model"],
      enabled: { tokens: false },
      tokens: { input: false },
      separator: "·",
    } as Parameters<typeof normaliseLayoutConfig>[0]);
    const second = normaliseLayoutConfig(first);
    expect(second).toEqual(first);
  });

  it("uses defaults when raw is not an object", () => {
    // Cast-through-unknown because the function deliberately accepts
    // garbage from a hand-edited JSON file.
    const out = normaliseLayoutConfig("not an object" as unknown as Parameters<
      typeof normaliseLayoutConfig
    >[0]);
    expect(out).toEqual(cloneDefaultLayout());
  });
});

describe("clampSeparator", () => {
  it("returns default for non-string input", () => {
    expect(clampSeparator(undefined)).toBe(DEFAULT_SEPARATOR);
    expect(clampSeparator(null)).toBe(DEFAULT_SEPARATOR);
    expect(clampSeparator(42)).toBe(DEFAULT_SEPARATOR);
  });

  it("preserves the canonical defaults exposed on DEFAULT_LAYOUT_CONFIG", () => {
    expect(DEFAULT_LAYOUT_CONFIG.separator).toBe(DEFAULT_SEPARATOR);
    expect(DEFAULT_LAYOUT_CONFIG.order).toEqual([...KNOWN_BLOCK_IDS]);
    for (const id of KNOWN_BLOCK_IDS) {
      expect(DEFAULT_LAYOUT_CONFIG.enabled[id]).toBe(true);
    }
    expect(DEFAULT_LAYOUT_CONFIG.model.showThinking).toBe(true);
    expect(DEFAULT_LAYOUT_CONFIG.tokens).toEqual({
      input: true,
      output: true,
      cacheRead: true,
      cacheWrite: true,
    });
  });
});

describe("cloneDefaultLayout", () => {
  it("returns a deep mutable copy", () => {
    const a = cloneDefaultLayout();
    const b = cloneDefaultLayout();
    a.order.push("model");
    a.enabled.git = false;
    a.model.showThinking = false;
    a.tokens.input = false;
    // Mutating one clone must not affect the other.
    expect(b.order).toEqual([...KNOWN_BLOCK_IDS]);
    expect(b.enabled.git).toBe(true);
    expect(b.model.showThinking).toBe(true);
    expect(b.tokens.input).toBe(true);
  });
});
