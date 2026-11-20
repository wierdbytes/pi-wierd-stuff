import { builtinModules } from "node:module";
import { describe, expect, it } from "vitest";
import { getInProcessPlayer } from "./inprocess.ts";

const supported =
  process.platform === "darwin" &&
  !process.versions.bun &&
  builtinModules.includes("node:ffi");

describe("getInProcessPlayer", () => {
  it.runIf(!supported)("is null where node:ffi / macOS is unavailable", async () => {
    expect(await getInProcessPlayer()).toBeNull();
  });

  it.runIf(supported)("starts one shared worker on macOS", async () => {
    const a = await getInProcessPlayer();
    const b = await getInProcessPlayer();
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    // An unreadable file must be dropped without taking the worker down.
    a!.play("/nonexistent/peon-test.wav", 0);
    await new Promise((r) => setTimeout(r, 200));
    expect(await getInProcessPlayer()).toBe(a);
  });
});
