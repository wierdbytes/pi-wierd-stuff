# Changelog

## 0.2.0

- **Fix:** on macOS with Node ≥ 26.1, sounds play inside pi instead of one `afplay` per sound, so bursts from many agents no longer make all Mac audio crackle.
- **Change:** `session.end` is skipped on quit when sounds play inside pi; it would be cut off as pi exits.

## 0.1.2

- **New:** ship `CHANGELOG.md` — pi shows release notes under "Extension Updates" after an update.

## 0.1.1

- **Fix:** first-run pack install progress now shows as pi notifications, even without `@wierdbytes/pi-statusline`.

## 0.1.0

- **New:** play CESP / OpenPeon sound packs on pi lifecycle events; per-category toggles, volume, mute and pack browser in `/peon`.
