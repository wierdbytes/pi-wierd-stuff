import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LABEL_KEYS } from "./meta.ts";
import { LabelPublisher } from "./publisher.ts";

describe("LabelPublisher", () => {
  let sent: Record<string, string>[];
  let ok: boolean;
  const send = vi.fn(async (labels: Record<string, string>) => {
    sent.push(labels);
    return ok;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    ok = true;
    send.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("collapses changes inside the debounce window into one write", async () => {
    const p = new LabelPublisher(send, 100);
    p.publish({ "agent.ctx": "1" });
    p.publish({ "agent.ctx": "2" });
    p.publish({ "agent.ctx": "3", "agent.model": "M" });
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toEqual([{ "agent.ctx": "3", "agent.model": "M" }]);
  });

  it("skips writes that change nothing and removes dropped keys", async () => {
    const p = new LabelPublisher(send, 10);
    p.publish({ "agent.model": "M", "agent.effort": "high" });
    await p.flush();
    p.publish({ "agent.model": "M", "agent.effort": "high" });
    await p.flush();
    p.publish({ "agent.model": "M" });
    await p.flush();
    expect(sent).toEqual([{ "agent.model": "M", "agent.effort": "high" }, { "agent.effort": "" }]);
  });

  it("retries the difference after a failed write", async () => {
    const p = new LabelPublisher(send, 10);
    ok = false;
    p.publish({ "agent.ctx": "1" });
    await p.flush();
    ok = true;
    p.publish({ "agent.ctx": "1", "agent.model": "M" });
    await p.flush();
    expect(sent).toEqual([{ "agent.ctx": "1" }, { "agent.ctx": "1", "agent.model": "M" }]);
  });

  it("sends what was queued while a write was out", async () => {
    let release: () => void = () => {};
    const slow = vi.fn(
      (labels: Record<string, string>) =>
        new Promise<boolean>((resolve) => {
          sent.push(labels);
          release = () => resolve(true);
        }),
    );
    const p = new LabelPublisher(slow, 10);
    p.publish({ "agent.ctx": "1" });
    const first = p.flush();
    p.publish({ "agent.ctx": "2" });
    const second = p.flush();
    release();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await Promise.all([first, second]);
    expect(sent).toEqual([{ "agent.ctx": "1" }, { "agent.ctx": "2" }]);
  });

  it("cancel drops queued work but keeps publishing afterwards", async () => {
    const p = new LabelPublisher(send, 100);
    p.publish({ "agent.ctx": "1" });
    p.cancel();
    await vi.advanceTimersByTimeAsync(200);
    expect(sent).toEqual([]);
    p.publish({ "agent.ctx": "2" });
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toEqual([{ "agent.ctx": "2" }]);
  });

  it("clear removes every owned label and stops publishing", async () => {
    const p = new LabelPublisher(send, 10);
    p.publish({ "agent.model": "M" });
    await p.flush();
    await p.clear();
    p.publish({ "agent.model": "N" });
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toHaveLength(2);
    expect(Object.keys(sent[1]).sort()).toEqual([...LABEL_KEYS].sort());
  });
});
