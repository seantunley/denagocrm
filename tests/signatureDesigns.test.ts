import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSignature, CARD_ORANGE, DEFAULT_SIGNATURE_DESIGN, parseSignatureDesign, type SignatureCompany } from "../src/lib/signature";
import { accentOf, BRAND_STYLES, DEFAULT_ACCENT } from "../src/lib/signatureDesigns";

// The Email signatures pack, item 5 (Sean, 2026-11-20): more designs, in each workspace's own colour. "The card style's
// orange and dark are fixed colours in the code, so check that another workspace doesn't get Denago's."

const src = (f: string) => readFileSync(f, "utf8");
const company: SignatureCompany = {
  name: "Acme Ltd", tagline: "Since 1990", address: "1 Main Rd", website: "acme.example", switchboard: "021 000 0000",
  assetBase: "https://crm.example.com", logoUrl: "https://crm.example.com/branding/logo.png", facebook: "", instagram: "",
};
const person = { name: "Ann <Smith>", email: "ann@example.com", mobile: "082 111 2222", jobTitle: "Sales" };
const sig = (style: string, accent?: string) =>
  buildSignature(person, { ...company, ...(accent ? { accent } : {}), design: { ...DEFAULT_SIGNATURE_DESIGN, style: style as "card" } });

test("the colour: a plain #rrggbb only; otherwise the design's own", () => {
  assert.equal(accentOf({ accent: "#123abc" }), "#123abc");
  assert.equal(accentOf({ accent: "red;background:url(x)" }), DEFAULT_ACCENT);
  assert.equal(accentOf({}), DEFAULT_ACCENT);
  assert.equal(accentOf({}, CARD_ORANGE), CARD_ORANGE);
});

test("the new designs are stored, drawn in the workspace colour, with no icon pictures; text is escaped", () => {
  for (const style of BRAND_STYLES) {
    assert.equal(parseSignatureDesign(JSON.stringify({ style })).style, style);
    const html = sig(style, "#7c3aed");
    assert.match(html, /#7c3aed/, style);
    assert.doesNotMatch(html, /#ea580c|#f1603c/i, `${style}: no orange when the workspace has a colour`);
    assert.doesNotMatch(html, /branding\/signature\/|social-/, `${style}: no icon images`);
    assert.match(html, /Ann &lt;Smith&gt;/, style);
    assert.doesNotMatch(html, /Ann <Smith>/, style);
    assert.match(sig(style), new RegExp(DEFAULT_ACCENT), `${style}: no colour set → orange`);
  }
  assert.equal(parseSignatureDesign(JSON.stringify({ style: "fancy" })).style, "card", "unknown → card");
  assert.doesNotMatch(sig("minimal", "#7c3aed"), /<img/, "minimal: no pictures");
  assert.match(sig("compact", "#7c3aed"), /<img src="https:\/\/crm\.example\.com\/branding\/logo\.png"/);
});

test("card and classic: unchanged without a colour; another workspace's colour replaces Denago's orange", () => {
  const card = sig("card");
  assert.match(card, /slant\.png/);
  assert.match(card, new RegExp(CARD_ORANGE));
  const purple = sig("card", "#7c3aed");
  assert.doesNotMatch(purple, new RegExp(CARD_ORANGE, "i"));
  assert.doesNotMatch(purple, /slant\.png/, "the orange stripe picture becomes a bar in the colour");
  assert.match(purple, /background-color:#7c3aed/);
  assert.match(purple, /colspan="4"/, "the footer spans the extra cell");
  assert.match(sig("classic"), /#ea580c/);
  assert.doesNotMatch(sig("classic", "#7c3aed"), /#ea580c/);
});

test("the colour reaches a signature only while the pack is on: one rule for every caller", () => {
  const sender = src("src/lib/signatureSender.ts");
  assert.match(sender, /export async function signatureAccent\(tenantId: string \| null\)[\s\S]*?if \(!tenantId \|\| !\(await isModuleEnabled\("signatures"\)\)\) return null;/);
  for (const f of ["src/lib/composerSend.ts", "src/app/actions/quoteEmail.ts", "src/app/(app)/settings/page.tsx", "src/app/(app)/email-signatures/page.tsx"]) {
    assert.match(src(f), /signatureCompanyFrom\([\s\S]{0,200}?await signatureAccent\(/, f);
  }
});

test("the new designs are offered and saved only while the pack is on; one already chosen stays", () => {
  const save = src("src/app/actions/emails.ts");
  assert.match(save, /if \(isBrandStyle\(style\) && style !== stored\.style && !\(await isModuleEnabled\("signatures"\)\)\) \{\s*refuse\(/);
  assert.match(src("src/components/SignatureDesignEditor.tsx"), /BRAND_STYLES\.filter\(\(style\) => moreDesigns \|\| design\.style === style\)/);
  assert.match(src("src/app/(app)/email-signatures/page.tsx"), /moreDesigns\b/);
  assert.doesNotMatch(src("src/app/(app)/settings/page.tsx"), /moreDesigns/, "Settings is where signatures live while the pack is off");
});
