# Changelog

## 0.1.0

- **New:** fork of `@eko24ive/pi-ask` 1.2.0 — same `ask_user` tool, `/ask-settings`, `/answer`, `/answer:again`, `/ask:replay` commands and bundled `ask-user` skill.
- **Fix:** pi now shows as blocked on a question (OSC 7501) while an ask form waits — herdr, Rex and other agent dashboards alert instead of showing it as working.
- **Change:** config moved to `~/.pi/agent/@wierdbytes/pi-ask/settings.json`.
- **Breaking:** remote `pi.events` channels renamed from `@eko24ive/pi-ask:*` to `@wierdbytes/pi-ask:*`.
