# pi-agents — herdr-native sub-agents

Replaces `@tintinweb/pi-subagents`. Instead of running sub-agents inside the
parent pi process, every sub-agent is its own interactive `pi` in a
herdr-core terminal started as a **child of the parent's terminal**. Herdr
already understands that relation (`terminals()[i].parent`): the Agents
sidebar nests sub-agents under the agent that started them, shows their
OSC 7501 status, their model labels (pi-herdr runs in them too), and lets a
person peek at / take over any of them.

## Decisions

| | |
|---|---|
| Package | `packages/agents` → `@wierdbytes/pi-agents` |
| Surface | LLM tools + `pi.events` RPC for other extensions |
| Tool names | Claude-style: `Agent`, `get_subagent_result`, `steer_subagent`, `stop_subagent` |
| Lifecycle | a finished sub-agent stays alive and idle (inspectable, can take a follow-up); killed by `stop_subagent` or when the parent pi quits |
| Depth | children don't get the tools by default (`maxDepth: 1`) |

## Transport

herdr-core JSON-RPC over `HC_TERMINAL_SOCKET` (the same socket pi-herdr
uses for labels), one connection per request plus one long-lived
`events.subscribe {children_of: <own terminal>}` stream.

- `terminal.run {argv, cwd, env, labels, name, caller, parent, no_notify}` —
  `no_notify` because notes typed into the parent's TUI would collide with
  pi; the extension delivers completions itself via `pi.sendMessage`.
- `terminal.send` — steer / follow-up (pi queues Enter-while-working as a steer).
- `terminal.kill` + `terminal.rm` — stop.
- `terminal.read` — screen tail for a child that exited without a result.

## Parent ↔ child protocol

The parent writes `<runs>/<runId>.meta.json` (description, type prompt, …)
and starts `pi --model … --thinking … --name <description> [--tools …] -- <prompt>`
with env `PI_AGENTS_RUN=<runId>`, `PI_AGENTS_DEPTH`, `PI_AGENTS_TRUST` plus a
filtered copy of its own env (terminal identity vars dropped).

The same extension, loaded in the child, sees `PI_AGENTS_RUN` and:

- adds a `<subagent>` system-prompt section (role + type instructions);
- answers `project_trust` with the parent's decision (no trust dialog);
- writes `<runs>/<runId>.json` atomically: `seq` (settled runs), `running`,
  `last {status, text, error}` (last assistant message at `agent_settled`),
  `activity {tools, turns, tool, detail}` (throttled).

The parent finishes a record when `seq` moves past the baseline taken when
the work was dispatched. herdr status events drive `blocked`; `finished`
events catch crashes. Triggers: hc events, `fs.watch` on the runs dir and
a 2 s safety poll.

`runs` = `~/.pi/agent/@wierdbytes/pi-agents/runs`, pruned after 7 days.

## Re-adoption

Children carry labels `pi-agents.run` / `pi-agents.pid`. After `/reload`
the new extension instance rebuilds its records from the subscription
snapshot (same pid) and the run files.

## RPC (`pi.events`)

Request channel `agents:rpc:<method>`, reply on
`agents:rpc:<method>:reply:<requestId>` with `{success, data?|error?}`.
Methods: `ping`, `spawn`, `get`, `wait`, `steer`, `stop`, `list`.
Broadcasts: `agents:spawned|running|blocked|completed|failed|stopped`.
`client.ts` wraps this for other extensions.
