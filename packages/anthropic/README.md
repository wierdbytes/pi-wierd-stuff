# @wierdbytes/pi-anthropic

Claude Pro/Max OAuth extension for the [pi](https://github.com/badlogic/pi-mono) coding agent.

Sign in with your Claude Pro or Max account and use it inside pi without an
Anthropic API key.

## Install

```bash
pi install npm:@wierdbytes/pi-anthropic
```

## Usage

Start pi, then run:

```text
/login anthropic
```

and pick **Claude Pro/Max**. Tokens are stored by pi's auth storage and
refreshed automatically.

## What it does

- Registers the `anthropic` provider with an OAuth login flow that targets
  `claude.ai` / `platform.claude.com`.
- Reuses pi-ai's built-in Anthropic streamer, which already detects OAuth
  tokens and applies Claude-Code-compatible headers / betas, the
  `"You are Claude Code, ..."` identity block, Claude-Code tool-name mapping
  and adaptive thinking with `output_config.effort` for Opus 4.6 / 4.7 and
  Sonnet 4.6.
- Layers two Claude-Code-only tweaks on top via the
  `before_provider_request` hook: it rewrites Pi-branded paragraphs in the
  system prompt to Claude Code identity, and prepends the
  `x-anthropic-billing-header` system block so Pro/Max billing accepts the
  request.
- Reuses pi's built-in Anthropic model registry — no custom model list is
  injected, so whatever models ship with your pi version are what you get.
- Creates a `~/.Claude Code` → `~/.pi` symlink on first load when missing,
  so tools that look for the Claude Code config directory keep working.

## Custom models

To expose an extra Anthropic model, declare it in `~/.pi/agent/models.json`
the usual pi way. Requests will still authenticate through the OAuth token
obtained via `/login anthropic`.

## Troubleshooting

- Re-run `/login anthropic` if auth looks stale.
- If the local callback never completes, paste the final callback URL (or
  the `code#state` fragment) when prompted.
- File issues at
  <https://github.com/wierdbytes/pi-wierd-stuff/issues> with your pi
  version, this extension's version and the error output.

## Caveats

> Use at your own risk. Driving Claude Pro/Max through a non-official client
> may go against Anthropic's terms.

## Credits

Originally based on
[`pi-anthropic-oauth`](https://github.com/leohenon/pi-anthropic-oauth) by
Leo Henon. This package is an independent fork maintained inside the
`pi-wierd-stuff` monorepo; bugs here are ours, not the original author's.

## License

MIT
