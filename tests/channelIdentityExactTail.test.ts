import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { channelVerifiedOwner, distinctIdentities, markUnverified } from "../src/lib/botBookingIdentity";

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

test("one Contact and one unrelated open Lead is two people, not one", () => {
  // The hole: the lookup returned as soon as a Contact matched, so a matching open
  // Lead on the same number was never seen. "Two records answering to one number
  // is not proof of one person" only held WITHIN a table.
  const C1 = [{ id: "c1" }];
  const L2 = [{ id: "l2", contactId: null }];
  assert.equal(distinctIdentities(C1, L2), 2, "a contact and an unrelated lead are two identities");

  const match = { contactId: "c1", leadId: null, ambiguous: distinctIdentities(C1, L2) > 1 };
  assert.equal(match.ambiguous, true);
  assert.equal(channelVerifiedOwner(match), null, "booking self-service must refuse this");
});

test("a Lead pointing at the matched Contact is the same person", () => {
  // Collapsing on row count instead would refuse self-service for a customer whose
  // records are perfectly consistent — an ordinary contact with an open lead.
  assert.equal(distinctIdentities([{ id: "c1" }], [{ id: "l1", contactId: "c1" }]), 1);
  assert.equal(channelVerifiedOwner({ contactId: "c1", leadId: null, ambiguous: false })?.contactId, "c1");

  // Two leads for one contact are still one person.
  assert.equal(distinctIdentities([], [{ id: "l1", contactId: "cX" }, { id: "l2", contactId: "cX" }]), 1);
  // Two contacts, or two unlinked leads, are still two.
  assert.equal(distinctIdentities([{ id: "c1" }, { id: "c2" }], []), 2);
  assert.equal(distinctIdentities([], [{ id: "l1", contactId: null }, { id: "l2", contactId: null }]), 2);
  // Nothing matched at all.
  assert.equal(distinctIdentities([], []), 0);
});

test("two leads on the matched contact must not hide a third person", () => {
  // Why the candidate query cannot be truncated to two rows: ROWS ARE NOT
  // IDENTITIES. Two Leads both pointing at the matched Contact fill both slots and
  // collapse to one person, so a third row belonging to somebody else is never
  // fetched and the number reads as unambiguous.
  const contacts = [{ id: "c1" }];
  const leads = [
    { id: "l1", contactId: "c1" },   // same person as C1
    { id: "l2", contactId: "c1" },   // same person as C1
    { id: "l3", contactId: null },   // SOMEBODY ELSE
  ];
  assert.equal(distinctIdentities(contacts, leads), 2, "C1 and L3 are two people");

  const match = { contactId: "c1", leadId: null, ambiguous: distinctIdentities(contacts, leads) > 1 };
  assert.equal(match.ambiguous, true);
  assert.equal(channelVerifiedOwner(match), null, "booking self-service must refuse this");

  // The truncation that hid it: the first two lead rows alone prove nothing.
  assert.equal(distinctIdentities(contacts, leads.slice(0, 2)), 1, "which is exactly the false negative");
});

test("reaching the candidate bound is itself ambiguous", () => {
  // A bound can always hide an identity, so hitting it means uniqueness cannot be
  // PROVED — and that is the same answer as proving there are two.
  const wa = src("src/lib/whatsapp.ts");
  assert.match(wa, /const CANDIDATE_LIMIT = \d+;/);
  assert.match(wa, /take: CANDIDATE_LIMIT/);
  const lookup = wa.slice(wa.indexOf("export async function matchByPhone"), wa.indexOf("/** Logs an inbound WhatsApp"));
  assert.doesNotMatch(lookup, /take: 2/, "rows are not identities, so two rows prove nothing");
  assert.match(wa, /const truncated = contacts\.length >= CANDIDATE_LIMIT \|\| leads\.length >= CANDIDATE_LIMIT;/);
  assert.match(wa, /const ambiguous = truncated \|\| distinctIdentities\(contacts, leads\) > 1;/);
  // Rows must stay lightweight, or the bound becomes a real page size.
  assert.match(wa, /select: \{ id: true, contactId: true \}/);
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
  // Both tables are read before identity is decided; returning early on a Contact
  // could not see a conflicting open Lead.
  assert.match(match, /const \[contacts, leads\] = await Promise\.all\(/);
  assert.match(match, /const ambiguous = truncated \|\| distinctIdentities\(contacts, leads\) > 1;/);
  assert.doesNotMatch(match, /ambiguous: contacts\.length > 1/, "row count within one table is not the rule");
});

test("the security boundary consumes the flag, or reporting it changes nothing", () => {
  const identity = src("src/lib/botBookingIdentity.ts");
  const fn = identity.slice(identity.indexOf("export function channelVerifiedOwner"));
  assert.match(fn, /if \(match\.ambiguous\) return null;/);
  // Before the existing check, so an ambiguous match cannot pass on the strength
  // of having a contactId.
  assert.ok(fn.indexOf("match.ambiguous") < fn.indexOf("match.contactId || match.leadId"));
});
