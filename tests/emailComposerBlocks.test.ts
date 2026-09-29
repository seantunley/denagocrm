import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  EMAIL_BUTTON_COLORS,
  emailButtonHtml,
  emailDividerHtml,
  emailSpacerHtml,
} from "../src/lib/emailBlockHtml";
import { inlineEmailStyles } from "../src/lib/emailInlineStyles";
import { trackedLinkPattern } from "../src/lib/trackRedirect";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * The email composer blocks — the `emailo` half of the Dittofeed borrow,
 * delivered natively. What these tests protect is not the markup's shape for
 * its own sake but the CONTRACTS the shape carries: no classes (mail clients
 * have no stylesheet), tracking rewritability, inliner compatibility, and
 * round-trip markers so a reopened template stays editable.
 */

// ── The bulletproof button ──────────────────────────────────────────────────

test("THE BUTTON IS A TABLE WITH EVERY STYLE INLINE — no class anywhere", () => {
  /*
   * A `<button>`, or an `<a>` with padding alone, is exactly what Outlook's
   * Word renderer mangles; and a class is a style that silently does not exist,
   * because no stylesheet of ours is present when a mail client renders this.
   */
  const html = emailButtonHtml({ label: "Book your service", url: "https://example.com/book" });
  assert.match(html, /^<table role="presentation"/);
  assert.doesNotMatch(html, /class=/);
  assert.doesNotMatch(html, /<button/);
  // The cell paints the background so Outlook shows a solid rectangle; the
  // anchor carries the padding so the whole visible button is clickable.
  assert.match(html, /<td style="[^"]*background:#/);
  assert.match(html, /<a href="https:\/\/example\.com\/book"[^>]*style="[^"]*display:inline-block;padding:/);
});

test("A CAMPAIGN BUTTON GETS CLICK TRACKING FOR FREE — its href matches the rewrite pattern", () => {
  /*
   * `buildTrackedEmail` rewrites every `href="https?://…"` through the tracking
   * redirect. The button is deliberately just a link wearing a table, so the
   * SAME pattern must match it — otherwise buttons, the most-clicked element in
   * any campaign, would be the one thing the click report cannot see.
   */
  const html = emailButtonHtml({ label: "Open", url: "https://example.com/x" });
  const matches = [...html.matchAll(trackedLinkPattern())];
  assert.equal(matches.length, 1, "exactly one trackable href");
  assert.equal(matches[0][1], "https://example.com/x");
});

test("THE BLOCKS SURVIVE SEND-TIME INLINING — the button's own styles keep winning", () => {
  /*
   * emailInlineStyles never touches tables, so the structural markup passes
   * through untouched. The one thing it DOES touch is the `<a>`: it prepends
   * its link defaults (blue, underlined) to any anchor. That is fine by the
   * inliner's own contract — an author's declarations come later and later
   * wins in CSS — but only as long as the button's colour and no-underline
   * remain AFTER whatever was prepended. This pins that ordering, because a
   * refactor of the inliner to append instead of prepend would repaint every
   * button link-blue and underline it, while every test that merely checks
   * "contains color:#ffffff" stayed green.
   */
  const button = inlineEmailStyles(emailButtonHtml({ label: "Go", url: "https://example.com" }));
  const anchorStyle = /<a [^>]*style="([^"]*)"/.exec(button)?.[1] ?? "";
  assert.ok(
    anchorStyle.lastIndexOf("color:#ffffff") > anchorStyle.lastIndexOf("color:#2563eb"),
    "the button's white must come after any prepended link colour, or blue wins",
  );
  assert.ok(
    anchorStyle.lastIndexOf("text-decoration:none") > anchorStyle.lastIndexOf("text-decoration:underline"),
    "no-underline must come after any prepended underline",
  );
  // The table structure itself is untouched: same cells, same td styles.
  assert.match(button, /<td style="border-radius:8px;background:#ea580c;">/);

  // Divider and spacer contain no anchors, so they must pass through unchanged.
  for (const html of [emailDividerHtml(), emailSpacerHtml(32)]) {
    assert.equal(inlineEmailStyles(html), html, "a block with no anchor must not be altered at all");
  }
});

test("label and url are escaped — authors paste, and pasted text contains anything", () => {
  const html = emailButtonHtml({ label: 'Save 20% on "R&M" <deals>', url: 'https://example.com/?a=1&b="x"' });
  assert.doesNotMatch(html, /<deals>/);
  assert.match(html, /&lt;deals&gt;/);
  assert.match(html, /R&amp;M/);
  assert.doesNotMatch(html.replace(/^<table[^>]*>/, ""), /"[^"]*"[^=]*=""/, "no attribute broken open by a quote");
});

test("A NON-HTTP URL NEVER REACHES AN HREF — javascript: renders as #", () => {
  for (const url of ["javascript:alert(1)", "data:text/html,x", "//evil.example", "ftp://x", "not a url"]) {
    const html = emailButtonHtml({ label: "x", url });
    assert.match(html, /<a href="#"/, `"${url}" must be defused to #`);
  }
  // Template variables are the one non-absolute form allowed: renderTemplate
  // resolves them at send, e.g. a per-recipient portal link.
  assert.match(emailButtonHtml({ label: "x", url: "{{portal_link}}" }), /<a href="\{\{portal_link\}\}"/);
});

test("an unknown colour falls back to the default rather than reaching a style attribute", () => {
  assert.match(emailButtonHtml({ label: "x", url: "https://e.com", color: "red;}" }), new RegExp(EMAIL_BUTTON_COLORS[0]));
  assert.match(emailButtonHtml({ label: "x", url: "https://e.com", color: "#2563EB" }), /#2563eb/);
});

// ── Round-trip markers ──────────────────────────────────────────────────────

test("EVERY BLOCK CARRIES ITS MARKER AND PARAMETERS — a reopened template stays editable", () => {
  /*
   * The Tiptap nodes parse blocks back by `data-email-block` and read their
   * parameters from data-attributes. Without these, a saved template reopens as
   * frozen table soup the author can only delete.
   */
  const button = emailButtonHtml({ label: "Hello", url: "https://e.com/a", color: "#059669", align: "left" });
  assert.match(button, /data-email-block="button"/);
  assert.match(button, /data-label="Hello"/);
  assert.match(button, /data-url="https:\/\/e\.com\/a"/);
  assert.match(button, /data-color="#059669"/);
  assert.match(button, /data-align="left"/);

  assert.match(emailDividerHtml(), /data-email-block="divider"/);
  const spacer = emailSpacerHtml(40);
  assert.match(spacer, /data-email-block="spacer"/);
  assert.match(spacer, /data-height="40"/);
});

test("spacer height is clamped to something a mail can survive", () => {
  assert.match(emailSpacerHtml(2), /data-height="8"/, "too small becomes the floor");
  assert.match(emailSpacerHtml(5000), /data-height="96"/, "too tall becomes the ceiling");
  assert.match(emailSpacerHtml(Number.NaN), /data-height="24"/, "nonsense becomes the default");
});

test("accessibility: layout tables announce as presentation, spacing is invisible to readers", () => {
  for (const html of [emailButtonHtml({ label: "x", url: "https://e.com" }), emailDividerHtml(), emailSpacerHtml()]) {
    assert.match(html, /role="presentation"/);
  }
});

// ── Wiring ──────────────────────────────────────────────────────────────────

test("both email surfaces get the tools; the editor loads the nodes only when asked", () => {
  const editor = src("src/components/RichTextEditor.tsx");
  assert.match(editor, /\.\.\.\(emailTools \? \[EmailButton, EmailDivider, EmailSpacer\] : \[\]\)/, "blocks are opt-in per surface");
  assert.match(src("src/components/EmailComposer.tsx"), /<RichTextEditor value=\{body\} onChange=\{setBody\} emailTools \/>/);
  assert.match(src("src/components/marketing/TemplateWorkspace.tsx"), /emailTools\r?\n/, "template workspace opts in");
});

test("the editor's node output IS the send output — renderHTML delegates to the generators", () => {
  // One source of markup. If the node rendered its own HTML, the editor would
  // show one button and the recipient would get another.
  const nodes = src("src/components/emailBlockNodes.ts");
  assert.match(nodes, /emailButtonHtml\(/);
  assert.match(nodes, /emailDividerHtml\(\)/);
  assert.match(nodes, /emailSpacerHtml\(/);
  assert.doesNotMatch(nodes, /<table/, "no hand-written block markup in the editor layer");
});

test("THE PREVIEW RENDERS THROUGH THE SEND PIPELINE, not a bare iframe of editor HTML", () => {
  /*
   * The old preview iframed the raw editor body: no shell, no brand, no inlined
   * styles — a preview of a mail that would never be sent. The workspace must
   * call the server action, and the action must render with the same shell and
   * inliner the campaign queue uses.
   */
  const workspace = src("src/components/marketing/TemplateWorkspace.tsx");
  assert.match(workspace, /previewMarketingEmailTemplate\(draft\.body\)/);
  assert.doesNotMatch(workspace, /srcDoc=\{draft\.body/, "the raw body must not be what the iframe shows");
  assert.match(workspace, /sandbox=""/, "the preview document stays inert");

  const campaigns = src("src/lib/campaigns.ts");
  assert.match(campaigns, /export function emailPreviewHtml/);
  assert.match(campaigns, /emailShell\(inlineEmailStyles\(bodyHtml\)/, "same shell, same inliner as a real send");
});
