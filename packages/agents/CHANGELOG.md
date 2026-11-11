# Changelog

## 0.1.0

- **New:** `Agent` starts a sub-agent as its own pi in a herdr-core terminal nested under this one, with a model, reasoning effort, prompt and agent type; foreground waits with live progress, background reports back when done.
- **New:** `get_subagent_result` checks on or waits for a sub-agent, `steer_subagent` steers it or gives a finished one a follow-up, `stop_subagent` closes it.
- **New:** agent types `general-purpose`, `Explore`, `Plan`, plus your own from `~/.pi/agent/agents/*.md` and `.pi/agents/*.md`.
- **New:** `/agents` lists sub-agents and peeks at one in herdr or stops it.
- **New:** `pi.events` RPC and a typed client (`@wierdbytes/pi-agents/client`) so other extensions can start, wait for, steer and stop sub-agents.
