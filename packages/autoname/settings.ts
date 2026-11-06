/**
 * `/autoname` settings overlay, built on `@wierdbytes/pi-common`'s modal.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openSettingsModal, type Field, type ModelValue } from "@wierdbytes/pi-common";
import {
  type AutonameConfig,
  DEFAULT_MODEL,
  DEFAULT_TEMPLATE,
  MAX_LENGTH,
  MIN_LENGTH,
  MODES,
  type Mode,
  TARGETS,
  type Target,
  type ThinkingLevel,
} from "./config.ts";

const TARGET_LABELS: Record<Target, string> = {
  both: "both — session name + terminal title",
  session: "session — session name only",
  title: "title — terminal title only",
};

const MODE_LABELS: Record<Mode, string> = {
  first: "first — once, after the first turn",
  auto: "auto — re-check each turn, rename on topic change",
  follow: "follow — rename after every turn",
};

export interface SettingsHandlers {
  config(): AutonameConfig;
  update(next: AutonameConfig): void;
  regenerate(ctx: ExtensionContext): void | Promise<void>;
}

export async function openAutonameSettings(ctx: ExtensionContext, h: SettingsHandlers): Promise<void> {
  const cfg = h.config();
  const fields: Field[] = [
    {
      key: "enabled",
      type: "boolean",
      label: "Enabled",
      description: "Name sessions automatically. Off leaves pi's own title and names alone.",
      value: cfg.enabled,
      default: true,
    },
    {
      key: "target",
      type: "enum",
      label: "Apply to",
      description: "Where the generated name goes: the session name (/resume, footer), the terminal title (herdr, tmux, tabs) or both.",
      value: cfg.target,
      options: TARGETS,
      optionLabels: TARGET_LABELS,
      default: "both",
    },
    {
      key: "mode",
      type: "enum",
      label: "Update",
      description: "first: name once. auto: after each turn the model keeps the name or picks a new one. follow: rename after every turn (one model call per turn).",
      value: cfg.mode,
      options: MODES,
      optionLabels: MODE_LABELS,
      default: "first",
    },
    {
      key: "model",
      type: "model",
      label: "Model",
      description: `Model that writes the name. Pick a small, cheap one; default ${DEFAULT_MODEL}. (session model) uses whatever this session runs.`,
      value: { id: cfg.model, thinking: cfg.thinking },
      default: { id: DEFAULT_MODEL, thinking: "off" },
    },
    {
      key: "maxLength",
      type: "number",
      label: "Max length",
      description: `Longest name in characters (${MIN_LENGTH}–${MAX_LENGTH}).`,
      value: cfg.maxLength,
      min: MIN_LENGTH,
      max: MAX_LENGTH,
      integer: true,
      default: 40,
    },
    {
      key: "titleTemplate",
      type: "string",
      label: "Title template",
      description: "Terminal title. {name} is the session name (required), {cwd} the folder name. e.g. \"{name} · {cwd}\".",
      value: cfg.titleTemplate,
      placeholder: DEFAULT_TEMPLATE,
      default: DEFAULT_TEMPLATE,
    },
    {
      key: "fallback",
      type: "boolean",
      label: "Fallback name",
      description: "When the model call fails, name the session from the first line of the first prompt (retried with the model next turn).",
      value: cfg.fallback,
      default: true,
    },
    {
      key: "regen",
      type: "action",
      label: "Regenerate now",
      description: "Name this session from the conversation so far, even if it was named by hand.",
      display: "(run)",
      onActivate: (c) => h.regenerate(c as unknown as ExtensionContext),
    },
  ];

  // pi-common may resolve a different pi-coding-agent copy in the workspace;
  // the context shape is the same at runtime.
  await openSettingsModal(ctx as unknown as Parameters<typeof openSettingsModal>[0], {
    title: "@wierdbytes/pi-autoname",
    fields,
    onChange: (key, value) => {
      const next: AutonameConfig = { ...h.config() };
      switch (key) {
        case "enabled":
          next.enabled = value as boolean;
          break;
        case "fallback":
          next.fallback = value as boolean;
          break;
        case "target":
          next.target = value as Target;
          break;
        case "mode":
          next.mode = value as Mode;
          break;
        case "model": {
          const v = value as ModelValue;
          next.model = v.id;
          next.thinking = (v.thinking ?? "off") as ThinkingLevel;
          break;
        }
        case "maxLength":
          next.maxLength = value as number;
          break;
        case "titleTemplate": {
          const t = String(value).trim();
          if (!t.includes("{name}")) throw new Error("Title template must contain {name}");
          next.titleTemplate = t;
          break;
        }
        default:
          return;
      }
      h.update(next);
    },
  });
}
