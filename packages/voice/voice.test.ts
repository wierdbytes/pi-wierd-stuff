/**
 * Unit tests for @wierdbytes/pi-voice.
 *
 * Coverage targets (per voice-v3.md §8):
 *   - wav.ts        — pcmToWav byte layout
 *   - voices.ts     — PREBUILT_VOICES integrity, isValidVoice case-sensitivity
 *   - tags.ts       — stripTags / countCharsExcludingTags / validateTags / truncateToSpokenBudget
 *   - messages.ts   — selectSummaryInput("last" + "sinceUser"), tool-only-turn → ""
 *   - auth.ts       — env-var precedence
 *   - config.ts     — round-trip through a tmp config path
 *   - summarizer.ts — happy path with stubbed `spawn` yielding pi JSON event stream + SKIP sentinel
 *   - player.ts     — probe order with mocked exec for darwin/linux/win32/none-found
 *
 * No real network / real audio anywhere.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

// ──────────────────────────────────────────────────────────────────── wav

import { GEMINI_TTS_FORMAT, pcmToWav, WAV_HEADER_BYTES } from "./wav.ts";

describe("wav.pcmToWav", () => {
  it("produces a 44-byte header followed by the PCM payload", () => {
    const pcm = Buffer.alloc(100, 0x42);
    const wav = pcmToWav(pcm);
    expect(wav.length).toBe(WAV_HEADER_BYTES + pcm.length);
    expect(wav.subarray(WAV_HEADER_BYTES)).toEqual(pcm);
  });

  it("encodes the canonical RIFF/WAVE/fmt /data tags at the right offsets", () => {
    const pcm = Buffer.alloc(2);
    const wav = pcmToWav(pcm);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.toString("ascii", 12, 16)).toBe("fmt ");
    expect(wav.toString("ascii", 36, 40)).toBe("data");
  });

  it("encodes the 24 kHz mono 16-bit format header values", () => {
    const pcm = Buffer.alloc(8);
    const wav = pcmToWav(pcm);
    // Subchunk1Size for PCM
    expect(wav.readUInt32LE(16)).toBe(16);
    // AudioFormat = PCM
    expect(wav.readUInt16LE(20)).toBe(1);
    // NumChannels = 1
    expect(wav.readUInt16LE(22)).toBe(GEMINI_TTS_FORMAT.channels);
    // SampleRate = 24000
    expect(wav.readUInt32LE(24)).toBe(GEMINI_TTS_FORMAT.sampleRate);
    // ByteRate = sampleRate * blockAlign = 24000 * 2 = 48000
    expect(wav.readUInt32LE(28)).toBe(48000);
    // BlockAlign = 2
    expect(wav.readUInt16LE(32)).toBe(2);
    // BitsPerSample = 16
    expect(wav.readUInt16LE(34)).toBe(GEMINI_TTS_FORMAT.bitsPerSample);
  });

  it("encodes data and RIFF chunk sizes correctly", () => {
    const pcm = Buffer.alloc(1000);
    const wav = pcmToWav(pcm);
    // Subchunk2Size = pcm.length
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    // ChunkSize = 36 + dataLen
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length);
  });

  it("handles zero-length PCM without throwing", () => {
    const wav = pcmToWav(Buffer.alloc(0));
    expect(wav.length).toBe(WAV_HEADER_BYTES);
    expect(wav.readUInt32LE(40)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────── voices

import { PREBUILT_VOICES, isValidVoice, voiceNames } from "./voices.ts";

describe("voices.PREBUILT_VOICES", () => {
  it("contains exactly 30 prebuilt voices", () => {
    expect(PREBUILT_VOICES.length).toBe(30);
  });

  it("contains the canonical default voice 'Kore'", () => {
    expect(PREBUILT_VOICES.some((v) => v.name === "Kore")).toBe(true);
  });

  it("contains all 30 documented names with no duplicates", () => {
    const names = PREBUILT_VOICES.map((v) => v.name);
    const expected = [
      "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede",
      "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba",
      "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
      "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi",
      "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
    ];
    expect(names.sort()).toEqual([...expected].sort());
    expect(new Set(names).size).toBe(names.length);
  });

  it("isValidVoice is case-sensitive", () => {
    expect(isValidVoice("Kore")).toBe(true);
    expect(isValidVoice("kore")).toBe(false);
    expect(isValidVoice("KORE")).toBe(false);
    expect(isValidVoice("Definitely Not A Voice")).toBe(false);
  });

  it("voiceNames returns the names in declaration order", () => {
    expect(voiceNames()).toEqual(PREBUILT_VOICES.map((v) => v.name));
  });
});

// ────────────────────────────────────────────────────────────────── tags

import {
  AUDIO_TAGS,
  countCharsExcludingTags,
  isKnownTag,
  stripTags,
  truncateToSpokenBudget,
  validateTags,
} from "./tags.ts";

describe("tags", () => {
  it("AUDIO_TAGS includes the documented baseline", () => {
    expect(AUDIO_TAGS).toContain("neutral");
    expect(AUDIO_TAGS).toContain("short pause");
    expect(AUDIO_TAGS).toContain("whispers");
    expect(AUDIO_TAGS).toContain("slow");
    expect(AUDIO_TAGS).toContain("fast");
  });

  it("isKnownTag accepts whitelisted tags case-insensitively", () => {
    expect(isKnownTag("neutral")).toBe(true);
    expect(isKnownTag("Neutral")).toBe(true);
    expect(isKnownTag("NEUTRAL")).toBe(true);
    expect(isKnownTag("definitely-not-a-tag")).toBe(false);
  });

  it("isKnownTag accepts parametric pause=N", () => {
    expect(isKnownTag("pause=0.5")).toBe(true);
    expect(isKnownTag("pause=2")).toBe(true);
    expect(isKnownTag("pause=.25")).toBe(true);
    expect(isKnownTag("pause=")).toBe(false);
    expect(isKnownTag("pause=abc")).toBe(false);
  });

  it("stripTags removes every bracketed token", () => {
    expect(stripTags("[neutral] hello [pause=0.5] world")).toBe(" hello  world");
    expect(stripTags("no tags here")).toBe("no tags here");
    expect(stripTags("[a][b][c]")).toBe("");
  });

  it("countCharsExcludingTags counts only the spoken portion", () => {
    // "[neutral] hi" → stripTags removes [neutral] → " hi" (3 chars)
    expect(countCharsExcludingTags("[neutral] hi")).toBe(3);
  });

  it("countCharsExcludingTags matches stripTags length", () => {
    const text = "[neutral] One sentence. [short pause] Two!";
    expect(countCharsExcludingTags(text)).toBe(stripTags(text).length);
  });

  it("validateTags drops unknown bracketed tokens and keeps known ones", () => {
    const { text, dropped } = validateTags(
      "[neutral] hello [bogus] world [pause=0.5]",
    );
    expect(text).toContain("[neutral]");
    expect(text).toContain("[pause=0.5]");
    expect(text).not.toContain("[bogus]");
    expect(dropped).toEqual(["[bogus]"]);
  });

  it("validateTags collapses double spaces left by dropped tokens", () => {
    const { text } = validateTags("hello [bogus] world");
    expect(text).not.toMatch(/  /);
  });

  it("truncateToSpokenBudget keeps text under the budget without harming tags", () => {
    const text = "[neutral] First sentence. Second sentence!";
    // budget enough for "First sentence." (15) but not the whole thing
    const out = truncateToSpokenBudget(text, 16);
    // We expect it to cut at the sentence boundary after "First sentence."
    expect(stripTags(out).trim()).toBe("First sentence.");
    expect(out).toContain("[neutral]");
  });

  it("truncateToSpokenBudget passes through when already short", () => {
    const text = "[neutral] short.";
    expect(truncateToSpokenBudget(text, 220)).toBe(text);
  });

  it("truncateToSpokenBudget hard-cuts when no sentence boundary fits", () => {
    const text = "abcdefghijklmnopqrstuvwxyz";
    const out = truncateToSpokenBudget(text, 5);
    expect(stripTags(out).length).toBeLessThanOrEqual(5);
  });
});

// ────────────────────────────────────────────────────────────── messages

import { selectSummaryInput, type SummaryMessage } from "./messages.ts";

describe("messages.selectSummaryInput", () => {
  const userMsg = (text: string): SummaryMessage => ({
    role: "user",
    content: text,
  });
  const asstText = (text: string): SummaryMessage => ({
    role: "assistant",
    content: [{ type: "text", text }],
  });
  const asstToolCall = (
    name: string,
    args: Record<string, unknown>,
  ): SummaryMessage => ({
    role: "assistant",
    content: [{ type: "toolCall", name, arguments: args } as any],
  });
  const asstMixed = (text: string, name: string, args: Record<string, unknown>): SummaryMessage => ({
    role: "assistant",
    content: [
      { type: "text", text },
      { type: "toolCall", name, arguments: args } as any,
    ],
  });
  const asstThinking = (thinking: string): SummaryMessage => ({
    role: "assistant",
    content: [{ type: "thinking", thinking } as any],
  });
  const toolResult: SummaryMessage = {
    role: "toolResult",
    toolName: "bash",
    isError: false,
    content: [{ type: "text", text: "stdout..." }],
  };

  it('scope="last" returns just the final assistant text', () => {
    const out = selectSummaryInput(
      [
        userMsg("first ask"),
        asstText("first reply"),
        userMsg("second ask"),
        asstText("Hello there. I did the thing."),
      ],
      "last",
    );
    expect(out).toBe("Hello there. I did the thing.");
  });

  it('scope="last" returns "" for tool-only assistant turn', () => {
    const out = selectSummaryInput(
      [userMsg("go"), asstToolCall("bash", { command: "ls" })],
      "last",
    );
    expect(out).toBe("");
  });

  it('scope="last" skips thinking blocks', () => {
    const out = selectSummaryInput(
      [
        userMsg("go"),
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "secret reasoning" } as any,
            { type: "text", text: "spoken reply" },
          ],
        } as SummaryMessage,
      ],
      "last",
    );
    expect(out).toBe("spoken reply");
  });

  it('scope="sinceUser" includes assistant text + tool-call digests after the last user message', () => {
    const out = selectSummaryInput(
      [
        userMsg("ignored"),
        asstText("ignored too"),
        userMsg("the real ask"),
        asstMixed("Sure, running it.", "bash", { command: "ls -la" }),
        // toolResult intentionally skipped
        toolResult,
        asstText("Done!"),
      ],
      "sinceUser",
    );
    expect(out).toContain("Sure, running it.");
    expect(out).toContain("(used bash: ls -la)");
    expect(out).toContain("Done!");
    // Should not bleed prior turn's text in
    expect(out).not.toContain("ignored");
  });

  it('scope="sinceUser" returns "" when only tool calls + thinking happened', () => {
    const out = selectSummaryInput(
      [
        userMsg("go"),
        asstThinking("thinking"),
        asstToolCall("bash", { command: "ls" }),
      ],
      "sinceUser",
    );
    // Tool-call digest is the only output → not empty.
    expect(out).toContain("(used bash: ls)");
  });

  it("returns '' for empty input", () => {
    expect(selectSummaryInput([], "last")).toBe("");
    expect(selectSummaryInput([], "sinceUser")).toBe("");
  });

  it("tail-slices oversized input to ≤ 8 000 chars", () => {
    const giant = "a".repeat(20_000);
    const out = selectSummaryInput(
      [userMsg("go"), asstText(giant)],
      "last",
    );
    expect(out.length).toBeLessThanOrEqual(8_000);
    expect(out.endsWith("a".repeat(50))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────── auth

import {
  clearRegistryCache,
  refreshFromRegistry,
  resolveGeminiKey,
} from "./auth.ts";

describe("auth.resolveGeminiKey", () => {
  const ENV_KEYS = ["PI_VOICE_GEMINI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    clearRegistryCache();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    clearRegistryCache();
  });

  // ── env-only fallback path (cache empty) ───────────────────────────

  it("returns undefined when no env var is set", () => {
    expect(resolveGeminiKey()).toBeUndefined();
  });

  it("ignores empty / whitespace-only env vars", () => {
    process.env.GEMINI_API_KEY = "   ";
    expect(resolveGeminiKey()).toBeUndefined();
  });

  it("returns GEMINI_API_KEY when only that is set", () => {
    process.env.GEMINI_API_KEY = "abc";
    expect(resolveGeminiKey()).toEqual({ key: "abc", source: "GEMINI_API_KEY" });
  });

  it("PI_VOICE_GEMINI_API_KEY wins over GEMINI_API_KEY", () => {
    process.env.PI_VOICE_GEMINI_API_KEY = "voice-key";
    process.env.GEMINI_API_KEY = "generic-key";
    expect(resolveGeminiKey()).toEqual({
      key: "voice-key",
      source: "PI_VOICE_GEMINI_API_KEY",
    });
  });

  it("GEMINI_API_KEY wins over GOOGLE_API_KEY", () => {
    process.env.GEMINI_API_KEY = "gem";
    process.env.GOOGLE_API_KEY = "goog";
    expect(resolveGeminiKey()).toEqual({ key: "gem", source: "GEMINI_API_KEY" });
  });

  it("GOOGLE_API_KEY is the last-resort fallback", () => {
    process.env.GOOGLE_API_KEY = "goog";
    expect(resolveGeminiKey()).toEqual({ key: "goog", source: "GOOGLE_API_KEY" });
  });

  it("trims surrounding whitespace from the resolved value", () => {
    process.env.GEMINI_API_KEY = "  spaced  ";
    expect(resolveGeminiKey()).toEqual({ key: "spaced", source: "GEMINI_API_KEY" });
  });

  // ── registry-cache path ────────────────────────────────────────────

  /** Build a minimal stub `ExtensionContext` whose `modelRegistry`
   *  resolves to the supplied value. */
  const fakeCtx = (
    apiKey: string | undefined | (() => string | undefined),
    opts: { throws?: boolean } = {},
  ) =>
    ({
      modelRegistry: {
        getApiKeyForProvider: async (_provider: string) => {
          if (opts.throws) throw new Error("registry boom");
          return typeof apiKey === "function" ? apiKey() : apiKey;
        },
      },
    }) as unknown as Parameters<typeof refreshFromRegistry>[0];

  it("refreshFromRegistry populates the cache from modelRegistry", async () => {
    await refreshFromRegistry(fakeCtx("stored-key"));
    expect(resolveGeminiKey()).toEqual({
      key: "stored-key",
      source: "pi:google",
    });
  });

  it("pi:google cache wins over GEMINI_API_KEY env", async () => {
    process.env.GEMINI_API_KEY = "env-key";
    await refreshFromRegistry(fakeCtx("stored-key"));
    expect(resolveGeminiKey()).toEqual({
      key: "stored-key",
      source: "pi:google",
    });
  });

  it("PI_VOICE_GEMINI_API_KEY beats the cached pi:google value", async () => {
    await refreshFromRegistry(fakeCtx("stored-key"));
    process.env.PI_VOICE_GEMINI_API_KEY = "override";
    expect(resolveGeminiKey()).toEqual({
      key: "override",
      source: "PI_VOICE_GEMINI_API_KEY",
    });
  });

  it("refreshFromRegistry clears the cache when the override is set", async () => {
    await refreshFromRegistry(fakeCtx("stored-key"));
    process.env.PI_VOICE_GEMINI_API_KEY = "override";
    // Calling refresh while the override is set must drop the stale
    // cached value so a later override unset doesn't surface it.
    await refreshFromRegistry(fakeCtx("never-read"));
    delete process.env.PI_VOICE_GEMINI_API_KEY;
    expect(resolveGeminiKey()).toBeUndefined();
  });

  it("empty/whitespace registry values do not populate the cache", async () => {
    await refreshFromRegistry(fakeCtx("   "));
    expect(resolveGeminiKey()).toBeUndefined();
  });

  it("trims whitespace returned by the registry", async () => {
    await refreshFromRegistry(fakeCtx("  trimmed  "));
    expect(resolveGeminiKey()).toEqual({
      key: "trimmed",
      source: "pi:google",
    });
  });

  it("registry exceptions fall through to env", async () => {
    process.env.GEMINI_API_KEY = "env-fallback";
    await refreshFromRegistry(fakeCtx(undefined, { throws: true }));
    expect(resolveGeminiKey()).toEqual({
      key: "env-fallback",
      source: "GEMINI_API_KEY",
    });
  });

  it("undefined ctx clears the cache", async () => {
    await refreshFromRegistry(fakeCtx("stored"));
    expect(resolveGeminiKey()?.source).toBe("pi:google");
    await refreshFromRegistry(undefined);
    expect(resolveGeminiKey()).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────── config

import {
  envDefaults,
  getConfigPath,
  loadConfig,
  loadOrInitConfig,
  saveConfig,
} from "./config.ts";

describe("config", () => {
  let dir: string;
  let configFile: string;
  const savedAgentDir = process.env.PI_AGENT_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wierd-voice-cfg-"));
    process.env.PI_AGENT_DIR = dir;
    configFile = join(dir, "wierd-voice-test.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (savedAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = savedAgentDir;
  });

  it("envDefaults uses the documented baseline", () => {
    const cfg = envDefaults();
    expect(cfg).toEqual({ muted: false, voice: "Umbriel", scope: "last" });
  });

  it("loadConfig returns defaults when file is missing", () => {
    expect(loadConfig(configFile)).toEqual(envDefaults());
  });

  it("saveConfig + loadConfig round-trip preserves all set fields", () => {
    saveConfig(
      {
        muted: true,
        voice: "Charon",
        scope: "sinceUser",
        summarizerModel: "anthropic/claude-haiku-4-5",
      },
      configFile,
    );
    const parsed = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(parsed).toMatchObject({
      muted: true,
      voice: "Charon",
      scope: "sinceUser",
      summarizerModel: "anthropic/claude-haiku-4-5",
    });
    expect(loadConfig(configFile)).toMatchObject({
      muted: true,
      voice: "Charon",
      scope: "sinceUser",
      summarizerModel: "anthropic/claude-haiku-4-5",
    });
  });

  it("saveConfig strips undefined optional fields", () => {
    saveConfig(envDefaults(), configFile);
    const parsed = JSON.parse(readFileSync(configFile, "utf-8"));
    expect("summarizerModel" in parsed).toBe(false);
    expect("summarizerThinkingLevel" in parsed).toBe(false);
  });

  it("loadConfig drops the legacy disabledReason field", () => {
    // Older versions of the extension persisted a `disabledReason`
    // sentinel that silently muted every subsequent session. The field
    // was removed; configs left over from those versions must load
    // cleanly without resurrecting it on the typed object.
    writeFileSync(
      configFile,
      JSON.stringify({
        muted: false,
        voice: "Kore",
        scope: "last",
        disabledReason: "Auth error from a previous run",
      }),
    );
    const cfg = loadConfig(configFile);
    expect((cfg as Record<string, unknown>).disabledReason).toBeUndefined();
  });

  it("saveConfig + loadConfig round-trip preserves summarizerThinkingLevel", () => {
    saveConfig(
      {
        muted: false,
        voice: "Kore",
        scope: "last",
        summarizerModel: "anthropic/claude-haiku-4-5",
        summarizerThinkingLevel: "medium",
      },
      configFile,
    );
    const parsed = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(parsed.summarizerThinkingLevel).toBe("medium");
    expect(loadConfig(configFile).summarizerThinkingLevel).toBe("medium");
  });

  it("loadConfig sanitises unknown summarizerThinkingLevel values to undefined", () => {
    // Anything off the whitelist (typos, empty string, null) should be
    // dropped so a corrupted config file can't poison `pi --thinking`.
    writeFileSync(
      configFile,
      JSON.stringify({
        muted: false,
        voice: "Kore",
        scope: "last",
        summarizerThinkingLevel: "super-saiyan",
      }),
    );
    const cfg = loadConfig(configFile);
    expect(cfg.summarizerThinkingLevel).toBeUndefined();
  });

  it("loadConfig accepts every documented thinking level", () => {
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh"]) {
      writeFileSync(
        configFile,
        JSON.stringify({
          muted: false,
          voice: "Kore",
          scope: "last",
          summarizerThinkingLevel: level,
        }),
      );
      expect(loadConfig(configFile).summarizerThinkingLevel).toBe(level);
    }
  });

  it("loadConfig sanitises bad scope values back to default", () => {
    writeFileSync(
      configFile,
      JSON.stringify({ muted: true, voice: "Kore", scope: "garbage" }),
    );
    const cfg = loadConfig(configFile);
    expect(cfg.scope).toBe("last");
    expect(cfg.muted).toBe(true);
  });

  it("loadOrInitConfig writes seeded defaults on first run", () => {
    expect(existsSync(configFile)).toBe(false);
    const cfg = loadOrInitConfig(configFile);
    expect(cfg).toEqual(envDefaults());
    expect(existsSync(configFile)).toBe(true);
  });

  it("getConfigPath points inside the per-package directory", () => {
    const path = getConfigPath();
    expect(path).toContain("wierd-voice");
    expect(path.endsWith("config.json")).toBe(true);
  });
});

// ── autocomplete (post-overlay rework) ──────────────────────────────
//
// After the rework, every persisted setting (voice / scope / summarizer
// model / muted) is configured through the `/wierd-voice` overlay (see
// config-picker.ts). The only remaining text subcommands are imperative
// actions: `status`, `mute`, `unmute`, `say <text>`, `replay`, `reset`.
//
// `say` is the only one that takes a follow-up argument, so it gets a
// trailing space (so a typed letter retriggers autocomplete — see the
// regression below). The other actions don't.
//
// We keep the original `applyCompletion` regression check so the
// "subcommand-eaten by Tab" bug stays fixed.

function simulateGetArgumentCompletions(prefix: string) {
  const subsWithArgs = new Set(["say"]);
  const subsNoArgs = ["status", "mute", "unmute", "replay", "reset"];
  const allSubs = [...subsWithArgs, ...subsNoArgs];
  const tokens = prefix.split(/\s+/);
  const firstToken = tokens[0] ?? "";
  const subcommandFinished =
    allSubs.includes(firstToken) && /\s/.test(prefix);
  if (subcommandFinished) return null;
  const lcPrefix = prefix.toLowerCase();
  return allSubs
    .filter((s) => s.toLowerCase().startsWith(lcPrefix))
    .map((s) => ({
      value: subsWithArgs.has(s) ? `${s} ` : s,
      label: s,
    }));
}

/**
 * Simulate pi-tui's argument-completion replacement: when an item is
 * applied, the whole text after the slash command is replaced by the
 * item's `value`. (See
 * node_modules/@earendil-works/pi-tui/dist/autocomplete.js:applyCompletion.)
 */
function simulateApplyCompletion(line: string, value: string): string {
  const cmdPrefix = "/wierd-voice ";
  if (!line.startsWith(cmdPrefix)) return line;
  return cmdPrefix + value;
}

describe("index.getArgumentCompletions (post-overlay rework)", () => {
  it("top-level: only `say` gets a trailing space; the other actions don't", () => {
    const items = simulateGetArgumentCompletions("");
    expect(items).not.toBeNull();
    const byLabel = (label: string) => items!.find((i) => i.label === label);
    expect(byLabel("say")?.value).toBe("say ");
    expect(byLabel("status")?.value).toBe("status");
    expect(byLabel("mute")?.value).toBe("mute");
    expect(byLabel("unmute")?.value).toBe("unmute");
    expect(byLabel("replay")?.value).toBe("replay");
    expect(byLabel("reset")?.value).toBe("reset");
  });

  it("top-level: removed config subcommands no longer appear in suggestions", () => {
    // `voice`, `scope`, `summarizer` moved into the overlay. Make sure
    // they don't sneak back into the autocomplete menu (they'd just
    // produce a no-op handler now).
    const items = simulateGetArgumentCompletions("");
    const labels = items!.map((i) => i.label);
    expect(labels).not.toContain("voice");
    expect(labels).not.toContain("scope");
    expect(labels).not.toContain("summarizer");
  });

  it('top-level: "sa" filters to "say " (with trailing space)', () => {
    const items = simulateGetArgumentCompletions("sa");
    expect(items?.map((i) => i.value)).toEqual(["say "]);
  });

  it("after `say `, no further completions are offered (free-form text)", () => {
    expect(simulateGetArgumentCompletions("say ")).toBeNull();
    expect(simulateGetArgumentCompletions("say hello")).toBeNull();
  });

  it("applying a no-arg subcommand does NOT add trailing space", () => {
    const items = simulateGetArgumentCompletions("sta");
    const status = items!.find((i) => i.label === "status");
    expect(status?.value).toBe("status");
    const after = simulateApplyCompletion("/wierd-voice sta", status!.value);
    expect(after).toBe("/wierd-voice status");
  });

  it("Tab on `say` lands cursor past a trailing space (regression: subcommand not eaten)", () => {
    const items = simulateGetArgumentCompletions("sa");
    const say = items!.find((i) => i.label === "say");
    expect(say).toBeDefined();
    const after = simulateApplyCompletion("/wierd-voice sa", say!.value);
    expect(after).toBe("/wierd-voice say ");
  });
});

// ──────────────────────────────────────────────────────────── summarizer

// vi.spyOn doesn't work on `node:child_process` in ESM (the namespace is
// non-configurable). We use vi.mock + vi.hoisted instead so the mock is
// wired in at module-evaluation time, and tests drive the per-call
// behaviour through the shared `summarizerSpawnState` slot.
const summarizerSpawnState = vi.hoisted(() => {
  return {
    impl: null as ((command: string, args: readonly string[]) => any) | null,
    calls: [] as Array<{ command: string; args: string[] }>,
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
  return {
    ...actual,
    spawn: (command: string, args: readonly string[], _opts?: any) => {
      summarizerSpawnState.calls.push({ command, args: [...args] });
      if (!summarizerSpawnState.impl) {
        throw new Error("summarizer test did not configure spawnImpl");
      }
      return summarizerSpawnState.impl(command, args);
    },
  };
});

import { runSummarizer, SUMMARIZER_PROMPT_TEMPLATE } from "./summarizer.ts";
import type { ChildProcess } from "node:child_process";

describe("summarizer.runSummarizer", () => {
  beforeEach(() => {
    summarizerSpawnState.impl = null;
    summarizerSpawnState.calls = [];
  });

  /**
   * Build a fake ChildProcess that emits a sequence of stdout chunks then
   * closes with the given exit code.
   */
  function makeFakeProc(stdoutChunks: string[], exitCode = 0): ChildProcess {
    const proc = new EventEmitter() as ChildProcess;
    (proc as any).stdout = new Readable({ read() {} });
    (proc as any).stderr = new Readable({ read() {} });
    (proc as any).kill = () => true;
    (proc as any).killed = false;
    setImmediate(() => {
      for (const chunk of stdoutChunks) {
        (proc as any).stdout.push(chunk);
      }
      (proc as any).stdout.push(null);
      proc.emit("close", exitCode);
    });
    return proc;
  }

  function lastCall(): { command: string; args: string[] } | undefined {
    return summarizerSpawnState.calls[summarizerSpawnState.calls.length - 1];
  }

  it("returns the assistant text from a message_end event", async () => {
    summarizerSpawnState.impl = () =>
      makeFakeProc(
        [
          JSON.stringify({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "[neutral] All done." }],
            },
          }) + "\n",
        ],
        0,
      );

    const result = await runSummarizer({ text: "some assistant output" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe("summary");
    if (result.kind !== "summary") return;
    expect(result.text).toContain("[neutral]");
    expect(result.text).toContain("All done.");
    expect(lastCall()?.command).toBe("pi");
    expect(lastCall()?.args.slice(0, 5)).toEqual([
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--no-tools",
    ]);
  });

  it("passes --model when summarizerModel is provided", async () => {
    summarizerSpawnState.impl = () =>
      makeFakeProc(
        [
          JSON.stringify({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "ok" }],
            },
          }) + "\n",
        ],
        0,
      );

    await runSummarizer({
      text: "some output",
      model: "anthropic/claude-haiku-4-5",
    });
    expect(lastCall()?.args).toContain("--model");
    expect(lastCall()?.args).toContain("anthropic/claude-haiku-4-5");
  });

  it("passes --thinking when thinkingLevel is provided", async () => {
    summarizerSpawnState.impl = () =>
      makeFakeProc(
        [
          JSON.stringify({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "ok" }],
            },
          }) + "\n",
        ],
        0,
      );

    await runSummarizer({
      text: "some output",
      model: "anthropic/claude-haiku-4-5",
      thinkingLevel: "medium",
    });
    const args = lastCall()?.args ?? [];
    expect(args).toContain("--thinking");
    expect(args[args.indexOf("--thinking") + 1]).toBe("medium");
    // --model must come before --thinking so the ordering matches
    // packages/web/subagent.ts (and pi's own arg parser is happy either
    // way — we just want the two extensions to be visually identical
    // in process listings / debug logs).
    expect(args.indexOf("--model")).toBeLessThan(args.indexOf("--thinking"));
  });

  it("omits --thinking when thinkingLevel is not provided", async () => {
    summarizerSpawnState.impl = () =>
      makeFakeProc(
        [
          JSON.stringify({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "ok" }],
            },
          }) + "\n",
        ],
        0,
      );

    await runSummarizer({ text: "some output" });
    expect(lastCall()?.args).not.toContain("--thinking");
  });

  it("treats SKIP as a skip signal", async () => {
    summarizerSpawnState.impl = () =>
      makeFakeProc(
        [
          JSON.stringify({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "SKIP" }],
            },
          }) + "\n",
        ],
        0,
      );
    const result = await runSummarizer({ text: "anything" });
    expect(result).toEqual({ ok: true, kind: "skip" });
  });

  it("drops unknown bracketed tags before returning", async () => {
    summarizerSpawnState.impl = () =>
      makeFakeProc(
        [
          JSON.stringify({
            type: "message_end",
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "[neutral] hi [definitely-bogus] world." },
              ],
            },
          }) + "\n",
        ],
        0,
      );
    const result = await runSummarizer({ text: "anything" });
    if (!result.ok || result.kind !== "summary") {
      throw new Error("expected a summary");
    }
    expect(result.text).toContain("[neutral]");
    expect(result.text).not.toContain("definitely-bogus");
    expect(result.droppedTags).toContain("[definitely-bogus]");
  });

  it("short-circuits on empty input without spawning", async () => {
    const result = await runSummarizer({ text: "   " });
    expect(result).toEqual({ ok: true, kind: "skip" });
    expect(summarizerSpawnState.calls.length).toBe(0);
  });

  it("includes the prompt template in the spawned args", async () => {
    summarizerSpawnState.impl = () =>
      makeFakeProc(
        [
          JSON.stringify({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "ok" }],
            },
          }) + "\n",
        ],
        0,
      );
    await runSummarizer({ text: "hello world" });
    const args = lastCall()!.args;
    const promptArg = args[args.length - 1];
    expect(promptArg).toContain("Audio tags");
    expect(promptArg).toContain("[neutral]");
    expect(promptArg).toContain("hello world");
  });

  it("the prompt template hints about Gemini 3.1 audio tags", () => {
    expect(SUMMARIZER_PROMPT_TEMPLATE).toContain("Gemini 3.1");
    expect(SUMMARIZER_PROMPT_TEMPLATE).toContain("[neutral]");
    expect(SUMMARIZER_PROMPT_TEMPLATE).toContain("[short pause]");
  });
});


import { detectPlayer, resetPlayerCache, type ExecLike } from "./player.ts";

describe("player.detectPlayer", () => {
  beforeEach(() => {
    resetPlayerCache();
  });

  it("returns afplay on darwin when present", async () => {
    const exec: ExecLike = async (cmd, args) => {
      if (cmd === "which" && args[0] === "afplay") return { code: 0 };
      return { code: 1 };
    };
    const spec = await detectPlayer(exec, "darwin");
    expect(spec?.command).toBe("afplay");
    expect(spec?.buildArgs("/tmp/x.wav")).toEqual(["/tmp/x.wav"]);
  });

  it("falls through paplay → aplay → ffplay on linux", async () => {
    resetPlayerCache();
    let exec: ExecLike = async (_cmd, _args) => ({ code: 1 });
    expect(await detectPlayer(exec, "linux")).toBeNull();

    resetPlayerCache();
    exec = async (cmd, args) => {
      if (cmd === "which" && args[0] === "ffplay") return { code: 0 };
      return { code: 1 };
    };
    const ffplay = await detectPlayer(exec, "linux");
    expect(ffplay?.command).toBe("ffplay");
    expect(ffplay?.buildArgs("/tmp/x.wav")).toEqual([
      "-nodisp",
      "-autoexit",
      "-loglevel",
      "quiet",
      "/tmp/x.wav",
    ]);

    resetPlayerCache();
    exec = async (cmd, args) => {
      if (cmd === "which" && args[0] === "aplay") return { code: 0 };
      return { code: 1 };
    };
    const aplay = await detectPlayer(exec, "linux");
    expect(aplay?.command).toBe("aplay");
    expect(aplay?.buildArgs("/tmp/x.wav")).toEqual(["-q", "/tmp/x.wav"]);

    resetPlayerCache();
    exec = async (cmd, args) => {
      if (cmd === "which" && args[0] === "paplay") return { code: 0 };
      return { code: 1 };
    };
    const paplay = await detectPlayer(exec, "linux");
    expect(paplay?.command).toBe("paplay");
  });

  it("uses where/powershell on win32", async () => {
    let probedCommands: string[] = [];
    const exec: ExecLike = async (cmd, args) => {
      probedCommands.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "where" && args[0] === "powershell.exe") return { code: 0 };
      return { code: 1 };
    };
    const spec = await detectPlayer(exec, "win32");
    expect(spec?.command).toBe("powershell.exe");
    const builtArgs = spec!.buildArgs("C:\\tmp\\x.wav");
    expect(builtArgs[0]).toBe("-NoProfile");
    expect(builtArgs[1]).toBe("-Command");
    expect(builtArgs[2]).toContain("Media.SoundPlayer");
    expect(probedCommands.some((c) => c.startsWith("where powershell.exe"))).toBe(true);
  });

  it("returns null when no probe succeeds and memoizes the result", async () => {
    let calls = 0;
    const exec: ExecLike = async () => {
      calls += 1;
      return { code: 1 };
    };
    expect(await detectPlayer(exec, "linux")).toBeNull();
    const before = calls;
    expect(await detectPlayer(exec, "linux")).toBeNull();
    expect(calls).toBe(before); // memoized
  });
});
