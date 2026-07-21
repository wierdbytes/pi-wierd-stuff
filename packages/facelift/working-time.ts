/**
 * Working-time tracking for @wierdbytes/pi-facelift.
 *
 * Two metrics are measured per agent run:
 *
 *   • `worked` — model-only time: from the moment a provider request is
 *     dispatched (`before_provider_request`, so time-to-first-token
 *     counts too) until the assistant message ends. Tool execution is
 *     deliberately excluded — tools run between an assistant
 *     `message_end` and the next request, so measuring only
 *     request→message-end lifetimes naturally drops them.
 *
 *   • `total` — wall-clock time from when the user submits the prompt
 *     (`before_agent_start`) until the run settles (`agent_settled`).
 *     Retries, tool calls, and every other overhead are included.
 *
 * Two consumers:
 *   • Live: while the current assistant message streams, a 1s interval
 *     calls `setWorkingMessage` with a ticking timer (spinner frames are
 *     left untouched — we only replace the message text).
 *   • Durable: on `agent_settled` both metrics are persisted via
 *     `pi.appendEntry` as a `WorkingTimeEntry` and rendered in chat
 *     history by the entry renderer registered in `index.ts`.
 *
 * The class is pure logic (an injectable `now()` clock) so it is fully
 * unit-testable without a running pi session.
 */

/** Custom entry type used with `pi.appendEntry` / `registerEntryRenderer`. */
export const WORKING_TIME_ENTRY = "facelift-working-time";

/** Payload stored on the durable working-time entry. */
export interface WorkingTimeEntry {
	/** Model-only streaming time for the run, in milliseconds (tools excluded). */
	ms: number;
	/** Wall-clock time from user prompt to final response, in milliseconds. */
	totalMs: number;
	/** Epoch ms when the run started (user prompt submitted). */
	startedAt: number;
	/** Epoch ms when the run settled. */
	endedAt: number;
}

/**
 * Tracks model streaming time and total wall-clock time across the turns
 * of a single agent run.
 *
 * Lifecycle (driven by pi events):
 *   before_agent_start      → beginRun()   (total clock starts here)
 *   agent_start             → ensureRun()  (fallback if before_agent_start skipped)
 *   before_provider_request → beginSegment() + start the live ticker
 *   message_end     (asst)  → endSegment()   + stop the ticker
 *   agent_settled           → settle() ⇒ { ms, totalMs }, then reset
 *
 * Retries / auto-compaction fire their own agent_start but pi only emits
 * `agent_settled` when it truly stops, so a run is measured end-to-end.
 */
export class WorkingTimeTracker {
	private readonly now: () => number;
	private accumulatorMs = 0;
	private segmentStart: number | undefined;
	private runStart: number | undefined;

	constructor(now: () => number = () => Date.now()) {
		this.now = now;
	}

	/** Start a fresh run, discarding any prior accumulated time. */
	beginRun(): void {
		this.accumulatorMs = 0;
		this.segmentStart = undefined;
		this.runStart = this.now();
	}

	/** Start a run only if one isn't already in progress (idempotent). */
	ensureRun(): void {
		if (this.runStart === undefined) this.beginRun();
	}

	/** Begin timing an assistant streaming segment. */
	beginSegment(): void {
		this.ensureRun();
		if (this.segmentStart === undefined) this.segmentStart = this.now();
	}

	/** Close the current segment, folding its duration into the total. */
	endSegment(): void {
		if (this.segmentStart !== undefined) {
			this.accumulatorMs += Math.max(0, this.now() - this.segmentStart);
			this.segmentStart = undefined;
		}
	}

	/** Milliseconds accumulated so far, including any open segment. */
	elapsedMs(): number {
		const open = this.segmentStart !== undefined ? Math.max(0, this.now() - this.segmentStart) : 0;
		return this.accumulatorMs + open;
	}

	/** True while a run is in progress (between beginRun and settle). */
	isActive(): boolean {
		return this.runStart !== undefined;
	}

	/**
	 * Finalize the run and return the durable entry, or `undefined` when
	 * no measurable time accrued (guards against junk 0ms entries).
	 * `totalMs` spans the whole run (retries, tools, overhead included).
	 */
	settle(): WorkingTimeEntry | undefined {
		this.endSegment();
		const endedAt = this.now();
		const ms = this.accumulatorMs;
		const startedAt = this.runStart;
		this.accumulatorMs = 0;
		this.segmentStart = undefined;
		this.runStart = undefined;
		if (startedAt === undefined || ms <= 0) return undefined;
		return { ms, totalMs: Math.max(0, endedAt - startedAt), startedAt, endedAt };
	}
}

/**
 * Build the live working message, e.g. `Working... 1m5s`. Uses the same
 * `formatClock` rules as the durable history line so the live and final
 * displays stay consistent. The animated spinner frames are drawn by pi
 * separately (via `setWorkingIndicator`), so this only supplies the
 * trailing text — preserving whatever spinner the user/other extensions
 * have configured.
 */
export function workingMessageText(elapsedMs: number): string {
	return `Working... ${formatClock(elapsedMs)}`;
}

/**
 * Format a duration as a compact clock string.
 *
 * - Sub-minute durations keep one decimal: `45.2s`.
 * - Longer durations use integer `h`/`m`/`s` parts and always end in
 *   seconds. Leading zero parts are dropped — `0h12m0s` → `12m0s`,
 *   `0h0m5s` → `5s` — but once a part is present every following part is
 *   shown, interior zeros included (`1h0m5s`, `1h0m0s`).
 */
export function formatClock(ms: number): string {
	const totalSec = Math.max(0, ms) / 1000;
	if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
	const totalSecInt = Math.floor(totalSec);
	const hours = Math.floor(totalSecInt / 3600);
	const min = Math.floor((totalSecInt % 3600) / 60);
	const sec = totalSecInt % 60;
	let out = "";
	if (hours > 0) out += `${hours}h`;
	if (hours > 0 || min > 0) out += `${min}m`;
	return `${out}${sec}s`;
}

/**
 * Render the durable entry body as a plain muted line (no frame):
 * `⏱ worked 45.2s (total: 1m15s)`.
 */
export function workingTimeLine(entry: WorkingTimeEntry, dim: (s: string) => string): string {
	return dim(`⏱ worked ${formatClock(entry.ms)} (total: ${formatClock(entry.totalMs)})`);
}
