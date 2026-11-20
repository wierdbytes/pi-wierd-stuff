import { afterEach, describe, expect, it, vi } from "vitest";
import { detectPlayer, play, resetPlayerCache, type ExecLike } from "./player.ts";
import type { InProcessPlayer } from "./inprocess.ts";

const execFound = (found: string[]): ExecLike =>
  vi.fn(async (_cmd: string, args: string[]) => ({
    code: found.includes(args[0]!) ? 0 : 1,
  }));

describe("detectPlayer", () => {
  afterEach(() => resetPlayerCache());

  it("prefers the in-process player on macOS without probing $PATH", async () => {
    const played: Array<[string, number]> = [];
    const inProcess: InProcessPlayer = { play: (f, v) => played.push([f, v]) };
    const exec = execFound(["afplay"]);

    const spec = await detectPlayer(exec, "darwin", async () => inProcess);

    expect(spec?.label).toBe("AVAudioPlayer (in-process)");
    expect(spec?.outlivesProcess).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    play(spec!, "/tmp/a.wav", 1.7);
    expect(played).toEqual([["/tmp/a.wav", 1]]);
  });

  it("falls back to afplay when the in-process player is unavailable", async () => {
    const spec = await detectPlayer(execFound(["afplay"]), "darwin", async () => null);
    expect(spec?.label).toBe("afplay");
    expect(spec?.outlivesProcess).toBe(true);
  });

  it("falls back to afplay when the in-process player fails to start", async () => {
    const spec = await detectPlayer(execFound(["afplay"]), "darwin", () =>
      Promise.reject(new Error("boom")),
    );
    expect(spec?.label).toBe("afplay");
  });

  it("never tries the in-process player off macOS", async () => {
    const inProcess = vi.fn(async () => ({ play: () => {} }));
    const spec = await detectPlayer(execFound(["paplay"]), "linux", inProcess);
    expect(inProcess).not.toHaveBeenCalled();
    expect(spec?.label).toBe("paplay (PulseAudio)");
  });

  it("returns null when nothing is available", async () => {
    expect(await detectPlayer(execFound([]), "darwin", async () => null)).toBeNull();
  });
});

describe("play", () => {
  it("swallows backend errors", () => {
    const spec = {
      label: "broken",
      outlivesProcess: true,
      start: () => {
        throw new Error("boom");
      },
    };
    expect(() => play(spec, "/tmp/a.wav", 0.5)).not.toThrow();
  });
});
