import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { jobCardPrintFields } from "../src/lib/docbuilder/jobCardFields";

/*
 * A job card no longer needs a vehicle (2026-11-05): a business that isn't a vehicle workshop opens a job for a
 * customer alone. Existing job cards keep their vehicles; a job with none has no mileage and no service history.
 */
const code = (path: string) => readFileSync(path, "utf8");
const actions = code("src/app/actions/jobcards.ts");
const slice = (from: string, to: string) => actions.slice(actions.indexOf(from), actions.indexOf(to));

test("the column only stops being required: one relaxing statement, nothing else", () => {
  assert.match(code("prisma/schema.prisma"), /vehicleId String\?\s+vehicle\s+Vehicle\? @relation\(fields: \[vehicleId\]/);
  const dir = readdirSync("prisma/migrations").find((name) => name.endsWith("_jobcard_vehicle_optional"));
  assert.ok(dir, "migration present");
  const sql = code(`prisma/migrations/${dir}/migration.sql`).replace(/--[^\n]*/g, "").trim();
  assert.equal(sql, 'ALTER TABLE "JobCard" ALTER COLUMN "vehicleId" DROP NOT NULL;');
});

test("opening a job for a customer alone is checked like any other", () => {
  const door = slice("export async function openJobCard", "async function claimPartStock");
  assert.match(door, /if \(!vehicleId && !String\(input\.contactId \?\? ""\)\.trim\(\)\) throw new Error\("Choose a vehicle or a customer\."\)/);
  // With a vehicle, the customer is still the vehicle's owner — a submitted contactId is ignored.
  assert.match(door, /if \(vehicleId\) \{\s*user = await requireVehicleAccess\(vehicleId, "jobcards\.manage"\);[\s\S]*?contactId = vehicle\.contactId;/);
  assert.match(door, /const kmIn = vehicleId \? input\.kmIn \?\? null : null;/, "no mileage without a vehicle");
  assert.match(door, /if \(vehicleId && jc\.kmIn != null\)/);
});

test("completing a job with no vehicle writes no service record or mileage", () => {
  const complete = slice("export async function completeJobCard", "export async function deleteJobCard(");
  assert.match(complete, /if \(jobCard\.vehicleId\) \{\s*await tx\.serviceRecord\.upsert/);
  assert.match(complete, /if \(jobCard\.vehicleId && km != null && !isNaN\(km\)\)/);
  const edit = slice("export async function updateJobCardDetails", "export async function setJobCardPriority");
  assert.match(edit, /if \(!before\.vehicleId && kmIn != null\) refuse\(/);
  assert.match(edit, /if \(before\.vehicleId && before\.kmIn !== kmIn\)/);
});

test("printed job cards read cleanly without a vehicle", () => {
  const base = { status: "repair", openedAt: new Date("2026-11-05T08:00:00Z"), completedAt: null, kmIn: null, notes: null, signedAt: null, signedByName: null, signerIp: null };
  const none = jobCardPrintFields({ ...base, vehicle: null });
  assert.equal(none.tokens["vehicle.title"], "");
  assert.match(none.tokens["vehicle.lines"], /^Opened /, "only the dates");
  const withOne = jobCardPrintFields({ ...base, vehicle: { model: "Denago Rover", color: "Red", vin: "V1", regNumber: null } });
  assert.equal(withOne.tokens["vehicle.title"], "Denago Rover — Red", "unchanged with a vehicle");
});

test("the form offers a customer when there is no vehicle, and every opener passes customers", () => {
  const form = code("src/components/JobCardForm.tsx");
  assert.match(form, /<ContactPicker id="job-card-contact" name="contactId" options=\{contacts\} required \/>/);
  assert.match(code("src/app/(app)/jobcards/page.tsx"), /contacts=\{contacts\.map/);
  assert.match(code("src/app/(app)/jobcards/new/page.tsx"), /contacts=\{contacts\.map/);
  assert.match(code("src/app/api/quick-create/route.ts"), /"jobcard"\]\.includes\(kind\)/);
});
