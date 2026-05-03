import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  envDefaults,
  loadConfig,
  loadOrInitConfig,
  saveConfig,
  DEFAULT_SEARCH_MODEL,
} from "./config.ts";

describe("config", () => {
  let dir: string;
  let configPath: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wierd-web-cfg-"));
    configPath = join(dir, "wierd-web.json");
    // Snapshot env vars we mutate so tests are isolated.
    for (const k of [
      "PI_WIERD_WEB_MODEL",
      "PI_WIERD_WEB_FETCH_MODEL",
      "PI_WIERD_WEB_FETCH_THINKING",
    ]) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe("envDefaults", () => {
    it("uses DEFAULT_SEARCH_MODEL when no env override", () => {
      const cfg = envDefaults();
      expect(cfg.searchModel).toBe(DEFAULT_SEARCH_MODEL);
      expect(cfg.fetchModel).toBeUndefined();
      expect(cfg.fetchThinkingLevel).toBeUndefined();
    });

    it("respects PI_WIERD_WEB_MODEL", () => {
      process.env.PI_WIERD_WEB_MODEL = "claude-sonnet-4";
      const cfg = envDefaults();
      expect(cfg.searchModel).toBe("claude-sonnet-4");
    });

    it("respects fetch env vars", () => {
      process.env.PI_WIERD_WEB_FETCH_MODEL = "openai/gpt-4o-mini";
      process.env.PI_WIERD_WEB_FETCH_THINKING = "high";
      const cfg = envDefaults();
      expect(cfg.fetchModel).toBe("openai/gpt-4o-mini");
      expect(cfg.fetchThinkingLevel).toBe("high");
    });

    it("trims whitespace from env values", () => {
      process.env.PI_WIERD_WEB_MODEL = "  claude-x  ";
      expect(envDefaults().searchModel).toBe("claude-x");
    });
  });

  describe("loadConfig", () => {
    it("returns env defaults when file missing", () => {
      const cfg = loadConfig(configPath);
      expect(cfg.searchModel).toBe(DEFAULT_SEARCH_MODEL);
    });

    it("parses a complete config file", () => {
      writeFileSync(
        configPath,
        JSON.stringify({
          searchModel: "claude-haiku-4-5",
          fetchModel: "anthropic/claude-haiku-4-5",
          fetchThinkingLevel: "medium",
        }),
      );
      const cfg = loadConfig(configPath);
      expect(cfg).toEqual({
        searchModel: "claude-haiku-4-5",
        fetchModel: "anthropic/claude-haiku-4-5",
        fetchThinkingLevel: "medium",
      });
    });

    it("falls back to defaults on malformed JSON", () => {
      writeFileSync(configPath, "{not json");
      const cfg = loadConfig(configPath);
      expect(cfg.searchModel).toBe(DEFAULT_SEARCH_MODEL);
    });

    it("ignores non-string fields", () => {
      writeFileSync(
        configPath,
        JSON.stringify({ searchModel: 42, fetchModel: null, fetchThinkingLevel: false }),
      );
      const cfg = loadConfig(configPath);
      expect(cfg.searchModel).toBe(DEFAULT_SEARCH_MODEL);
      expect(cfg.fetchModel).toBeUndefined();
      expect(cfg.fetchThinkingLevel).toBeUndefined();
    });
  });

  describe("saveConfig", () => {
    it("writes a clean JSON file with only set fields", () => {
      saveConfig({ searchModel: "x" }, configPath);
      const raw = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed).toEqual({ searchModel: "x" });
      expect("fetchModel" in parsed).toBe(false);
      expect("fetchThinkingLevel" in parsed).toBe(false);
    });

    it("preserves all fields when set", () => {
      saveConfig(
        {
          searchModel: "x",
          fetchModel: "y/z",
          fetchThinkingLevel: "low",
        },
        configPath,
      );
      const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(parsed).toEqual({
        searchModel: "x",
        fetchModel: "y/z",
        fetchThinkingLevel: "low",
      });
    });

    it("creates parent directory if missing", () => {
      const nested = join(dir, "a", "b", "wierd-web.json");
      saveConfig({ searchModel: "x" }, nested);
      expect(existsSync(nested)).toBe(true);
    });
  });

  describe("loadOrInitConfig", () => {
    it("creates the file with env defaults on first run", () => {
      process.env.PI_WIERD_WEB_MODEL = "seeded-model";
      const cfg = loadOrInitConfig(configPath);
      expect(cfg.searchModel).toBe("seeded-model");
      expect(existsSync(configPath)).toBe(true);

      const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(parsed.searchModel).toBe("seeded-model");
    });

    it("does not overwrite an existing file", () => {
      writeFileSync(configPath, JSON.stringify({ searchModel: "preset" }));
      process.env.PI_WIERD_WEB_MODEL = "ignored";
      const cfg = loadOrInitConfig(configPath);
      expect(cfg.searchModel).toBe("preset");
    });
  });
});
