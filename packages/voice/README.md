# @wierdbytes/pi-voice

Spoken summary after each agent turn for the [pi](https://github.com/earendil-works/pi) coding agent.

After the assistant finishes a user request, this extension:

1. Picks the assistant text from the latest turn.
2. Generates a short, expressive 1–2 sentence summary of it.
3. Speaks the summary aloud through your system's audio player.

If a new agent turn starts while a previous summary is still playing,
the in-flight summary is cancelled and replaced. Stays silent in
print/RPC mode and when no Gemini API key is configured.

## Install

```bash
pi install npm:@wierdbytes/pi-voice
```

Restart pi to activate. Verify with `/voice status`.

You also need:

- A Gemini API key (see **Auth** below).
- A system audio player on `$PATH`:
  - macOS: `afplay` (preinstalled).
  - Linux: one of `paplay` (PulseAudio), `aplay` (ALSA), or `ffplay` (ffmpeg).
  - Windows: PowerShell (preinstalled).

## Auth

Resolved in this order, first hit wins:

1. **`PI_VOICE_GEMINI_API_KEY`** — package-specific override env var.
   Always wins, useful for power users who want voice to use a
   different Google credential than the rest of pi.
2. **pi's stored Google credential** — read via
   `ctx.modelRegistry.getApiKeyForProvider("google")`. This covers:
   - any key set with `pi auth set google <key>` (stored in pi's
     `auth.json`),
   - custom-provider Google entries in `models.json`,
   - the `GEMINI_API_KEY` environment variable that pi-ai falls back on.
   The cached value is refreshed on `session_start`, on every
   `agent_end`, and on every `/voice` subcommand, so a credential
   rotated mid-session is picked up without restarting pi.
3. **`GOOGLE_API_KEY`** — last-resort env fallback. pi-ai's registry
   only maps `GEMINI_API_KEY` to the `google` provider, so we keep
   `GOOGLE_API_KEY` as a separate hop for users who only have that one
   exported.

If none of the above resolves to a non-empty key, the extension stays
silent on every `agent_end` and `/voice status` shows
`key: none`. The status row labels each successful resolution with its
source (`PI_VOICE_GEMINI_API_KEY` / `pi:google` / `GEMINI_API_KEY` /
`GOOGLE_API_KEY`).

## Configuration

State lives in `~/.pi/agent/wierd-voice/`:

> Migrating from a previous version? On first run after upgrading,
> the extension silently renames the legacy `~/.pi/agent/pi-wierd-voice/`
> directory to `~/.pi/agent/wierd-voice/` so you keep your config and
> last-played audio.

- `config.json` — settings (created on first save).
- `last.wav` — most recent synthesized audio. Overwritten each turn and
  by `/voice say`. Used by `/voice replay`.

`config.json` shape:

```json
{
  "muted": false,
  "voice": "Umbriel",
  "scope": "last",
  "summarizerModel": "anthropic/claude-haiku-4-5",
  "summarizerThinkingLevel": "medium"
}
```

- `muted` — when true, no playback (still kept current via /voice unmute).
- `voice` — one of 30 prebuilt voices (see the overlay's Voice row).
- `scope` — `last` (final assistant message only) or `sinceUser`
  (assistant text + tool-call digests since the last user message).
- `summarizerModel` — provider/model id for the summary sub-agent. Unset
  ⇒ uses the current session model.
- `summarizerThinkingLevel` — reasoning effort for the summary sub-agent,
  forwarded as `pi --thinking <level>`. One of
  `off | minimal | low | medium | high | xhigh`. Unset ⇒ inherit pi's
  default for the chosen model. The overlay clamps the value to whatever
  the highlighted model advertises in its `thinkingLevelMap` (same
  contract as `/web fetch-model`).

The TTS model itself is hardcoded to `gemini-3.1-flash-tts-preview`.

## Commands

Every persisted setting (voice, scope, summarizer model, mute) is
configured through a single centered overlay. Bare `/voice` opens
it; the rest of the surface is imperative actions.

| Command            | What it does                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `/voice`           | Open the settings overlay (Up/Down between rows, Enter/Space cycles or opens submenu, Esc closes). Falls back to `status` in non-interactive sessions. |
| `/voice status`    | Show config path, key source, voice, scope, summarizer, thinking level, muted, audio player.                       |
| `/voice mute`      | Shortcut for the overlay's `Muted` row. Sets `muted=true` and aborts any in-flight job.                            |
| `/voice unmute`    | Shortcut for the overlay's `Muted` row. Sets `muted=false`.                                                        |
| `/voice say <text>`| Synthesize and play `<text>` directly. Bypasses the summarizer.                                                    |
| `/voice replay`    | Re-spawn the audio player on the stored `last.wav`.                                                                |
| `/voice reset`     | Restore defaults (`muted=false`, voice=Umbriel, scope=last, summarizer cleared).                                   |

The overlay rows:

- **Muted** — cycle `false` / `true`. Same effect as `/voice mute`.
- **Voice** — Enter opens a picker showing all 30 prebuilt Gemini
  voices with their descriptors (`Umbriel  Easy-going`, `Kore  Firm`,
  `Puck  Upbeat`, …). Up/Down to scroll, Enter saves, Esc cancels. The
  parent row label shows both, e.g. `Umbriel  ·  Easy-going`.
- **Summary scope** — cycle `last` / `sinceUser`.
- **Summarizer model** — Enter opens a dual model + effort picker (a
  port of `/web fetch-model`):
  - Up/Down moves through every model with configured auth (mirrors
    `/models`), plus a `(session model)` entry at the top that clears
    the override.
  - Left/Right cycles the reasoning effort, restricted to the levels
    the highlighted model advertises in `thinkingLevelMap`. Switching
    models re-clamps the effort (e.g. dropping `xhigh` when moving to
    a model that doesn't support it).
  - Enter saves both fields atomically; Esc abandons the choice.
  - The row label in the parent overlay shows both, e.g.
    `anthropic/claude-haiku-4-5  ·  medium`.

Every change is persisted to `config.json` immediately (Esc just closes
the overlay; there is no separate "save" step — same UX as
`/settings`).

## CLI flags

- `--no-voice` — disable voice playback for the current session.
