import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSignature, DEFAULT_SIGNATURE_DESIGN, parseSignatureDesign, type SignatureCompany } from "../src/lib/signature";
import { cleanDetail, extrasHtml, legalHtml, missingBasics, parseLegal, SIGNATURE_FIELDS } from "../src/lib/signaturePeople";

// The Email signatures pack, items 6, 8 and 10 (Sean, 2026-11-20): the owner's small print under every signature,
// telling the owner whose signature is missing details, and a line of each person's own.

const src = (f: string) => readFileSync(f, "utf8");
const company: SignatureCompany = {
  name: "Acme", tagline: "", address: "", website: "", switchboard: "", assetBase: "", logoUrl: "", facebook: "", instagram: "",
};
const person = { name: "Ann", email: "ann@example.com", mobile: "082 111 2222", jobTitle: "Sales" };
const legal = { companyLine: "Acme (Pty) Ltd · Reg. 2015/1 · VAT 41 <x>", notice: "Confidential.", privacyUrl: "https://acme.example/privacy" };

test("small print: cleaned, https-only link, escaped; nothing set adds nothing", () => {
  assert.deepEqual(parseLegal({ companyLine: " a\nb ", notice: "n", privacyUrl: "javascript:alert(1)" }), { companyLine: "a b", notice: "n", privacyUrl: "" });
  assert.deepEqual(parseLegal(undefined), { companyLine: "", notice: "", privacyUrl: "" });
  assert.equal(parseLegal({ notice: "x".repeat(2000) }).notice.length, 800);
  assert.equal(legalHtml(parseLegal({}), "#f00"), "");
  const html = legalHtml(legal, "#f00");
  assert.match(html, /VAT 41 &lt;x&gt;/);
  assert.match(html, /<a href="https:\/\/acme\.example\/privacy"[^>]*>Privacy policy<\/a>/);
  assert.match(html, /Confidential\./);
});

test("small print goes under every signature built — every design, and short replies — never under someone's own HTML", () => {
  for (const style of ["card", "classic", "modern", "compact", "minimal"] as const) {
    const design = { ...DEFAULT_SIGNATURE_DESIGN, style, legal };
    assert.match(buildSignature(person, { ...company, design }), /Confidential\./, style);
    assert.doesNotMatch(buildSignature(person, { ...company, design: { ...design, legal: parseLegal({}) } }), /Privacy policy/, `${style}: none set`);
  }
  const short = buildSignature({ ...person, reply: true }, { ...company, design: { ...DEFAULT_SIGNATURE_DESIGN, shortReplies: true, legal } });
  assert.match(short, /Confidential\./);
  assert.doesNotMatch(buildSignature({ ...person, signatureHtml: "<b>mine</b>" }, { ...company, design: { ...DEFAULT_SIGNATURE_DESIGN, legal } }), /Confidential/);
  assert.deepEqual(parseSignatureDesign(JSON.stringify({ legal })).legal, legal, "stored on the design");
});

test("the owner sets the small print with the rules; a bad privacy link is refused, not dropped quietly", () => {
  const actions = src("src/app/actions/emailSignatures.ts");
  const rules = actions.slice(actions.indexOf("export async function saveSignatureRules"));
  assert.match(rules, /requireTenantOwner\(\)/);
  assert.match(rules, /legal: \{\s*companyLine: String\(formData\.get\("legalCompanyLine"\)/);
  assert.match(rules, /if \(privacyTyped && !next\.legal\?\.privacyUrl\) refuse\(/);
});

test("a line of their own: one more detail, lockable like the rest, shown in the colour", () => {
  assert.ok(SIGNATURE_FIELDS.includes("cta"));
  assert.equal(cleanDetail("cta", "x".repeat(121)).ok, false);
  assert.match(extrasHtml({ cta: "Ask me about <the> new model" }, "", "#7c3aed"), /color:#7c3aed;font-weight:bold;">Ask me about &lt;the&gt; new model/);
  assert.match(src("src/app/actions/emailSignatures.ts"), /cta: "signatureCta",/);
  assert.match(src("src/lib/signatureSender.ts"), /cta: person\.signatureCta,/);
  const sql = src("prisma/migrations/20261120140000_user_signature_cta/migration.sql");
  assert.match(sql, /ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "signatureCta" TEXT;/);
  assert.doesNotMatch(sql, /DROP|DELETE|NOT NULL/i);
});

test("missing details: the owner sees whose signature lacks a job title or mobile; each person sees their own", () => {
  assert.deepEqual(missingBasics({ jobTitle: "Sales", mobile: "082" }), []);
  assert.deepEqual(missingBasics({ jobTitle: " ", mobile: null }), ["job title", "mobile"]);
  const ui = src("src/components/EmailSignatureDetails.tsx");
  assert.match(ui, /const incomplete = staff\.filter\(\(person\) => missingBasics\(person\)\.length > 0\);/);
  assert.match(ui, /\{missingBasics\(me\)\.length > 0 && \(/);
});
