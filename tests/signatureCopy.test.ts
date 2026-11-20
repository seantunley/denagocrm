import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SIGNATURE_GUIDES, absolutise, plainSignature } from "../src/lib/signatureCopy";
import { DEFAULT_SIGNATURE_COMPANY, buildSignature, signatureAssetOrigin, type SignatureCompany } from "../src/lib/signature";

/**
 * Copy my signature (lib/signatureCopy.ts): the CRM's own signature, for Gmail,
 * Outlook or a phone. What these hold: the copy is the signature the send path
 * builds, every picture in it has a full address once it leaves the CRM, and a
 * phone gets readable text rather than a stripped table.
 */

const code = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

const company = (over: Partial<SignatureCompany> = {}): SignatureCompany => ({
  ...DEFAULT_SIGNATURE_COMPANY,
  name: "Acme Motors",
  website: "https://acme.example/",
  switchboard: "021 555 0100",
  assetBase: "https://crm.acme.example",
  logoUrl: "/api/brand/logo/t1",
  ...over,
});
const person = { name: "Thandi Nkosi", email: "thandi@acme.example", mobile: "082 555 0101", jobTitle: "Sales Executive", signatureHtml: null };

test("a root-relative picture or link gets the workspace's origin; everything else is left alone", () => {
  const html = `<img src="/api/brand/logo/t1"><a href='/book'>x</a><img src="https://cdn.example/a.png"><a href="mailto:a@b.co">m</a><a href="tel:+27825550101">t</a><img src="//cdn.example/b.png"><a href="#top">top</a>`;
  assert.equal(
    absolutise(html, "https://crm.acme.example/"),
    `<img src="https://crm.acme.example/api/brand/logo/t1"><a href='https://crm.acme.example/book'>x</a><img src="https://cdn.example/a.png"><a href="mailto:a@b.co">m</a><a href="tel:+27825550101">t</a><img src="//cdn.example/b.png"><a href="#top">top</a>`,
  );
});

test("an origin that is not an http address changes nothing", () => {
  const html = `<img src="/logo.png">`;
  for (const origin of ["", "javascript:alert(1)", 'https://x" onerror="y', "crm.acme.example"]) assert.equal(absolutise(html, origin), html, origin);
});

test("both designs, copied, have no picture or link the mail app could not load", () => {
  for (const style of ["card", "classic"] as const) {
    const c = company({ design: { style, companyLine: "", footerLine: "", bannerUrl: "" }, facebook: "https://facebook.com/acme", instagram: "https://instagram.com/acme" });
    const html = absolutise(buildSignature(person, c), signatureAssetOrigin(c));
    const addresses = [...html.matchAll(/\b(?:src|href)=["']([^"']*)["']/gi)].map((m) => m[1]);
    assert.ok(addresses.length > 3, `${style}: the signature has pictures and links`);
    for (const address of addresses) assert.match(address, /^(https:\/\/|mailto:|tel:)/, `${style}: ${address}`);
    assert.match(html, /https:\/\/crm\.acme\.example\/api\/brand\/logo\/t1/, `${style}: the logo is addressed in full`);
  }
});

test("the asset origin is the workspace's domain, else the platform's — never empty", () => {
  assert.equal(signatureAssetOrigin({ assetBase: "https://crm.acme.example/" }), "https://crm.acme.example");
  assert.match(signatureAssetOrigin({ assetBase: "  " }), /^https?:\/\/[^/]+$/);
});

test("the plain-text signature is the person's details, one per line", () => {
  assert.equal(
    plainSignature(person, company()),
    ["Thandi Nkosi", "Sales Executive | Acme Motors", "M 082 555 0101  T 021 555 0100", "thandi@acme.example", "acme.example"].join("\n"),
  );
});

test("an unset detail is a line that is not there", () => {
  assert.equal(
    plainSignature({ name: "Thandi Nkosi", email: "thandi@acme.example" }, company({ switchboard: "", website: "" })),
    ["Thandi Nkosi", "Acme Motors", "thandi@acme.example"].join("\n"),
  );
  // The company's number is not repeated when it is the person's own.
  assert.match(plainSignature({ ...person, mobile: "021 555 0100" }, company()), /^M 021 555 0100$/m);
});

test("the workspace's own company line is used when the owner set one", () => {
  const c = company({ design: { style: "card", companyLine: "Acme Motors Cape Town", footerLine: "", bannerUrl: "" } });
  assert.match(plainSignature(person, c), /^Sales Executive \| Acme Motors Cape Town$/m);
});

test("someone using their own HTML gets that signature — designed and plain", () => {
  const own = { ...person, signatureHtml: "<p>Thandi</p><p>Acme &amp; Sons</p>" };
  assert.equal(buildSignature(own, company()), own.signatureHtml);
  assert.equal(plainSignature(own, company()), "Thandi\nAcme & Sons");
});

test("every guide starts with the copy button its app needs, and a phone gets plain text", () => {
  assert.deepEqual(SIGNATURE_GUIDES.map((g) => g.id), ["gmail", "outlook", "outlook-classic", "apple-mail", "phone"]);
  for (const guide of SIGNATURE_GUIDES) {
    assert.ok(guide.steps.length >= 4, guide.id);
    assert.match(guide.steps[0], guide.copy === "plain" ? /Copy as plain text/ : /Copy my signature/, guide.id);
  }
  const phone = SIGNATURE_GUIDES.find((g) => g.id === "phone")!;
  assert.equal(phone.copy, "plain");
  assert.match(phone.note ?? "", /plain text/);
});

test("the page copies what the send path builds, with full addresses", () => {
  const page = code("src/app/(app)/settings/page.tsx");
  assert.match(page, /html=\{absolutise\(buildSignature\(currentUser, signatureCompany\), signatureAssetOrigin\(signatureCompany\)\)\}/);
  assert.match(page, /text=\{plainSignature\(currentUser, signatureCompany\)\}/);
  // The same builder and the same company the composer sends with.
  assert.match(code("src/lib/composerSend.ts"), /buildSignature\(user, company\)/);
});

test("the designed copy goes on the clipboard as HTML with plain text beside it — never plain passed off as designed", () => {
  const button = code("src/components/CopySignature.tsx");
  assert.match(button, /"text\/html": new Blob\(\[html\], \{ type: "text\/html" \}\)/);
  assert.match(button, /"text\/plain": new Blob\(\[text\], \{ type: "text\/plain" \}\)/);
  // No HTML clipboard: say so and stop, before anything is written.
  assert.match(button, /if \(typeof ClipboardItem === "undefined" \|\| !navigator\.clipboard\?\.write\) \{\s*toast\.error\([^)]*\);\s*return;/);
  // The signature is never injected into this page to be copied.
  assert.doesNotMatch(button, /dangerouslySetInnerHTML|innerHTML|execCommand/);
});
