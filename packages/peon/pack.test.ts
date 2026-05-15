/**
 * Manifest-resolution tests. We build a fake manifest in memory and
 * exercise the alias-fallback and implicit-`sounds/`-prefix rules from
 * the CESP spec.
 */

import { describe, expect, it } from "vitest";
import { resolveCategory, type InstalledPack } from "./pack.ts";

function fakePack(): InstalledPack {
  return {
    name: "fixture",
    displayName: "Fixture",
    root: "/packs/fixture",
    declaredCategories: ["session.start", "complete"],
    manifest: {
      cesp_version: "1.0",
      name: "fixture",
      categories: {
        "session.start": {
          sounds: [
            { file: "Hello.wav", label: "Hi" },
            { file: "sub/dir/Ready.wav", label: "Ready" },
          ],
        },
        // Note: "complete" is a non-canonical name, only reachable via alias.
        complete: {
          sounds: [{ file: "Done.wav", label: "Done" }],
        },
      },
      category_aliases: {
        "task.complete": "complete",
      },
    },
  };
}

describe("resolveCategory", () => {
  it("returns direct matches and prefixes paths without slashes with sounds/", () => {
    const pack = fakePack();
    const r = resolveCategory(pack, "session.start");
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({
      label: "Hi",
      resolvedCategory: "session.start",
    });
    // Implicit `sounds/` prefix on slashless paths.
    expect(r[0]!.absPath.endsWith("/sounds/Hello.wav")).toBe(true);
    // Explicit subpaths are preserved verbatim.
    expect(r[1]!.absPath.endsWith("/sub/dir/Ready.wav")).toBe(true);
  });

  it("falls back through category_aliases when direct missing", () => {
    const pack = fakePack();
    const r = resolveCategory(pack, "task.complete");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ label: "Done", resolvedCategory: "complete" });
  });

  it("returns [] when neither direct nor alias resolves", () => {
    const pack = fakePack();
    expect(resolveCategory(pack, "task.progress")).toEqual([]);
  });
});
