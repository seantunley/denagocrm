import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { channelVerifiedOwner, markUnverified } from "../src/lib/botBookingIdentity";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

/**
 * botBookingIdentity.ts exists because a typed phone number is a claim and not
 * proof, and it says identity must come from the CHANNEL — `matchByPhone` on
 * WhatsApp. That boundary is only ever as good as this lookup, and the lookup had
 * two ways to name the wrong person.
 */

// The `contains` semantics that shipped, versus the `endsWith` that was meant.
const contains = (stored: string, tail: string) => stored.includes(tail);
const endsWith = (stored: string, tail: string) => stored.endsWith(tail);

test("a 9-digit tail matched ANYWHERE in the stored number, not at the end", () => {
  // Real CRM data: a second number in the same field, an extension, a note.
  const tail = "821234567";
  assert.equal(contains("0821234567 / 0839876543", tail), true, "the defect");
  assert.equal(endsWith("0821234567 / 0839876543", tail), false, "the fix");

  assert.equal(contains("+27821234567x204", tail), true, "the defect");
  assert.equal(endsWith("+27821234567x204", tail), false, "the fix");

  // And the ordinary case still matches, in every stored format.
  for (const stored of ["0821234567", "+27821234567", "27821234567"]) {
    assert.equal(endsWith(stored, tail), true, `${stored} is the same person`);
  }
});

test("an ambiguous number does not identify anyone, so booking actions refuse it", () => {
  // Duplicate contacts are ordinary in a real CRM, and while enforcement is
  // dormant withChannelTenantScope adds no tenant predicate — so "more than one
  // match" can even mean another workspace's customer.
  assert.equal(channelVerifiedOwner({ contactId: "c1", leadId: null, ambiguous: true }), null);
  assert.equal(channelVerifiedOwner({ contactId: null, leadId: "l1", ambiguous: true }), null);

  // Unambiguous still works, and an absent flag means "not known to be ambiguous"
  // — which is how the Messenger/Instagram PSID lookups behave.
  assert.deepEqual(channelVerifiedOwner({ contactId: "c1", leadId: null, ambiguous: false }), { contactId: "c1", leadId: null, ambiguous: false });
  assert.deepEqual(channelVerifiedOwner({ contactId: "c1", leadId: null }), { contactId: "c1", leadId: null });

  // And an unidentifiable channel is still refused, as before.
  assert.equal(channelVerifiedOwner({ contactId: null, leadId: null }), null);
});

test("refusing identity also drops anything an earlier turn had resolved", () => {
  const vars: Record<string, string> = { booking_id: "act_1", booking_slot: "Tue 09:00", booking_summary: "Service" };
  markUnverified(vars);
  assert.equal(vars.booking_identity, "unverified");
  assert.equal(vars.booking_id, undefined, "a later node must not act on a booking this customer was never shown to own");
  assert.equal(vars.booking_slot, undefined);
  assert.equal(vars.booking_summary, undefined);
});

test("the lookup matches the end of the number and picks deterministically", () => {
  const wa = src("src/lib/whatsapp.ts");
  const match = wa.slice(wa.indexOf("export async function matchByPhone"), wa.indexOf("/** Logs an inbound WhatsApp"));

  assert.match(match, /phone: \{ endsWith: tail \}/);
  assert.match(match, /whatsapp: \{ endsWith: tail \}/);
  assert.match(match, /phone: \{ endsWith: digits\.slice\(-9\) \}/);
  assert.doesNotMatch(match, /contains:/, "contains matches a tail that is not the stored number's own");

  // `take: 1` with no ordering let Postgres choose, so the same inbound number
  // could resolve to different customers on different requests.
  assert.match(match, /orderBy: \[\{ createdAt: "asc" \}, \{ id: "asc" \}\]/);
  assert.doesNotMatch(match, /take: 1\b/);
  // take: 2 is how it learns there IS a second one.
  assert.match(match, /take: 2/);
  assert.match(match, /ambiguous: contacts\.length > 1/);
  assert.match(match, /ambiguous: leads\.length > 1/);
});

test("the security boundary consumes the flag, or reporting it changes nothing", () => {
  const identity = src("src/lib/botBookingIdentity.ts");
  const fn = identity.slice(identity.indexOf("export function channelVerifiedOwner"));
  assert.match(fn, /if \(match\.ambiguous\) return null;/);
  // Before the existing check, so an ambiguous match cannot pass on the strength
  // of having a contactId.
  assert.ok(fn.indexOf("match.ambiguous") < fn.indexOf("match.contactId || match.leadId"));
});
