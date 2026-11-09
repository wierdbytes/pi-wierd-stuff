# @wierdbytes/pi-dream

Offline memory consolidation — "dreaming" — for the [pi](https://pi.dev) coding agent.

While you work, pi sessions pile up in `~/.pi/agent/sessions`. Every so often pi-dream "falls asleep" in a background pi process, reads the new sessions, and distills what future sessions will need into a few small, evidence-backed memory notes. **Every change goes to a pull request in your private memory repository**; only what you merge is loaded into new sessions — as a small index, within a token budget, frozen per session so the prompt cache keeps hitting.

Built after Anthropic's [The components of agent memory](https://www.anthropic.com/research/components-of-agent-memory) and the evidence on what makes agent memory hurt: wrong or stale notes, full-text rewrites, bloated always-on context.

## Install

```bash
pi install npm:@wierdbytes/pi-dream
```

Then, in pi:

```text
/dream init
```

This creates `~/.pi/memory` (a git repo), a **private** GitHub repository `<you>/pi-memory` as its `origin` (needs the `gh` CLI, logged in), a `pi-dream` label, and `~/.pi/agent/@wierdbytes/pi-dream/settings.json`.

## How a dream works

1. **Digests.** Every session (active branch) becomes a compact digest: user messages, assistant text, one line per tool call, tool-result heads, errors; no images, no thinking; credentials scrubbed. Digests are also the corpus for `memory_search`.
2. **Cards** (`anthropic/claude-sonnet-5-5`). Each new or grown session gets a card: what happened, how it ended, the user's feedback (verbatim), candidate learnings — each citing digest entry ids.
3. **Curator** (`anthropic/claude-opus-5-5`, per project). Sees the current notes (global + project), the cards, *history hits* (older sessions that mention a candidate, to judge recurrence), other projects the evidence points to, inbox items, the project's AGENTS.md, and what you rejected before. Proposes operations: `add`, `update` (also moves a note to another scope), `supersede`, `deprecate`, `confirm`, `skill`, `agents_md`.

   **Scope.** A session belongs to the project it was about, not to the folder pi was started in: when pi runs in a workspace folder (`~/me/dev`, `~` — a folder that contains other projects), the session goes to the project whose files it worked with most. Only real projects count (git repositories or folders with markers such as `.pi`, `AGENTS.md`, `package.json`); `~/Downloads` or `/tmp` never become one. `global` is only for your general preferences and machine-wide setup; a topic used in several projects goes to each of them. The fact checker can move a note out of global, and code refuses global notes whose evidence comes from a single project without your own words.
4. **Fact check** (`openai-codex/gpt-6.1-sol`). Every cited entry is looked up in the raw session; operations citing entries that do not exist are dropped. An independent model checks each operation against those excerpts: supported, partial (with a fix), unsupported, contradicted, unsafe.
5. **Code applies** what passed — item by item, never a full rewrite; near-duplicates merge into the existing note; superseded notes stay with `valid_until`; credentials and prompt-injection patterns are refused. `MEMORY.md` indexes are regenerated from note front matter within the token budgets.
6. **Pull request.** Changes are committed on a `pi-dream/…` branch with the dream's full report (`reports/<run>.md`: every change with its rationale, evidence and fact check, plus what the check rejected). The PR description is the review view of the whole PR: counts and what to check before merging (risky commands, failed AGENTS.md edits, over-budget indexes) on top, then one line per note grouped by project — marked when it loads into every session (_always_ / _on demand_) — with the note text, rationale and sessions folded under it. While a PR is open, later dreams add commits to it, rebuild the description from the branch (so it shows what merging does, review comments and your edits included) and leave a short comment with what they changed.
7. **AGENTS.md / CLAUDE.md** edits become pull requests in the project's own repository (from a temporary worktree, your working copy is never touched; public repos get no session details). One open proposal per repository: no new one is made while it awaits review.

Reviewing:

- **Merge** — the changes become memory.
- **Edit notes in the PR** — the next dream continues from your version.
- **Comment on the PR** — an instruction for the dream (edit, drop, move to another project); `/dream review` applies new comments right away without processing new sessions.
- **Close without merging** — the notes count as rejected and are not proposed again without new evidence.

## In a session

- A `<memory>` section with the approved global index and the current project's index (built on the first turn, frozen for the session, replayed on resume). Nothing is injected while memory is empty.
- `memory_search` — notes and past-session digests (BM25, Russian + English).
- `memory_read` — a note (`m-xxxxxx`) with its evidence, or a past session entry (`s:<session>#<entry>`).
- `memory_inbox` — keep something for the next dream; it becomes memory only after review.
- `/remember <text>` — the same, from you.
- `/memory` — what this session got; `/memory sync` — pull merged memory now.
- `/dream` — status; `/dream run [--since <days>] [--max <sessions>]`, `/dream review` (apply new PR comments now), `/dream dry` (no push, report and worktree stay local), `/dream index` (rebuild digests), `/dream log`, `/dream init`.
- `--no-memory` — no injection and no memory tools for this run (`PI_DREAM_DISABLE=1` does the same).

## When it dreams

pi is the scheduler: when a session starts and a dream is due — at least `schedule.minHoursBetween` hours (20) since the last one and `schedule.minNewSessions` (3) new sessions or inbox items — a detached headless pi process runs it:

```text
pi -p --no-session --no-extensions -e <childExtensions…> -e runner.ts "/pi-dream-run …"
```

It survives the interactive pi exiting, holds a lock (one dream at a time across all pi processes; stale locks are taken over), and loads only the extensions listed in `dream.childExtensions` (default: `@wierdbytes/pi-anthropic`, so Claude Pro/Max OAuth behaves as in your sessions). Sessions written to in the last `dream.minIdleMinutes` (30) are left for the next dream.

## Memory repository

```text
~/.pi/memory/
  scopes/global/{charter.md, MEMORY.md, notes/, skills/}
  scopes/projects/<key>/{charter.md?, MEMORY.md, notes/, skills/, scope.json}
  scopes/projects/_charter.md      default purpose of project memory
  reports/<run>.md
  prompts/{cards,curator,review,verify}.md   optional prompt overrides
  .local/                          gitignored: inbox, digests, cards, runs, logs, state
```

Projects are keyed by their `origin` remote (`github.com/owner/repo`) or by path; worktrees map to their main repository. `charter.md` says what a scope's memory is *for* — it steers the dream and is never injected.

## Settings

`~/.pi/agent/@wierdbytes/pi-dream/settings.json`:

| Key | Default | |
|---|---|---|
| `memoryDir` | `~/.pi/memory` | memory repository (`PI_DREAM_DIR` overrides) |
| `language` | `Russian` | language of notes and reports |
| `inject` | `true` | inject the approved index into sessions |
| `models.cards` / `analyze` / `verify` | Sonnet 5.5 low / Opus 5.5 high / GPT-6.1 sol medium | `{ "model": "provider/id", "thinking": "…" }` |
| `schedule` | `{ enabled: true, minHoursBetween: 20, minNewSessions: 3 }` | when a dream is due |
| `dream.firstRunLookbackDays` | `14` | how far back the first dream looks |
| `dream.maxSessionsPerRun` | `60` | the rest waits for the next dream |
| `dream.minIdleMinutes` | `30` | sessions written more recently are skipped |
| `dream.concurrency` | `4` | parallel card calls |
| `dream.maxRuntimeMinutes` | `180` | hard limit of one dream |
| `dream.childExtensions` | `["npm:@wierdbytes/pi-anthropic"]` | extensions the dream process loads |
| `budgets.globalTokens` / `projectTokens` | `1000` / `1500` | index budgets |
| `github` | `{ repo: "pi-memory", base: "main", label: "pi-dream" }` | |
| `agentsMd` | `true` | propose AGENTS.md / CLAUDE.md changes |

## Development

```bash
cd packages/dream && bun run test
pi -e ./index.ts            # try in a session
```
