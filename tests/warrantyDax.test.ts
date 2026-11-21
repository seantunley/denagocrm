import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { linkedDocumentIds, wantsCertificate, MAX_CERTIFICATES_SENT } from "../src/lib/assistantWarrantyCertificateRules";
import { CERTIFICATE_NOT_CURRENT, certificateFingerprint, certificateState } from "../src/lib/warrantyCertificateState";
import { vehicleArgs } from "../src/lib/crmAssistantPlan";
import { selfKnowledge } from "../src/lib/assistantSoul";
import { SIGNING_EMAILS } from "../src/lib/signing/emailTemplates";
import type { ModuleId } from "../src/lib/modules/registry";

/**
 * Sean, 2026-11-21: "DAX must be able to check warranties on vehicles and know which vehicle belongs to which customer …
 * and which vehicle has been purchased. DAX must be able to retrieve the warranty information and send the warranty
 * certificate to chat when requested." Decided: to the person asking only, as with quotes. Sending it to the owner is a
 * person's Send, behind a Confirm.
 */
const code = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

test("DAX can ask for warranties: who owns what, what they bought, each part's cover, the certificate's link", () => {
  assert.ok(vehicleArgs.safeParse({ kind: "warranty", search: "Sipho Nomad" }).success);
  assert.match(code("src/lib/crmAssistantPlan.ts"), /kind warranty: who owns which vehicle and what they bought[\s\S]*it is delivered to the person asking, never to the customer/);
  assert.match(code("src/lib/assistant/lookups/vehicles.ts"), /if \(args\.kind === "warranty"\) return vehicleWarranty\(user, \{ search: args\.search, limit: args\.limit \}\);/);
  const lookup = code("src/lib/assistant/lookups/vehicleWarranty.ts");
  assert.match(lookup, /if \(!\(await isModuleEnabled\("warranty"\)\)\) return/);
  assert.match(lookup, /if \(!\(await hasAnyPermission\(user, \.\.\.WARRANTY_READ\)\)\) return refused\("warranties"\);/);
  assert.match(lookup, /\.\.\.\(accessible \? \{ id: \{ in: accessible \} \} : \{\}\)/, "only vehicles they may open");
  assert.match(lookup, /owner: contactName\(v\.contact\), ownerLink: `\/contacts\/\$\{v\.contactId\}`, product:/);
  assert.match(lookup, /cover: vehicleCover\(v, now\)\.map/);
  assert.match(lookup, /certificate: certificate\s*\? \{ link: `\/api\/files\/\$\{certificate\.id\}`/);
  assert.match(selfKnowledge("DAX", new Set(["core", "automotive", "warranty"] as ModuleId[])), /warranty certificate — which you send to the person asking/);
  assert.doesNotMatch(selfKnowledge("DAX", new Set(["core", "automotive"] as ModuleId[])), /warranty certificate/);
});

test("on WhatsApp: the certificates DAX linked go to the asker's own phone, each re-checked — never a customer", () => {
  assert.ok(wantsCertificate("send me the warranty certificate for Sipho's cart"));
  assert.ok(wantsCertificate("cert for VIN 123?"));
  assert.ok(!wantsCertificate("what warranty is on the Nomad?"));
  assert.deepEqual(linkedDocumentIds("Here: [certificate](/api/files/cmabc12345) and /api/files/cmabc12345 again, /api/files/cmdef67890"), ["cmabc12345", "cmdef67890"]);
  assert.equal(linkedDocumentIds(Array.from({ length: 6 }, (_, i) => `/api/files/doc0000000${i}`).join(" ")).length, MAX_CERTIFICATES_SENT);
  const sender = code("src/lib/assistantWarrantyCertificate.ts");
  assert.match(sender, /where: \{ id, tenantId, tag: CERTIFICATE_TAG, deletedAt: null, replacedById: null \}/, "only a current certificate, only this workspace");
  assert.match(sender, /if \(!doc\?\.vehicleId \|\| !\(await canAccessVehicle\(user, doc\.vehicleId\)\)\) continue;/);
  assert.match(sender, /if \(!\(await input\.phoneSafe\(\)\)\) return sent;/);
  assert.match(sender, /sendWhatsAppDocument\(waId, \{ content: pdf, filename: doc\.fileName, contentType: "application\/pdf" \}, "Warranty certificate — for you\. This copy was not sent to the customer\."\)/);
  assert.doesNotMatch(sender, /sendWhatsAppDocument\([^)]*record/, "no customer record: nothing on a customer's timeline");
  assert.match(code("src/lib/assistantWhatsApp.ts"), /if \(answer && wantsCertificate\(q\)\) await sendCertificatesInAnswer\(\{ tenantId, user, waId, answer, phoneSafe: \(\) => staffPhoneStillSafe\(tenantId, user\.id, waId\) \}\);/);
});

test("to the owner: only on a Send behind a Confirm — consent-checked, the editable template, PDF attached, logged", () => {
  assert.equal(SIGNING_EMAILS.warranty_certificate.group, "Service & aftersales");
  assert.deepEqual(SIGNING_EMAILS.warranty_certificate.fields.slice(-2), ["model", "cover_lines"]);
  const send = code("src/app/actions/warrantyCertificateSend.ts");
  assert.match(send, /requireVehicleAccess\(vehicleId, "warranty\.manage"\)/);
  assert.match(send, /firstAllowedChannel\(\{ contactId: c\.id, tenantId, purpose: "service", channels: \["email"\] \}\)/);
  assert.match(send, /tenantEmailContent\("warranty_certificate", tenantId,/);
  assert.match(send, /attachments: \[\{ filename: certificate\.fileName, content: pdf, contentType: "application\/pdf" \}\]/);
  assert.match(send, /prisma\.communication\.create\(/);
  assert.match(send, /action: "vehicle\.warranty_certificate_sent"/);
  const card = code("src/components/VehicleWarrantyParts.tsx");
  assert.match(card, /confirmLabel="Send"\s*onConfirm=\{sendWarrantyCertificate\.bind\(null, vehicle\.id\)\}/);
  // Issuing never sends; the delivery never sends.
  assert.doesNotMatch(code("src/lib/warrantyCertificateStore.ts"), /sendEmail|sendWarrantyCertificate/);
});

test("a certificate is sent or offered only while it names the owner now and states the warranty as it is now", () => {
  const delivered = new Date("2026-11-21T00:00:00");
  const annaContact = {
    firstName: "Anna", lastName: "Smit", company: null, isCompany: false,
    phone: "082 000 0000", email: "anna@example.com", address: "1 Example Road", suburb: "Constantia", city: "Cape Town",
  };
  const anna = {
    contactId: "anna", model: "Nomad XL", vin: "VIN1", regNumber: null, color: "White", purchaseDate: delivered, warrantyMonths: null,
    warrantyParts: [{ part: "Battery", months: 60 }, { part: "Cart", months: 24 }, { part: "Chassis", months: null }],
    warrantyStartsAt: delivered, contact: annaContact, ownerships: [{ warranty: "carried" }],
  };
  // Issued: stamped with what it was made from.
  const cert = { contactId: "anna", issuedFrom: certificateFingerprint(anna) };
  assert.equal(certificateState(cert, anna), "current");
  // Review case: Cart extended 2 → 3 years. The old PDF says 2, so it can't go out with a 3-year email.
  const extended = { ...anna, warrantyParts: [{ part: "Battery", months: 60 }, { part: "Cart", months: 36 }, { part: "Chassis", months: null }] };
  assert.equal(certificateState(cert, extended), "out_of_date");
  assert.equal(certificateState(cert, { ...anna, warrantyStartsAt: new Date("2026-12-01T00:00:00") }), "out_of_date", "start date moved");
  assert.equal(certificateState(cert, { ...anna, contact: { ...annaContact, lastName: "Botha" } }), "out_of_date", "owner's name changed");
  // Review of #1174 [P2]: every owner detail a certificate can print — phone, email, address — and the registration.
  for (const changed of [{ phone: "083 111 1111" }, { email: "anna@new.example" }, { address: "9 New Street" }, { suburb: "Bishopscourt" }, { city: "Stellenbosch" }]) {
    assert.equal(certificateState(cert, { ...anna, contact: { ...annaContact, ...changed } }), "out_of_date", Object.keys(changed)[0]);
  }
  assert.equal(certificateState(cert, { ...anna, regNumber: "CA 1" }), "out_of_date", "registration");
  // Review of #1174 [P1]: the warranty didn't transfer to the owner (pending approval, or declined) — never current, even
  // for a certificate stamped for them; reissuing is refused too (#1173's ownerCovered).
  assert.equal(certificateState(cert, { ...anna, ownerships: [{ warranty: "pending" }] }), "not_covered");
  assert.equal(certificateState(cert, { ...anna, ownerships: [{ warranty: "not_carried" }] }), "not_covered");
  assert.equal(certificateState(cert, { ...anna, ownerships: [{ warranty: "carried" }] }), "current", "approved: current again");
  assert.match(CERTIFICATE_NOT_CURRENT.not_covered, /hasn't transferred/);
  // Reissued: current again, with the same body and PDF terms.
  assert.equal(certificateState({ contactId: "anna", issuedFrom: certificateFingerprint(extended) }, extended), "current");
  // Transferred to Ben: Anna's certificate isn't his, and a certificate from before stamping is never current.
  assert.equal(certificateState(cert, { ...anna, contactId: "ben", contact: { ...annaContact, firstName: "Ben" } }), "previous_owner");
  assert.equal(certificateState({ contactId: "anna", issuedFrom: null }, anna), "out_of_date");
  assert.match(CERTIFICATE_NOT_CURRENT.out_of_date, /Reissue it first/);

  // Issuing stamps it; every reader checks it: the email send, DAX's lookup, DAX's WhatsApp send, the vehicle page.
  assert.match(code("src/lib/warrantyCertificateStore.ts"), /issuedFrom: certificateFingerprint\(vehicle\),/);
  assert.match(code("prisma/migrations/20261121140000_document_issued_from/migration.sql"), /ADD COLUMN IF NOT EXISTS "issuedFrom" TEXT/);
  // One select for every reader: everything printed, plus the owner's open ownership row.
  const state = code("src/lib/warrantyCertificateState.ts");
  assert.match(state, /contact: \{ select: \{ firstName: true, lastName: true, company: true, isCompany: true, phone: true, email: true, address: true, suburb: true, city: true \} \},\s*ownerships: \{ where: \{ ownedUntil: null \}, select: \{ warranty: true \}, take: 1 \},/);
  const send = code("src/app/actions/warrantyCertificateSend.ts");
  assert.match(send, /\.\.\.CERTIFICATE_FACTS_SELECT,/);
  assert.match(send, /const state = certificateState\(certificate, vehicle\);\s*if \(state !== "current"\) return refuse\(CERTIFICATE_NOT_CURRENT\[state\]\);/);
  const lookup = code("src/lib/assistant/lookups/vehicleWarranty.ts");
  assert.match(lookup, /\.\.\.CERTIFICATE_FACTS_SELECT,/);
  assert.match(lookup, /const certificate = state === "current" \? filed : null;/);
  assert.match(lookup, /ownerCovered\(v\.ownerships\) \? \{\} : \{ warrantyForThisOwner:/, "DAX hears the warranty didn't transfer");
  const whatsapp = code("src/lib/assistantWarrantyCertificate.ts");
  assert.match(whatsapp, /select: CERTIFICATE_FACTS_SELECT,/);
  assert.match(whatsapp, /if \(!vehicle \|\| certificateState\(doc, vehicle\) !== "current"\) continue;/);
  assert.match(code("src/app/(app)/vehicles/[id]/page.tsx"), /state: certificateState\(filedCertificate, \{ \.\.\.vehicle, ownerships: \[\{ warranty: ownerWarranty \}\] \}\)/);
  const card = code("src/components/VehicleWarrantyParts.tsx");
  assert.match(card, /\{current && \(/, "Send only for a current certificate");
  assert.match(card, /canManage && cover\.length > 0 && ownerCovered && \(/, "no Send or Issue for an owner the warranty didn't transfer to");
});
