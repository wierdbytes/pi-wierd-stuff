/**
 * How many `@tintinweb/pi-subagents` agents are queued or running right now.
 * They run inside pi, so herdr-core never sees them as child terminals;
 * the count goes out as `agent.subagents` instead. Reads the same
 * `subagents:*` bus events the statusline's chip does, without depending on
 * the package.
 */

export const SUBAGENT_EVENTS = {
  CREATED: "subagents:created",
  STARTED: "subagents:started",
  COMPLETED: "subagents:completed",
  FAILED: "subagents:failed",
} as const;

interface Bus {
  on(channel: string, handler: (data: unknown) => void): () => void;
}

const idOf = (data: unknown): string | undefined => {
  const id = (data as { id?: unknown } | null)?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
};

export class SubagentCounter {
  private readonly active = new Set<string>();
  private readonly offs: Array<() => void> = [];

  constructor(private readonly onChange: () => void) {}

  start(bus: Bus): void {
    if (this.offs.length) return;
    const add = (data: unknown) => {
      const id = idOf(data);
      if (!id || this.active.has(id)) return;
      this.active.add(id);
      this.onChange();
    };
    const remove = (data: unknown) => {
      const id = idOf(data);
      if (!id || !this.active.delete(id)) return;
      this.onChange();
    };
    this.offs.push(
      bus.on(SUBAGENT_EVENTS.CREATED, add),
      bus.on(SUBAGENT_EVENTS.STARTED, add),
      bus.on(SUBAGENT_EVENTS.COMPLETED, remove),
      bus.on(SUBAGENT_EVENTS.FAILED, remove),
    );
  }

  get count(): number {
    return this.active.size;
  }

  reset(): void {
    if (this.active.size === 0) return;
    this.active.clear();
    this.onChange();
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) {
      try {
        off();
      } catch {
        // Unsubscribing never matters enough to disturb pi.
      }
    }
    this.active.clear();
  }
}
