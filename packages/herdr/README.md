# @wierdbytes/pi-herdr

Tells [herdr](https://herdr.dev) which model, reasoning effort and context size each [pi](https://github.com/earendil-works/pi) runs with.

Pi already reports its status (working, blocked, done) over OSC 7501, but that report has no room for the model. This extension writes it as `agent.*` labels on the herdr-core terminal pi runs in, so a herdr agent list can show a second line under each pi:

```
 D  Fix login redirect loop                    ◌
 A\ Opus 5.5 @high              ⑂ 2   228k   4m
```

## Install

```bash
pi install npm:@wierdbytes/pi-herdr
```

Nothing to configure. Outside a herdr-core terminal (no `HC_TERMINAL_ID` / `HC_TERMINAL_SOCKET`) it does nothing.

## Labels

| Label | Example | |
|---|---|---|
| `agent.app` | `pi` | Who wrote the labels |
| `agent.pid` | `88638` | pi's process id: a reader compares it with the terminal's foreground pid and ignores labels left behind by a pi that crashed |
| `agent.model` | `Claude Opus 5.5` | Model display name (`ctx.model.name`, else its id) |
| `agent.model_id` | `claude-opus-5-5` | Model id |
| `agent.provider` | `anthropic` | Provider id |
| `agent.effort` | `high` | Thinking level, or the model's own word for it (`max`, a token budget). Absent when off or the model doesn't reason |
| `agent.ctx` | `228432` | Tokens in the context now. Absent while unknown (right after compaction) |
| `agent.ctx_max` | `1000000` | Context window |
| `agent.session` | `019f8940-4b3b-7d72-8112-3a9ebd007d5c` | The open session's id (`pi --session <id>` opens it again). Follows `/new`, `/resume` and forks; absent for `--no-session` |
| `agent.subagents` | `2` | [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) agents queued or running. Absent when none |

Read them in a herdr mod from `terminals()`:

```js
const t = terminals().find((t) => t.address === agent.address);
const meta = t?.labels?.["agent.pid"] === String(t?.foreground?.pid) ? t.labels : {};
meta["agent.model"]; // "Claude Opus 5.5"
```

## How it works

- Updates on session start, `/model` and model cycling, effort changes, every assistant reply, turn end, compaction and tree navigation.
- Changes within 150 ms collapse into one `terminal.label` request over herdr-core's JSON-RPC socket; unchanged values are never sent. No `hc` process is spawned.
- Only the interactive pi owns the terminal: `pi -p`, RPC hosts and in-process sub-agents never write labels.
- Quitting pi removes every label it set. Switching sessions and `/reload` keep them and the next session republishes.
