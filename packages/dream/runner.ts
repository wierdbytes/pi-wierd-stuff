/**
 * Entry point of the headless dream process. Not listed in `pi.extensions`:
 * the scheduler starts
 *
 *   pi -p --no-session --no-extensions -e <provider ext> -e runner.ts "/pi-dream-run --run-id …"
 *
 * so the dream runs with pi's model registry and credentials but without the
 * user's other extensions (sounds, voice, status bars) and without writing a
 * session file of its own.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseRunArgs, runDream } from "./pipeline.ts";

export default function piDreamRunner(pi: ExtensionAPI) {
	pi.registerCommand("pi-dream-run", {
		description: "pi-dream: run a dream in this process (used by the background runner)",
		handler: async (args, ctx) => {
			await runDream(ctx, parseRunArgs(args ?? ""));
		},
	});
}
