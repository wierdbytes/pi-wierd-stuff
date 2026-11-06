import { describe, expect, it, vi } from "vitest";
import { SUBAGENT_EVENTS, SubagentCounter } from "./subagents.ts";

function bus() {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    on(channel: string, handler: (data: unknown) => void) {
      if (!handlers.has(channel)) handlers.set(channel, new Set());
      handlers.get(channel)!.add(handler);
      return () => handlers.get(channel)!.delete(handler);
    },
    emit(channel: string, data: unknown) {
      for (const h of handlers.get(channel) ?? []) h(data);
    },
    size: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
  };
}

describe("SubagentCounter", () => {
  it("counts queued and running agents until they finish", () => {
    const b = bus();
    const onChange = vi.fn();
    const c = new SubagentCounter(onChange);
    c.start(b);
    b.emit(SUBAGENT_EVENTS.CREATED, { id: "a" });
    b.emit(SUBAGENT_EVENTS.STARTED, { id: "a" });
    b.emit(SUBAGENT_EVENTS.STARTED, { id: "b" });
    expect(c.count).toBe(2);
    b.emit(SUBAGENT_EVENTS.COMPLETED, { id: "a" });
    b.emit(SUBAGENT_EVENTS.FAILED, { id: "b" });
    expect(c.count).toBe(0);
    // created a, started b, completed a, failed b: started a was no change.
    expect(onChange).toHaveBeenCalledTimes(4);
  });

  it("ignores payloads without an id and unknown finishes", () => {
    const b = bus();
    const onChange = vi.fn();
    const c = new SubagentCounter(onChange);
    c.start(b);
    b.emit(SUBAGENT_EVENTS.CREATED, null);
    b.emit(SUBAGENT_EVENTS.CREATED, { id: "" });
    b.emit(SUBAGENT_EVENTS.COMPLETED, { id: "never-started" });
    expect(c.count).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reset empties the count, dispose unsubscribes", () => {
    const b = bus();
    const c = new SubagentCounter(() => {});
    c.start(b);
    c.start(b);
    expect(b.size()).toBe(4);
    b.emit(SUBAGENT_EVENTS.CREATED, { id: "a" });
    c.reset();
    expect(c.count).toBe(0);
    c.dispose();
    expect(b.size()).toBe(0);
  });
});
