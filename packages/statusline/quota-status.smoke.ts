/**
 * Real Pi terminal smoke test. Requires pi and tmux on PATH.
 * Run from the repository root: bun packages/statusline/quota-status.smoke.ts
 * Set PI_BIN to select a host Pi binary instead of a workspace dependency.
 * Uses an isolated HOME/agent directory and deterministic setStatus data;
 * never loads personal credentials or calls a model/provider API.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "pi-quota-smoke-"));
const socket = `pi-quota-smoke-${process.pid}`;
const home = join(root, "home");
const agent = join(root, "agent");
const settingsDir = join(home, ".pi/agent/wierd-statusline");
mkdirSync(settingsDir, { recursive: true });
mkdirSync(agent);
writeFileSync(join(agent, "settings.json"), JSON.stringify({
  tuiMode: "regular", enableInstallTelemetry: false, enableAnalytics: false,
}));
writeFileSync(join(settingsDir, "events.json"), JSON.stringify({
  version: 2,
  display: { footerHidden: true, fixedEditorEnabled: false, mouseScrollEnabled: false, iconSet: "ascii" },
}));
const fixture = join(root, "fixture.ts");
writeFileSync(fixture, `export default function(pi) {
  pi.on("session_start", (_event, ctx) => ctx.ui.setStatus("pi-quotas-usage", "5h:91% left 7d:82% left"));
  pi.registerCommand("quota-fixture", {
    handler: async (args, ctx) => ctx.ui.setStatus("pi-quotas-usage", args === "clear" ? undefined : args),
  });
}`);
const extension = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const tmux = (...args: string[]) => execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const screen = () => tmux("capture-pane", "-pt", "test");
const statusRow = (text: string) => text.split("\n").find((line) => line.startsWith("─ [m]")) ?? "";
async function waitFor(check: (text: string) => boolean, description: string) {
  for (let n = 0; n < 120; n++) {
    const text = screen();
    if (check(text)) return text;
    await sleep(100);
  }
  throw new Error(`${description}\n${screen()}`);
}
async function command(text: string) {
  tmux("send-keys", "-t", "test", "-l", text);
  tmux("send-keys", "-t", "test", "Enter");
  await sleep(250);
}
async function toggleFooter() {
  await command("/statusline");
  await waitFor((s) => s.includes("Hide pi footer"), "settings overlay did not open");
  tmux("send-keys", "-t", "test", "Down", "Space", "Escape");
  await sleep(250);
}

try {
  const launch = ["env", `HOME=${home}`, `PI_CODING_AGENT_DIR=${agent}`, "PI_OFFLINE=1", "PI_TELEMETRY=0",
    process.env.PI_BIN ?? "pi", "--no-extensions", "--no-skills", "--no-context-files",
    "--no-session", "-e", extension, "-e", fixture].map(quote).join(" ");
  tmux("new-session", "-d", "-s", "test", "-x", "160", "-y", "32", "/bin/sh");
  tmux("set-option", "-t", "test", "remain-on-exit", "on");
  tmux("send-keys", "-t", "test", "-l", `cd ${quote(root)} && exec ${launch}`);
  tmux("send-keys", "-t", "test", "Enter");
  await waitFor((s) => statusRow(s).includes("7d:82% left"), "initial quota missing from custom row");
  console.log("PASS: Pi starts with quota in the custom row and standard footer hidden");
  if (process.env.PI_QUOTA_SMOKE_CAPTURE) {
    writeFileSync(process.env.PI_QUOTA_SMOKE_CAPTURE, tmux("capture-pane", "-ept", "test"));
  }

  await command("/quota-fixture 7d:81% left");
  await waitFor((s) => statusRow(s).includes("7d:81% left") && !statusRow(s).includes("82%"), "live update missing");
  await command("/quota-fixture usage unavailable");
  await waitFor((s) => statusRow(s).includes("usage unavailable"), "error status missing");
  await command("/quota-fixture clear");
  assert(!statusRow(screen()).includes("usage unavailable"));
  assert(!statusRow(screen()).includes("7d:"));
  console.log("PASS: idle updates, errors, and status removal");

  await command("/quota-fixture 7d:80% left");
  await command("/statusline layout toggle quotas");
  assert(!statusRow(screen()).includes("7d:"));
  await command("/statusline layout toggle quotas");
  await command("/statusline layout move quotas top");
  await waitFor((s) => s.split("\n").some((line) => line.startsWith("─ 7d:80% left")), "layout reorder missing");
  tmux("resize-window", "-t", "test", "-x", "60", "-y", "32");
  await waitFor((s) => s.split("\n").some((line) => line.startsWith("─ 7d:80% left")), "quota lost on narrow terminal");
  tmux("resize-window", "-t", "test", "-x", "160", "-y", "32");
  await command("/statusline layout reset");
  console.log("PASS: hide/show, reorder, narrow-terminal rendering, and reset");

  await toggleFooter();
  await waitFor((s) => !statusRow(s).includes("7d:") && s.split("\n").some((line) => line.trim() === "7d:80% left"), "quota did not return to the standard footer");
  await toggleFooter();
  await waitFor((s) => statusRow(s).includes("7d:80% left"), "quota did not return to custom row");
  await command("/statusline off");
  await waitFor((s) => !statusRow(s) && s.split("\n").some((line) => line.trim() === "7d:80% left"), "disable did not restore footer");
  await command("/statusline on");
  await waitFor((s) => statusRow(s).includes("7d:80% left"), "enable did not reconnect quota");
  await command("/reload");
  await waitFor((s) => statusRow(s).includes("7d:82% left"), "reload did not reconnect quota");
  console.log("PASS: footer toggles, statusline disable/enable, and extension reload");
  console.log(screen());
} finally {
  try { tmux("kill-server"); } catch { /* Server may have exited after a startup failure. */ }
  rmSync(root, { recursive: true, force: true });
}
