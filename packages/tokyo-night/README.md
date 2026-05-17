# @wierdbytes/pi-tokyo-night

[Tokyo Night](https://github.com/folke/tokyonight.nvim) themes for the
[pi](https://github.com/earendil-works/pi) coding agent — all four folke
variants in one package, each mapping the canonical palette to all 51 pi
color tokens (UI chrome, tool boxes, markdown, diffs, syntax highlighting,
thinking-level borders, bash mode).

## Variants

| Theme name          | Variant | Background | Best for                              |
| ------------------- | ------- | ---------- | ------------------------------------- |
| `tokyo-night`       | Night   | `#1a1b26`  | Deepest dark, default folke variant   |
| `tokyo-night-storm` | Storm   | `#24283b`  | Slightly lifted, blue-leaning dark    |
| `tokyo-night-moon`  | Moon    | `#222436`  | Cooler, more saturated, pastel accents |
| `tokyo-night-day`   | Day     | `#e1e2e7`  | Light terminals                       |

All four files live side-by-side in [`themes/`](./themes/) and share an
identical `vars` key set + identical `colors` mapping — only the palette
differs, so they're line-for-line diffable.

## Install

```bash
# user-level (recommended)
pi install npm:@wierdbytes/pi-tokyo-night

# or, project-local
pi install --local npm:@wierdbytes/pi-tokyo-night
```

## Activate

Either pick a variant via `/settings` → Theme, or set it in `settings.json`:

```json
{ "theme": "tokyo-night-storm" }
```

Replace the value with `tokyo-night`, `tokyo-night-moon`, or `tokyo-night-day`
to switch variants. If you edit the JSON of the active theme, pi hot-reloads
on save.

## Palette (Storm shown — others mirror the same role mapping)

Colors come straight from
[`folke/tokyonight.nvim`](https://github.com/folke/tokyonight.nvim):

| Role          | Storm     | Used for                                |
| ------------- | --------- | --------------------------------------- |
| Background    | `#24283b` | tool box base, export card              |
| Bg dark       | `#1f2335` | export page background                  |
| Bg highlight  | `#292e42` | user message background                 |
| Foreground    | `#c0caf5` | default text (terminal default)         |
| Comment       | `#565f89` | muted text, comments, quotes, diff ctx  |
| Blue          | `#7aa2f7` | accent, borders, links, functions       |
| Cyan          | `#7dcfff` | accent borders, inline code, tool title |
| Blue light    | `#89ddff` | operators, blockquote border            |
| Teal          | `#73daca` | types                                   |
| Magenta       | `#bb9af7` | keywords, list bullets, custom label    |
| Orange        | `#ff9e64` | headings, numbers                       |
| Yellow        | `#e0af68` | warnings                                |
| Green         | `#9ece6a` | success, strings, diff added, bash mode |
| Red           | `#f7768e` | error, variables, diff removed          |

The Night, Moon, and Day files reuse the same role mapping — open any of
them and the only thing that changes are the hex values inside `vars`.

## Customize

Drop a fork in `~/.pi/agent/themes/` and tweak `vars`. Because the role
mapping is centralized, a custom variant is mostly a single hex swap per
slot away.

## License

MIT
