# pi-wierd-voice

Spoken summary after each agent turn for the [pi](https://github.com/badlogic/pi-mono) coding agent.

After the assistant finishes a user request, this extension:

1. Picks the assistant text from the latest turn.
2. Generates a short, expressive 1–2 sentence summary of it.
3. Speaks the summary aloud through your system's audio player.

If a new agent turn starts while a previous summary is still playing,
the in-flight summary is cancelled and replaced. Stays silent in
print/RPC mode and when no Gemini API key is configured.

## Install

```bash
pi install npm:pi-wierd-voice
```

Restart pi to activate. Verify with `/wierd-voice status`.

You also need:

- A Gemini API key (see **Auth** below).
- A system audio player on `$PATH`:
  - macOS: `afplay` (preinstalled).
  - Linux: one of `paplay` (PulseAudio), `aplay` (ALSA), or `ffplay` (ffmpeg).
  - Windows: PowerShell (preinstalled).

## Auth

Resolved in this order, first hit wins:

1. `PI_VOICE_GEMINI_API_KEY` — package-specific override.
2. `GEMINI_API_KEY`
3. `GOOGLE_API_KEY`

If none is set, the extension stays silent on every `agent_end` and
`/wierd-voice status` shows `key: none`.

## Configuration

State lives in `~/.pi/agent/pi-wierd-voice/`:

- `config.json` — settings (created on first save).
- `last.wav` — most recent synthesized audio. Overwritten each turn and
  by `/wierd-voice say`. Used by `/wierd-voice replay`.

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

- `muted` — when true, no playback (still kept current via /wierd-voice unmute).
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
  contract as `/wierd-web-fetch-model`).

The TTS model itself is hardcoded to `gemini-3.1-flash-tts-preview`.

## Commands

Every persisted setting (voice, scope, summarizer model, mute) is
configured through a single centered overlay. Bare `/wierd-voice` opens
it; the rest of the surface is imperative actions.

| Command                   | What it does                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `/wierd-voice`            | Open the settings overlay (Up/Down between rows, Enter/Space cycles or opens submenu, Esc closes). Falls back to `status` in non-interactive sessions. |
| `/wierd-voice status`     | Show config path, key source, voice, scope, summarizer, thinking level, muted, audio player.                       |
| `/wierd-voice mute`       | Shortcut for the overlay's `Muted` row. Sets `muted=true` and aborts any in-flight job.                            |
| `/wierd-voice unmute`     | Shortcut for the overlay's `Muted` row. Sets `muted=false`.                                                        |
| `/wierd-voice say <text>` | Synthesize and play `<text>` directly. Bypasses the summarizer.                                                    |
| `/wierd-voice replay`     | Re-spawn the audio player on the stored `last.wav`.                                                                |
| `/wierd-voice reset`      | Restore defaults (`muted=false`, voice=Umbriel, scope=last, summarizer cleared).                                      |

The overlay rows:

- **Muted** — cycle `false` / `true`. Same effect as `/wierd-voice mute`.
- **Voice** — Enter opens a picker showing all 30 prebuilt Gemini
  voices with their descriptors (`Umbriel  Easy-going`, `Kore  Firm`,
  `Puck  Upbeat`, …). Up/Down to scroll, Enter saves, Esc cancels. The
  parent row label shows both, e.g. `Umbriel  ·  Easy-going`.
- **Summary scope** — cycle `last` / `sinceUser`.
- **Summarizer model** — Enter opens a dual model + effort picker (a
  port of `/wierd-web-fetch-model`):
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
