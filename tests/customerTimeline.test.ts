import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NO_DEAL, customerTimelineWhere, dealChoice, dealTimelineWhere, filedOn, postedDealId } from "../src/lib/customerTimeline";

/*
 * ONE TIMELINE (Sean, 2026-10-12: "Quote timeline in one place and email
 * timeline in another… surely everything must be in one place?").
 *
 * Each page showed only the entries filed on itself: an email written from the
 * customer's page never appeared on their deal, a call logged on the deal never
 * appeared on the customer. These pin the one rule both pages now follow, where
 * a new entry is filed, and when the person is asked which deal it is about.
 */

const code = (rel: string) => readFileSync(rel, "utf8");
type Row = { id: string; leadId: string | null; contactId: string | null };
/** Applies a where-clause of the shapes these builders produce, the way the database would. */
function matches(row: Row, where: { OR: Record<string, unknown>[] }): boolean {
  return where.OR.some((alt) =>
    Object.entries(alt).every(([key, want]) => {
      const have = row[key as keyof Row];
      if (want && typeof want === "object") return (want as { in: unknown[] }).in.includes(have);
      return have === want;
    }),
  );
}

const ROWS: Row[] = [
  { id: "on-deal-1", leadId: "d1", contactId: null }, // logged on the deal, before entries carried the customer
  { id: "on-deal-1-and-customer", leadId: "d1", contactId: "c1" }, // how a deal's entry is filed now
  { id: "on-deal-2", leadId: "d2", contactId: "c1" }, // the same customer's OTHER deal
  { id: "on-customer-only", leadId: null, contactId: "c1" }, // an email from the customer's page, an inbox reply
  { id: "other-customer", leadId: null, contactId: "c2" },
  { id: "other-customers-deal", leadId: "d9", contactId: "c2" },
];
const shown = (where: { OR: Record<string, unknown>[] }) => ROWS.filter((row) => matches(row, where)).map((row) => row.id);

test("A DEAL's timeline: its own entries and the customer's that sit on no deal — never another deal's", () => {
  assert.deepEqual(shown(dealTimelineWhere({ id: "d1", contactId: "c1" })), ["on-deal-1", "on-deal-1-and-customer", "on-customer-only"]);
  assert.deepEqual(shown(dealTimelineWhere({ id: "d2", contactId: "c1" })), ["on-deal-2", "on-customer-only"]);
  // No customer linked, or one the viewer may not open: the deal's own entries only.
  assert.deepEqual(shown(dealTimelineWhere({ id: "d1", contactId: null })), ["on-deal-1", "on-deal-1-and-customer"]);
});

test("A CUSTOMER's timeline: everything on them and on every deal of theirs the viewer may open", () => {
  assert.deepEqual(shown(customerTimelineWhere("c1", ["d1", "d2"])), ["on-deal-1", "on-deal-1-and-customer", "on-deal-2", "on-customer-only"]);
  // A deal the viewer cannot open contributes only what was ALSO filed on the customer.
  assert.deepEqual(shown(customerTimelineWhere("c1", ["d2"])), ["on-deal-1-and-customer", "on-deal-2", "on-customer-only"]);
  assert.deepEqual(shown(customerTimelineWhere("c1", [])), ["on-deal-1-and-customer", "on-deal-2", "on-customer-only"]);
  // Never another customer's.
  for (const where of [customerTimelineWhere("c1", ["d1", "d2"]), dealTimelineWhere({ id: "d1", contactId: "c1" })]) {
    assert.ok(!shown(where).some((id) => id.startsWith("other-")));
  }
});

test("WHICH DEAL? Asked only when the customer has more than one open deal", () => {
  assert.deepEqual(dealChoice([]), { ask: false, leadId: null });
  assert.deepEqual(dealChoice([{ id: "d1", label: "Rover XL" }]), { ask: false, leadId: "d1" });
  const two = dealChoice([{ id: "d1", label: "Rover XL" }, { id: "d2", label: "Fleet of 4" }]);
  assert.equal(two.ask, true);
  assert.deepEqual(two.ask && two.options.map((o) => o.id), ["d1", "d2"]);

  const field = code("src/components/DealField.tsx");
  // One open deal: filed on it silently. Several: a REQUIRED choice with nothing pre-selected.
  assert.match(field, /if \(!choice\.ask\) return choice\.leadId \? <input type="hidden" name="leadId" value=\{choice\.leadId\} \/> : null;/);
  assert.match(field, /<select id=\{id\} name="leadId" required defaultValue="" className="input">/);
  assert.match(field, /<option value="" disabled>Choose a deal…<\/option>/);
  assert.match(field, /<option value=\{NO_DEAL\}>None of these — the customer in general<\/option>/);
  // "The customer in general" posts no deal.
  assert.equal(postedDealId(NO_DEAL), null);
  assert.equal(postedDealId(""), null);
  assert.equal(postedDealId(null), null);
  assert.equal(postedDealId(" d1 "), "d1");
});

test("WHERE A NEW ENTRY IS FILED: a deal's entry always carries the deal's customer — and never somebody else's", () => {
  // Written on a deal's page (deal only): the customer is added.
  assert.deepEqual(filedOn({ leadId: "d1", contactId: null }, "c1"), { ok: true, leadId: "d1", contactId: "c1" });
  // Written on the customer's page with a deal chosen: both.
  assert.deepEqual(filedOn({ leadId: "d1", contactId: "c1" }, "c1"), { ok: true, leadId: "d1", contactId: "c1" });
  // Written on the customer's page, no deal (none open, or "the customer in general").
  assert.deepEqual(filedOn({ leadId: null, contactId: "c1" }, undefined), { ok: true, leadId: null, contactId: "c1" });
  // A deal with no customer linked stays a deal's entry.
  assert.deepEqual(filedOn({ leadId: "d1", contactId: null }, null), { ok: true, leadId: "d1", contactId: null });
  // A deal that is ANOTHER customer's, posted from this customer's page: refused, not filed on both.
  assert.deepEqual(filedOn({ leadId: "d9", contactId: "c1" }, "c2"), { ok: false, error: "That deal belongs to a different customer." });
  // A deal with no customer, posted with one: refused — it would link them by the back door.
  assert.equal(filedOn({ leadId: "d1", contactId: "c1" }, null).ok, false);
});

test("every door that writes a timeline entry files it by that rule, after its own access checks", () => {
  for (const [file, postedLead] of [
    ["src/app/actions/communications.ts", 'postedDealId(str("leadId"))'],
    ["src/app/actions/emails.ts", 'postedDealId(formData.get("leadId"))'],
    ["src/app/actions/whatsapp.ts", 'postedDealId(formData.get("leadId"))'],
  ] as const) {
    const src = code(file);
    assert.ok(src.includes(`const postedLeadId = ${postedLead};`), `${file}: "the customer in general" must not be read as a deal id`);
    const access = src.indexOf("canAccessLead(user, postedLeadId)");
    const filing = src.indexOf("await resolveFiling({ leadId: postedLeadId, contactId: postedContactId })");
    assert.ok(access > 0 && filing > access, `${file}: filed only after the posted ids are access-checked`);
    assert.match(src, /const \{ contactId, leadId \} = filing;/, file);
  }
  // The deal's customer comes from the deal's own record, through the workspace's client.
  const resolve = code("src/lib/customerTimelineFiling.ts");
  assert.match(resolve, /await prisma\.lead\.findUnique\(\{ where: \{ id: posted\.leadId \}, select: \{ contactId: true \} \}\)/);
  assert.match(resolve, /return filedOn\(posted, deal\.contactId\);/);
});

test("both pages read by the one rule, respect what the viewer may open, and say where an entry came from", () => {
  const lead = code("src/app/(app)/leads/[id]/page.tsx");
  assert.match(lead, /const timelineWhere = dealTimelineWhere\(\{\s*id: lead\.id,\s*contactId: lead\.contactId && \(accessibleContactIds === null \|\| accessibleContactIds\.includes\(lead\.contactId\)\) \? lead\.contactId : null,/);
  assert.match(lead, /prisma\.communication\.findMany\(\{ where: timelineWhere,/);
  assert.match(lead, /prisma\.activity\.findMany\(\{\s*where: timelineWhere,/);
  assert.match(lead, /ownerLabel: "on the customer's record"/);
  assert.doesNotMatch(lead, /lead\.communications|lead\.activities/, "nothing still reads the deal-only relations");

  const customer = code("src/app/(app)/contacts/[id]/page.tsx");
  assert.match(customer, /const myDeals = contact\.leads\.filter\(\(deal\) => accessibleLeadIds === null \|\| accessibleLeadIds\.includes\(deal\.id\)\);/);
  assert.match(customer, /const timelineWhere = customerTimelineWhere\(contact\.id, myDeals\.map\(\(deal\) => deal\.id\)\);/);
  assert.match(customer, /ownerLabel: `Deal: \$\{dealTitle\.get\(c\.leadId\)\}`/);
  assert.doesNotMatch(customer, /contact\.communications|contact\.activities/);
  // Only OPEN deals the viewer may open are offered — to all FOUR places the page can write an entry
  // from: the email composer, the WhatsApp box, the log form, and the Live timeline's note box.
  assert.match(customer, /myDeals\.filter\(\(deal\) => deal\.status === "open"\)/);
  assert.equal((customer.match(/deals=\{openDeals\}/g) ?? []).length, 4);
  // The forms ask only where there is no deal already (a customer's page), never on a deal's.
  for (const file of ["src/components/EmailComposer.tsx", "src/components/WhatsAppPanel.tsx", "src/components/CommsTimeline.tsx", "src/components/LeadTimeline.tsx"]) {
    assert.match(code(file), /\{!leadId && deals\.length > 0 && (<div className="w-full">)?<DealField deals=\{deals\}/, file);
  }
});
