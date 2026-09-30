import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describeBlockedReason, portalPreferenceBlock } from "../src/lib/communicationPolicy";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shipped = (rel: string) =>
  readFileSync(path.join(root, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * Gap audit 2026-09-30, items 2 and 10. The portal's "Email service reminders"
 * and "SMS service updates" switches were written and read by nothing; service
 * reminders did not check Trash or consent; an unsubscribe left no evidence.
 */

const ALL_ON = { serviceReminders: true, emailServiceUpdates: true, smsServiceUpdates: true, marketingEmail: true, emailMarketing: true };

test("the portal service switches refuse service messages on their channel", () => {
  assert.equal(portalPreferenceBlock(null, "service", "email"), null, "no row = defaults = on");
  assert.equal(portalPreferenceBlock(ALL_ON, "service", "email"), null);
  assert.equal(portalPreferenceBlock({ ...ALL_ON, serviceReminders: false }, "service", "email"), "portal_service_opt_out");
  assert.equal(portalPreferenceBlock({ ...ALL_ON, emailServiceUpdates: false }, "service", "email"), "portal_service_opt_out");
  assert.equal(portalPreferenceBlock({ ...ALL_ON, smsServiceUpdates: false }, "service", "sms"), "portal_service_opt_out");
  assert.equal(portalPreferenceBlock({ ...ALL_ON, smsServiceUpdates: false }, "service", "whatsapp"), "portal_service_opt_out");
  // Email off does not silence SMS, and vice versa — each switch is its channel's.
  assert.equal(portalPreferenceBlock({ ...ALL_ON, serviceReminders: false }, "service", "sms"), null);
  assert.equal(portalPreferenceBlock({ ...ALL_ON, smsServiceUpdates: false }, "service", "email"), null);
});

test("the portal marketing switch refuses marketing and review asks, not service", () => {
  const off = { ...ALL_ON, marketingEmail: false };
  assert.equal(portalPreferenceBlock(off, "marketing", "email"), "portal_unsubscribed");
  assert.equal(portalPreferenceBlock({ ...ALL_ON, emailMarketing: false }, "review", "email"), "portal_unsubscribed");
  assert.equal(portalPreferenceBlock(off, "service", "email"), null, "a marketing unsubscribe keeps service reminders");
  assert.equal(portalPreferenceBlock({ ...ALL_ON, serviceReminders: false }, "review", "email"), null);
});

test("refusals read as plain words, one per distinct cause", () => {
  assert.equal(describeBlockedReason("contact_deleted"), "contact is in Trash");
  assert.equal(describeBlockedReason("email: contact_deleted, sms: contact_deleted"), "contact is in Trash");
  assert.equal(
    describeBlockedReason("email: portal_service_opt_out, sms: missing_sms_destination"),
    "customer turned these messages off in the portal; no phone number on file",
  );
  assert.equal(describeBlockedReason(undefined), "not contactable");
});

test("the gate checks Trash, consent and the portal for service sends", () => {
  const gate = shipped("src/lib/communicationPolicy.ts");
  const fn = gate.slice(gate.indexOf("export async function canContactPerson"));
  assert.match(fn, /if \(contact\.deletedAt\) return \{ allowed: false, reason: "contact_deleted" \}/);
  assert.match(fn, /if \(honoursMarketingOptOut \|\| service\) \{/, "service must reach the consent + portal block");
  assert.match(fn, /type: service \? "service" : "marketing"/, "a withdrawn SERVICE consent refuses service sends");
  assert.match(fn, /portalPreferenceBlock\(pref, args\.purpose, args\.requestedChannel\)/);
  assert.match(fn, /const honoursMarketingOptOut = marketing \|\| args\.purpose === "review"/);
});

// Each service/operational path: asks the one gate with its purpose BEFORE its
// first send, and records the refusal as an audit line (the contact timeline).
for (const [rel, gateCall, purpose, send] of [
  ["src/lib/serviceReminders.ts", "canContactPerson({", "service", "await sendEmail("],
  ["src/lib/reviewRequests.ts", "canContactPerson({", "review", "await sendEmail("],
  ["src/app/actions/warranty.ts", "firstAllowedChannel({", "service", "await sendEmail("],
] as const) {
  test(`${rel} is gated (${purpose}) before it sends and records why it did not`, () => {
    const code = shipped(rel);
    const gate = code.indexOf(gateCall);
    assert.ok(gate !== -1, `${rel} must ask the shared gate`);
    assert.ok(gate < code.indexOf(send), "the gate must precede the send");
    assert.match(code.slice(gate, gate + 200), new RegExp(`purpose: "${purpose}"`));
    assert.match(code, /action: "communication\.suppressed"/, "a skipped send leaves a recorded reason");
  });
}

test("the manual Remind button cannot override the customer", () => {
  const code = shipped("src/lib/serviceReminders.ts");
  const fn = code.slice(code.indexOf("export async function remindVehicleService"));
  const gate = fn.indexOf("firstAllowedChannel({");
  assert.ok(gate !== -1 && gate < fn.indexOf("await sendEmail(") && gate < fn.indexOf("await sendSms("));
  assert.match(fn, /channels: \["email", "sms"\]/);
  assert.match(fn, /sendEmail\(\{ to: verdict\.destination/, "sends only to the destination the gate approved");
  assert.match(fn, /sendSms\(verdict\.destination/);
});

test("the nightly run no longer trusts the included contact row", () => {
  const code = shipped("src/lib/serviceReminders.ts");
  const fn = code.slice(code.indexOf("export async function runServiceReminders"), code.indexOf("export async function remindVehicleService"));
  // `include: { contact: true }` bypasses the soft-delete filter: a trashed
  // contact was still reminded. The gate reads deletedAt itself.
  assert.match(fn, /recordSuppressedReminder\(vehicle\.id, vehicle\.contactId, vehicle\.model, dueKey, verdict\.reason, "Automation"\)/);
});

test("an unsubscribe writes consent evidence in the opt-out's transaction, then audits", () => {
  const code = shipped("src/app/api/unsubscribe/[token]/route.ts");
  const post = code.slice(code.indexOf("export async function POST"));
  const tx = post.indexOf("prisma.$transaction(");
  const consent = post.indexOf("tx.consentRecord.create(");
  const committed = post.indexOf("}, GOVERNANCE_TX);");
  assert.ok(tx < consent && consent < committed, "the ConsentRecord commits with the opt-out");
  assert.match(post.slice(consent, committed), /type: "marketing",\s*granted: false,\s*source: "unsubscribe_link"/);
  assert.match(post.slice(consent, committed), /tenantId: r\.tenantId/);
  const audit = post.indexOf("await logAudit({");
  assert.ok(audit > committed, "the audit is written after commit — it must never roll back an opt-out");
  assert.match(post.slice(audit, audit + 200), /action: "consent\.unsubscribed"/);
  assert.match(post, /List-Unsubscribe=One-Click/, "records HOW: one-click vs the confirmation page");
});

test("a failed unsubscribe is logged, without the token or the person", () => {
  const code = shipped("src/app/api/unsubscribe/[token]/route.ts");
  const post = code.slice(code.indexOf("export async function POST"));
  const catchAt = post.lastIndexOf("} catch (error) {");
  assert.ok(catchAt !== -1, "the POST catch must bind the error, not swallow it");
  const handler = post.slice(catchAt, post.indexOf("return html(", catchAt));
  assert.match(handler, /await logError\("unsubscribe", error,/);
  assert.doesNotMatch(handler, /token|email|contactId/, "the token is a credential; logs carry no client data");
});
