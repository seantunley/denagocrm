import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

// Gap audit #20: what was captured at check-in (work requested, arrival km)
// could never be corrected after the job card was created.

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const actions = src("src/app/actions/jobcards.ts");
const fn = actions.slice(actions.indexOf("export async function updateJobCardDetails("), actions.indexOf("export async function setJobCardPriority("));

test("the edit is gated like every other job card change", () => {
  assert.match(fn, /await requireJobCardAccess\(jobCardId, "jobcards\.manage"\)/);
});

test("a completed card can't be edited (its service record was written from these)", () => {
  assert.match(fn, /if \(before\.status === "collected"\) refuse\(/);
});

test("the collected check is atomic with the write — a card completed mid-edit is refused", () => {
  const tx = fn.slice(fn.indexOf("prisma.$transaction(async (tx) =>"));
  assert.match(tx, /tx\.jobCard\.updateMany\(\{\s*where: \{ id: jobCardId, status: \{ not: "collected" \} \}/);
  assert.match(tx, /if \(count === 0\) refuse\(completed\)/);
  assert.doesNotMatch(tx, /tx\.jobCard\.update\(/);
});

test("a recreated check-in mileage log carries the job card's tenant", () => {
  assert.match(fn, /const tenantId = before\.tenantId \?\? \(await actingTenantId\(\)\);/);
  assert.match(fn, /tx\.mileageLog\.create\(\{\s*data: \{ tenantId, vehicleId/);
});

test("input is validated: description required, km a non-negative whole number", () => {
  assert.match(fn, /if \(!description\) refuse\(/);
  assert.match(fn, /isNaN\(kmIn\) \|\| kmIn < 0\)\) refuse\(/);
});

test("the check-in mileage log follows the corrected reading, in the same transaction", () => {
  const tx = fn.slice(fn.indexOf("prisma.$transaction(async (tx) =>"));
  assert.match(tx, /tx\.jobCard\.updateMany\(/);
  assert.match(tx, /note: checkInNote/);
  assert.match(tx, /tx\.mileageLog\.update\(/);
});

test("the change is audited old → new", () => {
  assert.match(fn, /action: "jobcard\.updated"/);
  assert.match(fn, /arrival km \$\{before\.kmIn \?\? "—"\} → \$\{kmIn \?\? "—"\}/);
});

test("the page offers Edit details on open cards only", () => {
  const page = src("src/app/(app)/jobcards/[id]/page.tsx");
  assert.match(page, /jobCard\.status !== "collected" && \(\s*<ModalTrigger label="Edit details"/);
  assert.match(page, /action=\{updateJobCardDetails\.bind\(null, jobCard\.id\)\}/);
});
