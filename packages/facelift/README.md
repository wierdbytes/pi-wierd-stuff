# `@wierdbytes/pi-facelift`

Cosmetic facelift for built-in [pi coding agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)
tool output.

> inspired by [`pi-pretty`](https://github.com/buddingnewinsights/pi-pretty)

![read / bash / ls / find / grep rendered with the open-right rounded frame](./media/demo.png)

## What you get

- **`read`** — syntax-highlighted file content with line numbers, plus
  inline image rendering (Kitty / iTerm2 protocols, with tmux passthrough).
- **`bash`** — open-right frame with the duration + status pinned to the
  bottom border

  Status color follows pi: **green** on success, **yellow** while still
  running, **red** on non-zero / timeout / abort. The exit summary is
  consistent across statuses (`✓ exit 0`, `✗ exit N`, `⚡ timed out`,
  `⚡ aborted`). Duration is shown as `3.3s` / `1m3s` / `2h5m`.
- **`ls`** — Nerd Font file icons + tree-oriented rendering.
- **`find` / `grep`** — grouped / highlighted rendering on top of pi's
  built-in tool implementations (no extra search backend, no extra
  dependencies).

## Install

```bash
pi install npm:@wierdbytes/pi-facelift
```

## Terminal support for inline images

Inline image previews work in **Ghostty**, **Kitty**, **iTerm2**, and
**WezTerm**. Inside `tmux`, pi-facelift uses passthrough escape
sequences:

```tmux
set -g allow-passthrough on
```

(or run once in a session: `tmux set -g allow-passthrough on`)

## Configuration

All configuration is via environment variables — no settings file:

| Variable                       | Default         | Notes                                                                         |
| ------------------------------ | --------------- | ----------------------------------------------------------------------------- |
| `FACELIFT_THEME`               | `github-dark`   | Shiki theme. Falls back to `~/.pi/agent/settings.json` `theme` if unset.      |
| `FACELIFT_MAX_HL_CHARS`        | `80000`         | Files larger than this skip syntax highlighting (still get line numbers).     |
| `FACELIFT_MAX_PREVIEW_LINES`   | `80`            | Body preview length for collapsed renderers.                                  |
| `FACELIFT_CACHE_LIMIT`         | `128`           | Max number of highlighted blocks held in memory.                              |
| `FACELIFT_ICONS`               | `nerd`          | Set to `none` / `off` to disable Nerd Font icons in `ls`/`find`/`grep`.       |
| `FACELIFT_IMAGE_PROTOCOL`      | auto            | Force `kitty` / `iterm2` / `none`. Auto-detected from `$TERM_PROGRAM` etc.    |

## Development

This package lives in the [`pi-wierd-stuff`](../../README.md) monorepo.

```bash
bun install                        # from the repo root
cd packages/facelift
bun run test                       # 11 tests
bun run test:watch                 # vitest watch mode
bun run demo                       # render every tool block to your terminal
```

The `demo` script (`scripts/demo.ts`) is a visual harness — it boots the
extension with mocked SDK tools and prints every renderer (read with
live shiki highlighting, bash in success / non-zero / streaming /
timeout states, ls tree, find groups, grep matches) so you can eyeball
the open-right rounded frame, status-aware coloring, and the duration /
exit summary in the bottom border.

Typecheck (uses the global `tsc`):

```bash
bunx tsc --noEmit --target esnext --module nodenext \
  --moduleResolution nodenext --strict --skipLibCheck \
  --allowImportingTsExtensions \
  index.ts
```

## License

MIT — see [LICENSE](./LICENSE).
