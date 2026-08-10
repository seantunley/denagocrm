import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { channelVerifiedOwner, markUnverified } from "../src/lib/botBookingIdentity";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("booking lookup is read-only and restricted to the conversation customer", () => {
  const code = src("src/lib/botBookingSelfService.ts");
  const start = code.indexOf("export async function findUpcomingBotBooking");
  const end = code.indexOf("export async function cancelBotBooking", start);
  const lookup = code.slice(start, end);
  assert.match(lookup, /ownerWhere\(owner\)/);
  assert.match(lookup, /category: "workshop"/);
  assert.match(lookup, /status: "planned"/);
  assert.match(lookup, /dueDate: \{ gte: new Date\(\) \}/);
  assert.doesNotMatch(lookup, /\.create\(|\.update\(|\.upsert\(/, "a failed booking lookup must not create or mutate CRM records");
});

test("a phone number typed into the chat is never an identity", () => {
  // The attack this replaces: on Telegram the runner passes no contact and no
  // lead, so whatever the customer typed decided whose booking was returned.
  // Anyone who knew a customer's number could read back their next booking and
  // then move or cancel it.
  const telegramSender = { contactId: null, leadId: null };
  assert.equal(
    channelVerifiedOwner(telegramSender),
    null,
    "a sender the channel cannot identify has no booking rights, whatever they type",
  );

  // The claim is not laundered through flow variables either.
  const vars: Record<string, string> = { phone: "0821234567", booking_id: "act_someone_else" };
  markUnverified(vars);
  assert.equal(vars.booking_identity, "unverified");
  assert.equal(vars.booking_id, undefined, "a booking id from an earlier turn must not survive");
  assert.equal(vars.booking_slot, undefined);
  assert.equal(vars.booking_summary, undefined);

  // A sender the provider authenticated and the CRM matched still works.
  const whatsappMatched = { contactId: "c_1", leadId: null };
  assert.deepEqual(channelVerifiedOwner(whatsappMatched), whatsappMatched);
  const leadOnly = { contactId: null, leadId: "l_1" };
  assert.deepEqual(channelVerifiedOwner(leadOnly), leadOnly);
});

test("every booking action refuses an unidentified customer before touching the CRM", () => {
  const code = src("src/lib/botBookingSelfService.ts");
  // No path may reach cancelWorkshopBooking / rescheduleWorkshopBooking / the
  // Activity lookup without having resolved a channel-verified owner first.
  for (const fn of ["findUpcomingBotBooking", "lookupBotBooking", "cancelBotBooking", "rescheduleBotBooking"]) {
    const start = code.indexOf(`export async function ${fn}`);
    assert.ok(start > 0, `${fn} must exist`);
    const body = code.slice(start, code.indexOf("\nexport ", start + 1) === -1 ? undefined : code.indexOf("\nexport ", start + 1));
    assert.match(body, /channelVerifiedOwner\(match\)/, `${fn} must establish identity from the channel`);
  }
  // The typed-phone resolver is gone, not merely bypassed.
  assert.doesNotMatch(code, /phoneTail|resolveBookingOwner/);
  assert.doesNotMatch(code, /vars\.phone/, "nothing in this file may read the number the customer typed");
});

test("cancellation retains history and releases workshop capacity by leaving planned state", () => {
  const code = src("src/lib/bookingSlots.ts");
  const cancel = code.slice(code.indexOf("export async function cancelWorkshopBooking"), code.indexOf("export async function rescheduleWorkshopBooking"));
  assert.match(cancel, /existing\.status === "cancelled"/);
  assert.match(cancel, /existing\.status !== "planned"/);
  assert.match(cancel, /data: \{ status: "cancelled" \}/);
  assert.doesNotMatch(cancel, /activity\.delete/);
});

test("cancellation is idempotent under retries and concurrent cancellation", () => {
  const code = src("src/lib/bookingSlots.ts");
  const cancel = code.slice(code.indexOf("export async function cancelWorkshopBooking"), code.indexOf("export async function rescheduleWorkshopBooking"));
  assert.match(cancel, /basePrisma\.\$transaction/);
  assert.match(cancel, /lockWorkshopBooking\(tx, input\.bookingId, tenantId\)/);
  assert.match(cancel, /existing\.status === "cancelled"/);
  assert.match(cancel, /alreadyCancelled: true/);
});

test("a booking id alone is never enough to cancel someone else's reservation", () => {
  const code = src("src/lib/bookingSlots.ts");
  const cancel = code.slice(code.indexOf("export async function cancelWorkshopBooking"), code.indexOf("export async function rescheduleWorkshopBooking"));
  assert.match(cancel, /const scope = ownerWhere\(input\.owner\)/);
  assert.match(cancel, /if \(!scope\) return \{ ok: false \}/);
  assert.match(cancel, /id: input\.bookingId/);
  assert.match(cancel, /\.\.\.scope/);
});
