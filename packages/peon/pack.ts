/**
 * CESP (Coding Event Sound Pack) manifest loading + resolution.
 *
 * A pack is just a directory under `~/.openpeon/packs/<name>/` with an
 * `openpeon.json` manifest at its root and a `sounds/` subdirectory
 * holding the audio files. See https://openpeon.com/spec for the
 * format.
 *
 * Resolution rules (from the spec):
 *   1. Look up `categories[<cat>]` directly.
 *   2. If missing, look up `category_aliases[<cat>]` and follow it to
 *      another `categories[<resolved>]` entry. Only one indirection —
 *      we deliberately don't chain aliases to avoid pathological loops.
 *   3. If still missing, return `[]` so the caller skips silently.
 *
 * File paths inside the manifest are relative to the manifest itself;
 * paths without a `/` are implicitly prefixed with `sounds/` (per
 * spec). The returned `absPath` is fully resolved against the pack
 * directory so callers can pass it straight to the audio player.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { packDir, packManifestPath, packsDir } from "./paths.ts";

/** Canonical CESP event categories. */
export const CESP_CATEGORIES = [
  "session.start",
  "task.acknowledge",
  "task.complete",
  "task.error",
  "input.required",
  "resource.limit",
  "user.spam",
  "session.end",
  "task.progress",
] as const;
export type CespCategory = (typeof CESP_CATEGORIES)[number];

/** Raw sound entry as it appears in the manifest. */
export interface ManifestSound {
  file: string;
  label?: string;
  sha256?: string;
}

/** Raw manifest shape (only the fields we care about). */
export interface PackManifest {
  cesp_version?: string;
  name: string;
  display_name?: string;
  version?: string;
  author?: { name?: string; github?: string };
  license?: string;
  language?: string;
  categories?: Record<string, { sounds: ManifestSound[] } | undefined>;
  category_aliases?: Record<string, string>;
}

/** Loaded pack record — includes resolved on-disk root for playback. */
export interface InstalledPack {
  /** Pack id (`peon`, `glados`, …) — taken from the directory name. */
  name: string;
  /** Friendly display name (falls back to `name`). */
  displayName: string;
  /** Absolute pack root (`<packsDir>/<name>/`). */
  root: string;
  /** Raw manifest contents. */
  manifest: PackManifest;
  /** Names of every category the manifest defines outright. */
  declaredCategories: string[];
}

/** Resolved sound for playback — absolute file path + display label. */
export interface ResolvedSound {
  absPath: string;
  label: string;
  /** Manifest-declared category that ultimately yielded this sound
   *  (after alias resolution). Useful for the preview UI. */
  resolvedCategory: string;
}

/** Read + sanity-check `openpeon.json` for the named pack. */
export function loadPack(name: string): InstalledPack | null {
  const root = packDir(name);
  const manifestFile = packManifestPath(name);
  if (!existsSync(manifestFile)) return null;
  let manifest: PackManifest;
  try {
    const raw = readFileSync(manifestFile, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    manifest = parsed as PackManifest;
  } catch {
    return null;
  }
  if (!manifest.name || typeof manifest.name !== "string") {
    // Manifest must at least declare its own name. Skip silently.
    return null;
  }
  const declaredCategories = manifest.categories
    ? Object.keys(manifest.categories)
    : [];
  return {
    name,
    displayName: manifest.display_name ?? manifest.name,
    root,
    manifest,
    declaredCategories,
  };
}

/** Enumerate installed packs (directories under `packsDir()` that have
 *  a readable manifest). Order is alphabetical for stable UX. */
export function listInstalledPacks(): InstalledPack[] {
  const root = packsDir();
  if (!existsSync(root)) return [];
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return [];
  }
  const out: InstalledPack[] = [];
  for (const entry of dirs) {
    if (entry.startsWith(".")) continue;
    let isDir = false;
    try {
      isDir = statSync(join(root, entry)).isDirectory();
    } catch {
      // Broken symlink / vanished mid-scan — skip silently.
      continue;
    }
    if (!isDir) continue;
    const pack = loadPack(entry);
    if (pack) out.push(pack);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** True iff `<packsDir>/<name>/openpeon.json` is readable JSON. */
export function isPackInstalled(name: string): boolean {
  return loadPack(name) !== null;
}

/**
 * Resolve every sound in `category` for the given pack, following the
 * one-step alias fallback. Returns `[]` when the pack defines nothing
 * for the category (and no alias maps to anything either).
 */
export function resolveCategory(
  pack: InstalledPack,
  category: string,
): ResolvedSound[] {
  const direct = pack.manifest.categories?.[category];
  if (direct?.sounds?.length) {
    return direct.sounds.map((s) => mapSound(pack, s, category));
  }
  const aliased = pack.manifest.category_aliases?.[category];
  if (aliased) {
    const sub = pack.manifest.categories?.[aliased];
    if (sub?.sounds?.length) {
      return sub.sounds.map((s) => mapSound(pack, s, aliased));
    }
  }
  return [];
}

/** Resolve every declared category in the pack — used by the preview UI. */
export function resolveAllCategories(
  pack: InstalledPack,
): Array<{ category: string; sounds: ResolvedSound[] }> {
  const out: Array<{ category: string; sounds: ResolvedSound[] }> = [];
  for (const category of pack.declaredCategories) {
    const sounds = resolveCategory(pack, category);
    if (sounds.length) out.push({ category, sounds });
  }
  return out;
}

function mapSound(
  pack: InstalledPack,
  sound: ManifestSound,
  resolvedCategory: string,
): ResolvedSound {
  // Per spec: paths use forward slashes and are relative to the
  // manifest. Paths without any slash get an implicit `sounds/` prefix.
  const file = sound.file;
  const rel = file.includes("/") ? file : `sounds/${file}`;
  const absPath = join(pack.root, ...rel.split("/"));
  const label = sound.label ?? rel;
  return { absPath, label, resolvedCategory };
}
