/**
 * Sub-agent runner for web_fetch.
 *
 * Spawns `pi --mode json -p --no-session --no-tools ...` to summarize or
 * extract information from fetched page content. Reads the streamed JSON
 * events and surfaces the final assistant text.
 */

import { spawn } from "node:child_process";
import { killProcess } from "./extract.ts";

export interface SubAgentResult {
  ok: true;
  response: string;
}

export interface SubAgentError {
  ok: false;
  error: string;
}

/**
 * The environment for the nested pi: this one's, minus pi-agents' `PI_AGENTS_*`.
 * Inside a sub-agent they say "you are sub-agent <run>": the nested pi would load
 * pi-agents, take itself for that sub-agent and report its summary to the parent
 * as the sub-agent's final result while the sub-agent is still working.
 */
export function nestedPiEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !key.startsWith("PI_AGENTS_")) out[key] = value;
  }
  return out;
}

export async function runSubAgent(
  content: string,
  prompt: string,
  model: string,
  thinkingLevel: string,
  signal?: AbortSignal,
): Promise<SubAgentResult | SubAgentError> {
  if (signal?.aborted) return { ok: false, error: "Aborted" };

  const fullPrompt = `Web page content:\n---\n${content}\n---\n\n${prompt}`;

  return new Promise((resolve) => {
    const proc = spawn(
      "pi",
      [
        "--mode",
        "json",
        "-p",
        "--no-session",
        "--no-tools",
        "--model",
        model,
        "--thinking",
        thinkingLevel,
        fullPrompt,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: nestedPiEnv(),
      },
    );

    let buffer = "";
    let lastAssistantText = "";
    let stderr = "";

    const onAbort = () => killProcess(proc);
    signal?.addEventListener("abort", onAbort, { once: true });

    const processLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (event.type === "message_end" && event.message?.role === "assistant") {
          for (const part of event.message.content) {
            if (part.type === "text") {
              lastAssistantText = part.text;
            }
          }
        }
      } catch {
        // ignore non-JSON lines
      }
    };

    proc.stdout.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);

      if (buffer.trim()) processLine(buffer);

      if (signal?.aborted) {
        resolve({ ok: false, error: "Aborted" });
        return;
      }

      if (lastAssistantText) {
        resolve({ ok: true, response: lastAssistantText });
      } else if (code !== 0) {
        resolve({
          ok: false,
          error: `Sub-agent failed (exit code ${code}): ${stderr.trim() || "(no output)"}`,
        });
      } else {
        resolve({ ok: false, error: "Sub-agent returned no response" });
      }
    });

    proc.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      resolve({ ok: false, error: `Failed to spawn pi sub-agent: ${err.message}` });
    });
  });
}
