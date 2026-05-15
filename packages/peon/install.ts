/**
 * Pack installation from the CESP registry.
 *
 * Steps (per CESP spec):
 *
 *   1. Fetch `https://github.com/{source_repo}/archive/refs/tags/{source_ref}.tar.gz`
 *   2. Extract it into a fresh temp directory.
 *   3. Move `{tmp}/{archive_root}/{source_path}/` to
 *      `~/.openpeon/packs/{name}/`.
 *   4. Verify `openpeon.json` exists at the new root.
 *
 * Cross-platform notes:
 *
 *   - We use Node's `fetch` (Node ≥ 18) — works on macOS, Linux, and
 *     Windows 10/11.
 *   - Extraction shells out to `tar -xzf` because every reasonable
 *     host already has it (BSD tar on macOS, GNU tar on Linux,
 *     bsdtar on Windows ≥ 1803). Bundling a JS tar parser would be
 *     overkill for a single one-shot install path.
 *   - We never auto-delete an existing pack directory; the caller is
 *     responsible for confirming overwrites.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePacksDir, packDir, packManifestPath } from "./paths.ts";
import type { PackManifest } from "./pack.ts";
import type { RegistryEntry } from "./registry.ts";

const DOWNLOAD_TIMEOUT_MS = 60_000;
const MANIFEST_TIMEOUT_MS = 10_000;
const SOUND_TIMEOUT_MS = 30_000;

/** Temp dir for individually-downloaded preview clips (registry browser). */
const PREVIEW_CACHE_DIR = join(tmpdir(), "peon-previews");

/** Build the `raw.githubusercontent.com` base URL for a registry entry.
 *  `source_path === "."` (or empty) means the pack lives at the repo
 *  root; otherwise we drill into the subdirectory. */
function rawUrlBase(entry: RegistryEntry): string {
  const prefix =
    entry.source_path === "." || entry.source_path === ""
      ? ""
      : `${entry.source_path}/`;
  return `https://raw.githubusercontent.com/${entry.source_repo}/${entry.source_ref}/${prefix}`;
}

export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallError";
  }
}

/**
 * Download + extract a registry pack. The pack ends up at
 * `<packsDir>/<entry.name>/` with a verified `openpeon.json` at its
 * root. Returns the absolute installed path.
 *
 * Re-installing on top of an existing pack: the old directory is
 * wiped (best-effort) before the new one is moved in. Callers should
 * confirm with the user before calling — there is no prompt here.
 */
export async function installPack(entry: RegistryEntry): Promise<string> {
  ensurePacksDir();
  const tarUrl = `https://github.com/${entry.source_repo}/archive/refs/tags/${entry.source_ref}.tar.gz`;
  const tmpRoot = mkdtempSync(join(tmpdir(), "peon-install-"));
  const tarPath = join(tmpRoot, "pack.tar.gz");
  const extractDir = join(tmpRoot, "extracted");
  mkdirSync(extractDir, { recursive: true });

  try {
    await downloadToFile(tarUrl, tarPath);
    await extractTarball(tarPath, extractDir);

    // GitHub tarballs contain a single top-level directory like
    // `<repo>-<sha>/` (or `<repo>-<tag>/`). The exact name varies, so
    // we just take whatever the only entry is.
    const roots = readdirSync(extractDir).filter((n) => !n.startsWith("."));
    if (roots.length === 0) {
      throw new InstallError("extracted archive was empty");
    }
    const archiveRoot = join(extractDir, roots[0]!);
    const sourcePath =
      entry.source_path === "." || entry.source_path === ""
        ? archiveRoot
        : join(archiveRoot, entry.source_path);

    if (!existsSync(sourcePath)) {
      throw new InstallError(
        `archive missing expected source_path: ${entry.source_path}`,
      );
    }
    if (!existsSync(join(sourcePath, "openpeon.json"))) {
      throw new InstallError(
        `archive missing openpeon.json at ${entry.source_path || "<root>"}`,
      );
    }

    const target = packDir(entry.name);
    // Best-effort wipe of an existing install. If `rmSync` fails (e.g.
    // permissions on Windows holding a sound open), we proceed and let
    // `cpSync(force: true)` overlay what it can.
    if (existsSync(target)) {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {
        // fall through
      }
    }
    mkdirSync(target, { recursive: true });
    cpSync(sourcePath, target, { recursive: true });

    if (!existsSync(packManifestPath(entry.name))) {
      throw new InstallError(
        `installed pack missing openpeon.json at ${target}`,
      );
    }
    return target;
  } finally {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) {
      throw new InstallError(`download HTTP ${res.status} for ${url}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(dest, buf);
  } catch (err) {
    if (err instanceof InstallError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new InstallError(`download failed: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

function extractTarball(tarPath: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("tar", ["-xzf", tarPath, "-C", dest], {
      stdio: "ignore",
    });
    proc.once("error", (err) => {
      reject(new InstallError(`tar failed to start: ${err.message}`));
    });
    proc.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new InstallError(`tar exited with code ${code}`));
    });
  });
}

// ──────────────────────────────────────────────────────────────────
// Lightweight remote reads — used by the registry browser's drill-in
// view so we can list the sounds of a pack and preview individual
// clips *without* downloading the full tarball.
// ──────────────────────────────────────────────────────────────────

const manifestCache = new Map<string, PackManifest>();

/**
 * Fetch a pack's `openpeon.json` directly from GitHub raw — no
 * tarball, no extraction, just the manifest. Cached by
 * `name@source_ref` so drilling into the same pack twice in one
 * session is free.
 */
export async function fetchPackManifest(
  entry: RegistryEntry,
): Promise<PackManifest> {
  const cacheKey = `${entry.name}@${entry.source_ref}`;
  const cached = manifestCache.get(cacheKey);
  if (cached) return cached;

  const url = `${rawUrlBase(entry)}openpeon.json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new InstallError(`manifest HTTP ${res.status} for ${url}`);
    }
    const parsed = (await res.json()) as unknown;
    if (!parsed || typeof parsed !== "object") {
      throw new InstallError("manifest is not a JSON object");
    }
    const manifest = parsed as PackManifest;
    manifestCache.set(cacheKey, manifest);
    return manifest;
  } catch (err) {
    if (err instanceof InstallError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new InstallError(`manifest fetch failed: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Download a single sound file to a temp cache and return its local
 * path. Idempotent — second call with the same `(entry, relFile)` is
 * a no-op (the cached file is reused).
 *
 * `relFile` is the path **as it should appear inside the pack root**
 * (e.g. `sounds/Hello.wav`). Callers are responsible for resolving the
 * spec's implicit-`sounds/` prefix rule before passing it in.
 */
export async function downloadSoundToTemp(
  entry: RegistryEntry,
  relFile: string,
): Promise<string> {
  if (!existsSync(PREVIEW_CACHE_DIR)) {
    mkdirSync(PREVIEW_CACHE_DIR, { recursive: true });
  }
  // Cache key: pack@ref + sanitized relpath. We keep the original
  // extension so the audio player picks the right decoder.
  const ext = relFile.includes(".") ? relFile.slice(relFile.lastIndexOf(".")) : "";
  const safeKey =
    `${entry.name}__${entry.source_ref}__${relFile.replace(/[^a-zA-Z0-9._-]/g, "_")}` ||
    `preview${ext}`;
  const cachePath = join(PREVIEW_CACHE_DIR, safeKey);
  if (existsSync(cachePath)) return cachePath;

  const url = `${rawUrlBase(entry)}${relFile}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOUND_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) {
      throw new InstallError(`sound HTTP ${res.status} for ${url}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(cachePath, buf);
    return cachePath;
  } catch (err) {
    if (err instanceof InstallError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new InstallError(`sound download failed: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Reset every in-memory cache. Useful for tests. */
export function resetRemoteCaches(): void {
  manifestCache.clear();
}
