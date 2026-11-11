import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Doc } from "./hc.ts";
import { type LimitReading, type LimitsDoc, readingFromHeaders } from "./limits.ts";
import { type DocStore, LimitsPublisher } from "./limits-publisher.ts";

const reading = (used5h: number): LimitReading =>
  readingFromHeaders({
    "anthropic-organization-id": "org",
    "anthropic-ratelimit-unified-status": "allowed",
    "anthropic-ratelimit-unified-5h-utilization": String(used5h / 100),
    "anthropic-ratelimit-unified-5h-reset": "1794321600",
  })!;
const account = { slug: "0rg00000" };
const key = "claude.0rg00000";

/** An in-memory core document with doc.get / doc.set semantics. */
class FakeStore implements DocStore {
  doc: Doc = { value: null, version: 0 };
  sets = 0;
  /** Runs before each set is checked: another writer racing us. */
  race: (() => void) | undefined;
  down = false;
  async get() {
    return this.down ? undefined : structuredClone(this.doc);
  }
  async set(value: LimitsDoc, version: number) {
    if (this.down) return undefined;
    this.sets++;
    this.race?.();
    if (version !== this.doc.version) return "conflict" as const;
    this.doc = { value: structuredClone(value), version: version + 1 };
    return this.doc.version;
  }
  used(window = "5h") {
    return (this.doc.value as LimitsDoc | null)?.accounts[key]?.windows[window]?.used;
  }
}

describe("LimitsPublisher", () => {
  let store: FakeStore;
  let now: number;
  const make = () => new LimitsPublisher(store, { debounceMs: 100, host: "mac", now: () => now });

  beforeEach(() => {
    vi.useFakeTimers();
    store = new FakeStore();
    now = 1_000_000;
  });
  afterEach(() => vi.useRealTimers());

  it("collapses readings inside the debounce window into one write", async () => {
    const p = make();
    p.record(reading(10), account);
    p.record(reading(12), account);
    await vi.advanceTimersByTimeAsync(100);
    expect(store.sets).toBe(1);
    expect(store.used()).toBe(12);
    expect((store.doc.value as LimitsDoc).accounts[key]).toMatchObject({ host: "mac", at: 1000 });
  });

  it("writes every reading, even with the same numbers, so `at` says when it was read", async () => {
    const p = make();
    p.record(reading(10), account);
    await p.flush();
    now += 30_000;
    p.record(reading(10), account);
    await vi.advanceTimersByTimeAsync(100);
    expect(store.sets).toBe(2);
    const acc = (store.doc.value as LimitsDoc).accounts[key];
    expect(acc?.at).toBe(1030);
    expect(acc?.windows["5h"]?.at).toBe(1030);
  });

  it("folds into what another writer stored in between, retrying on conflict", async () => {
    const other = new LimitsPublisher(store, { now: () => now });
    other.record({ ...reading(50), provider: "codex" }, { slug: "c0ffee00" });
    const p = make();
    p.record(reading(20), account);
    let raced = false;
    store.race = () => {
      if (raced) return;
      raced = true;
      store.race = undefined;
      void other.flush();
    };
    await p.flush();
    await other.flush();
    const doc = store.doc.value as LimitsDoc;
    expect(Object.keys(doc.accounts).sort()).toEqual([key, "codex.c0ffee00"]);
    expect(store.used()).toBe(20);
  });

  it("drops a failed write; the next reading lands", async () => {
    const p = make();
    store.down = true;
    p.record(reading(10), account);
    await p.flush();
    expect(store.doc.version).toBe(0);
    store.down = false;
    p.record(reading(10), account);
    await p.flush();
    expect(store.used()).toBe(10);
  });

  it("gives up after its attempts when the document never settles", async () => {
    const p = new LimitsPublisher(store, { attempts: 3 });
    store.race = () => {
      store.doc = { ...store.doc, version: store.doc.version + 1 };
    };
    p.record(reading(10), account);
    await p.flush();
    expect(store.sets).toBe(3);
    expect(store.used()).toBeUndefined();
  });

  it("cancel drops what is queued", async () => {
    const p = make();
    p.record(reading(10), account);
    p.cancel();
    await vi.advanceTimersByTimeAsync(500);
    expect(store.sets).toBe(0);
  });
});
