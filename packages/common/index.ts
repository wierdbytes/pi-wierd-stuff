/**
 * @wierdbytes/pi-common — public entry point.
 *
 * Shared TUI building blocks for pi coding agent extensions inside this
 * monorepo. Today the package ships a single feature: a settings modal
 * for tweaking extension configuration, with ratatui-flavoured aesthetics
 * (rounded-light border + title pill).
 *
 * See `./settings/index.ts` for the settings-modal API. The package is
 * intentionally a tree of small re-export walls so future features live
 * in their own subdirectory without polluting the root namespace.
 */

export * from "./settings/index.ts";
