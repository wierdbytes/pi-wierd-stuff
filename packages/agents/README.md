# @wierdbytes/pi-agents

Sub-agents for [pi](https://github.com/earendil-works/pi) that show up natively in [herdr](https://herdr.dev).

Each sub-agent is its own interactive `pi`, started in a herdr-core terminal as a **child of the terminal the parent pi runs in**. Herdr already understands that relation: its agent list nests sub-agents under the agent that started them, shows their status (working / blocked / done) and, with [pi-herdr](../herdr), their model and context. You can peek at any of them, type into it, or take it over.

```
 ◌ Fix login redirect loop                       Opus 5.5 @high
   ├ ◌ find-auth-code          Explore           Sonnet 5.5 @low
   └ ✓ review-session-store    general-purpose   Opus 5.5 @medium
```

Replaces [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) — same tool names, so models keep using them the way they know.

## Install

```bash
pi install npm:@wierdbytes/pi-agents
pi remove npm:@tintinweb/pi-subagents   # same tool names: keep only one
```

pi must run inside a herdr-core terminal (`HC_TERMINAL_ID` / `HC_TERMINAL_SOCKET` set, as in every herdr pane). Elsewhere the tools aren't registered and the RPC's `ping` answers `available: false`.

## Tools

| Tool | What it does |
|---|---|
| `Agent` | Start a sub-agent: `description` (its title in herdr, like a session name), `prompt`, optional `subagent_type`, `model` (`provider/id` or fuzzy: `"sonnet"`), `thinking` (`off` … `max`), `cwd`, `run_in_background`. Foreground (default) waits and returns its report, with live progress; background returns at once. |
| `get_subagent_result` | State now, or `wait: true` until it finishes (optional `timeout` seconds). |
| `steer_subagent` | Type a message into it: a steer while it works, a follow-up turn once it has finished (context intact). |
| `stop_subagent` | End it and close its terminal. |

- **Defaults:** the agent type's model / effort, else the parent session's.
- **Background results** arrive as one message per batch when the parent is idle (or right after its current run), and start a turn. Results already collected with `get_subagent_result` are not repeated.
- **Blocked:** a sub-agent waiting on a dialog shows as blocked in herdr; the parent gets a note (no turn) and `wait` returns, so nothing hangs on it.
- **Lifecycle:** a finished sub-agent stays open and idle — inspect it in herdr or send a follow-up. `stop_subagent`, `/agents → Stop`, or quitting the parent pi ends it. After `/reload` the parent picks its sub-agents up again.
- **Depth:** sub-agents don't get these tools (`maxDepth: 1`).
- `/agents` lists the sub-agents; pick one to peek at it in herdr (`herdr-app do terminal.peek`) or stop it.

## Agent types

Built in: `general-purpose` (all tools), `Explore` and `Plan` (read-only: `read, bash, grep, find, ls`). Add your own as Markdown in `~/.pi/agent/agents/*.md` or, in trusted projects, `.pi/agents/*.md` — the same files pi-subagents reads:

```md
---
name: reviewer
description: Reviews a diff for bugs and risky changes
model: anthropic/claude-sonnet-5-5   # optional; "inherit" = the parent's
thinking: medium                     # optional
tools: read, grep, find, ls, bash    # optional allowlist → pi --tools
disallowed_tools: write, edit        # optional denylist → pi --exclude-tools
---
Review only what you were pointed at. Report each finding with file:line and severity.
```

The body is added to the sub-agent's system prompt (pi-subagents' `prompt_mode: replace` is treated as append). A file named like a built-in replaces it.

## Settings

`~/.pi/agent/@wierdbytes/pi-agents/settings.json`, every key optional:

```json
{
  "command": ["pi"],
  "extraArgs": ["--no-voice", "--no-peon"],
  "maxDepth": 1,
  "inheritEnv": true
}
```

| Key | Default | |
|---|---|---|
| `command` | `["pi"]` | How to start pi in a sub-agent's terminal |
| `extraArgs` | `[]` | Extra pi arguments for every sub-agent — e.g. silence [pi-voice](../voice) and [pi-peon](../peon) in sub-agents. Only list flags of extensions you have installed |
| `maxDepth` | `1` | `2` lets sub-agents start their own sub-agents |
| `inheritEnv` | `true` | Sub-agents get the parent's environment (PATH, API keys) minus terminal identity (`HC_*`, `TERM*`, the parent's `PI_SESSION_*`) |

## For other extensions: `pi.events` RPC

```ts
import { agentsClient } from "@wierdbytes/pi-agents/client";

const agents = agentsClient(pi.events);
if ((await agents.ping()).available) {
  const a = await agents.spawn({ description: "Review diff", prompt: "…", model: "sonnet", thinking: "low" });
  const done = await agents.wait(a.id);          // until it finishes or needs a person
  console.log(done.status, done.result);
}
agents.on("completed", (a) => { /* … */ });
```

Without the client: emit `agents:rpc:<method>` with a `requestId`, listen on `agents:rpc:<method>:reply:<requestId>` for `{ success: true, data } | { success: false, error }`.

| Method | Params | Data |
|---|---|---|
| `ping` | — | `{ version, available }` |
| `spawn` | `{ prompt, description, subagent_type?, model?, thinking?, cwd?, notify? }` | snapshot. Always background; the parent model hears about it only with `notify: true` |
| `get` / `stop` | `{ id }` | snapshot |
| `wait` | `{ id, timeoutMs? }` | snapshot once it isn't working |
| `steer` | `{ id, message }` | snapshot + `mode: "steer" \| "follow-up"` |
| `list` | — | snapshots |

Broadcasts: `agents:spawned`, `agents:running`, `agents:blocked`, `agents:completed`, `agents:failed`, `agents:stopped`, each with the snapshot (`id`, `address`, `status`, `description`, `type`, `model`, `thinking`, `result`, `error`, `activity`, …). `id` is the herdr terminal name (`find-auth-code`); `address` its hc address (`t8c`) — both work wherever an id is asked for.

## How it works

- **Start:** herdr-core `terminal.run` over `HC_TERMINAL_SOCKET` with `parent` = this pi's terminal, `no_notify` (pi-agents reports to the model itself instead of hc typing notes into pi), labels `pi-agents.run` / `pi-agents.pid`, and `pi --model … --thinking … --name <description> [--tools …] -- <prompt>`. The terminal is named after the description (Cyrillic transliterated, `-2` on collisions).
- **Child side:** the same extension, loaded in the sub-agent, sees `PI_AGENTS_RUN`: it adds a `<subagent>` system-prompt section (role, report format, the type's instructions), inherits the parent's project trust, and writes `~/.pi/agent/@wierdbytes/pi-agents/runs/<run>.json` — settled-run count, last assistant message, tool activity.
- **Parent side:** one `events.subscribe {children_of}` stream (status, exit), `fs.watch` on the run files and a 2 s safety poll. A record finishes when the child's settled-run count moves past where it was when the work was handed over, so a fresh pi's startup idle never counts as done. A pi that exits without a result fails with its last screen.
- Run files older than 7 days are pruned.
