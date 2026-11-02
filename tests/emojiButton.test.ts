import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { insertAtCursor } from "../src/components/EmojiButton";

// Sean, 2026-11-02: "can we build a button to open the emoji picker?"
test("the emoji goes where the cursor is — or replaces the selection — and the cursor lands after it", () => {
  const box = (start: number, end = start) => ({ selectionStart: start, selectionEnd: end }) as HTMLTextAreaElement;
  assert.deepEqual(insertAtCursor(box(9), "Thank you for contacting", "🙏"), { next: "Thank you🙏 for contacting", caret: 11 });
  assert.deepEqual(insertAtCursor(box(0, 5), "Hello there", "👋"), { next: "👋 there", caret: 2 });
  assert.deepEqual(insertAtCursor(null, "Feel the Electric", " ⚡"), { next: "Feel the Electric ⚡", caret: 19 }, "no box found: at the end");
});

test("the flow builder's message boxes each have the button, pointed at their own box", () => {
  const builder = readFileSync("src/components/FlowBuilder.tsx", "utf8");
  for (const id of ["msg", "ask", "prompt", "doc-cap"]) {
    assert.match(builder, new RegExp(`<EmojiButton targetId=\\{\`${id}-\\$\\{node\\.id\\}\`\\}`), id);
    assert.match(builder, new RegExp(`id=\\{\`${id}-\\$\\{node\\.id\\}\`\\}`), `${id} box carries the id`);
  }
});
