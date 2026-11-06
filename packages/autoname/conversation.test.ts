import { describe, expect, it } from "vitest";
import { collectInput, FIRST_REQUEST_CHARS, RECENT_REQUESTS, stripInjected } from "./conversation.ts";

const user = (content: unknown) => ({ type: "message", message: { role: "user", content } });
const assistant = (content: unknown) => ({ type: "message", message: { role: "assistant", content } });

describe("collectInput", () => {
  it("returns undefined without user messages", () => {
    expect(collectInput([])).toBeUndefined();
    expect(collectInput([assistant([{ type: "text", text: "hi" }])])).toBeUndefined();
  });

  it("collects first, recent and the last assistant text", () => {
    const input = collectInput([
      user("first"),
      assistant([{ type: "thinking", thinking: "hmm" }, { type: "text", text: "reply 1" }]),
      { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "tool" }] } },
      { type: "custom", customType: "x", data: {} },
      user([{ type: "text", text: "second" }, { type: "image", data: "", mimeType: "image/png" }]),
      assistant([{ type: "toolCall", id: "1", name: "bash", arguments: {} }]),
      assistant([{ type: "text", text: "reply 2" }]),
    ])!;
    expect(input.first).toBe("first");
    expect(input.recent).toEqual(["second"]);
    expect(input.assistant).toBe("reply 2");
  });

  it("keeps only the latest recent requests and clips the first", () => {
    const msgs = [user("x".repeat(FIRST_REQUEST_CHARS + 50)), ...Array.from({ length: 6 }, (_, i) => user(`r${i}`))];
    const input = collectInput(msgs)!;
    expect(input.first.length).toBe(FIRST_REQUEST_CHARS + 1);
    expect(input.recent).toEqual(["r3", "r4", "r5"].slice(-RECENT_REQUESTS));
  });
});

describe("stripInjected", () => {
  it("collapses skill bodies and drops clipboard image paths", () => {
    const text = 'look <skill name="web" location="/x">long body\nmore</skill> at /tmp/pi-clipboard-ab12-cd.png please';
    expect(stripInjected(text)).toBe("look [skill: web] at  please");
  });
});
