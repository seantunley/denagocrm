import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  DEFAULT_RECORD_LABELS,
  isCustom,
  jobNumberLabel,
  midSentence,
  navLabelOverrides,
  parseRecordLabels,
} from "../src/lib/recordLabels";

test("a workspace's own names are read defensively", () => {
  assert.deepEqual(parseRecordLabels(null), DEFAULT_RECORD_LABELS);
  assert.deepEqual(parseRecordLabels("not json"), DEFAULT_RECORD_LABELS);
  const labels = parseRecordLabels(JSON.stringify({ lead: { one: "  Enquiry ", many: "Enquiries" }, jobcard: { one: "Work order", many: "" }, junk: { one: "x" } }));
  assert.deepEqual(labels.lead, { one: "Enquiry", many: "Enquiries" });
  assert.deepEqual(labels.jobcard, { one: "Work order", many: "Job cards" }, "a blank box is the built-in word");
  assert.deepEqual(labels.deal, DEFAULT_RECORD_LABELS.deal);
  assert.equal(parseRecordLabels(JSON.stringify({ deal: { one: "x".repeat(80) } })).deal.one.length, 30, "capped");
});

test("Denago's screens are unchanged on the built-in words", () => {
  assert.deepEqual(navLabelOverrides(DEFAULT_RECORD_LABELS), {}, "the menu keeps 'Leads' and 'Job Cards'");
  assert.equal(jobNumberLabel(DEFAULT_RECORD_LABELS, 12), "Job #12");
  assert.equal(isCustom(DEFAULT_RECORD_LABELS, "lead"), false);
});

test("custom names reach the menu and the job number", () => {
  const labels = parseRecordLabels(JSON.stringify({ lead: { one: "Matter", many: "Matters" }, jobcard: { one: "Work order", many: "Work orders" } }));
  assert.deepEqual(navLabelOverrides(labels), { "/leads": "Matters", "/jobcards": "Work orders" });
  assert.equal(jobNumberLabel(labels, 7), "Work order #7");
  assert.equal(midSentence("Matter"), "matter");
  assert.equal(midSentence("RFQ"), "RFQ", "acronyms keep their capitals");
});

test("the shell and the main pages read the workspace's names", () => {
  const read = (path: string) => readFileSync(path, "utf8");
  const layout = read("src/app/(app)/layout.tsx");
  assert.match(layout, /\n\s*getRecordLabels\(\),\s/);
  assert.match(layout, /recordLabels=\{recordLabels\}/);
  assert.match(read("src/components/Nav.tsx"), /navLabelOverrides\(useRecordLabels\(\)\)/);
  assert.match(read("src/components/nav-config.ts"), /label: labels\["\/leads"\] \?\? "Leads"/);
  assert.match(read("src/app/(app)/leads/page.tsx"), /title=\{labels\.lead\.many\}/);
  assert.match(read("src/app/(app)/jobcards/page.tsx"), /title=\{labels\.jobcard\.many\}/);
  assert.match(read("src/app/(app)/deals/[id]/page.tsx"), /eyebrow=\{labels\.deal\.one\}/);
  // Only the workspace owner may change them, and the save goes through the acting-workspace wrapper.
  const action = read("src/app/actions/company.ts");
  const save = action.slice(action.indexOf("export async function saveRecordLabels"), action.indexOf("export async function saveCompanyProfile"));
  assert.match(save, /return asActionResult\(async \(\) => \{\s*const user = await requireTenantOwner\(\);/);
});
