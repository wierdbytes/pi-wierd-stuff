/**
 * Every test file gets an empty agent dir of its own, so the extension
 * never reads the person's `~/.pi/agent/wierd-facelift/config.json`
 * (a tool switched off there would leave it unregistered in the tests).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "pi-facelift-test-"));
process.env.PI_AGENT_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));
