/**
 * `createSettingsModal` and `openSettingsModal` — the public modal
 * entry points. Both wrap `createSettingsModalBody` and shape it for
 * `ctx.ui.custom`.
 */

import type {
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type {
  Component,
  KeybindingsManager,
  OverlayOptions,
  TUI,
} from "@earendil-works/pi-tui";
import { createSettingsModalBody } from "./body.ts";
import type {
  Field,
  SettingsModalFactory,
  SettingsModalOptions,
} from "./types.ts";

const DEFAULT_OVERLAY: OverlayOptions = {
  anchor: "center",
  width: "92%",
  maxHeight: "85%",
};

/**
 * Build a `ctx.ui.custom`-compatible factory for the settings modal.
 * Useful for callers that already manage their own overlay lifecycle.
 *
 * The returned factory captures `ctx` from `openSettingsModal`'s call
 * site — when used standalone, the caller is expected to invoke it via
 * `ctx.ui.custom(createSettingsModal(opts), …)`, and pi will pass the
 * tui/theme/keybindings/done arguments at mount time.
 */
export function createSettingsModal<F extends Field>(
  ctx: ExtensionContext,
  options: SettingsModalOptions<F>,
): SettingsModalFactory<void> {
  return (tui: TUI, theme: Theme, _keybindings: KeybindingsManager, done: (result: void) => void): Component => {
    const close = (): void => {
      try {
        options.onClose?.();
      } catch {
        // Caller-supplied onClose must not break the modal teardown.
      }
      done();
    };
    return createSettingsModalBody<F>(options, { tui, theme, ctx, close });
  };
}

/**
 * Convenience: open a settings modal as a centered overlay and resolve
 * when the user closes it. This is the **happy-path** entry point most
 * callers want.
 *
 * Defaults: anchor center, width 92%, maxHeight 85%. Override via
 * `options.overlayOptions`.
 *
 * @example
 * ```ts
 * await openSettingsModal(ctx, {
 *   title: "@wierdbytes/pi-voice",
 *   fields: [
 *     { key: "muted", type: "boolean", label: "Muted", value: cfg.muted },
 *   ],
 *   onChange: (key, value) => { cfg[key] = value; saveConfig(cfg); },
 * });
 * ```
 */
export async function openSettingsModal<F extends Field>(
  ctx: ExtensionContext,
  options: SettingsModalOptions<F>,
): Promise<void> {
  const overlayOptions = options.overlayOptions ?? DEFAULT_OVERLAY;
  await ctx.ui.custom<void>(createSettingsModal(ctx, options), {
    overlay: true,
    overlayOptions,
  });
}
