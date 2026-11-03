// Vitest setup: point pi's agent dir at a throwaway folder for every test file,
// so config-store reads/writes never touch the real ~/.pi/agent.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TEST_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-ask-test-agent-"));
process.env.PI_CODING_AGENT_DIR = TEST_AGENT_DIR;
