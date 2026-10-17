import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const composer = readFileSync("src/components/EmailComposer.tsx", "utf8");
const editor = readFileSync("src/components/RichTextEditor.tsx", "utf8");
const pictures = readFileSync("src/components/emailBlockStyle.ts", "utf8");

test("the signature shows under the message, built by the same server code Send uses, and runs nothing", () => {
  assert.match(composer, /previewComposerEmail\("", \{ to, contactId, leadId, choice: banner \}\)/);
  const frame = composer.match(/<iframe title="Signature preview"[^>]*\/>/)?.[0] ?? "";
  // No scripts, and (since #893) not even same-origin: it is only looked at.
  assert.match(frame, /sandbox=""/);
  assert.doesNotMatch(frame, /allow-scripts/);
  // A changed banner or recipient changes the banner the email carries, so the signature is built again.
  assert.match(composer, /\}, \[open, smtpConfigured, to, banner, contactId, leadId, signatureKey\]\);/);
});

test("pictures in an email start at an email's width and can be resized by their corners", () => {
  assert.match(pictures, /export const EMAIL_PICTURE_WIDTH = 600;/);
  assert.match(pictures, /const width = Math\.min\(canvas\.width, EMAIL_PICTURE_WIDTH\);/);
  assert.match(editor, /resize: emailTools \? \{ enabled: true,/);
  // The handles arrive unstyled (zero-sized): without these rules there is nothing to drag.
  assert.match(editor, /\[&_\[data-resize-handle\]\]:size-3/);
});
