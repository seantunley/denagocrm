import test from "node:test";
import assert from "node:assert/strict";
import { SOCIAL_CHANNELS, isSocialChannel } from "../src/lib/socialChannels";
import { inboxWhereForScope } from "../src/lib/inboxScope";
import { ensureFollowUpTime, followUpDueDateError } from "../src/lib/followUp";

// --- Fix 4: social-channel validation for thread mutations ------------------

test("isSocialChannel: accepts exactly the three inbox channels", () => {
  assert.deepEqual([...SOCIAL_CHANNELS], ["whatsapp", "messenger", "instagram"]);
  for (const channel of SOCIAL_CHANNELS) {
    assert.equal(isSocialChannel(channel), true, `${channel} should be allowed`);
  }
});

test("isSocialChannel: rejects non-inbox channels a caller could smuggle in", () => {
  for (const channel of ["note", "email", "call", "sms", "", "WHATSAPP", "whatsapp "]) {
    assert.equal(isSocialChannel(channel), false, `${channel} must be rejected`);
  }
});

// --- Fix 1: pure inbox-scope where builder ---------------------------------

test("inboxWhereForScope: fully privileged (all contacts AND all leads) → no filter", () => {
  assert.deepEqual(
    inboxWhereForScope({ contactsViewAll: true, leadsViewAll: true, contactIds: null, leadIds: null }),
    {},
  );
});

test("inboxWhereForScope: view-all on only one entity still scopes (not fully privileged)", () => {
  // contacts.view_all but NOT leads.view_all: contactId branch is unrestricted
  // (not null), lead branch is the explicit allow-list.
  assert.deepEqual(
    inboxWhereForScope({ contactsViewAll: true, leadsViewAll: false, contactIds: null, leadIds: ["l1"] }),
    { OR: [{ contactId: { not: null } }, { leadId: { in: ["l1"] } }] },
  );
});

test("inboxWhereForScope: scoped user → OR over accessible contact/lead id lists", () => {
  assert.deepEqual(
    inboxWhereForScope({ contactsViewAll: false, leadsViewAll: false, contactIds: ["c1", "c2"], leadIds: ["l1"] }),
    { OR: [{ contactId: { in: ["c1", "c2"] } }, { leadId: { in: ["l1"] } }] },
  );
});

test("inboxWhereForScope: no accessible records → matches nothing (in: [])", () => {
  // The exploit this blocks: a user with neither view-all nor any owned records
  // must not see the global 400-row social feed.
  assert.deepEqual(
    inboxWhereForScope({ contactsViewAll: false, leadsViewAll: false, contactIds: [], leadIds: [] }),
    { OR: [{ contactId: { in: [] } }, { leadId: { in: [] } }] },
  );
});

test("inboxWhereForScope: null id list for one entity means all of that entity", () => {
  assert.deepEqual(
    inboxWhereForScope({ contactsViewAll: false, leadsViewAll: false, contactIds: null, leadIds: [] }),
    { OR: [{ contactId: { not: null } }, { leadId: { in: [] } }] },
  );
});

// --- Fix 6: rescheduleActivity follow-up validator path --------------------
// Mirrors the exact composition the action runs for a follow_up activity:
// ensureFollowUpTime(when) → new Date(...) → followUpDueDateError.

const now = new Date("2026-07-20T10:00:00Z");

function rescheduleFollowUpError(when: string, ref: Date = now): string | null {
  const normalised = ensureFollowUpTime(when);
  const dueDate = normalised ? new Date(`${normalised}:00+02:00`) : new Date(NaN);
  return followUpDueDateError(dueDate, ref);
}

test("reschedule follow-up: a future time is accepted", () => {
  assert.equal(rescheduleFollowUpError("2026-08-03T14:30"), null);
});

test("reschedule follow-up: midnight is lifted to a real business hour, still future", () => {
  // Would otherwise miss the hour-before reminder (cron skips 00:00).
  assert.equal(rescheduleFollowUpError("2026-08-03T00:00"), null);
});

test("reschedule follow-up: a past date is rejected", () => {
  assert.match(rescheduleFollowUpError("2026-07-01T09:00") ?? "", /future/i);
});

test("reschedule follow-up: an invalid date is rejected", () => {
  assert.match(rescheduleFollowUpError("not-a-date") ?? "", /valid future/i);
});
