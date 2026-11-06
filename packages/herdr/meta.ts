/**
 * What pi tells herdr about itself, as terminal labels.
 *
 * OSC 7501 only carries a status word, an app name and a message, so the
 * model, the reasoning effort and the context size travel as `agent.*`
 * labels on the terminal instead (`hc label`). Herdr mods read them from
 * `terminals()[i].labels` and re-render whenever they change.
 *
 * Pure functions only: the wiring lives in `index.ts`, the socket in `hc.ts`.
 */

/** Every label this extension owns. Removing all of them clears pi's trace. */
export const LABEL_KEYS = [
  "agent.app",
  "agent.pid",
  "agent.model",
  "agent.model_id",
  "agent.provider",
  "agent.effort",
  "agent.ctx",
  "agent.ctx_max",
  "agent.subagents",
] as const;

export type LabelKey = (typeof LABEL_KEYS)[number];
export type Labels = Partial<Record<LabelKey, string>>;

/**
 * Pi's own thinking levels; a provider map that only renames between them is
 * not a display name. `max` is left out on purpose, as in the statusline: a
 * model whose top level is `max` shows `max`.
 */
const STANDARD_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

export interface MetaModel {
  id?: string;
  name?: string;
  provider?: string;
  reasoning?: boolean;
  contextWindow?: number;
  thinkingLevelMap?: Record<string, unknown>;
}

export interface MetaInputs {
  pid: number;
  model: MetaModel | undefined;
  thinkingLevel: string | undefined;
  context: { tokens: number | null; contextWindow: number } | undefined;
  subagents: number;
}

/** The effort to show: pi's level, or the model's own word for it (`max`, a token budget). */
export function effortLabel(model: MetaModel | undefined, level: string | undefined): string | undefined {
  if (!model?.reasoning || !level || level === "off") return undefined;
  const mapped = model.thinkingLevelMap?.[level];
  if (typeof mapped === "string" && mapped.length > 0 && !STANDARD_LEVELS.has(mapped)) return mapped;
  return level;
}

/** The labels for this moment. A key left out means "not known now" and gets removed. */
export function collectLabels(inputs: MetaInputs): Labels {
  const { model, context } = inputs;
  const labels: Labels = { "agent.app": "pi", "agent.pid": String(inputs.pid) };
  if (model) {
    const name = model.name || model.id;
    if (name) labels["agent.model"] = name;
    if (model.id) labels["agent.model_id"] = model.id;
    if (model.provider) labels["agent.provider"] = model.provider;
  }
  const effort = effortLabel(model, inputs.thinkingLevel);
  if (effort) labels["agent.effort"] = effort;
  if (context?.tokens != null && Number.isFinite(context.tokens)) labels["agent.ctx"] = String(Math.round(context.tokens));
  const max = context?.contextWindow || model?.contextWindow;
  if (max) labels["agent.ctx_max"] = String(Math.round(max));
  if (inputs.subagents > 0) labels["agent.subagents"] = String(inputs.subagents);
  return labels;
}

/**
 * What to send to go from `prev` (what the terminal has) to `next`: changed
 * keys with their value, vanished keys as `""` (hc's "remove"). Empty when
 * nothing changed, so callers can skip the round trip.
 */
export function diffLabels(prev: Labels, next: Labels): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of LABEL_KEYS) {
    const before = prev[key];
    const after = next[key];
    if (after !== undefined && after !== before) out[key] = after;
    else if (after === undefined && before !== undefined) out[key] = "";
  }
  return out;
}

/** Every owned key set to `""`: removes them all. */
export function clearLabels(): Record<string, string> {
  return Object.fromEntries(LABEL_KEYS.map((key) => [key, ""]));
}
