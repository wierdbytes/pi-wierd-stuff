/**
 * Model calls for the dream, through pi's model registry (the user's
 * configured providers and credentials, OAuth included).
 *
 * `json()` asks for a JSON object, validates it, and on a bad reply shows the
 * model its own answer with the error and asks again (3 attempts). Transient
 * provider errors are retried with backoff. Usage and cost are tallied per
 * stage for the report.
 */

import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Stage, StageModel } from "./config.ts";

export interface StageUsage {
	calls: number;
	input: number;
	output: number;
	cacheRead: number;
	cost: number;
	failures: number;
}

export interface CallOptions {
	maxTokens: number;
	timeoutMs: number;
}

/** Pull a JSON value out of a model reply (bare, fenced, or embedded in prose). */
export function extractJson(text: string): unknown {
	const t = text.trim();
	const candidates: string[] = [];
	for (const m of t.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/gi)) candidates.push(m[1]);
	candidates.push(t);
	const a = t.indexOf("{");
	const b = t.lastIndexOf("}");
	if (a >= 0 && b > a) candidates.push(t.slice(a, b + 1));
	for (const c of candidates) {
		try {
			return JSON.parse(c);
		} catch {
			// next candidate
		}
	}
	throw new Error("no valid JSON object found in the reply");
}

export function replyText(msg: AssistantMessage): string {
	return msg.content
		.filter((p) => p.type === "text")
		.map((p) => (p as { text: string }).text)
		.join("\n");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				resolve();
			},
			{ once: true },
		);
	});
}

export class Llm {
	readonly usage: Partial<Record<Stage, StageUsage>> = {};

	constructor(
		private ctx: ExtensionContext,
		private log: (msg: string) => void,
		private signal?: AbortSignal,
	) {}

	resolve(spec: StageModel): Model<Api> {
		const slash = spec.model.indexOf("/");
		const model = slash > 0 ? this.ctx.modelRegistry.find(spec.model.slice(0, slash), spec.model.slice(slash + 1)) : undefined;
		if (!model) throw new Error(`model ${spec.model} not found`);
		if (!this.ctx.modelRegistry.hasConfiguredAuth(model)) throw new Error(`no credentials for ${spec.model}`);
		return model;
	}

	totalCost(): number {
		return Object.values(this.usage).reduce((s, u) => s + (u?.cost ?? 0), 0);
	}

	async complete(stage: Stage, spec: StageModel, system: string, messages: Message[], opts: CallOptions): Promise<AssistantMessage> {
		const model = this.resolve(spec);
		const reasoning = model.reasoning && spec.thinking !== "off" ? spec.thinking : undefined;
		const u = (this.usage[stage] ??= { calls: 0, input: 0, output: 0, cacheRead: 0, cost: 0, failures: 0 });
		let lastErr = "";
		for (let attempt = 0; attempt < 3; attempt++) {
			if (this.signal?.aborted) throw new Error("dream aborted (time limit)");
			const signals = [AbortSignal.timeout(opts.timeoutMs)];
			if (this.signal) signals.push(this.signal);
			try {
				const stream = this.ctx.modelRegistry.streamSimple(
					model,
					{ systemPrompt: system, messages },
					{ signal: AbortSignal.any(signals), maxTokens: opts.maxTokens, ...(reasoning ? { reasoning } : {}) },
				);
				const msg = await stream.result();
				u.calls++;
				u.input += msg.usage?.input ?? 0;
				u.output += msg.usage?.output ?? 0;
				u.cacheRead += msg.usage?.cacheRead ?? 0;
				u.cost += msg.usage?.cost?.total ?? 0;
				if (msg.stopReason === "error" || msg.stopReason === "aborted") throw new Error(msg.errorMessage || msg.stopReason);
				return msg;
			} catch (err) {
				u.failures++;
				lastErr = err instanceof Error ? err.message : String(err);
				if (this.signal?.aborted || attempt === 2) break;
				const wait = [10_000, 45_000][attempt];
				this.log(`  ! ${stage} (${spec.model}) failed: ${lastErr.slice(0, 200)} — retry in ${wait / 1000}s`);
				await sleep(wait, this.signal);
			}
		}
		throw new Error(`${stage} (${spec.model}): ${lastErr}`);
	}

	async json<T>(stage: Stage, spec: StageModel, system: string, user: string, validate: (v: unknown) => T, opts: CallOptions): Promise<T> {
		const messages: Message[] = [{ role: "user", content: user, timestamp: Date.now() }];
		let lastErr = "";
		for (let attempt = 0; attempt < 3; attempt++) {
			const msg = await this.complete(stage, spec, system, messages, opts);
			try {
				return validate(extractJson(replyText(msg)));
			} catch (err) {
				lastErr = err instanceof Error ? err.message : String(err);
				if (msg.stopReason === "length") lastErr += " (the reply hit the output limit — be more concise)";
				this.log(`  ! ${stage}: unusable reply (${lastErr.slice(0, 160)}), asking again`);
				messages.push(msg, {
					role: "user",
					content: `Your reply could not be used: ${lastErr}. Reply again with only the corrected JSON object.`,
					timestamp: Date.now(),
				});
			}
		}
		throw new Error(`${stage}: no usable JSON after 3 attempts: ${lastErr}`);
	}
}
