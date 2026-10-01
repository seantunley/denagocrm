import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

// Gap audit #24: the customer page had no New lead / New quote / Book test drive /
// New job card, and the lead page no Book test drive — staff had to leave the
// record and re-find the customer in another screen.

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const contactPage = src("src/app/(app)/contacts/[id]/page.tsx");
const leadPage = src("src/app/(app)/leads/[id]/page.tsx");
const quickCreate = src("src/components/QuickCreateDialog.tsx");

test("the customer page starts each next step pre-filled with this customer, for staff allowed to", () => {
  assert.match(contactPage, /canCreateLead && \(\s*<QuickCreateButton kind="lead" defaults=\{\{ contactId: contact\.id/);
  assert.match(contactPage, /canCreateQuote && \(\s*<QuickCreateButton kind="quote" defaults=\{\{ contactId: contact\.id \}\}/);
  assert.match(contactPage, /automotiveOn && canBookTestDrive && \(\s*<Link href=\{`\/test-drives\?book=1&contactId=\$\{contact\.id\}`\}/);
  assert.match(contactPage, /automotiveOn && canOpenJobCard && contact\.vehicles\.length > 0 && \(\s*<QuickCreateButton\s+kind="jobcard"/);
  for (const perm of ["leads.create", "quotes.create", "activities.manage", "jobcards.manage"]) {
    assert.match(contactPage, new RegExp(`hasPermission\\(user, "${perm.replace(".", "\\.")}"\\)`), perm);
  }
});

test("quick create actually uses those defaults", () => {
  assert.match(quickCreate, /initialContactId=\{createDefaults\.contactId\}/, "new quote opens on the customer");
  assert.match(quickCreate, /<JobCardForm vehicles=\{currentOptions\.vehicles\} defaultVehicleId=\{createDefaults\.vehicleId\} \/>/);
  assert.match(src("src/components/QuickCreateButton.tsx"), /openQuickCreate\(kind, defaults\)/);
});

test("the lead page books a test drive with the lead (and its customer) chosen", () => {
  assert.match(leadPage, /href=\{`\/test-drives\?book=1&leadId=\$\{lead\.id\}\$\{lead\.contactId \? `&contactId=\$\{lead\.contactId\}` : ""\}`\}/);
});

test("the test drives page opens the form pre-filled — within the viewer's own access scope", () => {
  const page = src("src/app/(app)/test-drives/page.tsx");
  assert.match(page, /const opening = book === "1" && canCreate;/);
  assert.match(page, /prisma\.contact\.findFirst\(\{ where: \{ id: bookContactId, deletedAt: null, \.\.\.contactScope \} \}\)/);
  assert.match(page, /where: \{ id: bookLeadId, deletedAt: null, \.\.\.leadScope \}/);
  // Exactly one trigger opens (the dialog portals to <body>).
  assert.equal((page.match(/\{\.\.\.bookDefaults\}/g) ?? []).length, 1);
});
