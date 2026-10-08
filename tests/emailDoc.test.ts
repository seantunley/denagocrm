import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { emailDocToText, safeEmailUrl, sanitizeEmailDoc, textToEmailDoc } from "../src/lib/signing/emailDoc";
import { SIGNING_EMAILS, renderSigningEmail, validateSigningTemplate } from "../src/lib/signing/emailTemplates";

const FIELDS = SIGNING_EMAILS.invite.fields;
const BRAND = { companyName: "Acme", tagline: null, logoUrl: null, accent: "#ea580c", accentText: "#ffffff", phone: "", email: "" };
const LINK = "https://crm.example.co.za/signing/tok_test_0000";
const field = (token: string) => ({ type: "mergeField", token, children: [{ text: "" }] });

test("sanitise keeps formatting and drops anything an email must not carry", () => {
  const doc = sanitizeEmailDoc(
    [
      { type: "h2", children: [{ text: "Hello", bold: true, color: "red" }] },
      { type: "script", children: [{ text: "x" }] }, // unknown block → plain paragraph
      { type: "p", onclick: "evil()", children: [{ type: "a", url: "javascript:alert(1)", children: [{ text: "click" }] }] },
      { type: "p", children: [field("not_a_field"), field("first_name")] },
      { type: "p", listStyleType: "disc", indent: 9, children: [{ text: "item" }] },
    ],
    FIELDS,
  )!;
  assert.deepEqual(doc[0], { type: "h2", children: [{ text: "Hello", bold: true }] });
  assert.equal(doc[1].type, "p");
  assert.deepEqual(doc[2].children, [{ text: "click" }], "unsafe link keeps its words, loses the link");
  assert.deepEqual(doc[3].children, [field("first_name")], "unknown merge field dropped");
  assert.equal(doc[4].indent, 4, "indent clamped");
  assert.ok(!JSON.stringify(doc).includes("onclick"));
});

test("only http(s) and mailto links survive", () => {
  assert.equal(safeEmailUrl("https://denago.co.za/x"), "https://denago.co.za/x");
  assert.equal(safeEmailUrl("mailto:sales@denago.co.za"), "mailto:sales@denago.co.za");
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "vbscript:x", "//evil", "", "   "]) assert.equal(safeEmailUrl(bad), null, bad);
});

test("formatted body renders as styled HTML; every character of text is escaped", () => {
  const doc = [
    { type: "h2", children: [{ text: "Your <quote>" }] },
    { type: "p", children: [{ text: "Hi " }, field("first_name"), { text: ", see " }, { type: "a", url: "https://acme.test/?a=1&b=2", children: [{ text: "our site" }] }] },
    { type: "p", listStyleType: "disc", indent: 1, children: [{ text: "one", bold: true }] },
    { type: "p", listStyleType: "disc", indent: 1, children: [{ text: "two" }] },
    { type: "p", children: [field("signing_link")] },
  ];
  const out = renderSigningEmail("invite", { subject: "S", body: "x {{signing_link}}", doc }, { first_name: "<b>Jo</b>", signing_link: LINK }, BRAND);
  assert.match(out.html, /<h2 style="[^"]*">Your &lt;quote&gt;<\/h2>/);
  assert.match(out.html, /Hi &lt;b&gt;Jo&lt;\/b&gt;, see <a href="https:\/\/acme\.test\/\?a=1&amp;b=2"/);
  assert.match(out.html, /<ul style="[^"]*"><li[^>]*><strong>one<\/strong><\/li><li[^>]*>two<\/li><\/ul>/, "consecutive items share one list");
  assert.match(out.html, /v:roundrect[\s\S]*Open &amp; sign/, "a line holding only the link becomes the button");
});

test("the action can't be dropped: a formatted body without the link still gets the button", () => {
  const out = renderSigningEmail("invite", { subject: "S", body: "x", doc: [{ type: "p", children: [{ text: "No link here" }] }] }, { signing_link: LINK }, BRAND);
  assert.match(out.html, /v:roundrect/);
});

test("plain text is derived from the formatted body — what validation reads is what is sent", () => {
  const doc = sanitizeEmailDoc(
    [
      { type: "p", children: [{ text: "Hi " }, field("first_name")] },
      { type: "p", listStyleType: "decimal", indent: 1, children: [{ text: "first" }] },
      { type: "p", listStyleType: "decimal", indent: 1, children: [{ text: "second" }] },
      { type: "p", children: [{ type: "a", url: "https://acme.test/", children: [{ text: "site" }] }] },
      { type: "p", children: [field("signing_link")] },
    ],
    FIELDS,
  )!;
  const text = emailDocToText(doc);
  assert.equal(text, "Hi {{first_name}}\n\n1. first\n2. second\n\nsite (https://acme.test/)\n\n{{signing_link}}");
  assert.equal(validateSigningTemplate("invite", "Sign", text), null);
  // A pasted real signing link inside a LINK is still caught.
  const pasted = emailDocToText(sanitizeEmailDoc([{ type: "p", children: [{ type: "a", url: LINK, children: [{ text: "here" }] }] }], FIELDS)!);
  assert.match(validateSigningTemplate("invite", "Sign", `${pasted}\n\n{{signing_link}}`) ?? "", /Don't paste a signing link/);
});

test("existing plain templates open in the editor with fields as pills", () => {
  const doc = textToEmailDoc(SIGNING_EMAILS.invite.body, FIELDS);
  assert.deepEqual(doc[0].children, [{ text: "Dear " }, field("recipient_name"), { text: "," }]);
  assert.deepEqual(doc[2].children, [field("signing_link")]);
  assert.equal(emailDocToText(sanitizeEmailDoc(doc, FIELDS)!), SIGNING_EMAILS.invite.body, "round-trips to the same text");
});

test("header style: white keeps the accent bar; dark/brand put the logo on a coloured header", () => {
  const vars = { recipient_name: "Jane", document_title: "Q-1", signing_link: LINK };
  const light = renderSigningEmail("invite", null, vars, { ...BRAND, logoUrl: "https://x.test/logo.png" }).html;
  assert.match(light, /<td height="4" bgcolor="#ea580c"/);
  const dark = renderSigningEmail("invite", null, vars, { ...BRAND, logoUrl: "https://x.test/logo.png", header: "dark" }).html;
  assert.match(dark, /<td bgcolor="#0f172a"[^>]*><img src="https:\/\/x\.test\/logo\.png"/);
  assert.doesNotMatch(dark, /<td height="4"/);
  const brand = renderSigningEmail("invite", null, vars, { ...BRAND, header: "brand" }).html;
  assert.match(brand, /<td bgcolor="#ea580c"[^>]*><div style="[^"]*color:#ffffff;">ACME<\/div>/, "wordmark turns light on a coloured header");
});

test("Email quote keeps the template's formatting when staff don't edit the message", () => {
  const src = readFileSync(new URL("../src/app/actions/quoteEmail.ts", import.meta.url), "utf8");
  assert.match(src, /const standard = await tenantEmailContent\("quote", quote\.tenantId, vars\);/);
  assert.match(src, /const email = unchanged \? standard : await tenantEmailContent\("quote", quote\.tenantId, vars, \{ subject, body \}\);/);
});

test("a template saved before formatting (no doc) renders exactly as before", () => {
  const plain = renderSigningEmail("invite", null, { recipient_name: "Jane", document_title: "Q-1", signing_link: LINK, company_name: "Acme" }, BRAND);
  assert.match(plain.html, /<p style="[^"]*">Dear Jane,<\/p>/);
  assert.match(plain.html, /v:roundrect/);
});
