import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, defaults, loadConfig, MAX_LENGTH, MIN_LENGTH, sanitize, saveConfig } from "./config.ts";

describe("config", () => {
  it("defaults: both targets, first mode, cheap model", () => {
    const d = defaults();
    expect(d).toMatchObject({ enabled: true, target: "both", mode: "first", model: DEFAULT_MODEL, thinking: "off" });
    expect(DEFAULT_MODEL).toBe("anthropic/claude-haiku-5-5");
  });

  it("sanitize drops unknown and invalid values", () => {
    const cfg = sanitize({ target: "nope", mode: "follow", thinking: "max", maxLength: 999, titleTemplate: "no placeholder", extra: 1 });
    expect(cfg.target).toBe("both");
    expect(cfg.mode).toBe("follow");
    expect(cfg.thinking).toBe("off");
    expect(cfg.maxLength).toBe(MAX_LENGTH);
    expect(cfg.titleTemplate).toBe("{name}");
    expect(sanitize({ maxLength: 1 }).maxLength).toBe(MIN_LENGTH);
    expect(sanitize(null)).toEqual(defaults());
  });

  it("allows the session-model sentinel", () => {
    expect(sanitize({ model: "" }).model).toBe("");
  });

  it("round-trips through disk and survives garbage", () => {
    const dir = mkdtempSync(join(tmpdir(), "autoname-"));
    const path = join(dir, "nested", "settings.json");
    expect(loadConfig(path)).toEqual(defaults());
    saveConfig({ ...defaults(), target: "title", mode: "auto", titleTemplate: "{name} · {cwd}" }, path);
    expect(JSON.parse(readFileSync(path, "utf-8")).target).toBe("title");
    expect(loadConfig(path)).toMatchObject({ target: "title", mode: "auto", titleTemplate: "{name} · {cwd}" });
    writeFileSync(path, "{not json");
    expect(loadConfig(path)).toEqual(defaults());
  });
});
