import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { Autonamer, ENTRY_TYPE, MAX_FAILURES, type AutonameEntry } from "./autoname.ts";
import { type AutonameConfig, defaults } from "./config.ts";
import type { GenerateOptions, GenerateResult } from "./generator.ts";
import { KEEP } from "./prompt.ts";

const user = (text: string) => ({ type: "message", message: { role: "user", content: text } });

function harness(opts: { config?: Partial<AutonameConfig>; entries?: unknown[]; sessionName?: string; sessionFile?: string | null; answers?: GenerateResult[] } = {}) {
  let config: AutonameConfig = { ...defaults(), ...opts.config };
  const entries: unknown[] = [...(opts.entries ?? [user("fix the login bug")])];
  let sessionName = opts.sessionName;
  const titles: string[] = [];
  const toasts: string[] = [];
  const answers = [...(opts.answers ?? [{ ok: true, name: "Login bug fix" } as GenerateResult])];
  const calls: GenerateOptions[] = [];
  let namer: Autonamer;

  const ctx = {
    hasUI: true,
    cwd: "/Users/me/dev",
    ui: { setTitle: (t: string) => titles.push(t) },
    sessionManager: {
      getBranch: () => entries,
      getSessionFile: () => (opts.sessionFile === null ? undefined : (opts.sessionFile ?? "/s.jsonl")),
    },
  } as unknown as ExtensionContext;

  const setSessionName = vi.fn((name: string) => {
    sessionName = name;
    namer.onNameChanged(ctx, name); // pi echoes session_info_changed
  });

  namer = new Autonamer({
    config: () => config,
    getSessionName: () => sessionName,
    setSessionName,
    appendEntry: (customType: string, data: AutonameEntry) => entries.push({ type: "custom", customType, data }),
    toast: (_level, message) => toasts.push(message),
    resolveModel: () => ({ ok: true, model: {} as never, label: "m/x" }),
    generate: async (_ctx, o) => {
      calls.push(o);
      return answers.shift() ?? { ok: true, name: KEEP };
    },
    schedule: () => {},
  });

  return {
    ctx,
    namer,
    titles,
    toasts,
    calls,
    entries,
    setSessionName,
    get sessionName() {
      return sessionName;
    },
    rename(name: string | undefined) {
      sessionName = name;
      namer.onNameChanged(ctx, name);
    },
    setConfig(c: Partial<AutonameConfig>) {
      config = { ...config, ...c };
      namer.onConfigChanged(ctx);
    },
  };
}

describe("Autonamer", () => {
  it("names session and title after the first turn, then stays put in first mode", async () => {
    const h = harness();
    h.namer.reset(h.ctx);
    await h.namer.onSettled(h.ctx);
    expect(h.sessionName).toBe("Login bug fix");
    expect(h.titles.at(-1)).toBe("Login bug fix");
    expect(h.entries.at(-1)).toEqual({ type: "custom", customType: ENTRY_TYPE, data: { name: "Login bug fix" } });
    expect(h.namer.status()).toMatchObject({ source: "auto", locked: false });

    await h.namer.onSettled(h.ctx);
    expect(h.calls).toHaveLength(1);
  });

  it("names an unnamed session from the prompt alone, before the reply", async () => {
    const h = harness({ entries: [], config: { mode: "auto" } });
    h.namer.reset(h.ctx);
    await h.namer.onPrompt(h.ctx, "fix the login bug");
    expect(h.calls[0].input).toEqual({ first: "fix the login bug", recent: [], assistant: "" });
    expect(h.calls[0].current).toBeUndefined();
    expect(h.sessionName).toBe("Login bug fix");
    await h.namer.onPrompt(h.ctx, "next prompt");
    expect(h.calls).toHaveLength(1);
  });

  it("title-only target leaves the session name alone", async () => {
    const h = harness({ config: { target: "title", titleTemplate: "{name} · {cwd}" } });
    h.namer.reset(h.ctx);
    await h.namer.onSettled(h.ctx);
    expect(h.setSessionName).not.toHaveBeenCalled();
    expect(h.titles.at(-1)).toBe("Login bug fix · dev");
  });

  it("session-only target never touches the title", async () => {
    const h = harness({ config: { target: "session" } });
    h.namer.reset(h.ctx);
    await h.namer.onSettled(h.ctx);
    expect(h.sessionName).toBe("Login bug fix");
    expect(h.titles).toEqual([]);
  });

  it("a manual name locks auto-naming and the title mirrors it", async () => {
    const h = harness({ config: { mode: "follow" } });
    h.namer.reset(h.ctx);
    await h.namer.onSettled(h.ctx);
    h.rename("My own name");
    expect(h.titles.at(-1)).toBe("My own name");
    await h.namer.onSettled(h.ctx);
    expect(h.calls).toHaveLength(1);
    expect(h.namer.status()).toMatchObject({ source: "manual", locked: true });

    h.rename(undefined); // cleared → unlocked
    await h.namer.onSettled(h.ctx);
    expect(h.calls).toHaveLength(2);
  });

  it("a name the user typed while the model was busy wins", async () => {
    let release!: (r: GenerateResult) => void;
    const h = harness();
    (h.namer as unknown as { deps: { generate: unknown } }).deps.generate = () => new Promise<GenerateResult>((r) => (release = r));
    h.namer.reset(h.ctx);
    const pending = h.namer.onSettled(h.ctx);
    h.rename("Typed by hand");
    release({ ok: true, name: "Model name" });
    await pending;
    expect(h.sessionName).toBe("Typed by hand");
  });

  it("resume: our own name keeps following, a foreign one is locked", () => {
    const ours = harness({ sessionName: "Auto", entries: [user("x"), { type: "custom", customType: ENTRY_TYPE, data: { name: "Auto" } }] });
    ours.namer.reset(ours.ctx);
    expect(ours.namer.status()).toMatchObject({ name: "Auto", source: "auto", locked: false });
    expect(ours.titles.at(-1)).toBe("Auto");

    const theirs = harness({ sessionName: "Manual", entries: [user("x"), { type: "custom", customType: ENTRY_TYPE, data: { name: "Auto" } }] });
    theirs.namer.reset(theirs.ctx);
    expect(theirs.namer.status()).toMatchObject({ name: "Manual", locked: true });
  });

  it("auto mode passes the current name and respects KEEP", async () => {
    const h = harness({ config: { mode: "auto" }, answers: [{ ok: true, name: "First" }, { ok: true, name: KEEP }, { ok: true, name: "Second" }] });
    h.namer.reset(h.ctx);
    await h.namer.onSettled(h.ctx);
    await h.namer.onSettled(h.ctx);
    expect(h.calls[1].current).toBe("First");
    expect(h.sessionName).toBe("First");
    await h.namer.onSettled(h.ctx);
    expect(h.sessionName).toBe("Second");
  });

  it("follow mode regenerates without a KEEP option", async () => {
    const h = harness({ config: { mode: "follow" }, answers: [{ ok: true, name: "A" }, { ok: true, name: "B" }] });
    h.namer.reset(h.ctx);
    await h.namer.onSettled(h.ctx);
    await h.namer.onSettled(h.ctx);
    expect(h.calls[1].current).toBeUndefined();
    expect(h.sessionName).toBe("B");
  });

  it("falls back to the prompt, retries with the model, gives up after repeated failures", async () => {
    const fail: GenerateResult = { ok: false, error: "boom" };
    const h = harness({ answers: Array.from({ length: MAX_FAILURES }, () => fail) });
    h.namer.reset(h.ctx);
    await h.namer.onSettled(h.ctx);
    expect(h.sessionName).toBe("Fix the login bug");
    expect(h.namer.status().source).toBe("fallback");
    for (let i = 1; i < MAX_FAILURES; i++) await h.namer.onSettled(h.ctx);
    expect(h.calls).toHaveLength(MAX_FAILURES);
    expect(h.namer.status().gaveUp).toBe(true);
    expect(h.toasts.at(-1)).toContain("gave up");
    await h.namer.onSettled(h.ctx);
    expect(h.calls).toHaveLength(MAX_FAILURES);

    (h.namer as unknown as { deps: { generate: unknown } }).deps.generate = async () => ({ ok: true, name: "Recovered" });
    await h.namer.regenerate(h.ctx);
    expect(h.sessionName).toBe("Recovered");
  });

  it("no fallback when disabled", async () => {
    const h = harness({ config: { fallback: false }, answers: [{ ok: false, error: "boom" }] });
    h.namer.reset(h.ctx);
    await h.namer.onSettled(h.ctx);
    expect(h.sessionName).toBeUndefined();
  });

  it("regen overrides a manual lock", async () => {
    const h = harness({ sessionName: "Manual" });
    h.namer.reset(h.ctx);
    await h.namer.regenerate(h.ctx);
    expect(h.sessionName).toBe("Login bug fix");
    expect(h.namer.status().locked).toBe(false);
  });

  it("disabling restores pi's own title", async () => {
    const h = harness();
    h.namer.reset(h.ctx);
    await h.namer.onSettled(h.ctx);
    h.setConfig({ enabled: false });
    expect(h.titles.at(-1)).toBe("π - Login bug fix - dev");
  });

  it("switching title → both pushes the name into the session", async () => {
    const h = harness({ config: { target: "title" } });
    h.namer.reset(h.ctx);
    await h.namer.onSettled(h.ctx);
    expect(h.sessionName).toBeUndefined();
    h.setConfig({ target: "both" });
    expect(h.sessionName).toBe("Login bug fix");
  });

  it("ephemeral sessions only get a title", async () => {
    const h = harness({ sessionFile: null });
    h.namer.reset(h.ctx);
    await h.namer.onSettled(h.ctx);
    expect(h.setSessionName).not.toHaveBeenCalled();
    expect(h.titles.at(-1)).toBe("Login bug fix");
  });

  it("ignores results that land after the session was replaced", async () => {
    let release!: (r: GenerateResult) => void;
    const h = harness();
    (h.namer as unknown as { deps: { generate: unknown } }).deps.generate = () => new Promise<GenerateResult>((r) => (release = r));
    h.namer.reset(h.ctx);
    const pending = h.namer.onSettled(h.ctx);
    h.namer.stop();
    release({ ok: true, name: "Late" });
    await pending;
    expect(h.sessionName).toBeUndefined();
  });

  it("does nothing without UI", async () => {
    const h = harness();
    (h.ctx as { hasUI: boolean }).hasUI = false;
    h.namer.reset(h.ctx);
    await h.namer.onSettled(h.ctx);
    expect(h.calls).toHaveLength(0);
    expect(h.titles).toEqual([]);
  });
});
