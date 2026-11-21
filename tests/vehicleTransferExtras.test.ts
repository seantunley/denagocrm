import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { proposedAction } from "../src/lib/assistantActions";
import { WHATSAPP_CONFIRMABLE } from "../src/lib/assistantWhatsAppRules";
import { renderSigningEmail, SIGNING_EMAILS } from "../src/lib/signing/emailTemplates";
import { HELP_ARTICLES } from "../src/lib/help/content";

/**
 * Vehicle transfer, PR 3 (warranty-transfer-brief.md): the certificate, reminders following the owner, a welcome sent
 * only on a Confirm, DAX reading the history and proposing a transfer, and the help article.
 */
const code = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

test("the transfer certificate: staff with the vehicle, the module on; names only the new owner; cover on the transfer date", () => {
  const page = code("src/app/(print)/vehicles/[id]/transfer-certificate/page.tsx");
  assert.match(page, /await requireModuleEnabled\("automotive"\);\s*await requireVehicleReadAccess\(id\);/);
  assert.match(page, /where: \{ tenantId: vehicle\.tenantId, vehicleId: id, reversedAt: null, NOT: \{ reason: "registered" \}/, "a real transfer that wasn't undone");
  assert.match(page, /coverRemaining\(vehicle, transfer\.ownedFrom\)/);
  assert.match(page, /title="Vehicle transfer certificate"/);
  // Only the new owner's contact is read — never the previous one.
  assert.equal((page.match(/include: \{ contact: true \}/g) ?? []).length, 1);
  assert.doesNotMatch(page, /ownedUntil: \{ not: null \}|previous owner's/i);
});

test("reminders: anything queued for the old owner about this vehicle is cancelled, in the transfer's own transaction", () => {
  const core = code("src/lib/vehicleOwnership.ts");
  const transfer = core.slice(core.indexOf("export async function transferVehicleOwnership"), core.indexOf("export async function undoLastTransfer"));
  assert.match(transfer, /const stopped = await tx\.\$executeRaw`\s*UPDATE "JourneyRun"\s*SET "status" = 'cancelled'/);
  assert.match(transfer, /WHERE "tenantId" = \$\{tenantId\}\s*AND \("contactId" = \$\{vehicle\.contactId\} OR \("entityType" = 'contact' AND "entityId" = \$\{vehicle\.contactId\}\)\)/);
  assert.match(transfer, /"status" IN \('queued', 'running', 'waiting', 'blocked'\)/);
  // By the event that started the run — never a text search: every contact's context lists all their vehicles.
  assert.match(transfer, /AND "context"->'event'->>'vehicleId' = \$\{vehicleId\}`;/);
  assert.doesNotMatch(transfer, /"context"::text LIKE/);
  assert.match(code("src/lib/journeyScheduling.ts"), /payload: \{ vehicleId: vehicle\.id,/, "vehicle journeys name it in their event");
  // New reminders are addressed when they run, from the vehicle's owner — the new one.
  assert.match(code("src/lib/serviceReminders.ts"), /contactId: vehicle\.contactId/);
});

test("the welcome: editable and branded, sent only on a Confirm, through the consent check, logged", () => {
  assert.equal(SIGNING_EMAILS.vehicle_welcome.group, "Service & aftersales");
  assert.equal(SIGNING_EMAILS.vehicle_welcome_sms.channel, "sms");
  const mail = renderSigningEmail("vehicle_welcome", null, { company_name: "Acme", company_contact: "Acme on 021 000 0000", company_phone: "", company_email: "", first_name: "Sipho", model: "Nomad XL", warranty_line: "Warranty: 14 months of cover left." }, { companyName: "Acme", tagline: null, logoUrl: null, accent: "#ea580c", accentText: "#ffffff", phone: "", email: "" });
  assert.equal(mail.subject, "Welcome — your Nomad XL is now registered to you");
  assert.match(mail.text, /Warranty: 14 months of cover left\./);
  const action = code("src/app/actions/vehicleTransfer.ts");
  const send = action.slice(action.indexOf("export async function sendVehicleWelcome"), action.indexOf("export async function saveWarrantyTransferRule"));
  assert.match(send, /requireVehicleAccess\(vehicleId, "vehicles\.transfer"\)/);
  assert.match(send, /firstAllowedChannel\(\{ contactId: c\.id, tenantId, purpose: "service", channels: \["email", "sms"\] \}\)/);
  assert.match(send, /prisma\.communication\.create\(/);
  assert.match(send, /action: "vehicle\.welcome_sent"/);
  // Only one caller: a person's Send, behind a confirmation.
  const panel = code("src/components/VehicleOwnershipPanel.tsx");
  assert.match(panel, /confirmLabel="Send"\s*onConfirm=\{sendVehicleWelcome\.bind\(null, vehicleId\)\}/);
  assert.doesNotMatch(code("src/lib/vehicleOwnership.ts"), /sendVehicleWelcome|sendEmail|sendSms/, "the transfer itself sends nothing");
});

test("DAX: reads who owned it when, behind the vehicles grant; proposes a transfer on a card, confirmed only in the CRM", () => {
  const ok = proposedAction.safeParse({ type: "transfer_vehicle", vehicleId: "veh_123456", contactId: "con_123456", date: "2026-11-03", because: "sold_privately" });
  assert.ok(ok.success);
  assert.ok(!proposedAction.safeParse({ type: "transfer_vehicle", vehicleId: "veh_123456", contactId: "con_123456", date: "3 Nov", because: "sold_privately" }).success);
  assert.ok(!proposedAction.safeParse({ type: "transfer_vehicle", vehicleId: "veh_123456", contactId: "con_123456", date: "2026-11-03", because: "registered" }).success);
  assert.ok(!WHATSAPP_CONFIRMABLE.has("transfer_vehicle"), "a transfer is confirmed in the CRM, not from a phone");
  const dax = code("src/lib/assistantVehicleTransfer.ts");
  assert.match(dax, /hasPermission\(user, "vehicles\.transfer"\)/);
  assert.match(dax, /canAccessVehicle\(user, p\.vehicleId\)/);
  assert.match(dax, /canAccessContact\(user, p\.contactId\)/);
  assert.match(dax, /expectedOwnerId: card\.fromContactId/, "a vehicle that changed hands since the card was shown is refused");
  assert.match(code("src/lib/crmAssistant.ts"), /const transfers = proposes && modules\.has\("automotive"\) \? VEHICLE_TRANSFER_RULE : "";/);
  assert.match(code("src/app/actions/assistant.ts"), /case "transfer_vehicle": return confirmTransferCard\(user, card\);/);
  const lookups = code("src/lib/assistant/lookups/vehicles.ts");
  assert.match(lookups, /if \(args\.kind === "ownership"\) \{\s*return \(await hasAnyPermission\(user, "vehicles\.view_all", "vehicles\.view_owned"\)\)/);
  assert.match(code("src/lib/assistant/lookups/vehicleOwnership.ts"), /\.\.\.\(accessible \? \{ id: \{ in: accessible \} \} : \{\}\)/, "only vehicles they may open");
});

test("the help article is there, in the workshop's help (shown with Automotive)", () => {
  const article = HELP_ARTICLES.find((a) => a.slug === "vehicle-transfer");
  assert.ok(article);
  assert.equal(article!.category, "workshop");
  assert.match(JSON.stringify(article!.body), /Transfer to new owner[\s\S]*Correction[\s\S]*Stays with the vehicle/);
});
