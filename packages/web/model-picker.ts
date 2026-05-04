/**
 * Interactive model pickers for /wierd-web-search-model and
 * /wierd-web-fetch-model.
 *
 * Both pickers are rendered through ctx.ui.custom() as centered overlays.
 * The fetch picker additionally exposes an "effort" (thinking level)
 * selector controlled by ←/→.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getSelectListTheme } from "@mariozechner/pi-coding-agent";
import type { Component, SelectItem } from "@mariozechner/pi-tui";
import { matchesKey, SelectList, truncateToWidth } from "@mariozechner/pi-tui";
import type { Api, Model, ModelThinkingLevel } from "@mariozechner/pi-ai";

export const ALL_THINKING_LEVELS: ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

const MAX_VISIBLE_ITEMS = 12;

interface ModelOption {
  /** Stable selector value: "<provider>/<id>" so models from different providers don't collide. */
  value: string;
  /** Bare model id (no provider prefix). */
  id: string;
  name: string;
  provider: string;
  model: Model<Api>;
}

function toOption(m: Model<Api>): ModelOption {
  return {
    value: `${m.provider}/${m.id}`,
    id: m.id,
    name: m.name,
    provider: m.provider,
    model: m,
  };
}

function listAnthropicModels(ctx: ExtensionContext): ModelOption[] {
  return ctx.modelRegistry
    .getAll()
    .filter((m) => m.provider === "anthropic")
    .map(toOption);
}

function listAvailableModels(ctx: ExtensionContext): ModelOption[] {
  // Mirror what /models shows: only models with configured auth, in registry
  // order. getAvailable() is a fast non-refreshing check (it does not trigger
  // OAuth refreshes), which matches the picker's "is this usable right now?"
  // intent.
  return ctx.modelRegistry.getAvailable().map(toOption);
}

function buildItems(models: ModelOption[], showProvider: boolean): SelectItem[] {
  return models.map((m) => ({
    value: m.value,
    label: showProvider ? `${m.name}  ${dimTagPlaceholder(m.provider)}` : m.name,
    description: m.value,
  }));
}

// SelectList renders strings as-is; we keep theming inside renderItem via the
// label string itself. Plain text marker so we don't depend on theme here.
function dimTagPlaceholder(provider: string): string {
  return `[${provider}]`;
}

function findInitialIndex(models: ModelOption[], currentValue: string | undefined): number {
  if (!currentValue) return 0;
  const idx = models.findIndex((m) => m.value === currentValue);
  return idx >= 0 ? idx : 0;
}

/**
 * Compute the effort levels supported by a model. Anthropic models
 * advertise `thinkingLevelMap`; a `null` entry marks a level as unsupported.
 * If the model has no map we fall back to the full list (matches pi's own
 * default behaviour of trusting the provider).
 */
function supportedEfforts(model: Model<Api>): ModelThinkingLevel[] {
  const map = model.thinkingLevelMap;
  if (!map) return ALL_THINKING_LEVELS;
  return ALL_THINKING_LEVELS.filter((lvl) => {
    // Only treat null as "explicitly unsupported". Missing keys are allowed
    // (provider default) and supported.
    return !(lvl in map && map[lvl] === null);
  });
}

function clampEffort(
  desired: string | undefined,
  supported: ModelThinkingLevel[],
): ModelThinkingLevel {
  if (desired && (supported as string[]).includes(desired)) {
    return desired as ModelThinkingLevel;
  }
  return supported.includes("medium") ? "medium" : (supported[0] ?? "off");
}

// --- Search picker (no effort) --------------------------------------------

export interface PickSearchModelResult {
  modelId: string;
}

export async function pickSearchModel(
  ctx: ExtensionContext,
  current: string | undefined,
): Promise<PickSearchModelResult | null> {
  const models = listAnthropicModels(ctx);
  if (models.length === 0) {
    ctx.ui.notify(
      "No Anthropic models available. Configure a provider or run /login anthropic.",
      "warning",
    );
    return null;
  }

  return runOverlay(ctx, {
    title: "Select web_search model",
    models,
    showProvider: false,
    initialIndex: findInitialIndex(models, current ? `anthropic/${current}` : undefined),
    showEffort: false,
    onConfirm: (selected) => ({ modelId: selected.id }),
  });
}

// --- Fetch picker (with effort) -------------------------------------------

export interface PickFetchModelResult {
  /** Stored as `anthropic/<id>` to match the existing fetch-model format. */
  fetchModelId: string;
  effort: ModelThinkingLevel;
}

export async function pickFetchModel(
  ctx: ExtensionContext,
  currentModelSpec: string | undefined,
  currentEffort: string | undefined,
): Promise<PickFetchModelResult | null> {
  const models = listAvailableModels(ctx);
  if (models.length === 0) {
    ctx.ui.notify(
      "No models with configured auth. Run /login or set an API key first.",
      "warning",
    );
    return null;
  }

  // currentModelSpec is stored as "<provider>/<id>" (canonical) but legacy
  // configs may contain a bare id; in that case fall back to matching by id.
  let initialValue = currentModelSpec;
  if (currentModelSpec && !currentModelSpec.includes("/")) {
    const match = models.find((m) => m.id === currentModelSpec);
    initialValue = match?.value;
  }

  return runOverlay(ctx, {
    title: "Select web_fetch model",
    models,
    showProvider: true,
    initialIndex: findInitialIndex(models, initialValue),
    showEffort: true,
    initialEffort: currentEffort,
    onConfirm: (selected, effort) => ({
      fetchModelId: `${selected.provider}/${selected.id}`,
      effort: effort ?? "off",
    }),
  });
}

// --- Shared overlay -------------------------------------------------------

interface OverlayOptions<T> {
  title: string;
  models: ModelOption[];
  /** When true, items get a `[provider]` suffix to disambiguate cross-provider lists. */
  showProvider: boolean;
  initialIndex: number;
  showEffort: boolean;
  initialEffort?: string;
  onConfirm: (selected: ModelOption, effort?: ModelThinkingLevel) => T;
}

function runOverlay<T>(
  ctx: ExtensionContext,
  opts: OverlayOptions<T>,
): Promise<T | null> {
  const items = buildItems(opts.models, opts.showProvider);

  return ctx.ui.custom<T | null>(
    (tui, theme, _keybindings, done) => {
      const selectList = new SelectList(
        items,
        Math.min(opts.models.length, MAX_VISIBLE_ITEMS),
        getSelectListTheme(),
      );
      selectList.setSelectedIndex(opts.initialIndex);

      // Effort state, recomputed whenever model selection changes so we
      // never show an unsupported level for the highlighted model.
      let effortIndex = 0;
      let supported: ModelThinkingLevel[] = [];

      const refreshEffortForSelected = (preferred: string | undefined) => {
        if (!opts.showEffort) return;
        const item = selectList.getSelectedItem();
        const model = opts.models.find((m) => m.value === item?.value)?.model;
        if (!model) {
          supported = ALL_THINKING_LEVELS;
        } else {
          supported = supportedEfforts(model);
          if (supported.length === 0) supported = ["off"];
        }
        const clamped = clampEffort(preferred, supported);
        effortIndex = Math.max(0, supported.indexOf(clamped));
      };

      refreshEffortForSelected(opts.initialEffort);

      selectList.onSelect = (item) => {
        const model = opts.models.find((m) => m.value === item.value);
        if (!model) {
          done(null);
          return;
        }
        const effort = opts.showEffort ? supported[effortIndex] : undefined;
        done(opts.onConfirm(model, effort));
      };
      selectList.onCancel = () => done(null);
      // Keep effort coherent as the user moves through models.
      selectList.onSelectionChange = () => {
        const previous = supported[effortIndex];
        refreshEffortForSelected(previous);
        tui.requestRender();
      };

      const border = (text: string) => theme.fg("dim", text);
      const wrapRow = (text: string, innerWidth: number): string =>
        `${border("│")}${truncateToWidth(text, innerWidth, "…", true)}${border("│")}`;

      const renderEffortRow = (innerWidth: number): string => {
        const current = supported[effortIndex] ?? "off";
        const left = effortIndex > 0 ? theme.fg("accent", "‹") : theme.fg("dim", "‹");
        const right =
          effortIndex < supported.length - 1
            ? theme.fg("accent", "›")
            : theme.fg("dim", "›");
        const label = theme.fg("muted", "effort: ");
        const value = theme.fg("accent", theme.bold(current));
        const hint = theme.fg("dim", `  (${effortIndex + 1}/${supported.length})`);
        const text = `${label}${left} ${value} ${right}${hint}`;
        return truncateToWidth(text, innerWidth, "…", true);
      };

      const component: Component = {
        render(width: number): string[] {
          const innerWidth = Math.max(20, Math.min(width - 2, 80));
          const lines: string[] = [];
          lines.push(border(`╭${"─".repeat(innerWidth)}╮`));
          lines.push(
            wrapRow(theme.fg("accent", theme.bold(opts.title)), innerWidth),
          );
          lines.push(border(`├${"─".repeat(innerWidth)}┤`));
          for (const line of selectList.render(innerWidth)) {
            lines.push(wrapRow(line, innerWidth));
          }
          if (opts.showEffort) {
            lines.push(border(`├${"─".repeat(innerWidth)}┤`));
            lines.push(wrapRow(renderEffortRow(innerWidth), innerWidth));
          }
          lines.push(border(`├${"─".repeat(innerWidth)}┤`));
          const hint = opts.showEffort
            ? "↑↓ model • ←→ effort • enter save • esc cancel"
            : "↑↓ navigate • enter save • esc cancel";
          lines.push(wrapRow(theme.fg("dim", hint), innerWidth));
          lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
          return lines;
        },
        invalidate(): void {
          selectList.invalidate();
        },
        handleInput(data: string): void {
          if (opts.showEffort) {
            if (matchesKey(data, "left")) {
              if (effortIndex > 0) {
                effortIndex -= 1;
                tui.requestRender();
              }
              return;
            }
            if (matchesKey(data, "right")) {
              if (effortIndex < supported.length - 1) {
                effortIndex += 1;
                tui.requestRender();
              }
              return;
            }
          }
          selectList.handleInput(data);
          tui.requestRender();
        },
      };

      return component;
    },
    {
      overlay: true,
      overlayOptions: () => ({ anchor: "center" }),
    },
  );
}
