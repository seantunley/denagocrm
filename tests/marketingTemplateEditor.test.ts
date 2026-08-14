import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
const shipped = (rel: string) =>
  src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const WORKSPACE = "src/components/marketing/TemplateWorkspace.tsx";

/**
 * Marketing email templates were authored by hand-writing HTML into a monospace
 * `<textarea>`, while one-to-one email has had a rich editor for months. The
 * wrong one of the two had it.
 *
 * TipTap round-trips HTML, so the swap reads and writes the same `body` column
 * and needs no migration — which is also why the two things worth pinning are
 * that SMS did NOT get it, and that an empty document cannot be saved.
 */

test("email templates are composed in the rich editor", () => {
  const code = shipped(WORKSPACE);
  assert.match(code, /<RichTextEditor/);
  assert.match(code, /value=\{draft\.body\}/, "it must read and write the same column");
  assert.match(code, /onChange=\{\(html\) => setDraft\(\(current\) => \(\{ \.\.\.current, body: html \}\)\)\}/);
  // The functional update matters: the editor's onChange can land in the same
  // tick as another field's, and `{ ...draft, body }` would restore a stale copy
  // of everything else.
  assert.doesNotMatch(code, /onChange=\{\(html\) => setDraft\(\{ \.\.\.draft,/);
});

test("everything that is not email keeps plain text", () => {
  // KEYED ON isEmail, NOT ON !isSms. There are THREE channels: the category list
  // types `channel` as "email" | "sms" | "internal", and `internal_notification`
  // plus the legacy `internal` category are neither of the first two. `!isSms`
  // handed them the rich editor as well, and their content is consumed as plain
  // text — so the markup would have been delivered literally, `<p>` and all, in
  // an internal message. A negated condition made a third case the default for a
  // change that was only ever about email.
  const code = shipped(WORKSPACE);
  assert.match(code, /\{!isEmail \? \(\s*<textarea id="marketing-template-body"/);
  assert.doesNotMatch(code, /\{isSms \? \(\s*<textarea/, "the two-channel assumption is what this replaced");
  assert.match(code, /\{draft\.body\.length\} characters/, "the SMS count is still measured on the raw string");

  // The emptiness rule follows the same split: plain-text semantics for anything
  // that is not email, or an internal template made only of spaces would save.
  assert.match(code, /hasVisibleContent\(draft\.body, !isEmail\)/);
  // …and the cursor insert only runs where the editor actually mounts.
  assert.match(code, /if \(editor && isEmail\)/);
});

test("the three channels are still three", () => {
  // The fix depends on `internal` existing as a channel rather than being
  // absorbed into one of the others. If that type ever collapses to two, `!isEmail`
  // and `isSms` become the same test and this defect cannot recur — but the
  // reader of this test should know why it was written.
  assert.match(shipped(WORKSPACE), /channel: "email" \| "sms" \| "internal";/);
  assert.match(shipped(WORKSPACE), /channel: "internal"/, "at least one category must use it");
});

test("an empty rich-text document cannot be saved", () => {
  // THE BUG THE SWAP WOULD OTHERWISE INTRODUCE. `draft.body.trim()` was a
  // sufficient emptiness check for plain text; the editor serialises an EMPTY
  // document as `<p></p>`, which is truthy — so an untouched template would have
  // looked ready and gone out as a blank email.
  const code = shipped(WORKSPACE);
  assert.match(code, /hasVisibleContent\(draft\.body, !isEmail\)/);
  assert.doesNotMatch(code, /draft\.name\.trim\(\) && draft\.body\.trim\(\)/, "the old check is what this replaced");
});

test("the emptiness check behaves", () => {
  // Re-implemented here from the shipped source rather than imported, because the
  // module is a client component and importing it drags React in. The regexes are
  // copied verbatim; the assertions below are the contract they must satisfy.
  const hasVisibleContent = (body: string, plainText: boolean): boolean => {
    if (plainText) return body.trim().length > 0;
    if (/<img\b/i.test(body)) return true;
    return body.replace(/<[^>]*>/g, "").replace(/&nbsp;|&#160;/gi, " ").trim().length > 0;
  };

  assert.equal(hasVisibleContent("<p></p>", false), false, "the editor's empty document");
  assert.equal(hasVisibleContent("<p><br></p>", false), false, "…and its empty-with-a-break form");
  assert.equal(hasVisibleContent("<p>&nbsp;</p>", false), false, "a non-breaking space is not content");
  assert.equal(hasVisibleContent("<p>Hello</p>", false), true);
  // An image-only template is a real template — a banner with no words — and
  // stripping tags first would call it empty.
  assert.equal(hasVisibleContent('<p><img src="x.png"></p>', false), true);
  assert.equal(hasVisibleContent("   ", true), false, "plain text is unchanged");
  assert.equal(hasVisibleContent("Hi", true), true);

  // The shipped implementation must still be the one asserted above.
  const shippedFn = shipped(WORKSPACE).slice(
    shipped(WORKSPACE).indexOf("function hasVisibleContent"),
  );
  assert.match(shippedFn, /if \(plainText\) return body\.trim\(\)\.length > 0;/);
  assert.match(shippedFn, /if \(\/<img\\b\/i\.test\(body\)\) return true;/);
  assert.match(shippedFn, /&nbsp;\|&#160;/);
});

test("merge variables land at the cursor, not after the closing tag", () => {
  // Appending `{{first_name}}` to the HTML string would put it OUTSIDE the
  // document, where it renders as a stray line and never gets merged. The buttons
  // have to reach the editor rather than the string.
  const code = shipped(WORKSPACE);
  assert.match(code, /editor\.chain\(\)\.focus\(\)\.insertContent\(variable\)\.run\(\)/);
  // …and the plain-text append survives for SMS, where it is correct.
  assert.match(code, /body: `\$\{current\.body\}\$\{current\.body && !current\.body\.endsWith\(" "\) \? " " : ""\}\$\{variable\}`/);
  const fn = code.slice(code.indexOf("function insertVariable"));
  assert.ok(
    fn.indexOf("editor.chain()") < fn.indexOf("setDraft("),
    "the editor path must be taken first when one is mounted",
  );
});

test("the editor reference is retracted on teardown", () => {
  // A parent holding a destroyed editor would throw on its next command — and the
  // template editor mounts and unmounts every time the panel opens and closes.
  const editor = shipped("src/components/RichTextEditor.tsx");
  assert.match(editor, /onEditorReady\?: \(editor: Editor \| null\) => void;/);
  assert.match(editor, /return \(\) => onEditorReady\(null\);/);
});

test("the capability is additive, so existing callers are untouched", () => {
  // RichTextEditor is used by the one-to-one composer too. The new prop is
  // optional and the effect returns early without it, so nothing changes there.
  const editor = shipped("src/components/RichTextEditor.tsx");
  assert.match(editor, /if \(!onEditorReady\) return;/);
});

test("the hint no longer tells people to write HTML", () => {
  // It said "HTML is supported, but plain text is fine too", which described the
  // textarea. Leaving it would be documentation for a screen that no longer
  // exists — and this suite has been caught before by prose outliving its code.
  assert.doesNotMatch(shipped(WORKSPACE), /HTML is supported/);
});
