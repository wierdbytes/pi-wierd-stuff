/**
 * macOS in-process playback for @wierdbytes/pi-peon.
 *
 * Spawning `afplay` per event makes every sound a fresh CoreAudio
 * client that connects, plays and exits. Under bursts (a dozen pi
 * sub-agents changing state at once) coreaudiod stops tearing down the
 * IO contexts of exited clients; the leaked contexts overload the audio
 * IO thread and everything on the Mac crackles until coreaudiod is
 * restarted.
 *
 * Here sounds play through AVAudioPlayer inside the pi process, which
 * stays a single CoreAudio client for its lifetime. Calls go through
 * Node's experimental `node:ffi` (Node >= 26.1) on a worker thread:
 *
 *   - a wedged coreaudiod can block a CoreAudio call for minutes; on a
 *     worker that never freezes pi's UI;
 *   - the worker drops its process warnings before loading `node:ffi`,
 *     so Node's ExperimentalWarning never reaches the TUI. (Capturing
 *     the worker's stderr instead would keep pi from exiting once
 *     anything is written to it.)
 *
 * One worker per process, shared across extension reloads through
 * `globalThis`. It is unref'd, so it never keeps pi alive, and sounds
 * still playing when pi exits are cut off.
 */

import { builtinModules } from "node:module";
import { Worker } from "node:worker_threads";

export interface InProcessPlayer {
  /** Queue `file` at `volume` (0..1). Fire and forget. */
  play(file: string, volume: number): void;
}

const READY_TIMEOUT_MS = 5_000;
const SLOT = Symbol.for("@wierdbytes/pi-peon/inprocess-player/v1");

/**
 * Worker body. Plain CommonJS so it runs as an `eval` worker no matter
 * how pi loaded this extension (jiti, Node type stripping, …).
 *
 * Protocol: the worker posts `{ type: "ready" }` or
 * `{ type: "failed", reason }` once; afterwards the main thread posts
 * `{ file, volume, at }` per sound and expects nothing back. Sounds
 * that waited longer than STALE_MS (the worker was stuck in a wedged
 * coreaudiod) are dropped instead of all playing at once on recovery.
 */
const WORKER_SOURCE = String.raw`
(() => {
  // Silences the ExperimentalWarning that require("node:ffi") emits.
  // Nothing in this worker may write to stdout / stderr: it shares the
  // TUI's terminal.
  process.removeAllListeners("warning");
  const { parentPort } = require("node:worker_threads");
  let api;
  try {
    const ffi = require("node:ffi");
    const OBJC = "/usr/lib/libobjc.A.dylib";
    // Keep every handle reachable so none is ever closed under us.
    const handles = [];
    const open = (path) => {
      const lib = new ffi.DynamicLibrary(path);
      handles.push(lib);
      return lib;
    };
    const fn = (lib, name, args, ret) =>
      lib.getFunction(name, { arguments: args, return: ret });
    // node:ffi binds one signature per symbol per handle, so every
    // objc_msgSend shape gets its own handle.
    const send = (args, ret) =>
      fn(open(OBJC), "objc_msgSend", ["pointer", "pointer", ...args], ret);

    const objc = open(OBJC);
    open("/System/Library/Frameworks/Foundation.framework/Foundation");
    open("/System/Library/Frameworks/AVFAudio.framework/AVFAudio");

    const getClass = fn(objc, "objc_getClass", ["string"], "pointer");
    const sel = fn(objc, "sel_registerName", ["string"], "pointer");
    const poolPush = fn(objc, "objc_autoreleasePoolPush", [], "pointer");
    const poolPop = fn(objc, "objc_autoreleasePoolPop", ["pointer"], "void");

    const NSString = getClass("NSString");
    const NSURL = getClass("NSURL");
    const AVAudioPlayer = getClass("AVAudioPlayer");
    if (!NSString || !NSURL || !AVAudioPlayer) {
      throw new Error("AVAudioPlayer is not available");
    }

    api = {
      poolPush,
      poolPop,
      NSString,
      NSURL,
      AVAudioPlayer,
      sendId: send([], "pointer"),
      sendBool: send([], "bool"),
      sendF64: send([], "double"),
      sendVoid: send([], "void"),
      sendIdStr: send(["string"], "pointer"),
      sendIdId: send(["pointer"], "pointer"),
      sendIdIdPtr: send(["pointer", "pointer"], "pointer"),
      sendVoidF32: send(["float"], "void"),
      sel: {
        alloc: sel("alloc"),
        release: sel("release"),
        stringWithUTF8String: sel("stringWithUTF8String:"),
        fileURLWithPath: sel("fileURLWithPath:"),
        initWithContentsOfURL: sel("initWithContentsOfURL:error:"),
        setVolume: sel("setVolume:"),
        play: sel("play"),
        isPlaying: sel("isPlaying"),
        duration: sel("duration"),
      },
    };
  } catch (err) {
    parentPort.postMessage({
      type: "failed",
      reason: String((err && err.message) || err),
    });
    return;
  }

  const a = api;
  const s = a.sel;

  // Players are alloc'd (+1) and released once they have finished.
  const releaseWhenDone = (player, delayMs, attempts) => {
    setTimeout(() => {
      const pool = a.poolPush();
      try {
        if (attempts > 0 && a.sendBool(player, s.isPlaying)) {
          releaseWhenDone(player, 1000, attempts - 1);
          return;
        }
        a.sendVoid(player, s.release);
      } catch {
        // best-effort
      } finally {
        a.poolPop(pool);
      }
    }, delayMs);
  };

  const STALE_MS = 2000;

  parentPort.on("message", (m) => {
    if (!m || typeof m.file !== "string") return;
    if (typeof m.at === "number" && Date.now() - m.at > STALE_MS) return;
    const volume = Number.isFinite(m.volume)
      ? Math.min(Math.max(m.volume, 0), 1)
      : 1;
    const pool = a.poolPush();
    try {
      const path = a.sendIdStr(a.NSString, s.stringWithUTF8String, m.file);
      if (!path) return;
      const url = a.sendIdId(a.NSURL, s.fileURLWithPath, path);
      if (!url) return;
      // -initWithContentsOfURL:error: releases the alloc'd object and
      // returns nil on failure (missing file, undecodable format).
      const player = a.sendIdIdPtr(
        a.sendId(a.AVAudioPlayer, s.alloc),
        s.initWithContentsOfURL,
        url,
        null,
      );
      if (!player) return;
      a.sendVoidF32(player, s.setVolume, volume);
      if (!a.sendBool(player, s.play)) {
        a.sendVoid(player, s.release);
        return;
      }
      const seconds = Math.min(Math.max(a.sendF64(player, s.duration), 0), 600);
      releaseWhenDone(player, Math.ceil(seconds * 1000) + 500, 30);
    } catch {
      // best-effort: never let one bad sound take the worker down
    } finally {
      a.poolPop(pool);
    }
  });

  parentPort.postMessage({ type: "ready" });
})();
`;

/** True when this runtime can host the worker at all. */
function runtimeSupported(): boolean {
  if (process.platform !== "darwin") return false;
  // Bun has no node:ffi.
  if (process.versions.bun) return false;
  // Checking the list doesn't load the module, so no ExperimentalWarning
  // on the main thread. Absent before Node 26.1 or with
  // --no-experimental-ffi.
  return builtinModules.includes("node:ffi");
}

function startWorker(
  timeoutMs: number,
  onExit: () => void,
): Promise<InProcessPlayer | null> {
  let worker: Worker;
  try {
    worker = new Worker(WORKER_SOURCE, { eval: true });
  } catch {
    return Promise.resolve(null);
  }
  worker.unref();

  let alive = true;
  const player: InProcessPlayer = {
    play(file, volume) {
      if (!alive) return;
      try {
        worker.postMessage({ file, volume, at: Date.now() });
      } catch {
        // best-effort
      }
    },
  };

  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: InProcessPlayer | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const giveUp = (): void => {
      alive = false;
      void worker.terminate().catch(() => {});
      settle(null);
    };
    const timer = setTimeout(giveUp, timeoutMs);
    timer.unref?.();

    worker.once("message", (m: { type?: string } | undefined) => {
      if (m?.type === "ready") settle(player);
      else giveUp();
    });
    // Permanent listener: an unhandled worker "error" would crash pi.
    worker.on("error", () => {
      alive = false;
      settle(null);
    });
    worker.on("exit", () => {
      alive = false;
      settle(null);
      onExit();
    });
  });
}

/**
 * The process-wide in-process player, or `null` when this platform /
 * runtime can't host it (not macOS, Bun, Node < 26.1, init failure).
 * The first call starts the worker; later calls, including from a
 * reloaded copy of this module, share it.
 */
export function getInProcessPlayer(
  timeoutMs: number = READY_TIMEOUT_MS,
): Promise<InProcessPlayer | null> {
  if (!runtimeSupported()) return Promise.resolve(null);
  const g = globalThis as Record<symbol, unknown>;
  const existing = g[SLOT] as Promise<InProcessPlayer | null> | undefined;
  if (existing) return existing;
  const slot = startWorker(timeoutMs, () => {
    // Let the next session_start try again with a fresh worker.
    if (g[SLOT] === slot) delete g[SLOT];
  });
  g[SLOT] = slot;
  return slot;
}
