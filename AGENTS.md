# AGENTS.md

Guidance for AI agents working in this repo.

## What this is

Monorepo of extensions, themes, and shared TUI helpers for the [pi](https://github.com/earendil-works/pi) coding agent. Each package under `packages/*` is published to npm as `@wierdbytes/pi-*`. Runtime is **Bun**; TypeScript files are consumed directly (no build step) — `package.json` ships `*.ts` in `files`.

## Layout

```
packages/
  anthropic/    Claude Pro/Max OAuth provider (pi extension)
  common/       Shared TUI: settings modal, tool-frame helpers (library)
  events/       Typed notify:toast / notify:status event bus (library)
  facelift/     Pretty rendering for built-in pi tools — bash/read/ls/find/grep (extension)
  statusline/   Tokyo Night statusline footer + chips/toasts (extension)
  tokyo-night/  Four Tokyo Night theme JSONs (theme-only package)
  voice/        Spoken turn summaries via Gemini TTS (extension)
  web/          Anthropic-powered web_search + Puppeteer-based web_fetch (extension)
docs/plans/     Design notes per feature/package
.github/workflows/publish.yml   Auto-publish on push to master
```

## Extension settings
- settings should be placed per-extension in ~/.pi/agent/@wierdbytes/pi-<package-name>/settings.json

## Package conventions

- `package.json` → `pi.extensions: ["./index.ts"]` for extensions, `pi.themes: [...]` for themes.
- Peer-depend on `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` (`>=0.74.0`). Don't bundle them.
- Internal deps use `@wierdbytes/pi-common` and `@wierdbytes/pi-events`.
- Ship sources: `files` lists `*.ts`, `*.md`, `*.json`, `LICENSE`. No `dist/`.
- Tests live next to sources as `*.test.ts`, run via `bun run test` (vitest).

## Getting docs
- when you need packages docs check `/opt/homebrew/lib/node_modules/...`
- when you don't find it there - use npm or github to get actual info

## Workflow

- Install: `bun install` at repo root (workspaces resolve `packages/*`).
- Test a package: `cd packages/<name> && bun run test`.
- Lockfile: `bun.lock` is canonical; `package-lock.json` exists for the publish workflow only.

## Publishing

- Automatic on push to `master` via `.github/workflows/publish.yml`.
- To release: bump `version` in the package's `package.json`, commit. Do **not** rename `publish.yml` — its filename is registered as the Trusted Publisher on npmjs.com.

## Conventions for changes

- Match the existing rounded-frame / Tokyo Night aesthetic when touching TUI output.
- Keep extension `index.ts` thin — register hooks/tools, delegate logic to siblings.
- When adding a new package, mirror an existing one's `package.json` (keywords, `files`, `pi` block, peer deps, `publishConfig.access: public`).
- Update root `README.md`'s package list when adding or removing a package.
