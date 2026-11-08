import { describe, expect, it } from "vitest";
import { Container, Text, VStack } from "@earendil-works/pi-tui";

import { EditorDockFit, findEditorEntry } from "./editor-dock.ts";

/** Mirrors pi's chat-viewport: transcript + dock with the editor at minSize 3. */
function viewport(editor: Text) {
  const editorContainer = new Container();
  editorContainer.addChild(editor);
  const transcript = new Container();
  for (let i = 0; i < 50; i++) transcript.addChild(new Text(`line ${i}`));
  const dock = new VStack([
    { component: new Container(), shrink: 1, minSize: 0 },
    { component: editorContainer, shrink: 1, minSize: 3 },
    { component: new Container(), shrink: 1, minSize: 0 },
  ]);
  const root = new VStack([
    { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
  ]);
  return { root, dock };
}

describe("findEditorEntry", () => {
  it("finds the dock entry holding the editor", () => {
    const editor = new Text("> ");
    const { root } = viewport(editor);
    expect(findEditorEntry(root, editor)?.minSize).toBe(3);
  });

  it("returns undefined when the editor is not mounted", () => {
    const { root } = viewport(new Text("> "));
    expect(findEditorEntry(root, new Text("other"))).toBeUndefined();
  });
});

describe("EditorDockFit", () => {
  it("drops the blank rows under a one-line prompt", () => {
    const editor = new Text("> ", 0, 0);
    const { root, dock } = viewport(editor);
    expect(dock.render(40)).toHaveLength(3);

    new EditorDockFit().apply({ layoutRoot: root }, editor);
    expect(dock.render(40)).toHaveLength(1);
  });

  it("does nothing in regular mode (no layout root)", () => {
    const editor = new Text("> ", 0, 0);
    const { root } = viewport(editor);
    new EditorDockFit().apply({}, editor);
    expect(findEditorEntry(root, editor)?.minSize).toBe(3);
  });
});
