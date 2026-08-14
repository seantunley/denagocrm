import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { inlineEmailStyles } from "../src/lib/emailInlineStyles";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
const shipped = (rel: string) =>
  src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * The send-time half of the Dittofeed borrow.
 *
 * The email SHELL was already email-safe — a 600px presentation table with inline
 * styles. The BODY was not: a tag with no style attribute is at the mercy of the
 * recipient client's default stylesheet, and Outlook's is not the browser's.
 *
 * Most of what follows is about NOT breaking mail that already worked, because
 * campaign bodies include HTML hand-written in the old monospace textarea and
 * this runs over all of it at send.
 */

/* ── the styling itself ─────────────────────────────────────────────────── */

test("a bare paragraph gets spacing and a line height", () => {
  assert.equal(
    inlineEmailStyles("<p>Hello</p>"),
    '<p style="margin:0 0 16px 0;line-height:1.6;">Hello</p>',
  );
});

test("lists get padding, because Outlook indents with padding and ignores margin", () => {
  const out = inlineEmailStyles("<ul><li>One</li></ul>");
  assert.match(out, /<ul style="[^"]*padding-left:24px;[^"]*">/);
  assert.match(out, /<li style="[^"]*line-height:1\.6;[^"]*">/);
});

test("a link is given a visible colour", () => {
  // A link that inherits the surrounding text colour is a link nobody can see.
  assert.match(inlineEmailStyles('<a href="https://x.com">go</a>'), /style="color:#2563eb;text-decoration:underline;"/);
});

test("an image is constrained so it cannot burst the 600px shell", () => {
  const out = inlineEmailStyles('<img src="wide.png">');
  assert.match(out, /max-width:100%;/);
  assert.match(out, /height:auto;/);
  assert.match(out, /display:block;/, "kills the descender gap under an image");
});

test("the closing tag is untouched and attributes survive", () => {
  const out = inlineEmailStyles('<a href="https://x.com" target="_blank">go</a>');
  assert.match(out, /href="https:\/\/x\.com"/);
  assert.match(out, /target="_blank"/);
  assert.match(out, /<\/a>$/);
});

/* ── not breaking what already worked ───────────────────────────────────── */

test("an author's own style wins", () => {
  // Defaults are PREPENDED, so the author's declarations come last and later
  // declarations win in CSS. A deliberate `margin:0` must survive.
  const out = inlineEmailStyles('<p style="margin:0">Tight</p>');
  assert.match(out, /^<p style="margin:0 0 16px 0;line-height:1\.6;margin:0"/);
  assert.ok(out.lastIndexOf("margin:0") > out.indexOf("margin:0 0 16px"), "the author's wins by position");
});

test("only one style attribute survives the merge", () => {
  // Two would be a malformed tag, and clients differ on which they honour.
  const out = inlineEmailStyles('<p style="color:red">x</p>');
  assert.equal(out.match(/style=/g)?.length, 1);
});

test("TABLES ARE LEFT ALONE — the most important thing here", () => {
  // Campaign bodies include HTML hand-written in the old textarea, and in email a
  // <table> is as likely to be LAYOUT as data. Giving every <td> a border would
  // put visible lines through somebody's existing newsletter the first time it
  // was resent. Under-styling is recoverable; over-styling changes mail that
  // already worked, silently, at send.
  const layout = '<table cellpadding="0"><tr><td>Left</td><td>Right</td></tr></table>';
  assert.equal(inlineEmailStyles(layout), layout, "not one byte");
});

test("unknown tags pass through untouched", () => {
  const html = "<section><span>hi</span><custom-tag>x</custom-tag></section>";
  assert.equal(inlineEmailStyles(html), html);
});

test("empty input is returned as-is", () => {
  assert.equal(inlineEmailStyles(""), "");
});

test("tag names keep their original case", () => {
  // Matching is case-insensitive, but rewriting the name would change markup that
  // was not asked to change.
  assert.match(inlineEmailStyles("<P>x</P>"), /^<P style=/);
});

test("merge variables are carried through untouched", () => {
  // The whole body is personalised BEFORE this runs, but a template previewed or
  // re-rendered later must not have its placeholders mangled.
  const out = inlineEmailStyles("<p>Hi {{first_name}}</p>");
  assert.match(out, /\{\{first_name\}\}/);
});

test("running it twice renders the same, even though the text grows", () => {
  // It is called once, at send. This pins that a double application is harmless
  // rather than corrupting — the defaults are prepended again and lose to the
  // copy already there.
  const once = inlineEmailStyles("<p>x</p>");
  const twice = inlineEmailStyles(once);
  assert.match(twice, /^<p style="margin:0 0 16px 0;line-height:1\.6;margin:0 0 16px 0;line-height:1\.6;">x<\/p>$/);
});

/* ── where it runs ──────────────────────────────────────────────────────── */

test("the campaign body is styled before the links are rewritten", () => {
  // It only ever adds style attributes to opening tags, while the steps after it
  // rewrite href values and append the tracking pixel. Doing it last would style
  // the pixel.
  const code = shipped("src/lib/campaigns.ts");
  const build = code.slice(code.indexOf("export function buildTrackedEmail("));
  const styled = build.indexOf("inlineEmailStyles(personalizedHtml)");
  const rewritten = build.indexOf("const rewritten =");
  const pixel = build.indexOf("const pixel =");
  assert.ok(styled > 0, "the campaign body must be styled");
  assert.ok(styled < rewritten && styled < pixel, "…before the links and the pixel");
  assert.match(build, /const rewritten = styled\.replace\(/, "the rewrite must consume the styled body");
});

test("the one-to-one composer gets the same treatment", () => {
  // It uses the SAME rich editor, so it arrives with the same problem. The
  // signature is already inline-styled and is deliberately not passed through.
  const code = shipped("src/lib/signature.ts");
  const fn = code.slice(code.indexOf("export function buildEmailHtml("));
  assert.match(fn, /\$\{inlineEmailStyles\(bodyHtml\)\}/);
  assert.doesNotMatch(fn, /inlineEmailStyles\(signature\)/, "the signature is already inline-styled");
});

test("no MJML dependency was added", () => {
  // The queue proposed MJML. The frame is already solved by emailShell, and MJML
  // cannot help with the BODY unless the body is authored as MJML — which would
  // mean storing TipTap JSON and plumbing it from template to campaign to send,
  // leaving every template written before the change unimproved. This approach
  // covers every campaign body regardless of where its HTML came from.
  const pkg = JSON.parse(src("package.json")) as { dependencies?: Record<string, string> };
  assert.ok(!pkg.dependencies?.mjml, "the decision not to take MJML is deliberate — see emailInlineStyles.ts");
});
