import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSignature, DEFAULT_SIGNATURE_DESIGN, type SignatureCompany } from "../src/lib/signature";
import { withoutPackExtras } from "../src/lib/signatureDesigns";

// Review of #1162: the Email signatures pack OFF means the signature from before the pack — its extras pause (the stored
// design keeps them for when it is switched back on), and staff keep their own HTML signature as before.

const src = (f: string) => readFileSync(f, "utf8");
const company: SignatureCompany = {
  name: "Acme", logoUrl: "", website: "", switchboard: "", address: "", tagline: "", facebook: "", instagram: "",
  assetBase: "https://crm.example.com", design: DEFAULT_SIGNATURE_DESIGN,
};
const person = { name: "Ann Smith", email: "ann@example.com", mobile: "082 111 2222", jobTitle: "Sales", signatureHtml: null };

test("off: a pack design falls back to the card; no short reply, privacy link or link counting", () => {
  const saved = { ...DEFAULT_SIGNATURE_DESIGN, style: "modern" as const, shortReplies: true, legal: { privacyUrl: "https://acme.example/privacy" }, trackLinks: true, teams: [{ teamId: "team_aaaaaa", line: "x" }] };
  const off = withoutPackExtras(saved);
  assert.equal(off.style, "card");
  assert.equal(off.shortReplies, false);
  assert.equal(off.legal?.privacyUrl, "");
  assert.equal(off.trackLinks, false);
  assert.deepEqual(saved.teams, off.teams, "the rules are not thrown away");
  assert.equal(saved.style, "modern", "the stored design is untouched");
  const reply = buildSignature({ ...person, reply: true }, { ...company, design: off });
  assert.equal(reply, buildSignature(person, { ...company, design: DEFAULT_SIGNATURE_DESIGN }), "exactly the automatic signature");
  assert.equal(withoutPackExtras({ ...DEFAULT_SIGNATURE_DESIGN, style: "classic" }).style, "classic", "the pre-pack designs stay");
});

test("every reader of the design uses it as the pack allows", () => {
  assert.match(src("src/lib/signatureSender.ts"), /tenantId && \(await isModuleEnabled\("signatures"\)\) \? design : withoutPackExtras\(design\)/);
  assert.match(src("src/lib/composerSend.ts"), /const design = await signatureDesignInUse\(tenantId, parseSignatureDesign\(/);
  assert.match(src("src/app/actions/quoteEmail.ts"), /const design = await signatureDesignInUse\(tenantId, saved\);/);
  assert.match(src("src/app/(app)/settings/page.tsx"), /const signatureDesign = await signatureDesignInUse\(signatureTenantId, parseSignatureDesign\(/);
});

test("own HTML: owner-only while the pack is on; anyone, as before, while it is off; anyone may remove theirs", () => {
  assert.match(src("src/app/actions/settings.ts"), /if \(signatureHtml && \(await isModuleEnabled\("signatures"\)\) && !\(await isTenantOwner\(\)\)\) \{/);
  const section = src("src/components/EmailSignatureSection.tsx");
  assert.match(section, /const mayEditHtml = canEditDesign \|\| !htmlOwnerOnly;/);
  assert.match(section, /\{!mayEditHtml \? \([\s\S]*?<input type="hidden" name="signatureHtml" value="" \/>[\s\S]*?Remove my HTML signature/, "staff on the pack's page can only remove it");
  assert.match(src("src/app/(app)/email-signatures/page.tsx"), /moreDesigns\s+htmlOwnerOnly\s+\/>/, "the pack's page: owner only");
  assert.doesNotMatch(src("src/app/(app)/settings/page.tsx"), /htmlOwnerOnly/, "Settings (pack off): as before");
});
