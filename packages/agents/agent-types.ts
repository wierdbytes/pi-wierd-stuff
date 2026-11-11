/**
 * Agent types: built-in `general-purpose`, `Explore` and `Plan`, plus
 * Markdown files in `~/.pi/agent/agents/*.md` and (trusted projects only)
 * `<cwd>/.pi/agents/*.md` — the same places and frontmatter as
 * pi-subagents, so existing definitions keep working:
 *
 * ```md
 * ---
 * name: reviewer              # default: the file name
 * description: Reviews a diff for bugs
 * model: anthropic/claude-sonnet-5-5   # optional, "inherit" = the parent's
 * thinking: medium            # optional
 * tools: read, grep, find, ls, bash   # optional allowlist (pi --tools)
 * disallowed_tools: write, edit       # optional denylist (pi --exclude-tools)
 * ---
 * Instructions, added to the sub-agent's system prompt.
 * ```
 *
 * A file named like a built-in replaces it; project files win over user files.
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface AgentType {
  name: string;
  description: string;
  /** Instructions added to the child's system prompt. */
  prompt: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  excludeTools?: string[];
  source: "builtin" | "user" | "project";
}

export const DEFAULT_TYPE = "general-purpose";

const READ_ONLY = ["read", "bash", "grep", "find", "ls"];

export const BUILTIN_TYPES: AgentType[] = [
  {
    name: "general-purpose",
    description:
      "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. All tools.",
    prompt: "",
    source: "builtin",
  },
  {
    name: "Explore",
    description:
      'Fast read-only agent for locating code: find files by pattern, grep for symbols, answer "where is X / what uses Y". Say how thorough to be: "quick", "medium" or "very thorough".',
    tools: READ_ONLY,
    prompt: [
      "READ-ONLY MODE: you search and analyze; you never create, modify, move or delete files, and never run commands that change system state (bash only for ls, git status/log/diff/show, cat, head, tail).",
      "Prefer the find, grep and read tools over their bash equivalents. Make independent calls in parallel.",
      "Match the thoroughness the task asks for. Report absolute file paths with line numbers, and quote the code that answers the question.",
    ].join("\n"),
    source: "builtin",
  },
  {
    name: "Plan",
    description:
      "Read-only software architect: designs an implementation plan, identifies the critical files and weighs trade-offs. Returns a step-by-step plan.",
    tools: READ_ONLY,
    prompt: [
      "READ-ONLY MODE: you never create, modify or delete files.",
      "Explore the code until you understand how the change fits, then return a plan: the approach and why, the files to change and what changes in each, the order of steps, risks and open questions.",
      "Name exact files and symbols. Keep the plan concrete enough that another agent can implement it without re-exploring.",
    ].join("\n"),
    source: "builtin",
  },
];

/** Minimal frontmatter: `key: value` lines between `---` fences. */
export function parseFrontmatter(text: string): { fm: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { fm: {}, body: text.trim() };
  const fm: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2]!.replace(/\s+#.*$/, "").trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    fm[kv[1]!] = value;
  }
  return { fm, body: m[2]!.trim() };
}

const csv = (v: string | undefined): string[] | undefined => {
  if (!v) return undefined;
  const list = v
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  return list.length ? list : undefined;
};

export function parseAgentFile(file: string, text: string, source: AgentType["source"]): AgentType | undefined {
  const { fm, body } = parseFrontmatter(text);
  const name = (fm.name || basename(file, ".md")).trim();
  if (!name) return undefined;
  const model = fm.model && fm.model !== "inherit" ? fm.model : undefined;
  const thinking = fm.thinking && fm.thinking !== "inherit" ? fm.thinking : undefined;
  return {
    name,
    description: fm.description || name,
    prompt: body,
    model,
    thinking,
    tools: csv(fm.tools),
    excludeTools: csv(fm.disallowed_tools ?? fm.disallowedTools ?? fm.exclude_tools),
    source,
  };
}

function loadDir(dir: string, source: AgentType["source"]): AgentType[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const out: AgentType[] = [];
  for (const f of files.sort()) {
    try {
      const t = parseAgentFile(f, readFileSync(join(dir, f), "utf8"), source);
      if (t) out.push(t);
    } catch {
      // An unreadable file is skipped, not fatal.
    }
  }
  return out;
}

export function loadAgentTypes(cwd: string, projectTrusted: boolean): Map<string, AgentType> {
  const types = new Map<string, AgentType>();
  for (const t of BUILTIN_TYPES) types.set(t.name, t);
  for (const t of loadDir(join(getAgentDir(), "agents"), "user")) types.set(t.name, t);
  if (projectTrusted) for (const t of loadDir(join(cwd, ".pi", "agents"), "project")) types.set(t.name, t);
  return types;
}

/** Exact name first, then case-insensitive. */
export function findType(types: Map<string, AgentType>, name: string | undefined): AgentType | undefined {
  const wanted = (name ?? DEFAULT_TYPE).trim() || DEFAULT_TYPE;
  const exact = types.get(wanted);
  if (exact) return exact;
  const lower = wanted.toLowerCase();
  for (const t of types.values()) if (t.name.toLowerCase() === lower) return t;
  return undefined;
}
