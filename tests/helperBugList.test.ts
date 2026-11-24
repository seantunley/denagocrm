import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 2026-11-24 help-review bug list: behaviour the guides had to warn about, now fixed at the source.
const code = (path: string) => readFileSync(path, "utf8");

test("inspecting a stock arrival keeps the unit's notes and adds the condition note under them", () => {
  const stock = code("src/app/actions/stock.ts");
  assert.match(stock, /notes: conditionNote \? \[current\.notes, `On arrival: \$\{conditionNote\}`\]\.filter\(Boolean\)\.join\("\\n\\n"\) : current\.notes,/);
  assert.doesNotMatch(stock, /notes: conditionNote,/);
});

test("Remove part asks first", () => {
  const parts = code("src/app/(app)/parts/page.tsx");
  assert.match(parts, /<ConfirmDelete\s+action=\{deletePart\.bind\(null, p\.id\)\}/);
  assert.doesNotMatch(parts, /<form action=\{deletePart/);
});

test("the vehicle page shows its forms only to people who may use them", () => {
  const page = code("src/app/(app)/vehicles/[id]/page.tsx");
  for (const action of ["addServiceRecord", "addMileage", "addBatteryCheck"]) {
    assert.match(page, new RegExp(`\\{canManage && <form[\\s\\S]{0,40}action=\\{${action}\\.bind`), action);
  }
  assert.match(page, /\{canManageWarranty && <form action=\{addWarrantyClaim\.bind/);
  assert.match(page, /\{canOpenJobCard && \(/);
});

test("labour rate and package price hints use the workspace currency", () => {
  assert.doesNotMatch(code("src/app/(app)/jobcards/[id]/page.tsx"), /placeholder=\{`R\$\{/);
  assert.doesNotMatch(code("src/app/(app)/settings/workshop/page.tsx"), /placeholder="Unit R"/);
  assert.doesNotMatch(code("src/components/dashboard/widgets.tsx"), /`R\$\{/);
  assert.match(code("src/components/JobCardForm.tsx"), /opens at the Booking stage/);
});
