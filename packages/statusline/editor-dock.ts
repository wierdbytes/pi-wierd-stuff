/**
 * pi's fullscreen layout docks the editor with `minSize: 3` (chat-viewport.js),
 * sized for the stock editor: top border, input, bottom border. We strip both
 * borders, so the editor renders a single input line and the stack pads it with
 * two blank rows under the prompt. Lowering that entry's `minSize` lets the
 * input be the last row of the terminal and grow only with its content.
 */

/** Structural view of pi-tui's Stack entries (`entries` is a public field). */
export interface StackEntryLike {
  component: unknown;
  minSize?: number;
}

interface NodeLike {
  entries?: StackEntryLike[];
  children?: unknown[];
}

const EDITOR_MIN_ROWS = 1;

function holds(entry: StackEntryLike, editor: unknown): boolean {
  if (entry.component === editor) return true;
  const children = (entry.component as NodeLike | null)?.children;
  return Array.isArray(children) && children.includes(editor);
}

/** Breadth-first: the dock sits two levels under the root, the transcript's long tail is never walked. */
export function findEditorEntry(root: unknown, editor: unknown): StackEntryLike | undefined {
  const seen = new Set<unknown>();
  const queue: unknown[] = [root];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    const { entries, children } = node as NodeLike;
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (entry && holds(entry, editor)) return entry;
      }
      for (const entry of entries) queue.push(entry?.component);
    }
    if (Array.isArray(children)) queue.push(...children);
  }
  return undefined;
}

/** Keeps the editor's dock entry from padding the prompt with blank rows. */
export class EditorDockFit {
  private entry: StackEntryLike | undefined;

  apply(tui: unknown, editor: unknown): void {
    const root = (tui as { layoutRoot?: unknown } | null)?.layoutRoot;
    if (!root) return; // regular (main-screen) mode: no fixed dock
    if (!this.entry || !holds(this.entry, editor)) {
      this.entry = findEditorEntry(root, editor);
    }
    if (this.entry && (this.entry.minSize ?? 0) > EDITOR_MIN_ROWS) {
      this.entry.minSize = EDITOR_MIN_ROWS;
    }
  }
}
