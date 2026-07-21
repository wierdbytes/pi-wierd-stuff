/**
 * Tests for the working-time tracker and its extension wiring.
 *
 * The tracker measures two metrics: `worked` (model streaming only,
 * tools excluded) and `totalMs` (wall-clock from user prompt to settle,
 * retries/tools/overhead included). The wiring drives it from pi
 * lifecycle events: before_agent_start / agent_start /
 * before_provider_request / message_end / agent_settled. The durable
 * history line is produced via pi.appendEntry + registerEntryRenderer.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import piFaceliftExtension from "./index.ts";
import {
	formatClock,
	WorkingTimeTracker,
	WORKING_TIME_ENTRY,
	workingMessageText,
	workingTimeLine,
	type WorkingTimeEntry,
} from "./working-time.ts";

describe("WorkingTimeTracker", () => {
	it("accumulates a single streaming segment", () => {
		let now = 1000;
		const t = new WorkingTimeTracker(() => now);
		t.beginRun();
		now = 2000;
		t.beginSegment();
		now = 4500;
		t.endSegment();
		expect(t.elapsedMs()).toBe(2500);
		const entry = t.settle();
		expect(entry?.ms).toBe(2500);
		expect(entry?.startedAt).toBe(1000);
	});

	it("measures totalMs as wall-clock across the whole run (incl. tool gap)", () => {
		let now = 0;
		const t = new WorkingTimeTracker(() => now);
		t.beginRun();
		t.beginSegment();
		now = 1000;
		t.endSegment();
		// tool + overhead from 1000..9000 counts toward total, not worked
		now = 9000;
		t.beginSegment();
		now = 10000;
		t.endSegment();
		const entry = t.settle();
		expect(entry?.ms).toBe(2000);
		expect(entry?.totalMs).toBe(10000);
	});

	it("ensureRun does not reset an in-progress run", () => {
		let now = 0;
		const t = new WorkingTimeTracker(() => now);
		t.beginRun();
		t.beginSegment();
		now = 500;
		t.endSegment();
		now = 1000;
		t.ensureRun(); // agent_start fallback mid-run — must not reset
		expect(t.elapsedMs()).toBe(500);
		now = 3000;
		expect(t.settle()?.totalMs).toBe(3000);
	});

	it("estimates live tps from streamed deltas over worked time", () => {
		let now = 0;
		const t = new WorkingTimeTracker(() => now);
		t.beginRun();
		t.beginSegment();
		t.addDelta(4000); // ~1000 estimated tokens at 4 chars/token
		now = 2000; // 2s of worked time
		expect(t.estimatedTokens()).toBe(1000);
		expect(t.liveTps()).toBe(500); // 1000 tokens / 2s
	});

	it("liveTps is 0 before any time elapses", () => {
		const t = new WorkingTimeTracker(() => 0);
		t.beginRun();
		t.beginSegment();
		t.addDelta(400);
		expect(t.liveTps()).toBe(0);
	});

	it("computes exact final tps from recorded tokens over worked ms", () => {
		let now = 0;
		const t = new WorkingTimeTracker(() => now);
		t.beginRun();
		t.beginSegment();
		now = 2000;
		t.recordExactTokens(1500);
		t.endSegment();
		const entry = t.settle();
		expect(entry?.tokens).toBe(1500);
		expect(entry?.tps).toBe(750); // 1500 tokens / 2s worked
	});

	it("excludes the gap between segments (tool execution time)", () => {
		let now = 0;
		const t = new WorkingTimeTracker(() => now);
		t.beginRun();
		// first model segment: 0..1000
		t.beginSegment();
		now = 1000;
		t.endSegment();
		// "tool" runs from 1000..9000 — must NOT count
		now = 9000;
		// second model segment: 9000..10000
		t.beginSegment();
		now = 10000;
		t.endSegment();
		expect(t.settle()?.ms).toBe(2000);
	});

	it("includes an open segment in elapsedMs while streaming", () => {
		let now = 0;
		const t = new WorkingTimeTracker(() => now);
		t.beginRun();
		t.beginSegment();
		now = 3000;
		expect(t.elapsedMs()).toBe(3000);
		expect(t.isActive()).toBe(true);
	});

	it("returns undefined for a zero-time run", () => {
		const t = new WorkingTimeTracker(() => 0);
		t.beginRun();
		expect(t.settle()).toBeUndefined();
	});

	it("resets state after settle", () => {
		let now = 0;
		const t = new WorkingTimeTracker(() => now);
		t.beginRun();
		t.beginSegment();
		now = 1000;
		t.endSegment();
		t.settle();
		expect(t.isActive()).toBe(false);
		expect(t.elapsedMs()).toBe(0);
	});
});

describe("formatClock", () => {
	it("keeps one decimal below a minute", () => {
		expect(formatClock(0)).toBe("0.0s");
		expect(formatClock(45_200)).toBe("45.2s");
		expect(formatClock(59_900)).toBe("59.9s");
	});

	it("formats minutes and seconds, always ending in seconds", () => {
		expect(formatClock(60_000)).toBe("1m0s");
		expect(formatClock(75_000)).toBe("1m15s");
		expect(formatClock(720_000)).toBe("12m0s"); // 0h12m0s -> 12m0s
	});

	it("formats hours, keeping interior zeros", () => {
		expect(formatClock(4_356_000)).toBe("1h12m36s");
		expect(formatClock(3_605_000)).toBe("1h0m5s");
		expect(formatClock(3_600_000)).toBe("1h0m0s");
	});

	it("drops the leading zero hours part", () => {
		expect(formatClock(65_000)).toBe("1m5s"); // 0h1m5s -> 1m5s
	});

	it("never returns a negative duration", () => {
		expect(formatClock(-5000)).toBe("0.0s");
	});
});

describe("workingMessageText / workingTimeLine", () => {
	it("formats the live message using formatClock rules", () => {
		expect(workingMessageText(0, 0)).toBe("Working... 0.0s · tps: ~0");
		expect(workingMessageText(1999, 120)).toBe("Working... 2.0s · tps: ~120");
		expect(workingMessageText(65_000, 756)).toBe("Working... 1m5s · tps: ~756");
		expect(workingMessageText(720_000, 800)).toBe("Working... 12m0s · tps: ~800");
	});

	it("renders a muted history line with worked, total and exact tps", () => {
		const dim = (s: string) => `<dim>${s}</dim>`;
		const entry: WorkingTimeEntry = {
			ms: 45_200,
			totalMs: 75_000,
			tokens: 34_200,
			tps: 756,
			startedAt: 0,
			endedAt: 0,
		};
		expect(workingTimeLine(entry, dim)).toBe("<dim>⏱ worked 45.2s (total: 1m15s) · tps: 756</dim>");
	});
});

// --- extension wiring ---------------------------------------------------

class MockText {
	private text: string;
	constructor(text = "", _x = 0, _y = 0) {
		this.text = text;
	}
	setText(value: string) {
		this.text = value;
	}
	getText() {
		return this.text;
	}
}

function mockToolFactory(exec: any) {
	return (_cwd: string) => ({
		name: "mock",
		description: "mock",
		parameters: { type: "object", properties: {} },
		execute: exec,
	});
}

interface MockCtx {
	hasUI: boolean;
	ui: { setWorkingMessage: ReturnType<typeof vi.fn> };
}

function loadExtension() {
	const handlers = new Map<string, (event: unknown, ctx: MockCtx) => void>();
	const entryRenderers = new Map<string, (entry: any, opts: any, theme: any) => unknown>();
	const entries: Array<{ type: string; data: unknown }> = [];

	const pi = {
		registerTool: () => {},
		registerCommand: () => {},
		on: (name: string, h: (event: unknown, ctx: MockCtx) => void) => handlers.set(name, h),
		registerEntryRenderer: (type: string, r: any) => entryRenderers.set(type, r),
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
	};

	const noopExec = async () => ({ content: [{ type: "text", text: "" }] });
	piFaceliftExtension(pi as any, {
		sdk: {
			createReadToolDefinition: mockToolFactory(noopExec),
			getAgentDir: () => "/tmp/pi-facelift-test",
		},
		TextComponent: MockText as any,
	});

	const ctx: MockCtx = { hasUI: true, ui: { setWorkingMessage: vi.fn() } };
	const fire = (name: string, event: unknown) => handlers.get(name)?.(event, ctx);
	return { fire, ctx, entries, entryRenderers };
}

const asst = { message: { role: "assistant" } };
const user = { message: { role: "user" } };

describe("working-time wiring", () => {
	beforeEach(() => vi.restoreAllMocks());

	it("worked counts request→message_end; total counts the whole run", () => {
		vi.useFakeTimers();
		const { fire, entries } = loadExtension();

		fire("before_agent_start", {}); // anchors the total clock
		vi.advanceTimersByTime(500); // pre-loop overhead
		fire("agent_start", {});
		fire("before_provider_request", {});
		vi.advanceTimersByTime(5000);
		fire("message_end", asst);
		// tool gap — counts toward total, NOT worked
		vi.advanceTimersByTime(3000);
		fire("before_provider_request", {});
		vi.advanceTimersByTime(2000);
		fire("message_end", asst);
		fire("agent_settled", {});

		vi.useRealTimers();
		expect(entries).toHaveLength(1);
		expect(entries[0].type).toBe(WORKING_TIME_ENTRY);
		const data = entries[0].data as WorkingTimeEntry;
		expect(data.ms).toBe(7000);
		expect(data.totalMs).toBe(10500); // 500 + 5000 + 3000 + 2000
	});

	it("tracks live estimated tps (~) and final exact tps from usage.output", () => {
		vi.useFakeTimers();
		const { fire, entries, ctx } = loadExtension();
		fire("before_agent_start", {});
		fire("agent_start", {});
		fire("before_provider_request", {});
		// Stream ~4000 chars => ~1000 estimated tokens over 2s of worked time.
		fire("message_update", {
			message: { role: "assistant" },
			assistantMessageEvent: { type: "text_delta", delta: "x".repeat(4000) },
		});
		vi.advanceTimersByTime(2000);
		const calls = ctx.ui.setWorkingMessage.mock.calls.map((c) => c[0]);
		expect(calls).toContain("Working... 2.0s · tps: ~500");
		// Final exact tokens come from usage.output, not the estimate.
		fire("message_end", { message: { role: "assistant", usage: { output: 1500 } } });
		fire("agent_settled", {});
		vi.useRealTimers();
		expect(entries).toHaveLength(1);
		const data = entries[0].data as WorkingTimeEntry;
		expect(data.tokens).toBe(1500);
		expect(data.tps).toBe(750); // 1500 / 2s worked
	});

	it("ignores non-assistant message_end (does not close the segment early)", () => {
		vi.useFakeTimers();
		const { fire, entries } = loadExtension();
		fire("before_agent_start", {});
		fire("agent_start", {});
		fire("before_provider_request", {});
		vi.advanceTimersByTime(1000);
		fire("message_end", user); // stray non-assistant end — ignored
		vi.advanceTimersByTime(1000);
		fire("message_end", asst);
		fire("agent_settled", {});
		vi.useRealTimers();
		expect(entries).toHaveLength(1);
		expect((entries[0].data as WorkingTimeEntry).ms).toBe(2000);
	});

	it("updates the live working message from request send and restores on settle", () => {
		vi.useFakeTimers();
		const { fire, ctx } = loadExtension();
		fire("before_agent_start", {});
		fire("agent_start", {});
		fire("before_provider_request", {});
		vi.advanceTimersByTime(2000);
		const calls = ctx.ui.setWorkingMessage.mock.calls.map((c) => c[0]);
		expect(calls[0]).toBe("Working... 0.0s · tps: ~0");
		expect(calls).toContain("Working... 2.0s · tps: ~0");
		fire("message_end", asst);
		fire("agent_settled", {});
		vi.useRealTimers();
		// last call restores the default (undefined)
		const last = ctx.ui.setWorkingMessage.mock.calls.at(-1);
		expect(last?.[0]).toBeUndefined();
	});

	it("registers an entry renderer that produces a dim worked+total line", () => {
		const { entryRenderers } = loadExtension();
		const renderer = entryRenderers.get(WORKING_TIME_ENTRY);
		expect(renderer).toBeDefined();
		const theme = { fg: (_k: string, s: string) => `dim(${s})` };
		const out = renderer!(
			{ data: { ms: 1500, totalMs: 4000, tokens: 300, tps: 200, startedAt: 0, endedAt: 0 } },
			{ expanded: false },
			theme,
		) as MockText;
		expect(out.getText()).toBe("dim(⏱ worked 1.5s (total: 4.0s) · tps: 200)");
	});
});
