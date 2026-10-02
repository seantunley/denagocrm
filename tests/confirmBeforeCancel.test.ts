import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Sean 2026-10-02: one click on the calendar's Cancel took a festival day off
// two people's calendars, with no confirmation and nothing in the audit log.
// Every cancel control now asks first.

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("activity cancels ask first, everywhere they are offered", () => {
  const ws = src("src/components/CalendarWorkspace.tsx");
  assert.match(ws, /<ConfirmActionDialog[\s\S]*?onConfirm=\{confirmCancelSelected\}/);
  assert.doesNotMatch(ws, /onClick=\{cancelSelected\}/);
  assert.match(src("src/components/ActivityPanel.tsx"), /<ConfirmActionDialog[\s\S]*?onConfirm=\{cancelActivity\.bind\(null, a\.id, revalidate\)\}/);
  assert.match(src("src/app/(app)/activities/page.tsx"), /<ConfirmActionDialog[\s\S]*?onConfirm=\{cancelActivity\.bind\(null, activity\.id, "\/activities"\)\}/);
  // No cancel posted straight from a form button.
  for (const file of ["src/components/ActivityPanel.tsx", "src/app/(app)/activities/page.tsx"]) {
    assert.doesNotMatch(src(file), /<SaveForm\s+action=\{cancelActivity/, file);
  }
});

test("other cancels ask first too", () => {
  assert.match(src("src/app/(app)/journeys/page.tsx"), /<ConfirmActionDialog[\s\S]*?onConfirm=\{cancelJourneyRun\.bind\(null, run\.id\)\}/);
  assert.match(src("src/app/(app)/marketing/surveys/distributions/[id]/page.tsx"), /<ConfirmActionDialog[\s\S]*?onConfirm=\{cancelDistribution\.bind\(null, id\)\}/);
  assert.match(src("src/app/(app)/marketing/campaigns/[id]/page.tsx"), /<ConfirmDelete action=\{cancelCampaign\.bind\(null, id\)\}/);
  assert.match(src("src/app/(app)/test-drives/[id]/page.tsx"), /<ConfirmDelete\s+action=\{cancelTestDrive\.bind\(null, booking\.id\)\}/);
});

test("a cancelled activity is audited, and the dialog actions return their refusals", () => {
  const actions = src("src/app/actions/activities.ts");
  const cancel = actions.slice(actions.indexOf("export async function cancelActivity("));
  assert.match(cancel.slice(0, 900), /action: "activity\.canceled"/);
  assert.match(src("src/app/actions/journeyRuns.ts"), /export async function cancelJourneyRun\(runId: string\) \{[\s\S]*?return asActionResult\(async \(\) => \{/);
  assert.match(src("src/app/actions/marketingCampaignOperations.ts"), /export async function cancelCampaign\(id: string, formData: FormData\) \{[\s\S]*?return asActionResult\(async \(\) => \{/);
});

test("Open record only appears when the activity is linked to a record", () => {
  assert.match(src("src/components/CalendarView.tsx"), /\? `\/contacts\/\$\{activity\.contact\.id\}`\s*: null,/);
  assert.match(src("src/components/CalendarWorkspace.tsx"), /\{selectedEvent\.href \? \(\s*<Button asChild variant="outline">\s*<Link href=\{selectedEvent\.href\}>Open record<\/Link>/);
});
