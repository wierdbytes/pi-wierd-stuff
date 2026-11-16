import { describe, expect, it, vi } from "vitest";
import { TERMINAL_DETAIL, terminalOf, withTerminal } from "./bash-tool.ts";

describe("terminalOf", () => {
  it("reads the terminal from a partial result's details", () => {
    expect(terminalOf({ [TERMINAL_DETAIL]: "t14s", truncation: {} })).toBe("t14s");
    expect(terminalOf({ [TERMINAL_DETAIL]: "" })).toBeUndefined();
    expect(terminalOf({ [TERMINAL_DETAIL]: 7 })).toBeUndefined();
    expect(terminalOf(undefined)).toBeUndefined();
    expect(terminalOf(null)).toBeUndefined();
  });
});

describe("withTerminal", () => {
  it("passes updates through until the terminal is known", () => {
    const onUpdate = vi.fn();
    const updates = withTerminal(onUpdate);
    updates.onUpdate?.({ content: [], details: undefined });
    expect(onUpdate).toHaveBeenLastCalledWith({ content: [], details: undefined });
  });

  it("sends an update when the terminal starts, then adds it to every update", () => {
    const onUpdate = vi.fn();
    const updates = withTerminal(onUpdate);
    updates.started("t14s");
    expect(onUpdate).toHaveBeenLastCalledWith({ content: [], details: { [TERMINAL_DETAIL]: "t14s" } });
    const truncation = { truncated: true };
    updates.onUpdate?.({ content: [{ type: "text", text: "out" }], details: { truncation } });
    expect(onUpdate).toHaveBeenLastCalledWith({
      content: [{ type: "text", text: "out" }],
      details: { truncation, [TERMINAL_DETAIL]: "t14s" },
    });
  });

  it("does nothing without a callback", () => {
    const updates = withTerminal(undefined);
    expect(updates.onUpdate).toBeUndefined();
    expect(() => updates.started("t1")).not.toThrow();
  });
});
