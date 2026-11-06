# Changelog

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
