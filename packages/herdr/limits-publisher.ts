/**
 * Writes the limits pi reads from provider responses into herdr-core's
 * `limits` document, cheaply and without losing anyone's writes:
 *
 *   - every reading is written, even with the same numbers: `at` says when
 *     a provider last confirmed them, so readers tell live data from stale;
 *   - readings inside the debounce window go out as one write;
 *   - every write reads the document, folds into it and writes it back at
 *     the version it read; when another pi wrote in between, it reads again
 *     and retries;
 *   - a failed write is dropped, not retried: the next response carries a
 *     fresh reading anyway.
 *
 * Never throws and never blocks pi: hooks only queue.
 */

import type { Doc } from "./hc.ts";
import {
  asLimitsDoc,
  foldReading,
  type LimitAccount,
  type LimitReading,
  type LimitsDoc,
} from "./limits.ts";

export interface DocStore {
  get(): Promise<Doc | undefined>;
  /** The new version, `"conflict"` when the document moved on, undefined on failure. */
  set(value: LimitsDoc, version: number): Promise<number | "conflict" | undefined>;
}

export interface LimitsPublisherOptions {
  debounceMs?: number;
  /** Writes tried per flush before giving up on conflicts. */
  attempts?: number;
  /** The machine name stored with each reading. */
  host?: string;
  now?: () => number;
}

interface Pending {
  reading: LimitReading;
  account: LimitAccount;
  at: number;
}

export class LimitsPublisher {
  private pending: Pending[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private draining: Promise<void> | undefined;
  private again = false;
  private readonly debounceMs: number;
  private readonly attempts: number;
  private readonly now: () => number;

  constructor(
    private readonly store: DocStore,
    private readonly options: LimitsPublisherOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 500;
    this.attempts = options.attempts ?? 5;
    this.now = options.now ?? Date.now;
  }

  /** Queue a reading; it is written within the debounce window. */
  record(reading: LimitReading, account: LimitAccount): void {
    this.pending.push({ reading, account, at: this.now() });
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /** Write what is queued now. Resolves once it landed or the write failed. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.draining) {
      this.again = true;
      return this.draining;
    }
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  /** Drop what is queued (pi is quitting and can't wait). */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = [];
  }

  private async drain(): Promise<void> {
    do {
      this.again = false;
      const batch = this.pending;
      this.pending = [];
      if (batch.length) await this.write(batch).catch(() => undefined);
    } while (this.again);
  }

  private async write(batch: Pending[]): Promise<void> {
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      const current = await this.store.get();
      if (!current) return;
      let doc = asLimitsDoc(current.value);
      for (const p of batch) doc = foldReading(doc, p.reading, p.account, Math.floor(p.at / 1000), this.options.host);
      const result = await this.store.set(doc, current.version);
      if (result !== "conflict") return;
    }
  }
}
