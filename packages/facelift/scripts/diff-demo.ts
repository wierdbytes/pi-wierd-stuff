/**
 * Visual smoke test for the new write/edit diff renderer.
 *
 * Renders a representative split-view diff inside an open-right facelift
 * frame so the result can be eyeballed against the original pi-diff
 * screenshot. Not run by CI — invoked manually with:
 *
 *     bun run packages/facelift/scripts/diff-demo.ts
 */

import {
	applyDiffPalette,
	canRenderSplit,
	getDiffLayoutPreference,
	lang,
	parseDiff,
	renderSplit,
	resolveDiffColors,
	summarize,
	type DiffLayout,
} from "@wierdbytes/pi-common/diff";
import {
	frameResultWithBottomLabel,
	frameTop,
} from "@wierdbytes/pi-common/tool-frame";

applyDiffPalette();

// Minimal theme stub. By default we mimic tokyo-night-ish bg tokens so the
// auto-derived diff bg tints (BG_DEL/BG_ADD/BG_BASE) blend with each other.
// Pass FACELIFT_DEMO_PLAIN=1 to fall back to default terminal bg for the
// uncommon case where you want to inspect raw output.
const plain = process.env.FACELIFT_DEMO_PLAIN === "1";
const theme = plain
	? ({
			fg: (_key: string, text: string) => text,
			bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
			getFgAnsi: () => "",
			getBgAnsi: () => "",
		} as unknown as Parameters<typeof frameTop>[2])
	: ({
			fg: (_key: string, text: string) => text,
			bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
			getFgAnsi: (key: string) => {
				if (key === "toolDiffAdded") return "\x1b[38;2;100;180;120m"; // green
				if (key === "toolDiffRemoved") return "\x1b[38;2;200;100;100m"; // red
				return "";
			},
			getBgAnsi: (key: string) => {
				if (key === "toolSuccessBg") return "\x1b[48;2;26;30;46m"; // tokyo-night-ish slate
				if (key === "toolErrorBg") return "\x1b[48;2;46;26;30m";
				return "";
			},
		} as unknown as Parameters<typeof frameTop>[2]);

const oldText = `if len(blockers) == 0 {
    return nil
}

tx, err := s.db.BeginTx(ctx, nil)
if err != nil {
    return fmt.Errorf("begin tx: %w", err)
`;

const newText = `if len(blockers) == 0 {
    return nil
}
return retryOnBusy(ctx, func() error { return s.blockOnce(ctx, id, blockers) })
}

func (s *Store) blockOnce(ctx context.Context, id string, blockers []string) error {
tx, err := s.db.BeginTx(ctx, nil)
if err != nil {
    return fmt.Errorf("begin tx: %w", err)
`;

const diff = parseDiff(oldText, newText);
const colors = resolveDiffColors(theme as never);
const width = Number(process.env.COLUMNS) || 200;
const innerW = width - 1;

// Mirror facelift's `decideDiffLayout` so the demo also respects
// `DIFF_LAYOUT=...` / `diffLayout` settings when invoked manually.
const pref = getDiffLayoutPreference();
let layout: DiffLayout | undefined;
if (pref === "split") layout = "split";
else if (pref === "unified") layout = "unified";
else if (pref === "per-edit") layout = undefined;
else layout = canRenderSplit(diff, innerW, 60) ? "split" : "unified";

const title = `\x1b[1medit\x1b[22m internal/store/doltlite/deps.go`;
console.log(frameTop(title, "success", theme, width));

const body = await renderSplit(diff, lang("foo.go"), 60, colors, innerW, { frameless: true, layout });
const label = `1 edit ${summarize(diff.added, diff.removed)} (${diff.lines.length} diff lines)`;
console.log(frameResultWithBottomLabel(body, label, "success", theme, width));
