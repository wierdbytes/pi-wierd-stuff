/**
 * Unit tests for the no-repeat + debounce picker. Pure-function tests
 * with injected clock + RNG — no fs / network needed.
 */

import { describe, expect, it } from "vitest";
import { createPickerState, pickSound } from "./picker.ts";
import type { ResolvedSound } from "./pack.ts";

const SOUNDS: ResolvedSound[] = [
  { absPath: "/a.wav", label: "A", resolvedCategory: "session.start" },
  { absPath: "/b.wav", label: "B", resolvedCategory: "session.start" },
  { absPath: "/c.wav", label: "C", resolvedCategory: "session.start" },
];

describe("pickSound", () => {
  it("returns null for empty candidates", () => {
    const state = createPickerState();
    expect(pickSound(state, "p", "session.start", [])).toBeNull();
  });

  it("never picks the same sound twice in a row when >1 available", () => {
    const state = createPickerState();
    let now = 0;
    const random = () => 0; // would always pick index 0 → "A"

    // First call: 3 candidates, picks A (index 0).
    const first = pickSound(state, "p", "session.start", SOUNDS, {
      random,
      now: () => now,
      debounceMs: 0,
    });
    expect(first?.label).toBe("A");

    // Second call past debounce: should now skip A and pick the first
    // of the remaining pool (B).
    now = 1_000;
    const second = pickSound(state, "p", "session.start", SOUNDS, {
      random,
      now: () => now,
      debounceMs: 0,
    });
    expect(second?.label).toBe("B");
  });

  it("returns the only sound repeatedly when count === 1", () => {
    const state = createPickerState();
    const single = SOUNDS.slice(0, 1);
    let now = 0;
    for (let i = 0; i < 5; i++) {
      now += 1_000;
      const p = pickSound(state, "p", "session.start", single, {
        now: () => now,
        debounceMs: 0,
      });
      expect(p?.label).toBe("A");
    }
  });

  it("debounces calls within the configured window", () => {
    const state = createPickerState();
    let now = 0;
    const first = pickSound(state, "p", "session.start", SOUNDS, {
      now: () => now,
      debounceMs: 500,
    });
    expect(first).not.toBeNull();

    now = 200; // <500ms later
    const debounced = pickSound(state, "p", "session.start", SOUNDS, {
      now: () => now,
      debounceMs: 500,
    });
    expect(debounced).toBeNull();

    now = 600; // >500ms — should fire
    const next = pickSound(state, "p", "session.start", SOUNDS, {
      now: () => now,
      debounceMs: 500,
    });
    expect(next).not.toBeNull();
  });

  it("isolates state across packs", () => {
    const state = createPickerState();
    let now = 0;
    // Pack A first call — debounces would only suppress *its own*
    // future calls.
    const pA = pickSound(state, "packA", "session.start", SOUNDS, {
      now: () => now,
      debounceMs: 500,
    });
    expect(pA).not.toBeNull();
    // Pack B fires immediately afterwards — different bucket, should
    // not be debounced.
    const pB = pickSound(state, "packB", "session.start", SOUNDS, {
      now: () => now,
      debounceMs: 500,
    });
    expect(pB).not.toBeNull();
  });

  it("isolates state across categories", () => {
    const state = createPickerState();
    let now = 0;
    const a = pickSound(state, "p", "session.start", SOUNDS, {
      now: () => now,
      debounceMs: 500,
    });
    expect(a).not.toBeNull();
    // Different category at the same instant — separate bucket.
    const b = pickSound(state, "p", "task.complete", SOUNDS, {
      now: () => now,
      debounceMs: 500,
    });
    expect(b).not.toBeNull();
  });
});
