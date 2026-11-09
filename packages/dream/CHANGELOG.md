# Changelog

## 0.2.0

- **Change:** the memory PR description is a review view — counts and what to check before merging on top, then one line per note grouped by project, marked when it loads into every session, with the note text, rationale and sessions folded under it.
- **New:** the PR description covers the whole PR — later dreams rebuild it from the branch (review comments and your edits included) and leave a short comment with what they changed.
- **Fix:** `<placeholders>` in note titles and text no longer vanish from the PR description.

## 0.1.1

- **Fix:** a note is no longer superseded or deprecated on evidence older than its own — the curator and the fact check see when each note was last observed, and the report flags replacements of notes with newer evidence.
- **Fix:** on Linux, paths under `/home/<user>` in shell commands now count when a session is matched to its project.

## 0.1.0

- **New:** dreaming — a background pi run distills new sessions into evidence-backed memory notes: per-session cards (Sonnet 5.5), a curator that proposes add / update / supersede / deprecate / confirm operations (Opus 5.5), and an independent fact check of every operation against the original transcript entries (GPT-6.1).
- **New:** every change goes to a pull request in your private memory repo (`~/.pi/memory` → GitHub); comments on the PR are applied by the next dream, closing it rejects its notes.
- **New:** approved memory is injected into new sessions as a small `<memory>` index (global + current project, token budgets enforced), frozen per session so the prompt cache keeps hitting.
- **New:** `memory_search` (notes and past sessions), `memory_read` (notes and transcript entries) and `memory_inbox` (keep something for the next dream) tools.
- **New:** notes go to the project a session was about — sessions started in a workspace folder (`~/me/dev`, `~`) belong to the project whose files they worked with; `global` is kept for general preferences and machine-wide setup, and a single project's findings never land there without your own words.
- **New:** notes can be moved between scopes (by the curator, the fact checker or a PR comment).
- **New:** AGENTS.md / CLAUDE.md change proposals as pull requests in the project's own repository, one open proposal per repository.
- **New:** `/dream` (status, run, review, dry, init, log, index), `/memory` (status, sync), `/remember`, and the `--no-memory` flag.
