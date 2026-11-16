# Changelog

## 0.6.0

- **New:** the model's bash commands are drawn in pi-facelift's frame — the command in the top border, the herdr terminal's address next to it while it runs (cmd-click it in herdr to peek), duration and ✓ / ✗ exit in the bottom border.

## 0.5.0

- **New:** the model's bash commands and your `!` / `!!` commands run in their own herdr-core terminal under pi's, so herdr clients show each command and its output live while it runs; the terminal is removed when it ends.
- **New:** `{"bash": false}` in `~/.pi/agent/@wierdbytes/pi-herdr/settings.json` keeps commands in pi's own process.

## 0.4.0

- **New:** publish the Claude and Codex subscription limits every provider response reports (5-hour, weekly and per-model windows, plan, status) to herdr-core's `limits` document, so the herdr app, Wierdr and any other herdr-core client can show them on every screen.

## 0.3.2

- **Fix:** context size no longer lags behind pi's statusline after a tool result or a prompt.

## 0.3.1

- **Fix:** after `/new`, `/resume`, `/fork` or a reload, the previous session's cache countdown and context size no longer stay on the terminal.

## 0.3.0

- **New:** publish when the prompt cache expires and how long it lives as `agent.cache_until` / `agent.cache_ttl`, so herdr can show how much of each pi's cache lifetime is left.

## 0.2.0

- **New:** publish the session id as `agent.session`, so herdr can tell which session each pi has open and switch to it instead of opening the session twice.

## 0.1.0

- **New:** publish the session's model, reasoning effort, context size and running pi-subagents count as `agent.*` labels on its herdr-core terminal, so herdr agent lists can show `Opus 5.5 @high · 228k` under each pi.
- **New:** labels follow `/model`, effort changes, every reply and compaction, and are removed when pi quits.
