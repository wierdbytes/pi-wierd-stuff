# pi-wierd-voice

Spoken summary after each agent turn for the [pi](https://github.com/badlogic/pi-mono) coding agent.

After the assistant finishes a user request, this extension:

1. Picks the assistant text from the latest turn (scope: `last` or `sinceUser`).
2. Runs a sub-agent (`pi --mode json -p --no-session --no-tools`) to produce a 1–2 sentence summary, with Gemini 3.1 audio tags (`[neutral]`, `[short pause]`, `[fast]`, …) so playback isn't monotone.
3. Synthesizes the summary with Google's [`gemini-3.1-flash-tts-preview`](https://ai.google.dev/gemini-api/docs/speech-generation) (24 kHz, 16-bit, mono PCM).
4. Wraps the PCM as WAV and plays it through whatever audio player the host already has (`afplay` / `paplay` / `aplay` / `ffplay` / PowerShell `SoundPlayer.PlaySync`).

A fresh agent turn while a previous summary is still playing aborts the
in-flight job (kill subagent / abort TTS / kill player) and starts a new
one. Disabled silently in print/RPC mode and when no Gemini API key is
configured.

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
  "voice": "Kore",
  "scope": "last",
  "summarizerModel": "anthropic/claude-haiku-4-5"
}
```

- `muted` — when true, no playback (still kept current via /wierd-voice unmute).
- `voice` — one of 30 prebuilt voices (see `/wierd-voice voice` with no arg).
- `scope` — `last` (final assistant message only) or `sinceUser`
  (assistant text + tool-call digests since the last user message).
- `summarizerModel` — provider/model id for the summary sub-agent. Unset
  ⇒ uses the current session model.

The TTS model itself is hardcoded to `gemini-3.1-flash-tts-preview`.

## Commands

| Command                              | What it does                                                              |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `/wierd-voice`                       | Alias of `/wierd-voice status`.                                           |
| `/wierd-voice status`                | Show config path, key source, voice, scope, summarizer, muted, last error. |
| `/wierd-voice mute`                  | Set `muted=true`. Aborts any in-flight job.                               |
| `/wierd-voice unmute`                | Set `muted=false`.                                                         |
| `/wierd-voice voice <name>`          | Set the voice. No arg ⇒ list all 30 with descriptors.                     |
| `/wierd-voice scope <last\|sinceUser>` | Set the summarizer input scope.                                          |
| `/wierd-voice summarizer <id>`       | Set `summarizerModel` (`""` to clear).                                    |
| `/wierd-voice say <text>`            | Synthesize and play `<text>` directly. Bypasses the summarizer.           |
| `/wierd-voice replay`                | Re-spawn the audio player on the stored `last.wav`.                       |
| `/wierd-voice reset`                 | Restore defaults; clear `disabledReason`.                                 |
| `/wierd-voice-summarizer-model`      | Interactive overlay picker for the summarizer model + effort.             |

## CLI flags

- `--no-voice` — disable voice playback for the current session.

## Tests

```bash
bun --filter pi-wierd-voice test
```
