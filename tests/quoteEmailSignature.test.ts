import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { SENDER_SIGNATURE_SLOT, SIGNING_EMAILS, renderSigningEmail, validateSigningTemplate, type SigningEmailBrand } from "../src/lib/signing/emailTemplates";
import { DEFAULT_SIGNATURE_COMPANY, buildEmailHtml, buildSignature, placeSignatureInEmail, signatureText } from "../src/lib/signature";
import { placeBannerInEmail } from "../src/lib/signatureBanners";
import { defaultEmailBody, isUntouchedEmailSeed } from "../src/lib/doceditor/emailDefaults";
import { REPLACED_STANDARD_WORDINGS } from "../src/lib/doceditor/emailWordingHistory";

/*
 * THE QUOTE EMAIL CARRIES THE SENDER'S OWN SIGNATURE (Sean, 2026-10-12: "Why
 * doesn't email quote attach branded signature?"). It was the one email a named
 * person sends that ended in typed text instead of the signature every other
 * email of theirs has.
 */

const code = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

const BRAND: SigningEmailBrand = { companyName: "Acme Carts", tagline: null, logoUrl: null, accent: "#ea580c", accentText: "#ffffff", phone: "021 555 0000", email: "hello@acme.test" };
const VARS = { recipient_name: "Thandi Mokoena", first_name: "Thandi", document_title: "Quote Q-42", quote_number: "Q-42", total: "R 1 000,00", company_name: "Acme Carts", sender_name: "Pat Smith" };
const PAT = { name: "Pat Smith", email: "pat@acme.test", mobile: "082 555 0101", jobTitle: "Sales Manager" };
const COMPANY = { ...DEFAULT_SIGNATURE_COMPANY, name: "Acme Carts", assetBase: "https://crm.acme.test" };

test("the signature goes INSIDE the card: after the message, before the company footer — once", () => {
  const email = renderSigningEmail("quote", null, VARS, BRAND);
  assert.equal(email.html.split(SENDER_SIGNATURE_SLOT).length - 1, 1, "the quote email marks where its sender's signature goes");
  const signature = buildSignature(PAT, COMPANY);
  const signed = placeSignatureInEmail(email.html, signature, SENDER_SIGNATURE_SLOT);
  assert.ok(signed.includes(signature), "the signature builder's own output, unchanged");
  assert.equal(signed.split(signature).length - 1, 1, "once");
  assert.ok(!signed.includes(SENDER_SIGNATURE_SLOT), "the mark is used up");
  // "Kind regards," → the person → the company footer. The first version put it after the footer, outside the card.
  const at = (needle: string) => signed.indexOf(needle);
  assert.ok(at("Kind regards,") > -1 && at("Kind regards,") < at(signature));
  assert.ok(at(signature) < at("hello@acme.test"), "the company footer comes after the person");
  assert.ok(at("hello@acme.test") < at("</body>"));
  assert.ok(signed.endsWith("</html>"));
});

test("only the quote email has the mark — the others are sent by the system and keep their typed sign-off", () => {
  for (const def of Object.values(SIGNING_EMAILS)) {
    if (def.channel) continue;
    const html = renderSigningEmail(def.kind, null, { ...VARS, signing_link: "https://x.test/s", code: "123456" }, BRAND).html;
    assert.equal(html.includes(SENDER_SIGNATURE_SLOT), def.kind === "quote", def.kind);
    if (def.kind !== "quote") assert.match(def.body, /Kind regards,\n(\{\{sender_name\}\}\n)?\{\{company_name\}\}$/, def.kind);
  }
});

test("a layout with no mark still gets the signature — under everything, before </body>", () => {
  const signature = buildSignature(PAT, COMPANY);
  const plain = "<html><head><title>x</title></head><body><p>message</p></body></html>";
  const signed = placeSignatureInEmail(plain, signature, SENDER_SIGNATURE_SLOT);
  assert.ok(signed.indexOf("message") < signed.indexOf(signature) && signed.indexOf(signature) < signed.indexOf("</body>"));
  assert.match(signed, /<div style="text-align:center;padding:4px 12px 0;"><div style="display:inline-block;text-align:left;max-width:100%;/);
  assert.equal(placeSignatureInEmail("<p>bare</p>", "<b>sig</b>").startsWith("<p>bare</p><div"), true);
  // Nothing to place changes nothing. And a "$" in a signature is text, not a replacement pattern.
  assert.equal(placeSignatureInEmail(plain, "   "), plain);
  assert.ok(placeSignatureInEmail(`<body>${SENDER_SIGNATURE_SLOT}</body>`, "<b>R$& $1 $'</b>", SENDER_SIGNATURE_SLOT).includes("<b>R$& $1 $'</b>"));
});

test("it brings the rules that stack the card on a phone — the same ones the composer's email has", () => {
  const signature = buildSignature(PAT, COMPANY);
  const composer = buildEmailHtml("<p>Hello</p>", signature);
  const rules = composer.slice(composer.indexOf("<link href="), composer.indexOf("</style>") + "</style>".length);
  assert.match(rules, /@media \(max-width: 600px\)[\s\S]*\.sig-panel \{ display: block !important;/);
  const signed = placeSignatureInEmail(renderSigningEmail("quote", null, VARS, BRAND).html, signature, SENDER_SIGNATURE_SLOT);
  assert.ok(signed.includes(rules), "byte for byte the composer's");
  assert.equal(signed.split(rules).length - 1, 1);
  assert.ok(signed.indexOf(rules) < signed.indexOf("</head>"));
  // A document with no closing head tag gets them straight before <body>.
  const open = placeSignatureInEmail("<html><head><title>x</title><body style=\"margin:0\"><p>m</p></body></html>", signature);
  assert.ok(open.includes(rules) && open.indexOf(rules) < open.search(/<body[\s>]/i));
});

test("a signature banner still goes under the whole email, after the signed card", () => {
  const signature = buildSignature(PAT, COMPANY);
  const signed = placeSignatureInEmail(renderSigningEmail("quote", null, VARS, BRAND).html, signature, SENDER_SIGNATURE_SLOT);
  const withBanner = placeBannerInEmail(signed, "<table><tr><td>BANNER</td></tr></table>", "below");
  assert.ok(withBanner.indexOf(signature) < withBanner.indexOf("BANNER"));
  assert.ok(withBanner.indexOf("BANNER") < withBanner.indexOf("</body>"));
});

test("the default Quote email ends at “Kind regards,” — the signature carries the name, so it is not printed twice", () => {
  const def = SIGNING_EMAILS.quote;
  assert.match(def.body, /\n\nKind regards,$/);
  assert.doesNotMatch(def.body, /\{\{sender_name\}\}|\{\{company_name\}\}\s*$/);
  assert.equal(validateSigningTemplate("quote", def.subject, def.body), null, "still a valid template");
  const email = renderSigningEmail("quote", null, VARS, BRAND);
  assert.match(email.text, /Kind regards,$/);
  assert.equal(email.html.includes("Pat Smith"), false, "the message itself no longer types the sender's name");
  const signed = placeSignatureInEmail(email.html, buildSignature(PAT, COMPANY), SENDER_SIGNATURE_SLOT);
  assert.equal(signed.split(">Pat Smith<").length - 1 + signed.split("Pat Smith</").length - 1 >= 1, true, "the signature does");
});

test("the designed quote email is not changed by this: it never held the typed name lines", () => {
  // The layout designed in the editor builds each message WITHOUT a trailing name line — its frame's
  // signature block carries the name. So the wording with the two name lines and the wording without
  // them make the same designed email: nothing to refresh, and nothing may be recorded as replaced.
  const before = { subject: SIGNING_EMAILS.quote.subject, body: `${SIGNING_EMAILS.quote.body}\n{{sender_name}}\n{{company_name}}`, headline: "Your quotation {{quote_number}}" };
  assert.deepEqual(defaultEmailBody("quote", null, before), defaultEmailBody("quote"));
  assert.equal(isUntouchedEmailSeed("quote", defaultEmailBody("quote")), false, "the current quote draft is current — never taken for an old seed");
  assert.equal(REPLACED_STANDARD_WORDINGS.length, 2, "no revision was added for this change");
});

test("the plain-text half is signed too: who sent it and how to reach them", () => {
  assert.equal(signatureText(PAT, "Acme Carts"), "Pat Smith\nSales Manager\nAcme Carts\n082 555 0101\npat@acme.test");
  assert.equal(signatureText({ name: "Pat Smith", email: "pat@acme.test", mobile: null, jobTitle: "  " }, "Acme Carts"), "Pat Smith\nAcme Carts\npat@acme.test", "blank lines are left out");
});

test("the quote action: the person in the workspace's signature style, never a second signature on a designed email, and never a lost email", () => {
  const action = code("src/app/actions/quoteEmail.ts");
  const sign = action.slice(action.indexOf("async function signQuoteEmail"), action.indexOf("/** What the dialog shows before anything is sent"));
  // The layout designed in the editor has its own signature block: it is left exactly as it is.
  assert.match(sign, /if \(email\.designed\) return email;/);
  assert.ok(sign.indexOf("if (email.designed) return email;") < sign.indexOf("prisma.user.findUnique"), "before anything is read or built");
  assert.match(code("src/lib/signing/signingEmail.ts"), /return \{ designed: true, \.\.\.renderEmailDocument\(\{/);
  // This person, the workspace's design, its own origin for the icons.
  assert.match(sign, /prisma\.user\.findUnique\(\{ where: \{ id: user\.id \}, select: \{ name: true, email: true, mobile: true, jobTitle: true, signatureHtml: true \} \}\)/);
  assert.match(sign, /getSetting\(SIGNATURE_DESIGN_KEY\)\.then\(parseSignatureDesign\)/);
  // Inside the card the header has the logo and the footer the company's details: the signature leaves
  // them out — which also keeps it within the card's width (the logo panel alone is wider).
  assert.match(sign, /signatureCompanyFrom\(\s*\{ \.\.\.profile, tagline: "", address: "", phone: "", logoUrl: "" \},\s*origin,\s*\{ \.\.\.design, bannerUrl: "" \},\s*\)/);
  assert.match(sign, /placeSignatureInEmail\(email\.html, buildSignature\(person, company\), SENDER_SIGNATURE_SLOT\)/);
  assert.match(sign, /catch \(err\) \{[\s\S]*return email;/, "a signature that cannot be built costs the signature, not the email");
  const send = action.slice(action.indexOf("export async function sendQuoteEmail"));
  assert.ok(send.indexOf("const signed = await signQuoteEmail(user, quote.tenantId, email);") < send.indexOf("await emailWithBanner({"));
  assert.match(send, /await emailWithBanner\(\{\s*html: signed\.html,/);
  assert.match(send, /text: signed\.text,\s*html: marketed\.html,/);
  // The dialog says so, where the person is typing.
  assert.match(code("src/components/quotes/QuoteEmailDialog.tsx"), /with your own email signature under it — so there is no need to type your name/);
});
