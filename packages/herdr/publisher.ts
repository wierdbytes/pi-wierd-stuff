/**
 * Keeps the terminal's `agent.*` labels in step with pi, with as few socket
 * round trips as possible: changes inside the debounce window collapse into
 * one request, unchanged values are never sent, and only one request is in
 * flight at a time. A failed write keeps the old picture, so the next
 * publish retries the difference.
 */

import { clearLabels, diffLabels, type Labels } from "./meta.ts";

export type SendLabels = (labels: Record<string, string>) => Promise<boolean>;

export class LabelPublisher {
  /** What the terminal is believed to carry. */
  private applied: Labels = {};
  /** What it should carry once the queue drains. */
  private desired: Labels = {};
  private timer: ReturnType<typeof setTimeout> | undefined;
  private draining: Promise<void> | undefined;
  /** A flush came in while a write was out: go around once more. */
  private again = false;
  private stopped = false;

  constructor(
    private readonly send: SendLabels,
    private readonly debounceMs = 150,
  ) {}

  /** Schedule the terminal to carry exactly `labels`. */
  publish(labels: Labels): void {
    if (this.stopped) return;
    this.desired = labels;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /** Send the pending difference now. Resolves once the terminal has it (or the write failed). */
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

  private async drain(): Promise<void> {
    do {
      this.again = false;
      if (this.stopped) return;
      const target = this.desired;
      const change = diffLabels(this.applied, target);
      if (Object.keys(change).length === 0) continue;
      const ok = await this.send(change).catch(() => false);
      if (!ok) return;
      this.applied = target;
    } while (this.again);
  }

  /** Stop publishing and remove every owned label (pi is quitting). */
  async clear(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.draining) await this.draining;
    await this.send(clearLabels()).catch(() => false);
    this.applied = {};
    this.desired = {};
  }

  /**
   * Drop what is queued without touching the terminal: the session is being
   * replaced and its successor republishes at its own start. Publishing
   * again later works as before.
   */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.desired = this.applied;
  }
}
