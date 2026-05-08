/**
 * @wierdbytes/pi-statusline — icon-set registry.
 *
 * The statusline's per-slot icons used to be hard-coded emoji
 * (🤖 🧠 📦 ✅ …). Emoji renders inconsistently across terminals,
 * fonts, and ssh sessions, so this module exposes a small registry of
 * named icon sets the user can switch between via
 * `/statusline icons <set>` (or the Display tab of the settings
 * modal).
 *
 * Five sets ship in the box:
 *
 *   - `nerd-font`  Nerd Font glyphs (PUA codepoints). Default.
 *                  Requires a Nerd Font configured in the terminal.
 *                  Single-cell, monochrome, recolours via ANSI.
 *   - `plain`      Geometric Unicode glyphs that render in any modern
 *                  terminal — no font install required. Works over
 *                  ssh / tmux / mosh.
 *   - `ascii`      Bracketed ASCII labels. Survives literally
 *                  everything (dumb terminals, log files, broken
 *                  fontconfig).
 *   - `minimal`    Single-character symbolic glyphs from BMP Unicode.
 *                  Reads more like a Powerline / starship preset.
 *   - `emoji`      Original emoji set — kept for users who liked the
 *                  pre-facelift look.
 *
 * `git` (✓ / ✗) and subagent inline marks (✓ / ✗) intentionally stay
 * plain Unicode regardless of icon set — they look identical
 * everywhere and don't read as "decoration" the way model / thinking
 * / stash icons do.
 */

/** Built-in icon-set identifiers. */
export type IconSet = "nerd-font" | "plain" | "ascii" | "minimal" | "emoji";

/** Every visual slot the statusline / subagents tracker can theme. */
export type IconKey =
  | "model"
  | "thinking"
  | "stash"
  | "debug"
  | "info"
  | "success"
  | "warning"
  | "error"
  | "scheduled"
  | "agents";

/** Ordered list of valid icon-set ids (also used by the modal field). */
export const VALID_ICON_SETS: readonly IconSet[] = [
  "nerd-font",
  "plain",
  "ascii",
  "minimal",
  "emoji",
] as const;

/** Default set used when the persisted config is missing or invalid. */
export const DEFAULT_ICON_SET: IconSet = "nerd-font";

/** User-facing names rendered in the settings modal cycle / submenu. */
export const ICON_SET_LABELS: Record<IconSet, string> = {
  "nerd-font": "Nerd Font",
  plain: "Plain Unicode",
  ascii: "ASCII",
  minimal: "Minimal",
  emoji: "Emoji (legacy)",
};

/** One-line description shown under each option in the modal. */
export const ICON_SET_DESCRIPTIONS: Record<IconSet, string> = {
  "nerd-font": "Nerd Font glyphs (PUA). Requires a Nerd Font in your terminal.",
  plain: "Geometric Unicode glyphs. No font install required.",
  ascii: "ASCII-only labels. Works in any terminal, including ssh / log files.",
  minimal: "Single-char symbolic glyphs. Powerline-style minimalism.",
  emoji: "Original emoji set (🤖 🧠 📦 …) — pre-facelift look.",
};

/**
 * Per-set glyph table. Every set must define every key — there is no
 * fallback chain. Keep this exhaustive so a typo in `IconKey` becomes
 * a TypeScript error instead of a silent missing icon at runtime.
 *
 * Codepoints commented inline for grep-ability.
 */
export const ICON_SETS: Record<IconSet, Record<IconKey, string>> = {
  "nerd-font": {
    model: "\uec19",     //  nf-cod-copilot
    thinking: "\uf0eb",  //  nf-fa-lightbulb-o
    stash: "\uf487",     //  nf-oct-package
    debug: "\uf188",     //  nf-fa-bug
    info: "\uf449",      //  nf-oct-info
    success: "\uf42e",   //  nf-oct-check
    warning: "\uf421",   //  nf-oct-alert
    error: "\uf467",     //  nf-oct-x
    scheduled: "\uf43a", //  nf-oct-clock
    agents: "\u{F02A9}", // 󰊩 nf-md-robot
  },
  plain: {
    model: "◆",
    thinking: "◇",
    stash: "▤",
    debug: "?",
    info: "ⓘ",
    success: "✓",
    warning: "⚠",
    error: "✗",
    scheduled: "▷",
    agents: "◉",
  },
  ascii: {
    model: "[m]",
    thinking: "[t]",
    stash: "[s]",
    debug: "[?]",
    info: "[i]",
    success: "[ok]",
    warning: "[!]",
    error: "[x]",
    scheduled: "[@]",
    agents: "[a]",
  },
  minimal: {
    model: "▸",
    thinking: "···",
    stash: "≡",
    debug: "?",
    info: "i",
    success: "✓",
    warning: "!",
    error: "✗",
    scheduled: "@",
    agents: "*",
  },
  emoji: {
    model: "🤖",
    thinking: "🧠",
    stash: "📦",
    debug: "🔍",
    info: "ℹ️",
    success: "✅",
    warning: "⚠️",
    error: "❌",
    scheduled: "⏰",
    agents: "🤖",
  },
};

/**
 * Look up a glyph for `key` in the given set, falling back to the
 * default set if `set` is unknown (defensive — `mergeWithDefaults` in
 * events-config.ts already clamps invalid persisted values).
 */
export function resolveIcon(set: IconSet, key: IconKey): string {
  const table = ICON_SETS[set] ?? ICON_SETS[DEFAULT_ICON_SET];
  return table[key];
}

/** Type-guard for hand-edited config / CLI argument validation. */
export function isIconSet(value: unknown): value is IconSet {
  return typeof value === "string" && (VALID_ICON_SETS as readonly string[]).includes(value);
}
