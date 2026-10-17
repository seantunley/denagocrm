import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { pasteKind } from "../src/lib/clipboardPaste";

test("right-click Paste chooses what Ctrl+V would", () => {
  // A screenshot: a picture and no text.
  assert.equal(pasteKind(["image/png"]), "image");
  // Copied from a web page or Word: formatted, even when a picture rides along.
  assert.equal(pasteKind(["text/html", "text/plain", "image/png"]), "html");
  assert.equal(pasteKind(["text/plain"]), "text");
  assert.equal(pasteKind([]), null);
});

test("the message editor opens its own right-click menu, and Shift or a long-press still get the browser's", () => {
  const menu = readFileSync("src/components/EditorContextMenu.tsx", "utf8");
  assert.match(menu, /event\.shiftKey \|\| touch\.current\) return;/);
  assert.match(menu, /navigator\.clipboard\.read\(\)/);
  const editor = readFileSync("src/components/RichTextEditor.tsx", "utf8");
  assert.equal(editor.match(/<EditorContextMenu /g)?.length, 2, "both editor appearances get the menu");
  // Escape closing the menu (or a dialog) must not also close the composer and lose the email.
  assert.match(readFileSync("src/components/EmailComposer.tsx", "utf8"), /e\.key === "Escape" && !e\.defaultPrevented && setOpen\(false\)/);
});
