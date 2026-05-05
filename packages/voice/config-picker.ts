/**
 * Single overlay that configures every persisted pi-wierd-voice setting.
 *
 * Visual reference: `/wierd-web-fetch-model` (see
 * packages/web/model-picker.ts:pickFetchModel) — same centered bordered
 * frame, same compact footer hint. Internally we delegate the row layout
 * to pi-tui's `SettingsList`, which is also what `/settings` uses, so the
 * UX matches the rest of the app:
 *
 *   - Up/Down move between rows.
 *   - Enter / Space cycles through `values` (or opens the submenu when
 *     the row defines one).
 *   - Esc closes the overlay (every change has already been persisted by
 *     the per-row `onChange` callback — there's no separate "save" step,
 *     same as `/settings`).
 *
 * The summarizer row uses a submenu rather than cycling because the model
 * list is variable-length and depends on which providers the user has
 * authed; cycling through 20+ entries with Enter would be tedious. The
 * submenu itself is a faithful port of `pickFetchModel`'s dual picker —
 * Up/Down on models, ←/→ on the reasoning effort, Enter saves both
 * fields atomically, Esc abandons the choice.
 *
 * Stored summarizer values are canonical "<provider>/<id>" strings (or
 * the empty string for "use the session model"). The empty value is
 * displayed and selected in the submenu as the literal sentinel
 * `(session model)` so the row never looks blank.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  getSelectListTheme,
  getSettingsListTheme,
} from "@mariozechner/pi-coding-agent";
import type { Component, SelectItem, SettingItem } from "@mariozechner/pi-tui";
import {
  matchesKey,
  SelectList,
  SettingsList,
  truncateToWidth,
} from "@mariozechner/pi-tui";
import type { Api, Model, ModelThinkingLevel } from "@mariozechner/pi-ai";
import { PREBUILT_VOICES } from "./voices.ts";
import type {
  Scope,
  SummarizerThinkingLevel,
  WierdVoiceConfig,
} from "./config.ts";

/** Sentinel displayed in the summarizer row when no model override is set. */
export const SESSION_MODEL_LABEL = "(session model)";

/**
 * Full effort ladder, ordered low → high so ←/→ feels natural. Mirrors
 * `ALL_THINKING_LEVELS` in packages/web/model-picker.ts. Kept local so
 * this file stays self-contained.
 */
export const ALL_THINKING_LEVELS: ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

const MAX_VISIBLE_ROWS = 12;
const MAX_VISIBLE_MODELS = 12;
const MAX_VISIBLE_VOICES = 12;
const FRAME_MAX_WIDTH = 80;
const FRAME_MIN_WIDTH = 48;

interface ModelOption {
  /** Canonical "<provider>/<id>" or "" for the session-model sentinel. */
  value: string;
  /** Display label including a `[provider]` suffix for disambiguation. */
  label: string;
  /** Live model record — used to compute supported reasoning levels. */
  model?: Model<Api>;
}

function listModelOptions(ctx: ExtensionContext): ModelOption[] {
  // Mirror what `/models` shows: only models with configured auth, in
  // registry order. getAvailable() doesn't trigger OAuth refreshes, which
  // matches the picker's "is this usable right now?" intent.
  const models: ModelOption[] = ctx.modelRegistry.getAvailable().map((m) => ({
    value: `${m.provider}/${m.id}`,
    label: `${m.name}  [${m.provider}]`,
    model: m,
  }));
  // Session-model sentinel goes first so it's the default highlight when
  // nothing is configured. No `model` reference: at picker time we don't
  // know which model the session will actually use, so we treat the
  // effort ladder as "all levels supported" (same fallback as the web
  // picker uses for unknown models).
  return [{ value: "", label: SESSION_MODEL_LABEL }, ...models];
}

/**
 * Filter the effort ladder to the levels a model actually supports.
 * Anthropic and other providers advertise this via `thinkingLevelMap`;
 * a `null` entry means "explicitly unsupported". Missing keys are treated
 * as supported (same convention as pi-ai's own clamp).
 *
 * Models with no map (and the `(session model)` sentinel) get the full
 * ladder — pi will clamp at runtime if the chosen session model can't
 * honor the level.
 */
function supportedEfforts(
  model: Model<Api> | undefined,
): ModelThinkingLevel[] {
  if (!model) return ALL_THINKING_LEVELS;
  const map = model.thinkingLevelMap;
  if (!map) return ALL_THINKING_LEVELS;
  return ALL_THINKING_LEVELS.filter(
    (lvl) => !(lvl in map && map[lvl] === null),
  );
}

/**
 * Map a desired effort onto the supported ladder. If the desired value
 * isn't supported (e.g. the user just switched to a model that doesn't
 * have `xhigh`), fall back to `medium` and finally to the first
 * supported level. Identical contract to `clampEffort` in
 * packages/web/model-picker.ts.
 */
function clampEffort(
  desired: string | undefined,
  supported: ModelThinkingLevel[],
): ModelThinkingLevel {
  if (desired && (supported as string[]).includes(desired)) {
    return desired as ModelThinkingLevel;
  }
  return supported.includes("medium") ? "medium" : (supported[0] ?? "off");
}

function summarizerDisplay(value: string): string {
  return value === "" ? SESSION_MODEL_LABEL : value;
}

/**
 * Render the SettingsList row for the summarizer, combining the model
 * choice with its effort. Examples:
 *
 *   "(session model)  ·  medium"
 *   "anthropic/claude-haiku-4-5  ·  high"
 */
function summarizerRowLabel(
  modelValue: string,
  effort: string | undefined,
): string {
  const model = summarizerDisplay(modelValue);
  return effort ? `${model}  ·  ${effort}` : model;
}

/**
 * Render the SettingsList row for the voice. Mirrors the summarizer
 * row's `<value>  ·  <hint>` format so the two submenu rows look
 * symmetrical. Falls back to the bare name if the voice isn't in the
 * prebuilt list (defensive — a corrupted config could still load).
 */
function voiceRowLabel(name: string): string {
  const v = PREBUILT_VOICES.find((p) => p.name === name);
  return v ? `${v.name}  ·  ${v.descriptor}` : name;
}

export interface VoiceConfigCallbacks {
  onMutedChange: (muted: boolean) => void;
  onVoiceChange: (voice: string) => void;
  onScopeChange: (scope: Scope) => void;
  /** Empty string ⇒ "use the session model" (clears the override). */
  onSummarizerChange: (modelId: string) => void;
  /** Always one of the six concrete levels — never undefined. */
  onSummarizerThinkingChange: (level: SummarizerThinkingLevel) => void;
  /** Fired exactly once, when the overlay is dismissed (Esc). */
  onClose: () => void;
}

/**
 * Open the overlay. Resolves when the user dismisses it. Per-field
 * changes are streamed through the callbacks as they happen; the
 * resolved promise carries no payload.
 */
export function pickVoiceConfig(
  ctx: ExtensionContext,
  current: WierdVoiceConfig,
  callbacks: VoiceConfigCallbacks,
): Promise<void> {
  const modelOptions = listModelOptions(ctx);
  const voiceValues = PREBUILT_VOICES.map((v) => v.name);
  const initialVoice = voiceValues.includes(current.voice)
    ? current.voice
    : voiceValues[0];
  const initialSummarizerStored = current.summarizerModel ?? "";
  const initialSummarizerEffort = current.summarizerThinkingLevel;

  return ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      // ── Submenu: voice picker (single-column SelectList) ─────────────
      // Same shape as the summarizer submenu below, minus the effort
      // row. Voices are static so we don't need any per-selection
      // recomputation — just preselect the current voice and persist
      // on confirm.
      const buildVoiceSubmenu = (
        _currentValue: string,
        finish: (selectedValue?: string) => void,
      ): Component => {
        const items: SelectItem[] = PREBUILT_VOICES.map((v) => ({
          value: v.name,
          label: v.name,
          // SelectList renders `description` in dim text next to the
          // label, so the descriptor ("Firm", "Bright", …) shows up
          // inline without us having to format it into the label.
          description: v.descriptor,
        }));
        const list = new SelectList(
          items,
          Math.min(items.length, MAX_VISIBLE_VOICES),
          getSelectListTheme(),
        );
        const idx = items.findIndex((i) => i.value === initialVoice);
        list.setSelectedIndex(idx >= 0 ? idx : 0);

        list.onSelect = (item) => {
          // Persist the canonical voice name first, then hand the
          // formatted label to SettingsList so the parent row updates.
          // The SettingsList `onChange` callback will see this label
          // too — we deliberately no-op there for `voice` (same trick
          // we use for `summarizer`) so the canonical value stays the
          // single source of truth on disk.
          callbacks.onVoiceChange(item.value);
          finish(voiceRowLabel(item.value));
        };
        list.onCancel = () => finish();

        return {
          render(width: number): string[] {
            const lines: string[] = [];
            for (const line of list.render(width)) lines.push(line);
            lines.push("");
            lines.push(
              theme.fg(
                "dim",
                "  ↑↓ navigate · enter save · esc cancel",
              ),
            );
            return lines;
          },
          invalidate(): void {
            list.invalidate();
          },
          handleInput(data: string): void {
            list.handleInput(data);
            tui.requestRender();
          },
        };
      };

      // ── Submenu: model + effort dual picker (mirrors pickFetchModel) ──
      const buildSummarizerSubmenu = (
        _currentValue: string,
        finish: (selectedValue?: string) => void,
      ): Component => {
        const items: SelectItem[] = modelOptions.map((m) => ({
          value: m.value,
          label: m.label,
          description: m.value || undefined,
        }));
        const list = new SelectList(
          items,
          Math.min(items.length, MAX_VISIBLE_MODELS),
          getSelectListTheme(),
        );
        const initialIdx = items.findIndex(
          (i) => i.value === initialSummarizerStored,
        );
        list.setSelectedIndex(initialIdx >= 0 ? initialIdx : 0);

        // Effort state, recomputed every time the highlighted model
        // changes so we never display a level the model can't honor.
        let effortIndex = 0;
        let supported: ModelThinkingLevel[] = [];

        const refreshEffort = (preferred: string | undefined): void => {
          const item = list.getSelectedItem();
          const opt = modelOptions.find((m) => m.value === item?.value);
          supported = supportedEfforts(opt?.model);
          if (supported.length === 0) supported = ["off"];
          const clamped = clampEffort(preferred, supported);
          effortIndex = Math.max(0, supported.indexOf(clamped));
        };

        refreshEffort(initialSummarizerEffort);

        list.onSelect = (item) => {
          const effort =
            (supported[effortIndex] as SummarizerThinkingLevel | undefined) ??
            "off";
          // Persist atomically: both fields land on disk before the
          // submenu's done() updates the SettingsList row label.
          callbacks.onSummarizerChange(item.value);
          callbacks.onSummarizerThinkingChange(effort);
          finish(summarizerRowLabel(item.value, effort));
        };
        list.onCancel = () => finish();
        list.onSelectionChange = () => {
          // Carry the user's preferred level across model switches when
          // possible; clampEffort drops it if the new model doesn't
          // support it.
          const previous = supported[effortIndex];
          refreshEffort(previous);
          tui.requestRender();
        };

        const renderEffortRow = (width: number): string => {
          const current = supported[effortIndex] ?? "off";
          const left =
            effortIndex > 0
              ? theme.fg("accent", "‹")
              : theme.fg("dim", "‹");
          const right =
            effortIndex < supported.length - 1
              ? theme.fg("accent", "›")
              : theme.fg("dim", "›");
          const label = theme.fg("muted", "  effort: ");
          const value = theme.fg("accent", theme.bold(current));
          const counter = theme.fg(
            "dim",
            `  (${effortIndex + 1}/${supported.length})`,
          );
          return truncateToWidth(
            `${label}${left} ${value} ${right}${counter}`,
            width,
            "…",
            true,
          );
        };

        return {
          render(width: number): string[] {
            const lines: string[] = [];
            for (const line of list.render(width)) lines.push(line);
            // Pad the effort row + footer hint with blank lines so they
            // sit visually separated from the model list.
            lines.push("");
            lines.push(renderEffortRow(width));
            lines.push("");
            lines.push(
              theme.fg(
                "dim",
                "  ↑↓ model · ←→ effort · enter save · esc cancel",
              ),
            );
            return lines;
          },
          invalidate(): void {
            list.invalidate();
          },
          handleInput(data: string): void {
            // Intercept ←/→ before the SelectList sees them — left/right
            // are not used by SelectList, so this is purely additive.
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
            list.handleInput(data);
            tui.requestRender();
          },
        };
      };

      // ── Main settings list ──────────────────────────────────────────
      const items: SettingItem[] = [
        {
          id: "muted",
          label: "Muted",
          description:
            "Mute extension voice.",
          currentValue: current.muted ? "true" : "false",
          values: ["false", "true"],
        },
        {
          id: "voice",
          label: "Voice",
          description:
            "Prebuilt Gemini TTS voice.",
          currentValue: voiceRowLabel(initialVoice),
          submenu: buildVoiceSubmenu,
        },
        {
          id: "scope",
          label: "Summary scope",
          description:
            "What to feed the summarizer: just the final assistant message (last) or everything since the last user turn (sinceUser)",
          currentValue: current.scope,
          values: ["last", "sinceUser"],
        },
        {
          id: "summarizer",
          label: "Summarizer model",
          description:
            "Sub-agent model + reasoning effort used to produce the spoken summary.",
          currentValue: summarizerRowLabel(
            initialSummarizerStored,
            initialSummarizerEffort,
          ),
          submenu: buildSummarizerSubmenu,
        },
      ];

      const settingsList = new SettingsList(
        items,
        Math.min(items.length, MAX_VISIBLE_ROWS),
        getSettingsListTheme(),
        (id, newValue) => {
          // Fires for cycle items on every Enter/Space step AND for
          // submenu items on confirm. Submenu rows (`voice`,
          // `summarizer`) persist the canonical value explicitly via
          // the callbacks inside their submenu factories, so we don't
          // try to parse the formatted label back here — we just
          // forward the cycle rows.
          if (id === "muted") {
            callbacks.onMutedChange(newValue === "true");
            return;
          }
          if (id === "scope") {
            callbacks.onScopeChange(newValue as Scope);
            return;
          }
          // id === "voice" or "summarizer" — already handled by their
          // submenus' onSelect; no-op here on purpose.
        },
        () => {
          // Esc on the main list. SettingsList itself doesn't emit any
          // further events after this, so it's safe to dispose.
          callbacks.onClose();
          done();
        },
      );

      const border = (text: string) => theme.fg("dim", text);
      const wrapRow = (text: string, innerWidth: number): string =>
        `${border("│")}${truncateToWidth(text, innerWidth, "…", true)}${border("│")}`;

      const component: Component = {
        render(width: number): string[] {
          const innerWidth = Math.max(
            FRAME_MIN_WIDTH,
            Math.min(width - 2, FRAME_MAX_WIDTH),
          );
          const lines: string[] = [];
          lines.push(border(`╭${"─".repeat(innerWidth)}╮`));
          lines.push(
            wrapRow(
              theme.fg("accent", theme.bold("pi-wierd-voice settings")),
              innerWidth,
            ),
          );
          lines.push(border(`├${"─".repeat(innerWidth)}┤`));
          // SettingsList renders its own description block + a built-in
          // hint footer, so we only frame its output. Rendering at
          // (innerWidth - 2) leaves a one-cell gutter on each side.
          for (const line of settingsList.render(innerWidth - 2)) {
            lines.push(wrapRow(` ${line}`, innerWidth));
          }
          lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
          return lines;
        },
        invalidate(): void {
          settingsList.invalidate();
        },
        handleInput(data: string): void {
          settingsList.handleInput(data);
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
