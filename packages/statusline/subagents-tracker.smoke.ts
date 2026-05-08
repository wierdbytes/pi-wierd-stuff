/**
 * Lightweight smoke harness for SubagentsTracker.
 *
 * Run with:
 *   npx tsx packages/statusline/subagents-tracker.smoke.ts
 *
 * Drives the tracker against a fake `pi.events` bus and asserts that
 * the synthetic `notify:status` / `notify:toast` payloads it emits
 * match the expected shapes for every lifecycle path. No real pi
 * runtime, no statusline rendering — just the bridge contract.
 */

import { PI_WIERD_EVENTS } from "@wierdbytes/pi-events";
import { DEFAULT_EVENTS_CONFIG } from "./events-config.ts";
import { DEFAULT_ICON_SET, ICON_SETS } from "./icons.ts";
import {
  SUBAGENT_EVENTS,
  SUBAGENT_SOURCE,
  SubagentsTracker,
} from "./subagents-tracker.ts";

// Tracker resolves icons against the active icon set on every emit.
// The smoke test always runs against the default set so the assertions
// stay deterministic; if the default set changes, the resolved icons
// here update with it.
const DEFAULT_ICONS = ICON_SETS[DEFAULT_ICON_SET];

interface RecordedEmit {
  channel: string;
  data: any;
}

function makeFakeBus() {
  const handlers = new Map<string, Set<(d: unknown) => void>>();
  const emitted: RecordedEmit[] = [];

  return {
    bus: {
      events: {
        emit(channel: string, data: unknown) {
          emitted.push({ channel, data });
          const set = handlers.get(channel);
          if (set) for (const fn of set) fn(data);
        },
        on(channel: string, handler: (d: unknown) => void) {
          let set = handlers.get(channel);
          if (!set) {
            set = new Set();
            handlers.set(channel, set);
          }
          set.add(handler);
          return () => set!.delete(handler);
        },
      },
    },
    emitted,
    /** Fire a lifecycle event onto the bus without going through the
     *  tracker's emit recorder. */
    fire(channel: string, data: unknown) {
      const set = handlers.get(channel);
      if (set) for (const fn of set) fn(data);
    },
  };
}

let failures = 0;
function assert(cond: unknown, label: string): void {
  if (!cond) {
    failures++;
    console.error(`  ✗ ${label}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
}

function lastStatus(emitted: RecordedEmit[]) {
  for (let i = emitted.length - 1; i >= 0; i--) {
    if (emitted[i].channel === PI_WIERD_EVENTS.STATUS) return emitted[i].data;
  }
  return undefined;
}

function lastToast(emitted: RecordedEmit[]) {
  for (let i = emitted.length - 1; i >= 0; i--) {
    if (emitted[i].channel === PI_WIERD_EVENTS.TOAST) return emitted[i].data;
  }
  return undefined;
}

function countToasts(emitted: RecordedEmit[]): number {
  return emitted.filter((e) => e.channel === PI_WIERD_EVENTS.TOAST).length;
}

function countStatuses(emitted: RecordedEmit[]): number {
  return emitted.filter((e) => e.channel === PI_WIERD_EVENTS.STATUS).length;
}

console.log("──────────── SubagentsTracker smoke ────────────");

// ─────────────────── happy path: created → started → completed (fast)
{
  console.log("\n[happy path: fast completion does NOT toast]");
  const { bus, emitted, fire } = makeFakeBus();
  const tracker = new SubagentsTracker(bus, () => DEFAULT_EVENTS_CONFIG.subagents);
  tracker.start();

  fire(SUBAGENT_EVENTS.CREATED, { id: "a1", type: "Explore", description: "find auth" });
  fire(SUBAGENT_EVENTS.STARTED, { id: "a1", type: "Explore", description: "find auth" });

  let chip = lastStatus(emitted);
  assert(chip?.state === "active", "chip is active while running");
  assert(chip?.progress?.current === 1 && chip?.progress?.total === 1, "1/1 running/total");
  assert(
    chip?.icon === DEFAULT_ICONS.agents,
    `chip uses default-set agents icon (${DEFAULT_ICONS.agents})`,
  );
  assert(chip?.source === SUBAGENT_SOURCE, `source is ${SUBAGENT_SOURCE}`);

  fire(SUBAGENT_EVENTS.COMPLETED, {
    id: "a1",
    type: "Explore",
    description: "find auth",
    status: "completed",
    durationMs: 1500, // < 30s threshold
  });

  chip = lastStatus(emitted);
  assert(chip?.state === "done", "chip transitions to done when total hits 0");
  assert(countToasts(emitted) === 0, "no toast for fast completion");

  tracker.dispose();
}

// ─────────────────── two parallel agents, one queued
{
  console.log("\n[parallel: two created, one started]");
  const { bus, emitted, fire } = makeFakeBus();
  const tracker = new SubagentsTracker(bus, () => DEFAULT_EVENTS_CONFIG.subagents);
  tracker.start();

  fire(SUBAGENT_EVENTS.CREATED, { id: "a1", type: "Explore" });
  fire(SUBAGENT_EVENTS.CREATED, { id: "a2", type: "Plan" });
  fire(SUBAGENT_EVENTS.STARTED, { id: "a1", type: "Explore" });

  const chip = lastStatus(emitted);
  assert(chip?.state === "active", "active while at least one agent");
  assert(
    chip?.progress?.current === 1 && chip?.progress?.total === 2,
    "renders 1/2 (one running + one queued)",
  );

  // Now the second one starts
  fire(SUBAGENT_EVENTS.STARTED, { id: "a2", type: "Plan" });
  const c2 = lastStatus(emitted);
  assert(c2?.progress?.current === 2 && c2?.progress?.total === 2, "renders 2/2");

  // And both finish, fast
  fire(SUBAGENT_EVENTS.COMPLETED, { id: "a1", type: "Explore", durationMs: 100, status: "completed" });
  fire(SUBAGENT_EVENTS.COMPLETED, { id: "a2", type: "Plan", durationMs: 100, status: "completed" });
  const c3 = lastStatus(emitted);
  assert(c3?.state === "done", "chip clears after all agents finish");

  tracker.dispose();
}

// ─────────────────── failure always toasts (red)
{
  console.log("\n[failure: emits red toast]");
  const { bus, emitted, fire } = makeFakeBus();
  const tracker = new SubagentsTracker(bus, () => DEFAULT_EVENTS_CONFIG.subagents);
  tracker.start();

  fire(SUBAGENT_EVENTS.CREATED, { id: "a1", type: "Agent" });
  fire(SUBAGENT_EVENTS.STARTED, { id: "a1", type: "Agent" });
  fire(SUBAGENT_EVENTS.FAILED, {
    id: "a1",
    type: "Agent",
    status: "error",
    error: "tool returned non-zero",
    durationMs: 4200,
  });

  const toast = lastToast(emitted);
  assert(toast?.level === "error", "failure toast is error level");
  assert(typeof toast?.message === "string" && toast.message.includes("tool returned"), "message includes error string");
  assert(
    toast?.icon === DEFAULT_ICONS.error,
    `uses default-set error icon (${DEFAULT_ICONS.error})`,
  );
}

// ─────────────────── long completion toasts (green)
{
  console.log("\n[long completion: emits green toast]");
  const { bus, emitted, fire } = makeFakeBus();
  const tracker = new SubagentsTracker(bus, () => DEFAULT_EVENTS_CONFIG.subagents);
  tracker.start();

  fire(SUBAGENT_EVENTS.CREATED, { id: "a1", type: "Explore", description: "deep search" });
  fire(SUBAGENT_EVENTS.STARTED, { id: "a1", type: "Explore", description: "deep search" });
  fire(SUBAGENT_EVENTS.COMPLETED, {
    id: "a1",
    type: "Explore",
    description: "deep search",
    status: "completed",
    durationMs: 45_000, // ≥ 30s threshold
  });

  const toast = lastToast(emitted);
  assert(toast?.level === "success", "long-completion toast is success level");
  assert(typeof toast?.message === "string" && toast.message.includes("45.0s"), "message includes duration");
}

// ─────────────────── disabled config: no chips, no toasts
{
  console.log("\n[disabled: silent across all events]");
  const { bus, emitted, fire } = makeFakeBus();
  const tracker = new SubagentsTracker(bus, () => ({
    ...DEFAULT_EVENTS_CONFIG.subagents,
    enabled: false,
  }));
  tracker.start();

  fire(SUBAGENT_EVENTS.CREATED, { id: "a1", type: "Agent" });
  fire(SUBAGENT_EVENTS.STARTED, { id: "a1", type: "Agent" });
  fire(SUBAGENT_EVENTS.FAILED, { id: "a1", type: "Agent", error: "boom" });

  assert(countStatuses(emitted) === 0, "no chip emits when disabled");
  assert(countToasts(emitted) === 0, "no toast emits when disabled");
}

// ─────────────────── dedupe: identical (running, total) snapshots collapse
{
  console.log("\n[dedupe: no chip emit when (running, total) unchanged]");
  const { bus, emitted, fire } = makeFakeBus();
  const tracker = new SubagentsTracker(bus, () => DEFAULT_EVENTS_CONFIG.subagents);
  tracker.start();

  fire(SUBAGENT_EVENTS.CREATED, { id: "a1", type: "Agent" });
  const afterCreated = countStatuses(emitted);

  // Re-fire the same created event — snapshot unchanged, no new emit.
  fire(SUBAGENT_EVENTS.CREATED, { id: "a1", type: "Agent" });
  assert(countStatuses(emitted) === afterCreated, "duplicate created is a no-op");

  // started moves a1 from created→running. running flips 0→1, so even
  // though total stays at 1 the chip MUST re-emit so the user sees the
  // updated `current/total`.
  fire(SUBAGENT_EVENTS.STARTED, { id: "a1", type: "Agent" });
  assert(
    countStatuses(emitted) === afterCreated + 1,
    "queued→running emits a fresh chip even when total stays the same",
  );
  const chip = lastStatus(emitted);
  assert(chip?.progress?.current === 1 && chip?.progress?.total === 1, "chip now shows 1/1");
}

// ─────────────────── reset clears state and chip
{
  console.log("\n[reset: drops chip and clears state]");
  const { bus, emitted, fire } = makeFakeBus();
  const tracker = new SubagentsTracker(bus, () => DEFAULT_EVENTS_CONFIG.subagents);
  tracker.start();

  fire(SUBAGENT_EVENTS.CREATED, { id: "a1", type: "Agent" });
  fire(SUBAGENT_EVENTS.STARTED, { id: "a1", type: "Agent" });
  tracker.reset();

  const chip = lastStatus(emitted);
  assert(chip?.state === "done", "reset emits chip done");
  assert(tracker.getCounts().total === 0, "reset zeroes counts");
}

// ─────────────────── start is idempotent + dispose is idempotent
{
  console.log("\n[idempotent start/dispose]");
  const { bus } = makeFakeBus();
  const tracker = new SubagentsTracker(bus, () => DEFAULT_EVENTS_CONFIG.subagents);
  tracker.start();
  tracker.start(); // no-op
  tracker.dispose();
  tracker.dispose(); // no-op
  assert(true, "no throws on repeated start/dispose");
}

// ─────────────────── garbage payloads are silently dropped
{
  console.log("\n[malformed payloads: silently dropped]");
  const { bus, emitted, fire } = makeFakeBus();
  const tracker = new SubagentsTracker(bus, () => DEFAULT_EVENTS_CONFIG.subagents);
  tracker.start();

  fire(SUBAGENT_EVENTS.CREATED, null);
  fire(SUBAGENT_EVENTS.CREATED, "not an object");
  fire(SUBAGENT_EVENTS.CREATED, { id: 123 }); // wrong type for id
  fire(SUBAGENT_EVENTS.STARTED, {}); // missing id
  assert(countStatuses(emitted) === 0, "no chip emits for invalid payloads");
}

console.log("\n────────────────────────────────────────────────");
if (failures === 0) {
  console.log("✓ all smoke checks passed");
  process.exit(0);
} else {
  console.error(`✗ ${failures} check(s) failed`);
  process.exit(1);
}
