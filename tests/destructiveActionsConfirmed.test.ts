import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

// Gap audit #21: these deleted or cancelled on ONE click, and the three hard
// deletes left no audit line at all.

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const CASES: Array<[string, string]> = [
  ["src/app/(app)/vehicles/[id]/page.tsx", "deleteBatteryCheck"],
  ["src/app/(app)/vehicles/[id]/page.tsx", "deleteWarrantyClaim"],
  ["src/app/(app)/warranty/page.tsx", "deleteRecall"],
  ["src/app/(app)/signing-workflows/[id]/page.tsx", "deleteSignWorkflow"],
];

for (const [file, action] of CASES) {
  test(`${action} is behind a confirmation, never a bare form`, () => {
    const s = src(file);
    assert.doesNotMatch(s, new RegExp(`<form action=\\{${action}\\.bind`), "one-click delete is back");
    assert.match(s, new RegExp(`<ConfirmDelete\\s+action=\\{${action}\\.bind\\(null,`));
  });
}

test("Cancel job is confirmed with a reason, and the reason reaches the audit line", () => {
  const page = src("src/app/(app)/jobcards/[id]/page.tsx");
  assert.doesNotMatch(page, /<SaveForm[^>]*setJobCardStatus\.bind\(null, jobCard\.id, "cancelled"\)/);
  assert.match(page, /<ConfirmDelete\s+action=\{setJobCardStatus\.bind\(null, jobCard\.id, "cancelled"\)\}/);
  assert.match(src("src/app/actions/jobcards.ts"), /setJobCardStatus\(jobCardId: string, status: string, formData\?: FormData\)[\s\S]*?\$\{reason \? ` — \$\{reason\}` : ""\}/);
});

test("the permanent deletes are audited with what was deleted and why", () => {
  const warranty = src("src/app/actions/warranty.ts");
  assert.match(warranty, /action: "warranty\.claim_deleted"/);
  assert.match(warranty, /action: "recall\.deleted"/);
  assert.doesNotMatch(warranty, /recall\.delete\(\{ where: \{ id \} \}\)\.catch\(\(\) => \{\}\)/, "a failed delete no longer pretends to succeed");
  assert.match(src("src/app/actions/vehicles.ts"), /action: "battery_check\.deleted"/);
  assert.match(src("src/app/actions/signflow.ts"), /Deleted the signing workflow “\$\{wf\.name\}” — \$\{reason\}/);
});
