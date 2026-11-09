# Changelog

## 0.2.6

- **Fix:** OAuth requests rejected with `claude_code_version_too_old` — Claude Code version markers bumped to 2.1.321.

## 0.2.5

- **New:** ship `CHANGELOG.md` — pi shows release notes under "Extension Updates" after an update.

## 0.2.4

- **Fix:** OAuth requests rejected with `claude_code_version_too_old` — Claude Code version markers bumped to 2.1.281.

## 0.2.3

- **Change:** Claude Code version markers bumped to 2.1.258 for Fable 5.1.

## 0.2.2

- **Change:** first release under the `@wierdbytes/pi-anthropic` name (was `pi-wierd-anthropic`).

## 0.2.1

- **Fix:** system prompt no longer rewrites `pi` → `Claude Code`, which mangled cwd paths and identifiers.

## 0.2.0

- **Change:** use pi-ai's built-in Anthropic streaming instead of a custom streamer.
- **Fix:** Opus 4.7 `xhigh` requesting a fixed thinking budget instead of `effort=max`.

## 0.1.0

- **New:** Claude Pro/Max OAuth provider on top of pi's built-in Anthropic model list.
