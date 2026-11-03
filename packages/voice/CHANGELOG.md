# Changelog

## 0.4.2

- **New:** ship `CHANGELOG.md` — pi shows release notes under "Extension Updates" after an update.

## 0.4.1

- **Change:** slash command renamed `/wierd-voice` → `/voice`.

## 0.4.0

- **Change:** voice settings moved to the shared pi-common settings modal.

## 0.3.2

- **New:** Gemini key resolved from pi's stored `google` credential before falling back to `GOOGLE_API_KEY`.

## 0.3.1

- **Change:** first release under the `@wierdbytes/pi-voice` name (was `pi-wierd-voice`); state dir moved to `~/.pi/agent/wierd-voice/` with automatic migration.

## 0.3.0

- **New:** live voice state via `notify:status` / `notify:toast` — shows as a chip in `@wierdbytes/pi-statusline`.

## 0.2.0

- **Change:** config consolidated into a `/wierd-voice` overlay with voice and summarizer (model + effort) pickers; default voice `Umbriel`.
- **Fix:** auth / rate-limit TTS errors no longer silently mute future sessions.

## 0.1.0

- **New:** spoken summary of each agent turn via Gemini 3.1 Flash TTS; `/wierd-voice` commands and `--no-voice` flag.
