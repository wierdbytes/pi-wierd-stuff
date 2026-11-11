# @wierdbytes/pi-herdr

Tells [herdr](https://herdr.dev) which model, reasoning effort and context size each [pi](https://github.com/earendil-works/pi) runs with, and how much of your Claude and Codex subscription limits is used ([Limits](#limits)).

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
| `agent.cache_until` | `1793534700000` | When the prompt cache of the current branch expires (epoch ms), as pi-statusline's countdown reads it: the last request or cache warming that touched the cache, plus the model's cache lifetime. Stays after expiry (compare with now); absent when the cache was never touched or the model's cache lifetime is unknown |
| `agent.cache_ttl` | `300000` | How long that cache entry lives from its last refresh (ms): the model's short or long tier. Set with `agent.cache_until`; together they give the share of the lifetime left |
| `agent.subagents` | `2` | [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) agents queued or running. Absent when none |

Read them in a herdr mod from `terminals()`:

```js
const t = terminals().find((t) => t.address === agent.address);
const meta = t?.labels?.["agent.pid"] === String(t?.foreground?.pid) ? t.labels : {};
meta["agent.model"]; // "Claude Opus 5.5"
```

## Limits

Every Claude and Codex response carries the subscription's usage windows (Anthropic's `anthropic-ratelimit-unified-*` headers, Codex's `x-codex-*` headers or `codex.rate_limits` stream event). pi-herdr folds them into one herdr-core document, `limits`, on the machine pi runs on. Any herdr-core client reads it with `doc.get {name: "limits"}` and hears about changes as `doc` events (`events.subscribe`), so the herdr app, Wierdr or a script all show the same numbers, also from other machines (`on`).

```json
{
  "schema": 1,
  "updated_at": 1794310000,
  "accounts": {
    "claude.1a2b3c4d": {
      "provider": "claude", "account": "1a2b3c4d", "plan": "max",
      "status": "ok", "binding": "5h", "source": "header", "host": "mentoair", "at": 1794310000,
      "windows": {
        "5h": { "id": "5h", "label": "5 hours", "window_s": 18000, "used": 67, "resets_at": 1794321600, "status": "ok", "at": 1794310000 },
        "7d": { "id": "7d", "label": "7 days", "window_s": 604800, "used": 36, "resets_at": 1794571200, "status": "ok", "at": 1794310000 }
      }
    }
  }
}
```

- Accounts are keyed `<provider>.<account>`; `account` is the first 8 hex digits of sha256 of the provider's account id (`main` without one), the same as pi-langfuse's `rl.<provider>.<account>.<window>` scores. Codex accounts carry the e-mail pi signs in with as `label`.
- Window ids: `5h`, `7d`, `7d_oi` (weekly with extra usage), `7d_opus`, `7d_sonnet` for Claude; `5h`, `7d` and `<family>.<window>` for extra Codex limit families. `used` is in percent and can pass 100. Times are unix seconds; `at` is when a window was last read, so readers can tell live from stale.
- Several pi processes write it: each reads the document, folds its reading in and writes it back at that version, retrying when another pi wrote in between. Within one window (same reset, give or take two minutes) `used` only grows; a later window replaces it.
- Every reading is written, even with the same numbers: `at` is when a provider last reported the window. Nothing is written between responses. Readings within 500 ms go out as one write.
- Every pi writes, not only the interactive one: `pi -p` runs and sub-agents spend the same subscription. Windows a provider stops reporting stay until a later reading replaces them.

## How it works

- Updates on session start, `/model` and model cycling, effort changes, every assistant request and reply, turn end, compaction, tree navigation and cache warming.
- Changes within 150 ms collapse into one `terminal.label` request over herdr-core's JSON-RPC socket; unchanged values are never sent. No `hc` process is spawned.
- Only the interactive pi owns the terminal: `pi -p`, RPC hosts and in-process sub-agents never write labels.
- Quitting pi removes every label it set (the `limits` document stays: it belongs to the subscription, not to this pi). Switching sessions and `/reload` keep them and the next session republishes.
