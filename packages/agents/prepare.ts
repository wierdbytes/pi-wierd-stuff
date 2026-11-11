/**
 * What the tool or an RPC caller asked for → a launchable SpawnSpec:
 * agent type, model, effort and folder resolved against the parent session.
 */

import { statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { type AgentType, DEFAULT_TYPE, findType } from "./agent-types.ts";
import type { SpawnSpec } from "./manager.ts";
import { isThinkingLevel, type ModelLike, resolveModel, THINKING_LEVELS } from "./models.ts";

export interface SpawnInput {
  prompt: string;
  description: string;
  subagent_type?: string;
  model?: string;
  thinking?: string;
  cwd?: string;
  background?: boolean;
  notify?: boolean;
}

export interface PrepareContext {
  cwd: string;
  types: Map<string, AgentType>;
  available: readonly ModelLike[];
  scoped?: readonly ModelLike[];
  currentModel?: ModelLike;
  currentThinking?: string;
  projectTrusted?: boolean;
}

const inside = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

export function prepareSpawn(input: SpawnInput, pc: PrepareContext): SpawnSpec {
  const prompt = input.prompt?.trim();
  if (!prompt) throw new Error("prompt is empty");
  const description = input.description?.trim() || prompt.split("\n")[0]!.slice(0, 40);

  const type = findType(pc.types, input.subagent_type);
  if (!type) {
    throw new Error(
      `Unknown subagent_type "${input.subagent_type}". Available: ${[...pc.types.keys()].join(", ") || DEFAULT_TYPE}`,
    );
  }

  let model: string | undefined;
  const wanted = input.model?.trim() || type.model;
  if (wanted) {
    const r = resolveModel(wanted, pc.available, { scoped: pc.scoped, provider: pc.currentModel?.provider });
    if (!r.ok) throw new Error(r.error);
    model = `${r.model.provider}/${r.model.id}`;
  } else if (pc.currentModel) {
    model = `${pc.currentModel.provider}/${pc.currentModel.id}`;
  }

  const thinking = input.thinking?.trim() || type.thinking || pc.currentThinking;
  if (thinking !== undefined && !isThinkingLevel(thinking)) {
    throw new Error(`Unknown thinking level "${thinking}". Use one of: ${THINKING_LEVELS.join(", ")}`);
  }

  const cwd = input.cwd?.trim() ? resolve(pc.cwd, input.cwd.trim().replace(/^@/, "")) : pc.cwd;
  let isDir = false;
  try {
    isDir = statSync(cwd).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw new Error(`cwd is not a folder: ${cwd}`);

  const background = input.background === true;
  return {
    prompt,
    description,
    type,
    model,
    thinking,
    cwd,
    background,
    notify: input.notify ?? background,
    trust: pc.projectTrusted === undefined || !inside(cwd, pc.cwd) ? undefined : pc.projectTrusted ? "yes" : "no",
  };
}
