import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.SESSION_SECRET ||= "test-secret-for-contact-cards";

import { vCard, contactCardFileName, parseContactCard } from "../src/lib/contactCard";
import { contactCardLinks, contactCardToken, verifyContactCardToken } from "../src/lib/contactCardToken";
import { extrasHtml } from "../src/lib/signaturePeople";
import { parseSignatureDesign } from "../src/lib/signature";
import { withoutPackExtras } from "../src/lib/signatureDesigns";
import { signatureLinkKind } from "../src/lib/signatureLinks";

/**
 * "Save my contact" (Sean, 2026-11-20): a link (or QR code) under the signature that adds the person to the customer's
 * phone. What these hold: the card is the signature's details and opens on any phone; the link can't be forged; the
 * owner's choice is off by default and pauses with the pack; and the public route only serves a card still on offer.
 */
const code = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

test("the card holds the signature's details, escaped, each number once, the address as plain text", () => {
  const card = vCard(
    { name: "Thandi van der Merwe", email: "thandi@acme.example", mobile: "082 555 0101", jobTitle: "Sales, New; Used", directLine: "021 555 0199", whatsapp: "082 555 0101" },
    { name: "Acme Motors", website: "https://acme.example", switchboard: "021 555 0100", address: "12 Main Rd &amp; Long St &middot; Cape Town" },
  );
  assert.equal(
    card,
    [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "N:Merwe;Thandi van der;;;",
      "FN:Thandi van der Merwe",
      "ORG:Acme Motors",
      "TITLE:Sales\\, New\\; Used",
      "TEL;TYPE=CELL:082 555 0101",
      "TEL;TYPE=WORK,VOICE:021 555 0199",
      "TEL;TYPE=WORK,MAIN:021 555 0100",
      "EMAIL;TYPE=INTERNET,WORK:thandi@acme.example",
      "URL:https://acme.example",
      "ADR;TYPE=WORK:;;12 Main Rd & Long St · Cape Town;;;;",
      "END:VCARD",
      "",
    ].join("\r\n"),
  );
  // An unset detail is a line that is not there; a line break can't start a new vCard property.
  const bare = vCard({ name: "Ann\nEVIL:1", email: "ann@x.example" }, { name: "", website: "", switchboard: "", address: "" });
  assert.doesNotMatch(bare, /ORG:|TITLE:|TEL;|URL:|ADR;/);
  assert.match(bare, /^FN:Ann\\nEVIL:1$/m);
  assert.equal(contactCardFileName('Thandi "T" Nkosi/../'), "Thandi T Nkosi.vcf");
});

test("the link is signed: the right person verifies, a changed or foreign one does not", () => {
  const token = contactCardToken("tenant_acme", "user_123456")!;
  assert.match(token, /^tenant_acme\.user_123456\.[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(verifyContactCardToken(token), { tenantId: "tenant_acme", userId: "user_123456" });
  for (const forged of [
    token.replace("user_123456", "user_999999"),
    token.replace("tenant_acme", "tenant_other"),
    `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`,
    `${token}.x`,
    "tenant_acme.user_123456",
    "",
  ]) assert.equal(verifyContactCardToken(forged), null, forged);
});

test("the owner's choice: off unless chosen, a QR only with 'qr', and paused with the pack", () => {
  assert.equal(parseSignatureDesign("{}").contactCard, undefined);
  assert.equal(parseSignatureDesign('{"contactCard":"off"}').contactCard, undefined);
  assert.equal(parseSignatureDesign('{"contactCard":"qr"}').contactCard, "qr");
  assert.equal(withoutPackExtras(parseSignatureDesign('{"contactCard":"link"}')).contactCard, undefined);
  assert.deepEqual(contactCardLinks("tenant_acme", "user_123456", undefined, "https://crm.acme.example"), {});
  assert.deepEqual(contactCardLinks(null, "user_123456", "qr", "https://crm.acme.example"), {});
  const link = contactCardLinks("tenant_acme", "user_123456", "link", "https://crm.acme.example/");
  assert.match(link.contactCardUrl!, /^https:\/\/crm\.acme\.example\/api\/contact-card\/tenant_acme\.user_123456\./);
  assert.equal(link.contactQrUrl, undefined);
  const qr = contactCardLinks("tenant_acme", "user_123456", "qr", "https://crm.acme.example");
  assert.equal(qr.contactQrUrl, `${qr.contactCardUrl}/qr`);
  assert.equal(parseContactCard("link"), "link");
});

test("the signature shows the link, and the QR code linked to the same card; nothing when off", () => {
  const { contactCardUrl, contactQrUrl } = contactCardLinks("tenant_acme", "user_123456", "qr", "https://crm.acme.example");
  const html = extrasHtml({ contactCardUrl, contactQrUrl }, "", "#123456");
  assert.match(html, new RegExp(`<a href="${contactCardUrl!.replace(/[.]/g, "\\.")}"[^>]*>Save my contact</a>`));
  assert.match(html, /<img src="[^"]+\/qr" alt="QR code: save my contact" width="88" height="88"/);
  assert.match(html, /Scan with your phone to save my contact/);
  assert.doesNotMatch(extrasHtml({ contactCardUrl }, "", "#123456"), /<img/);
  assert.equal(extrasHtml({}, "", "#123456"), "");
  // A counted link knows what it is.
  assert.equal(signatureLinkKind(contactCardUrl!, {}), "contact");
});

test("the public card is served only while it is on offer, and the routes are public and plain", () => {
  const server = code("src/lib/contactCardServer.ts");
  // In that workspace's own scope; the workspace active, the pack on, the owner's choice on, the person still a member.
  assert.match(server, /runInTenantScope\(\{ tenantId, system: false \}/);
  assert.match(server, /if \(!tenant\?\.active \|\| !\(await isModuleEnabled\("signatures"\)\)\) return null;/);
  assert.match(server, /if \(!design\.contactCard\) return null;/);
  assert.match(server, /where: \{ id: userId, memberships: \{ some: \{ tenantId \} \} \}/);
  // Never the photo.
  assert.doesNotMatch(server, /avatarRef|signaturePhoto/);
  assert.match(code("src/proxy.ts"), /"\/api\/contact-card",/);
  const route = code("src/app/api/contact-card/[token]/route.ts");
  assert.match(route, /"Content-Type": "text\/vcard; charset=utf-8"/);
  assert.match(route, /status: 404/);
  assert.match(code("src/app/api/contact-card/[token]/qr/route.ts"), /card\?\.design\.contactCard === "qr"/);
  // An email from the CRM carries the QR picture, drawn only for a token of the sending workspace.
  assert.match(code("src/lib/emailInlineLogo.ts"), /verifyContactCardToken\(qrToken\)\?\.tenantId !== tenantId\) return null;/);
  // The sender's signature gets the links from the owner's choice.
  assert.match(code("src/lib/signatureSender.ts"), /\.\.\.contactCardLinks\(tenantId, userId, design\.contactCard, origin\)/);
});
