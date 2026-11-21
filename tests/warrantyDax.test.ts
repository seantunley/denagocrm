import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { currentOwnersCertificate, linkedDocumentIds, wantsCertificate, MAX_CERTIFICATES_SENT } from "../src/lib/assistantWarrantyCertificateRules";
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

test("after a transfer, the previous owner's certificate is never sent or offered as the new owner's", () => {
  const oldOwners = { id: "doc1", contactId: "anna" };
  assert.equal(currentOwnersCertificate([oldOwners], "ben"), null, "Ben now owns it: Anna's certificate isn't his");
  assert.equal(currentOwnersCertificate([oldOwners], "anna"), oldOwners);
  assert.equal(currentOwnersCertificate([{ id: "doc2", contactId: null }], "ben"), null, "a de-identified owner's neither");
  // Every reader applies it: the email send, DAX's lookup, DAX's WhatsApp send, and the vehicle page's Send button.
  const send = code("src/app/actions/warrantyCertificateSend.ts");
  assert.match(send, /const certificate = currentOwnersCertificate\(vehicle\.documents, c\.id\);\s*if \(!certificate\) return refuse\(REISSUE_FOR_OWNER\);/);
  const lookup = code("src/lib/assistant/lookups/vehicleWarranty.ts");
  assert.match(lookup, /const certificate = currentOwnersCertificate\(v\.documents, v\.contactId\);/);
  assert.match(lookup, /only a previous owner's is filed — a new one must be issued for the current owner/);
  assert.match(code("src/lib/assistantWarrantyCertificate.ts"), /if \(!vehicle \|\| !currentOwnersCertificate\(\[doc\], vehicle\.contactId\)\) continue;/);
  const card = code("src/components/VehicleWarrantyParts.tsx");
  assert.match(card, /const previousOwners = !!certificate && certificate\.contactId !== vehicle\.contactId;/);
  assert.match(card, /\{certificate && !previousOwners && \(/, "no Send for a previous owner's certificate");
});
