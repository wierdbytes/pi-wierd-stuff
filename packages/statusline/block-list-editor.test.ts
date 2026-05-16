/**
 * Unit tests for the pure block-list-editor helpers. The full
 * `createBlockListEditor()` factory needs a TUI handle so it stays
 * untested at this layer — every behaviour-bearing helper it relies
 * on (`moveBlock`, `toggleBlock`, `defaultBlockLayoutValue`,
 * `normaliseBlockLayoutValue`) is exercised here in isolation.
 */

import { describe, expect, it } from "vitest";

import { KNOWN_BLOCK_IDS, type BlockId } from "./blocks.ts";
import {
  defaultBlockLayoutValue,
  moveBlock,
  normaliseBlockLayoutValue,
  toggleBlock,
} from "./block-list-editor.ts";

describe("moveBlock", () => {
  const sample: BlockId[] = ["model", "path", "git", "context"];

  it("swaps neighbours up", () => {
    const out = moveBlock(sample, 2, -1);
    expect(out).toEqual(["model", "git", "path", "context"]);
  });

  it("swaps neighbours down", () => {
    const out = moveBlock(sample, 1, 1);
    expect(out).toEqual(["model", "git", "path", "context"]);
  });

  it("is a no-op at the top edge", () => {
    const out = moveBlock(sample, 0, -1);
    expect(out).toEqual(sample);
  });

  it("is a no-op at the bottom edge", () => {
    const out = moveBlock(sample, sample.length - 1, 1);
    expect(out).toEqual(sample);
  });

  it("returns a fresh array (does not mutate the input)", () => {
    const input = [...sample];
    const out = moveBlock(input, 1, 1);
    expect(input).toEqual(sample);
    expect(out).not.toBe(input);
  });

  it("handles out-of-range indices defensively", () => {
    expect(moveBlock(sample, -1, 1)).toEqual(sample);
    expect(moveBlock(sample, 99, -1)).toEqual(sample);
  });
});

describe("toggleBlock", () => {
  const enabled = {
    model: true,
    path: true,
    git: true,
    context: true,
    cost: true,
    tokens: true,
    chips: true,
    stash: true,
  } as Record<BlockId, boolean>;

  it("flips one block independently", () => {
    const next = toggleBlock(enabled, "git");
    expect(next.git).toBe(false);
    // Every other id stays untouched.
    for (const id of KNOWN_BLOCK_IDS) {
      if (id === "git") continue;
      expect(next[id]).toBe(true);
    }
  });

  it("does not mutate the input", () => {
    toggleBlock(enabled, "git");
    expect(enabled.git).toBe(true);
  });

  it("round-trips through two toggles", () => {
    const a = toggleBlock(enabled, "tokens");
    const b = toggleBlock(a, "tokens");
    expect(b).toEqual(enabled);
  });
});

describe("defaultBlockLayoutValue", () => {
  it("returns every known block enabled in the canonical order", () => {
    const v = defaultBlockLayoutValue();
    expect(v.order).toEqual([...KNOWN_BLOCK_IDS]);
    for (const id of KNOWN_BLOCK_IDS) {
      expect(v.enabled[id]).toBe(true);
    }
  });

  it("returns mutable copies (callers can mutate without crashing)", () => {
    const v = defaultBlockLayoutValue();
    expect(() => v.order.push("model")).not.toThrow();
    expect(() => {
      v.enabled.git = false;
    }).not.toThrow();
  });
});

describe("normaliseBlockLayoutValue", () => {
  it("appends missing known ids to the tail", () => {
    const v = normaliseBlockLayoutValue({
      order: ["model"],
      enabled: { model: true } as Record<BlockId, boolean>,
    });
    expect(v.order[0]).toBe("model");
    for (const id of KNOWN_BLOCK_IDS) expect(v.order).toContain(id);
    expect(v.order.length).toBe(KNOWN_BLOCK_IDS.length);
  });

  it("drops unknown ids from order", () => {
    const v = normaliseBlockLayoutValue({
      // @ts-expect-error — unknown id from a hand-edited json
      order: ["model", "frobulator", "path"],
      enabled: {} as Record<BlockId, boolean>,
    });
    expect(v.order).not.toContain("frobulator" as never);
  });

  it("defaults missing enabled keys to true", () => {
    const v = normaliseBlockLayoutValue({
      order: [...KNOWN_BLOCK_IDS],
      enabled: { git: false } as Record<BlockId, boolean>,
    });
    expect(v.enabled.git).toBe(false);
    for (const id of KNOWN_BLOCK_IDS) {
      if (id === "git") continue;
      expect(v.enabled[id]).toBe(true);
    }
  });
});
