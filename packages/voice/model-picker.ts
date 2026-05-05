/**
 * Interactive summarizer-model picker for `/wierd-voice-summarizer-model`.
 *
 * Mirrors the shape of `packages/web/model-picker.ts:pickFetchModel` but
 * stripped to v3 needs:
 *
 *   - One column ("model"), no separate "effort" column. The plan
 *     deliberately doesn't pipe a thinking level into the summarizer
 *     (the prompt is short and the model picks something natural).
 *   - Stored value is "<provider>/<id>", same canonical shape used by
 *     `pi --model`.
 *
 * Lives inside `packages/voice/` so this package stays self-contained
 * when published to npm — we don't reach across workspaces at runtime.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getSelectListTheme } from "@mariozechner/pi-coding-agent";
import type { Component, SelectItem } from "@mariozechner/pi-tui";
import { SelectList, truncateToWidth } from "@mariozechner/pi-tui";
import type { Api, Model } from "@mariozechner/pi-ai";

const MAX_VISIBLE_ITEMS = 12;

interface ModelOption {
  value: string;       // "<provider>/<id>"
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

function listAvailableModels(ctx: ExtensionContext): ModelOption[] {
  return ctx.modelRegistry.getAvailable().map(toOption);
}

function findInitialIndex(models: ModelOption[], current: string | undefined): number {
  if (!current) return 0;
  // Accept either canonical "<provider>/<id>" or a bare id (legacy).
  const idx = models.findIndex((m) => m.value === current || m.id === current);
  return idx >= 0 ? idx : 0;
}

export interface PickSummarizerResult {
  modelId: string; // "<provider>/<id>"
}

export async function pickSummarizerModel(
  ctx: ExtensionContext,
  current: string | undefined,
): Promise<PickSummarizerResult | null> {
  const models = listAvailableModels(ctx);
  if (models.length === 0) {
    ctx.ui.notify(
      "wierd-voice: no models with configured auth. Run /login or set an API key first.",
      "warning",
    );
    return null;
  }

  const items: SelectItem[] = models.map((m) => ({
    value: m.value,
    label: `${m.name}  [${m.provider}]`,
    description: m.value,
  }));

  return ctx.ui.custom<PickSummarizerResult | null>(
    (tui, theme, _keybindings, done) => {
      const selectList = new SelectList(
        items,
        Math.min(models.length, MAX_VISIBLE_ITEMS),
        getSelectListTheme(),
      );
      selectList.setSelectedIndex(findInitialIndex(models, current));

      selectList.onSelect = (item) => {
        const model = models.find((m) => m.value === item.value);
        if (!model) {
          done(null);
          return;
        }
        done({ modelId: model.value });
      };
      selectList.onCancel = () => done(null);

      const border = (text: string) => theme.fg("dim", text);
      const wrapRow = (text: string, innerWidth: number): string =>
        `${border("│")}${truncateToWidth(text, innerWidth, "…", true)}${border("│")}`;

      const component: Component = {
        render(width: number): string[] {
          const innerWidth = Math.max(20, Math.min(width - 2, 80));
          const lines: string[] = [];
          lines.push(border(`╭${"─".repeat(innerWidth)}╮`));
          lines.push(
            wrapRow(theme.fg("accent", theme.bold("Select summarizer model")), innerWidth),
          );
          lines.push(border(`├${"─".repeat(innerWidth)}┤`));
          for (const line of selectList.render(innerWidth)) {
            lines.push(wrapRow(line, innerWidth));
          }
          lines.push(border(`├${"─".repeat(innerWidth)}┤`));
          lines.push(
            wrapRow(theme.fg("dim", "↑↓ navigate • enter save • esc cancel"), innerWidth),
          );
          lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
          return lines;
        },
        invalidate(): void {
          selectList.invalidate();
        },
        handleInput(data: string): void {
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
