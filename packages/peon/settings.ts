/**
 * Settings modal for @wierdbytes/pi-peon.
 *
 * Wraps `@wierdbytes/pi-common`'s `openSettingsModal`. The biggest UX
 * decision in this file is that **everything pack-related** —
 * choosing the active pack, browsing the registry, auditioning
 * sounds — lives behind a single `Packs` field that opens an in-modal
 * submenu. Sub-dialogs (`ctx.ui.select` / `ctx.ui.confirm`) would
 * hang when stacked on top of the settings overlay; the custom-field
 * submenu lives inside the modal frame and owns input cleanly.
 *
 * Layout:
 *
 *   1. Packs…              — sectioned picker (Active / Available /
 *                            Registry) → drill into a pack's sounds.
 *   2. Master volume       — 0..100, scaled to the active backend.
 *   3. Muted               — global kill switch.
 *   4. Per-category toggles — one boolean per canonical CESP category.
 *
 * Keybindings inside the Packs submenu:
 *
 *   ↑/↓          select (skips section headers)
 *   Enter        drill into the highlighted pack's sound files
 *   Tab          install (if needed) + set as the active pack
 *   Esc          back to the main settings list
 *   type         substring filter over the unified pack list
 *
 * And inside the files submenu (drilled-in from a pack):
 *
 *   ↑/↓          select
 *   Enter        play the sound (local copy, or single-file download
 *                to temp when the pack isn't installed)
 *   Tab          set this sound's pack as the active pack (installing
 *                if needed)
 *   Esc          back to the packs picker
 *
 * The files submenu has no filter — a single pack's sound list is
 * always short enough that ↑↓ is enough.
 *
 * Left/Right do **nothing special** — they're forwarded to the
 * inline-edit state machine, so users can move the filter cursor
 * normally. There is no arrow-driven drill-in; everything goes
 * through Enter / Tab / Esc.
 *
 * State mutations route through caller-supplied callbacks so the
 * extension keeps a single source of truth for in-memory config.
 */

import {
  getSelectListTheme,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  SelectList,
  truncateToWidth,
  type Component,
  type SelectItem,
} from "@earendil-works/pi-tui";
import {
  formatHintLine,
  handleInlineEditInput,
  openSettingsModal,
  type CustomFieldSubmenuArgs,
  type Field,
  type InlineEditState,
  type KeyHint,
} from "@wierdbytes/pi-common";
import {
  CESP_CATEGORIES,
  type CespCategory,
  type InstalledPack,
  type ManifestSound,
  type PackManifest,
} from "./pack.ts";
import { type PeonConfig, isCategoryEnabled } from "./config.ts";
import type { RegistryEntry } from "./registry.ts";

/** Display label per CESP category (used everywhere in the modal). */
const CATEGORY_LABELS: Record<CespCategory, string> = {
  "session.start": "Session start",
  "task.acknowledge": "Task acknowledge",
  "task.complete": "Task complete",
  "task.error": "Task error",
  "input.required": "Input required",
  "resource.limit": "Resource limit",
  "user.spam": "User spam",
  "session.end": "Session end",
  "task.progress": "Task progress",
};

/** How many vertical rows the picker viewport reserves. */
const MAX_PICKER_VISIBLE = 14;

export interface SettingsCallbacks {
  getConfig: () => PeonConfig;
  saveConfig: (cfg: PeonConfig) => void;
  getActivePack: () => InstalledPack | null;
  listInstalled: () => InstalledPack[];
  /** Activate a pack by name. Returns false when not installed. */
  setActivePack: (name: string) => boolean;
  fetchRegistry: () => Promise<RegistryEntry[]>;
  /** Download + extract a pack. The wrapper in index.ts is expected
   *  to emit progress/result toasts via the events bus and auto-
   *  activate the freshly-installed pack — this fn just resolves /
   *  rejects so the submenu can sync its UI. */
  installPack: (entry: RegistryEntry) => Promise<void>;
  /** Fetch a single pack's `openpeon.json` straight from GitHub raw
   *  — used to list sounds for a remote pack without installing it. */
  fetchPackManifest: (entry: RegistryEntry) => Promise<PackManifest>;
  /** Play a single sound from a registry entry. Uses the local copy
   *  when the pack is installed, otherwise downloads just that one
   *  clip to a temp cache. Bypasses per-category toggles. */
  previewRemoteSound: (
    entry: RegistryEntry,
    sound: ManifestSound,
  ) => Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────
// Top-level: open the settings modal
// ─────────────────────────────────────────────────────────────────────

export async function openPeonSettings(
  ctx: ExtensionContext,
  callbacks: SettingsCallbacks,
): Promise<void> {
  const cfg = () => callbacks.getConfig();
  const config = cfg();
  const active = callbacks.getActivePack();
  const declared = active
    ? new Set(active.declaredCategories)
    : new Set<string>();

  // ── Packs row label: show the current active pack so the user
  // can tell at a glance which one fires for events. ────────────────
  const packsLabel = (): string => {
    const a = callbacks.getActivePack();
    const c = cfg();
    if (a) return `${a.displayName}  ·  ${a.name}`;
    return `${c.activePack} (not installed)`;
  };

  const fields: Field[] = [
    {
      // ── The unified Packs submenu ───────────────────────────────
      // Replaces the previous trio of "Active pack" / "Browse
      // registry…" / "Preview sounds…" fields. The submenu does:
      //   1. fuzzy-filter across all known packs (installed +
      //      registry) in one sectioned list;
      //   2. Enter drills into the pack's sound files;
      //   3. Tab sets the highlighted pack as the active one
      //      (downloading + installing if the pack is registry-only).
      key: "packs",
      type: "custom",
      label: "Packs…",
      description:
        "Active / Available / Registry packs. Enter drills into sounds; Tab makes a pack the active one (downloading if needed).",
      value: undefined,
      render: (args) =>
        args.theme.fg(
          args.selected ? "accent" : "muted",
          truncateToWidth(packsLabel(), Math.max(20, args.width), "…", true),
        ),
      openSubmenu: (args) => buildPacksSubmenu(callbacks, args),
    },
    {
      key: "volume",
      type: "number",
      label: "Master volume",
      description: "0–100. Scaled to each backend's native range.",
      value: Math.round(config.volume * 100),
      min: 0,
      max: 100,
      integer: true,
    },
    {
      key: "muted",
      type: "boolean",
      label: "Muted",
      description: "Silence every category until cleared.",
      value: config.muted,
    },
  ];

  // Per-category toggles. We render *all* canonical categories so the
  // user has a knob even for events the current pack hasn't recorded
  // sounds for — packs change.
  for (const cat of CESP_CATEGORIES) {
    const present = active ? declared.has(cat) : false;
    fields.push({
      key: `cat:${cat}`,
      type: "boolean",
      label: `▸ ${CATEGORY_LABELS[cat]}`,
      description: present
        ? `Plays from ${active!.name} on ${cat}.`
        : `Pack has no sounds for ${cat} — toggle is preserved for future packs.`,
      value: isCategoryEnabled(cfg(), cat),
    });
  }

  await openSettingsModal(ctx, {
    title: "@wierdbytes/pi-peon",
    fields,
    onChange: (key, value) => {
      const current = cfg();
      if (key === "volume") {
        const v = Math.max(0, Math.min(100, value as number));
        callbacks.saveConfig({ ...current, volume: v / 100 });
        return;
      }
      if (key === "muted") {
        callbacks.saveConfig({ ...current, muted: value as boolean });
        return;
      }
      if (typeof key === "string" && key.startsWith("cat:")) {
        const cat = key.slice("cat:".length) as CespCategory;
        if (!(CESP_CATEGORIES as readonly string[]).includes(cat)) return;
        const next: PeonConfig = {
          ...current,
          enabledCategories: {
            ...current.enabledCategories,
            [cat]: value as boolean,
          },
        };
        callbacks.saveConfig(next);
        return;
      }
      // `packs` is a custom submenu — it closes via `done()` with the
      // sentinel `undefined` value, which we ignore here. State
      // mutations happen via direct `setActivePack`/`installPack`
      // calls from inside the submenu.
    },
  });
}

// ─────────────────────────────────────────────────────────────────────
// Packs submenu — sectioned picker + files drill-in
// ─────────────────────────────────────────────────────────────────────

/** One row in the unified pack list. The `section` field drives both
 *  the section header it appears under and the colouring. */
interface PackRow {
  /** Pack id (`peon`, `glados`, …). */
  name: string;
  /** Friendly display name. */
  displayName: string;
  section: "active" | "installed" | "registry";
  /** Flattened text used as the fuzzy-filter haystack. */
  search: string;
  /** Local pack record, when this pack is installed. */
  local?: InstalledPack;
  /** Registry record, when this pack appears in the public registry.
   *  Required for drilling into a registry-only pack (we need the
   *  GitHub-raw URLs from `source_repo` + `source_ref`). */
  registry?: RegistryEntry;
  /** Cached lookup label, e.g. `"peon  ·  Orc Peon (1.0.0)"`. */
  rowLabel: string;
}

function buildPacksSubmenu(
  callbacks: SettingsCallbacks,
  args: CustomFieldSubmenuArgs<unknown>,
): Component {
  // ── state machine ──────────────────────────────────────────────────
  type State =
    | "loading"        // fetching the registry
    | "ready"          // sectioned pack picker shown
    | "installing"     // user pressed Tab on a registry pack
    | "error"          // registry fetch failed
    | "files-loading"  // user pressed Enter; fetching pack manifest
    | "files"          // files picker shown
    | "files-error";   // manifest fetch failed
  let state: State = "loading";
  let registryEntries: RegistryEntry[] = [];
  let errorMsg = "";
  let filesErrorMsg = "";
  let packPicker: Component | undefined;
  let filesPicker: Component | undefined;
  let currentPack: PackRow | undefined;

  // ── pack-row builder ───────────────────────────────────────────────
  // Re-derives the union of installed + registry packs whenever the
  // picker needs to refresh (e.g. after a successful install).
  const buildPackRows = (): PackRow[] => {
    const config = callbacks.getConfig();
    const installed = callbacks.listInstalled();
    const installedByName = new Map(installed.map((p) => [p.name, p]));
    const activeName = config.activePack;
    const registryByName = new Map(registryEntries.map((e) => [e.name, e]));

    const rows: PackRow[] = [];

    // Active section — single row, sourced from whichever side has
    // the freshest metadata (prefer the local manifest).
    const activeLocal = installedByName.get(activeName);
    const activeRegistry = registryByName.get(activeName);
    if (activeLocal || activeRegistry) {
      const displayName =
        activeLocal?.displayName ?? activeRegistry?.display_name ?? activeName;
      rows.push({
        name: activeName,
        displayName,
        section: "active",
        local: activeLocal,
        registry: activeRegistry,
        rowLabel: formatPackRowLabel({
          name: activeName,
          displayName,
          local: activeLocal,
          registry: activeRegistry,
        }),
        search: searchTextFor(activeName, displayName, activeRegistry),
      });
    } else {
      // Configured pack isn't installed and isn't in the registry —
      // still show a stub so the user can tell what's going on.
      rows.push({
        name: activeName,
        displayName: activeName,
        section: "active",
        rowLabel: `${activeName}  ·  not installed`,
        search: activeName,
      });
    }

    // Available = installed minus active.
    for (const p of installed) {
      if (p.name === activeName) continue;
      const reg = registryByName.get(p.name);
      rows.push({
        name: p.name,
        displayName: p.displayName,
        section: "installed",
        local: p,
        registry: reg,
        rowLabel: formatPackRowLabel({
          name: p.name,
          displayName: p.displayName,
          local: p,
          registry: reg,
        }),
        search: searchTextFor(p.name, p.displayName, reg),
      });
    }

    // Registry = remote entries minus everything already listed.
    const seen = new Set(rows.map((r) => r.name));
    for (const e of registryEntries) {
      if (seen.has(e.name)) continue;
      rows.push({
        name: e.name,
        displayName: e.display_name ?? e.name,
        section: "registry",
        registry: e,
        rowLabel: formatRegistryRow(e),
        search: searchTextFor(e.name, e.display_name ?? e.name, e),
      });
    }
    return rows;
  };

  // ── set-active flow ────────────────────────────────────────────────
  // Tab on a row → either flip the in-memory config (if installed) or
  // install + activate (if registry-only). Already-active rows are
  // no-ops with an info toast.
  const setActiveFromRow = async (row: PackRow): Promise<void> => {
    const config = callbacks.getConfig();
    const isActiveButMissing =
      row.name === config.activePack && !row.local;
    if (row.name === config.activePack && !isActiveButMissing) {
      // Already active *and installed* — Tab is a no-op.
      return;
    }
    // Active-but-missing falls through to the install path below, so
    // pressing Tab on the orange row downloads the configured pack.
    if (row.local) {
      callbacks.setActivePack(row.name);
      // The pack picker reflects the new active row on next re-render.
      rebuildPackPicker();
      args.tui.requestRender();
      return;
    }
    if (!row.registry) {
      // Stub row — no registry entry, no way to install. Silent skip.
      return;
    }
    if (state === "installing") return;
    state = "installing";
    currentPack = row;
    args.tui.requestRender();
    try {
      await callbacks.installPack(row.registry);
      // installPack wrapper in index.ts has already activated the new
      // pack + emitted toasts. Re-fetch installed list and re-render.
      rebuildPackPicker();
      state = "ready";
      args.tui.requestRender();
    } catch {
      // Wrapper emitted an error toast. Drop back to the picker.
      state = "ready";
      args.tui.requestRender();
    }
  };

  // ── drill-in flow ──────────────────────────────────────────────────
  // Enter on a pack row → load its manifest (local first, otherwise
  // GitHub raw) → mount the files picker for it.
  const enterFiles = async (row: PackRow): Promise<void> => {
    currentPack = row;
    state = "files-loading";
    args.tui.requestRender();
    try {
      let manifest: PackManifest;
      if (row.local) {
        manifest = row.local.manifest;
      } else if (row.registry) {
        manifest = await callbacks.fetchPackManifest(row.registry);
      } else {
        throw new Error("no manifest available (pack not installed or in registry)");
      }
      filesPicker = buildFilesPicker(row, manifest);
      state = "files";
      args.tui.requestRender();
    } catch (err) {
      filesErrorMsg = err instanceof Error ? err.message : String(err);
      state = "files-error";
      args.tui.requestRender();
    }
  };

  const exitFiles = (): void => {
    filesPicker = undefined;
    currentPack = undefined;
    state = "ready";
    args.tui.requestRender();
  };

  // ── files picker (inner) ───────────────────────────────────────────
  // Flat SelectList of every sound the pack declares. No filter row —
  // a single pack rarely has more than ~30 clips, and SelectList's
  // built-in auto-scroll is enough on its own.
  //   Enter plays, Tab sets the pack as active, Esc returns to the
  // pack list.
  const buildFilesPicker = (
    row: PackRow,
    manifest: PackManifest,
  ): Component => {
    interface SoundRowFile {
      cat: string;
      label: string;
      rel: string;
      sound: ManifestSound;
    }
    const fileRows: SoundRowFile[] = [];
    if (manifest.categories) {
      for (const cat of Object.keys(manifest.categories)) {
        const sounds = manifest.categories[cat]?.sounds ?? [];
        for (const s of sounds) {
          const rel = s.file.includes("/") ? s.file : `sounds/${s.file}`;
          fileRows.push({
            cat,
            label: s.label ?? rel,
            rel,
            sound: s,
          });
        }
      }
    }

    if (fileRows.length === 0) {
      return {
        render: () => [
          "",
          args.theme.fg(
            "muted",
            `  ${row.displayName} declares no sounds.`,
          ),
          "",
          args.theme.fg("dim", "  esc back"),
        ],
        handleInput: (data: string) => {
          if (
            matchesKey(data, "escape") ||
            matchesKey(data, "ctrl+c") ||
            matchesKey(data, "enter") ||
            matchesKey(data, "return")
          ) {
            exitFiles();
          }
        },
        invalidate: () => {},
      };
    }

    // `previewRemoteSound` always tries the local copy first before
    // falling back to a single-file download. For installed-only
    // packs we don't have a real RegistryEntry, so synthesize a stub
    // — the download path stays unreachable in that case anyway.
    const fallbackEntry: RegistryEntry = row.registry ?? {
      name: row.name,
      source_repo: "",
      source_ref: "",
      source_path: ".",
    };

    // Two-column row layout: the bracketed event category sits in a
    // fixed 20-column primary cell, the sound's display title sits in
    // the description cell which the SelectList grows to fill the rest
    // of the viewport. The filename is intentionally dropped.
    //
    // Color hierarchy is the inverse of the SelectList default:
    //   primary (event tag)  → `muted`  (less important; redundant when
    //                                       scanning the title)
    //   secondary (title)    → default foreground (the thing the user
    //                                       actually reads)
    // We get there by pre-coloring the label and overriding the theme's
    // `description` function to identity so the title isn't dimmed.
    const items: SelectItem[] = fileRows.map((r) => ({
      value: `${r.cat}::${r.rel}`,
      label: args.theme.fg("muted", `[${r.cat}]`),
      description: r.label,
    }));
    const list = new SelectList(
      items,
      Math.min(items.length, MAX_PICKER_VISIBLE),
      {
        ...getSelectListTheme(),
        description: (text) => text,
      },
      {
        minPrimaryColumnWidth: 20,
        maxPrimaryColumnWidth: 20,
      },
    );

    const playHighlighted = (): void => {
      const selected = list.getSelectedItem();
      if (!selected) return;
      const picked = fileRows.find(
        (r) => `${r.cat}::${r.rel}` === selected.value,
      );
      if (!picked) return;
      void callbacks.previewRemoteSound(
        row.registry ?? fallbackEntry,
        picked.sound,
      );
      // Stay open — user typically auditions several clips in a row.
    };

    list.onSelect = () => playHighlighted();
    list.onCancel = () => exitFiles();
    list.onSelectionChange = () => args.tui.requestRender();

    const filesHints: KeyHint[] = [
      { key: "↑↓", label: "select" },
      { key: "enter/space", label: "play" },
      { key: "tab", label: "set active" },
      { key: "esc", label: "back" },
    ];

    return {
      render(width: number): string[] {
        const lines = list.render(width);
        lines.push("");
        const hintLine = formatHintLine(filesHints, args.theme);
        const tail = args.theme.fg(
          "dim",
          `  ·  ${fileRows.length} sound${fileRows.length === 1 ? "" : "s"} — ${row.displayName}`,
        );
        lines.push(
          truncateToWidth(`  ${hintLine}${tail}`, width, "…", true),
        );
        return lines;
      },
      invalidate(): void {
        list.invalidate();
      },
      handleInput(data: string): void {
        if (matchesKey(data, "tab")) {
          // Tab on a sound row → set the *pack* as the active one
          // (not the sound). Symmetric with the packs picker.
          void setActiveFromRow(row);
          args.tui.requestRender();
          return;
        }
        if (matchesKey(data, "space") || data === " ") {
          // Space is an alias for Enter — audition the highlighted clip
          // without having to reach for Enter. SelectList may not handle
          // space natively, so we route it ourselves.
          playHighlighted();
          args.tui.requestRender();
          return;
        }
        // Everything else — ↑/↓/Enter/Esc/Ctrl+C — goes to SelectList.
        list.handleInput(data);
        args.tui.requestRender();
      },
    };
  };

  // ── outer pack picker (sectioned) ─────────────────────────────────
  const rebuildPackPicker = (): void => {
    packPicker = buildSectionedPackPicker({
      args,
      rows: buildPackRows(),
      onEnter: (row) => {
        void enterFiles(row);
      },
      onSetActive: (row) => {
        void setActiveFromRow(row);
      },
    });
  };

  callbacks
    .fetchRegistry()
    .then((es) => {
      registryEntries = es;
      rebuildPackPicker();
      state = "ready";
      args.tui.requestRender();
    })
    .catch((err: unknown) => {
      // Registry fetch failure shouldn't strand the user: they can
      // still see + activate locally-installed packs. So we render
      // the pack picker with an empty registry list and surface the
      // error as a one-time toast-style line at the top.
      errorMsg = err instanceof Error ? err.message : String(err);
      registryEntries = [];
      rebuildPackPicker();
      state = "ready";
      args.tui.requestRender();
    });

  // ── outer Component ────────────────────────────────────────────────
  return {
    render: (width: number) => {
      if (state === "loading") {
        return [
          "",
          args.theme.fg("muted", "  Fetching registry…"),
          "",
          args.theme.fg("dim", "  esc cancel"),
        ];
      }
      if (state === "error") {
        return [
          "",
          args.theme.fg("muted", `  Registry fetch failed: ${errorMsg}`),
          "",
          args.theme.fg("dim", "  esc back"),
        ];
      }
      if (state === "installing") {
        const name = currentPack?.displayName ?? currentPack?.name ?? "pack";
        return [
          "",
          args.theme.fg(
            "accent",
            `  Installing ${name}… this may take a few seconds.`,
          ),
          "",
          args.theme.fg("dim", "  watch the toast for progress"),
        ];
      }
      if (state === "files-loading") {
        const name = currentPack?.displayName ?? currentPack?.name ?? "pack";
        return [
          "",
          args.theme.fg("muted", `  Fetching ${name} manifest…`),
          "",
          args.theme.fg("dim", "  esc cancel"),
        ];
      }
      if (state === "files-error") {
        return [
          "",
          args.theme.fg("muted", `  Manifest fetch failed: ${filesErrorMsg}`),
          "",
          args.theme.fg("dim", "  esc back"),
        ];
      }
      if (state === "files") {
        return filesPicker!.render(width);
      }
      // ready — show the sectioned pack picker. If the registry
      // fetch had failed earlier we still got here; surface the
      // error inline above the picker so it doesn't disappear.
      const lines: string[] = [];
      if (errorMsg) {
        lines.push(
          args.theme.fg(
            "muted",
            `  ⚠ registry fetch failed: ${errorMsg}`,
          ),
        );
        lines.push("");
      }
      for (const l of packPicker!.render(width - lines.length)) {
        lines.push(l);
      }
      return lines;
    },
    handleInput: (data: string) => {
      if (state === "loading" || state === "installing") {
        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
          args.done();
        }
        return;
      }
      if (state === "error") {
        if (
          matchesKey(data, "escape") ||
          matchesKey(data, "ctrl+c") ||
          matchesKey(data, "enter")
        ) {
          args.done();
        }
        return;
      }
      if (state === "files-loading") {
        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
          // The in-flight manifest fetch is left to resolve on its
          // own; we just stop caring about its result.
          exitFiles();
        }
        return;
      }
      if (state === "files-error") {
        if (
          matchesKey(data, "escape") ||
          matchesKey(data, "ctrl+c") ||
          matchesKey(data, "enter") ||
          matchesKey(data, "return")
        ) {
          exitFiles();
        }
        return;
      }
      if (state === "files") {
        filesPicker?.handleInput?.(data);
        return;
      }
      // ready
      packPicker?.handleInput?.(data);
    },
    invalidate: () => {
      packPicker?.invalidate();
      filesPicker?.invalidate();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Sectioned pack picker — handcrafted (not SelectList-based) so we
// can render section headers between groups and skip them during ↑↓
// navigation.
// ─────────────────────────────────────────────────────────────────────

interface SectionedPickerOptions {
  args: CustomFieldSubmenuArgs<unknown>;
  rows: PackRow[];
  /** Enter on a pack → drill into its sound list. */
  onEnter: (row: PackRow) => void;
  /** Tab on a pack → make it the active pack (installing if needed). */
  onSetActive: (row: PackRow) => void;
}

type RenderRow =
  | { kind: "header"; text: string }
  | { kind: "blank" }
  | { kind: "item"; row: PackRow; flatIdx: number };

function buildSectionedPackPicker(
  opts: SectionedPickerOptions,
): Component {
  const { args } = opts;
  const filter: InlineEditState = { buffer: "", cursor: 0 };

  /** Flat list of selectable items after filter. `selectedIdx` indexes
   *  into this array. */
  let visibleItems: PackRow[] = [];
  /** Rendered rows including section headers / blanks. */
  let renderRows: RenderRow[] = [];
  /** Map from `selectedIdx` to row index in `renderRows`. */
  let itemToRowIdx: number[] = [];
  let selectedIdx = 0;
  let scrollOffset = 0;

  const rebuild = (preserveName: string | undefined): void => {
    const q = filter.buffer.trim().toLowerCase();
    visibleItems = q
      ? opts.rows.filter((r) => r.search.toLowerCase().includes(q))
      : opts.rows;

    // Bucket into sections, preserving the original (alphabetical)
    // ordering inside each bucket.
    const buckets: Record<"active" | "installed" | "registry", PackRow[]> = {
      active: [],
      installed: [],
      registry: [],
    };
    for (const r of visibleItems) buckets[r.section].push(r);

    renderRows = [];
    itemToRowIdx = new Array(visibleItems.length);
    let flatIdx = 0;
    const sections: Array<{
      key: "active" | "installed" | "registry";
      title: string;
    }> = [
      { key: "active", title: "Active" },
      { key: "installed", title: "Available" },
      { key: "registry", title: "Registry" },
    ];

    for (const sec of sections) {
      const items = buckets[sec.key];
      if (items.length === 0) continue;
      if (renderRows.length > 0) renderRows.push({ kind: "blank" });
      const titleSuffix =
        sec.key === "registry" && q ? `  (${items.length})` : "";
      const titleFull =
        sec.key === "registry" && !q
          ? `── ${sec.title} (${items.length}) ──`
          : `── ${sec.title}${titleSuffix} ──`;
      renderRows.push({ kind: "header", text: titleFull });
      for (const it of items) {
        itemToRowIdx[flatIdx] = renderRows.length;
        renderRows.push({ kind: "item", row: it, flatIdx });
        flatIdx++;
      }
    }

    // Preserve the previously-highlighted row across rebuilds so
    // typing a filter character doesn't yank the cursor to the top.
    if (preserveName !== undefined) {
      const idx = visibleItems.findIndex((r) => r.name === preserveName);
      if (idx >= 0) {
        selectedIdx = idx;
        return;
      }
    }
    if (visibleItems.length === 0) selectedIdx = -1;
    else selectedIdx = Math.max(0, Math.min(selectedIdx, visibleItems.length - 1));
  };

  rebuild(undefined);

  const renderFilterRow = (width: number): string => {
    const cursorBlock = args.theme.inverse(" ");
    const buf = filter.buffer;
    const before = buf.slice(0, filter.cursor);
    const after = buf.slice(filter.cursor);
    const text = buf
      ? `  ${args.theme.fg("muted", "filter:")} ${args.theme.fg("accent", before)}${cursorBlock}${args.theme.fg("accent", after)}`
      : `  ${args.theme.fg("muted", "filter:")} ${cursorBlock}${args.theme.fg("dim", "  type to filter…")}`;
    return truncateToWidth(text, width, "…", true);
  };

  /** True iff this row is the configured active pack but no install
   *  was found on disk. Used to colour the row orange and switch the
   *  Tab hint from "set active" to "download". */
  const isMissingActive = (row: PackRow): boolean =>
    row.section === "active" && !row.local;

  const renderItemRow = (
    row: PackRow,
    isSelected: boolean,
    width: number,
  ): string => {
    const prefix = isSelected ? " ▶ " : "   ";
    const body = `${prefix}${row.rowLabel}`;
    // Missing active pack: render in `warning` (orange) regardless of
    // selection, so the user can't miss the broken state. Selection
    // is still indicated by the ▶ prefix.
    const colored = isMissingActive(row)
      ? args.theme.fg("warning", body)
      : isSelected
        ? args.theme.fg("accent", body)
        : args.theme.fg("muted", body);
    return truncateToWidth(colored, width, "…", true);
  };

  const renderHeaderRow = (text: string, width: number): string => {
    return truncateToWidth(
      args.theme.fg("accent", args.theme.bold(`  ${text}`)),
      width,
      "…",
      true,
    );
  };

  const adjustScroll = (viewportHeight: number): void => {
    if (selectedIdx < 0) return;
    const rowIdx = itemToRowIdx[selectedIdx];
    if (rowIdx === undefined) return;
    if (rowIdx < scrollOffset) {
      scrollOffset = rowIdx;
    } else if (rowIdx >= scrollOffset + viewportHeight) {
      scrollOffset = rowIdx - viewportHeight + 1;
    }
    scrollOffset = Math.max(
      0,
      Math.min(scrollOffset, Math.max(0, renderRows.length - viewportHeight)),
    );
  };

  return {
    render(width: number): string[] {
      const lines: string[] = [];
      lines.push(renderFilterRow(width));
      lines.push("");

      if (visibleItems.length === 0) {
        lines.push(args.theme.fg("muted", "  no packs match filter"));
      } else {
        adjustScroll(MAX_PICKER_VISIBLE);
        const end = Math.min(scrollOffset + MAX_PICKER_VISIBLE, renderRows.length);
        for (let i = scrollOffset; i < end; i++) {
          const row = renderRows[i]!;
          if (row.kind === "header") {
            lines.push(renderHeaderRow(row.text, width));
          } else if (row.kind === "blank") {
            lines.push("");
          } else {
            lines.push(
              renderItemRow(row.row, row.flatIdx === selectedIdx, width),
            );
          }
        }
        if (renderRows.length > MAX_PICKER_VISIBLE) {
          lines.push(
            args.theme.fg(
              "dim",
              `  rows ${scrollOffset + 1}-${end}/${renderRows.length}  ·  ${visibleItems.length}/${opts.rows.length} packs`,
            ),
          );
        }
      }
      lines.push("");
      // When the highlighted row is the active-but-missing pack we
      // relabel the Tab hint to "download" so the user knows pressing
      // Tab here pulls the pack from the registry rather than "setting
      // it active" (it already is).
      const highlighted = visibleItems[selectedIdx];
      const highlightedMissing =
        highlighted !== undefined && isMissingActive(highlighted);
      const packsHints: KeyHint[] = [
        { key: "↑↓", label: "select" },
        { key: "enter", label: "files" },
        { key: "tab", label: highlightedMissing ? "download" : "set active" },
        { key: "type", label: "filter" },
        { key: "esc", label: "back" },
      ];
      lines.push(
        truncateToWidth(
          `  ${formatHintLine(packsHints, args.theme)}`,
          width,
          "…",
          true,
        ),
      );
      return lines;
    },
    invalidate(): void {
      // Nothing cached we need to drop — the list is rebuilt on every
      // filter change.
    },
    handleInput(data: string): void {
      if (matchesKey(data, "up")) {
        if (selectedIdx > 0) {
          selectedIdx--;
          args.tui.requestRender();
        }
        return;
      }
      if (matchesKey(data, "down")) {
        if (selectedIdx < visibleItems.length - 1) {
          selectedIdx++;
          args.tui.requestRender();
        }
        return;
      }
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
        args.done();
        return;
      }
      if (matchesKey(data, "enter") || matchesKey(data, "return")) {
        const row = visibleItems[selectedIdx];
        if (row) opts.onEnter(row);
        return;
      }
      if (matchesKey(data, "tab")) {
        const row = visibleItems[selectedIdx];
        if (row) opts.onSetActive(row);
        return;
      }
      // Everything else — printable chars, backspace, Ctrl+U, Left/Right —
      // routes through the inline-edit state machine. Left/Right move
      // the filter cursor; they no longer drive any navigation.
      const previousName = visibleItems[selectedIdx]?.name;
      const consumed = handleInlineEditInput(filter, data);
      if (consumed) {
        rebuild(previousName);
        args.tui.requestRender();
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────

function formatPackRowLabel(args: {
  name: string;
  displayName: string;
  local?: InstalledPack;
  registry?: RegistryEntry;
}): string {
  const version =
    args.local?.manifest.version ?? args.registry?.version ?? "";
  const verSuffix = version ? `  (${version})` : "";
  return `${args.displayName}  ·  ${args.name}${verSuffix}`;
}

function searchTextFor(
  name: string,
  displayName: string,
  registry?: RegistryEntry,
): string {
  const parts = [name, displayName];
  if (registry) {
    parts.push(
      registry.description ?? "",
      registry.source_repo,
      registry.language ?? "",
      registry.trust_tier ?? "",
      ...(registry.tags ?? []),
    );
  }
  return parts.filter(Boolean).join(" ");
}

function formatRegistryRow(e: RegistryEntry): string {
  const display = e.display_name ?? e.name;
  const meta: string[] = [];
  if (e.trust_tier) meta.push(e.trust_tier);
  if (e.language) meta.push(e.language);
  if (typeof e.sound_count === "number") meta.push(`${e.sound_count} sounds`);
  if (typeof e.total_size_bytes === "number") {
    meta.push(formatBytes(e.total_size_bytes));
  }
  const tail = meta.length ? `  [${meta.join(" · ")}]` : "";
  return `${display}  ·  ${e.name}${tail}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
