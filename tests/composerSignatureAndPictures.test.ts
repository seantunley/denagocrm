import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const composer = readFileSync("src/components/EmailComposer.tsx", "utf8");
const editor = readFileSync("src/components/RichTextEditor.tsx", "utf8");
const pictures = readFileSync("src/components/emailBlockStyle.ts", "utf8");

test("the signature shows under the message, built by the same server code Send uses, and runs nothing", () => {
  assert.match(composer, /previewComposerEmail\("", \{ to: field\("to"\), contactId, leadId, choice: field\("banner"\) \}\)/);
  const frame = composer.match(/<iframe\s+title="Your signature"[\s\S]*?\/>/)?.[0] ?? "";
  assert.match(frame, /sandbox="allow-same-origin"/);
  assert.doesNotMatch(frame, /allow-scripts/);
  // A changed banner or recipient changes the banner the email carries, so the signature is built again.
  assert.match(composer, /aria-label="Marketing banner"\s+onChange=\{loadSignature\}/);
  assert.match(composer, /name="to"[^>]*onBlur=\{loadSignature\}/);
});

test("pictures in an email start at an email's width and can be resized by their corners", () => {
  assert.match(pictures, /export const EMAIL_PICTURE_WIDTH = 600;/);
  assert.match(pictures, /const width = Math\.min\(canvas\.width, EMAIL_PICTURE_WIDTH\);/);
  assert.match(editor, /resize: emailTools \? \{ enabled: true,/);
  // The handles arrive unstyled (zero-sized): without these rules there is nothing to drag.
  assert.match(editor, /\[&_\[data-resize-handle\]\]:size-3/);
});
