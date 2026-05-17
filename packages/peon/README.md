# @wierdbytes/pi-peon

[CESP / OpenPeon](https://openpeon.com/spec) sound-pack player for the
[pi](https://github.com/earendil-works/pi) coding agent.

> *"Work, work."*

Drop a sound pack into `~/.openpeon/packs/<name>/` (or install one from
the [community registry](https://openpeon.com/packs) - 300+ packs:
peons, GLaDOS, Stronghold lords, StarCraft battlecruisers, ...) and pi
will play a clip on every notable lifecycle event.

## Install

```bash
pi install npm:@wierdbytes/pi-peon
```

The default config points at the **peon** pack (Warcraft III Orc Peon).
If it isn't on disk yet, the extension auto-downloads it from the
[community registry](https://peonping.github.io/registry/index.json)
on `session_start`. The pack ends up at `~/.openpeon/packs/peon/` and
the very first `session.start` clip plays as soon as the install
finishes — no restart needed.

## What you hear

| pi event                                  | CESP category       |
| ----------------------------------------- | ------------------- |
| `session_start` (startup / new)           | `session.start`     |
| `agent_start`                             | `task.acknowledge`  |
| `agent_end` (turn used tools)             | `task.complete`     |
| `agent_end` (no tools, just chat)         | `input.required`    |
| `tool_result` with `isError === true`     | `task.error`        |
| `after_provider_response` with `status === 429` | `resource.limit` |
| `session_shutdown` (reason `"quit"`)      | `session.end`       |
| user sending ≥ 3 messages in 5 s          | `user.spam`         |

Every category can be toggled individually from the settings modal -
the on-disk pack decides whether that category has actual sounds, and
missing categories are silently skipped (per spec).

## Commands

```text
/peon                  open settings modal (active pack, volume, mute,
                       per-event toggles, registry browser, sound preview)
/peon status           print active pack + player + config path
/peon mute             silence every category until /peon unmute
/peon unmute
/peon test [category]  play a random sound from the named category
                       (defaults to session.start). Bypasses debounce.
/peon reset            restore default config
```

CLI flag `--no-peon` disables playback for one pi session without
touching the config.

## Settings modal

Everything you can configure interactively lives behind `/peon`:

- **Packs…** — one unified picker for everything pack-related. Opens
  a sectioned list with three groups:
  - **Active** — the pack currently bound to events.
  - **Available** — installed packs at `~/.openpeon/packs/`.
  - **Registry** — everything else from
    [`https://peonping.github.io/registry/index.json`](https://peonping.github.io/registry/index.json).

  Keys inside the picker:
  - `↑`/`↓` — navigate (skips section headers).
  - `Enter` — drill into the highlighted pack's sound files.
  - `Tab` — set the highlighted pack as active. Downloads + installs
    automatically when the pack lives only in the registry.
  - `Esc` — back to the main settings.
  - Type to substring-filter across pack id, display name, description,
    tags, language, and trust tier (case-insensitive).

  Inside the **files** drill-in:
  - `↑`/`↓` — navigate the sound list (no filter row — a single
    pack rarely has more than ~30 clips).
  - `Enter` — play the sound. Uses the local copy if the pack is
    installed; otherwise downloads just **that one clip** to
    `$TMPDIR/peon-previews/` and plays from there — no full-pack
    install needed for auditioning.
  - `Tab` — set this sound's pack as the active pack (same install-
    if-needed logic).
  - `Esc` — back to the packs picker.

  Left/Right arrows are filter-cursor movement only — they don't
  drive navigation between submenus.

- **Master volume** — 0–100. Scaled to each backend's native range
  (afplay's `-v 0.0–1.0`, paplay's 0–65 536, ffplay's `-volume 0–100`).
- **Muted** — global kill switch.
- **Per-event toggles** — one boolean per CESP category. The settings
  description tells you whether the active pack actually has sounds for
  that category.

## Audio backends

Detected once per session via `which` / `where`:

| Platform | Order tried                                          |
| -------- | ---------------------------------------------------- |
| macOS    | `afplay`                                              |
| Linux    | `pw-play`, `paplay`, `ffplay`, `mpv`, `play`, `aplay` |
| Windows  | `powershell.exe` (`System.Windows.Media.MediaPlayer`) |

`aplay` has no volume control; the master-volume setting is ignored
when it's the only backend.

## Storage layout

```
~/.openpeon/packs/<pack>/
   ├── openpeon.json         # CESP manifest
   └── sounds/
       ├── *.wav | *.mp3 | *.ogg

~/.pi/agent/peon/
   └── config.json           # this extension's own config
```

Override the pack root with `PEON_PACKS_DIR=/some/other/dir`. Override
the state dir with the standard `PI_AGENT_DIR`.

## Picker behaviour

- **No-repeat** - when a category has > 1 sound, the picker never picks
  the same one twice in a row.
- **Debounce** - events firing within 500 ms of the previous play of
  the same category are suppressed.
- **User-spam cooldown** - `user.spam` re-fires at most once per 10 s.

## Spec reference

Built against [CESP 1.0](https://openpeon.com/spec). Manifest format,
category-alias fallback, and tarball-from-GitHub install flow all
follow the spec verbatim - packs that work in any other CESP-aware
tool work here, and vice versa.

## License

MIT — see [LICENSE](./LICENSE). Sound packs themselves ship under their
own licenses; see each pack's `openpeon.json`.
