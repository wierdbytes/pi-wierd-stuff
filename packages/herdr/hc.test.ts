import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hcTargetFromEnv, setLabels } from "./hc.ts";

describe("hcTargetFromEnv", () => {
  it("needs both the socket and the terminal id", () => {
    expect(hcTargetFromEnv({ HC_TERMINAL_SOCKET: "/s", HC_TERMINAL_ID: "t7" })).toEqual({ socket: "/s", terminal: "t7" });
    expect(hcTargetFromEnv({ HC_TERMINAL_SOCKET: "/s" })).toBeUndefined();
    expect(hcTargetFromEnv({ HC_TERMINAL_ID: "t7" })).toBeUndefined();
  });
});

describe.skipIf(process.platform === "win32")("setLabels", () => {
  let dir: string | undefined;
  let server: net.Server | undefined;
  afterEach(() => {
    server?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    server = undefined;
    dir = undefined;
  });

  function listen(reply: (request: any) => unknown): Promise<{ socket: string; requests: any[] }> {
    dir = mkdtempSync(join(tmpdir(), "pi-herdr-"));
    const socket = join(dir, "hc.sock");
    const requests: any[] = [];
    server = net.createServer((conn) => {
      let buffer = "";
      conn.on("data", (chunk) => {
        buffer += chunk.toString();
        const nl = buffer.indexOf("\n");
        if (nl === -1) return;
        const request = JSON.parse(buffer.slice(0, nl));
        requests.push(request);
        const answer = reply(request);
        if (answer !== undefined) conn.write(`${JSON.stringify(answer)}\n`);
      });
    });
    return new Promise((resolve) => server!.listen(socket, () => resolve({ socket, requests })));
  }

  it("sends terminal.label and resolves true on a result", async () => {
    const { socket, requests } = await listen((r) => ({ jsonrpc: "2.0", id: r.id, result: { address: "t7" } }));
    await expect(setLabels({ socket, terminal: "t7" }, { "agent.model": "M", "agent.effort": "" })).resolves.toBe(true);
    expect(requests[0]).toMatchObject({
      jsonrpc: "2.0",
      method: "terminal.label",
      params: { terminal: "t7", labels: { "agent.model": "M", "agent.effort": "" } },
    });
  });

  it("resolves false on an error reply", async () => {
    const { socket } = await listen((r) => ({ jsonrpc: "2.0", id: r.id, error: { code: -32000, message: "not_found" } }));
    await expect(setLabels({ socket, terminal: "t7" }, { a: "b" })).resolves.toBe(false);
  });

  it("resolves false when nobody answers or nothing listens", async () => {
    const { socket } = await listen(() => undefined);
    await expect(setLabels({ socket, terminal: "t7" }, { a: "b" }, 50)).resolves.toBe(false);
    await expect(setLabels({ socket: join(dir!, "missing.sock"), terminal: "t7" }, { a: "b" })).resolves.toBe(false);
  });
});
