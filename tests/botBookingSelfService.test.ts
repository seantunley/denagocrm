import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("booking lookup is read-only and restricted to the conversation customer", () => {
  const code = src("src/lib/botBookingSelfService.ts");
  const start = code.indexOf("export async function findUpcomingBotBooking");
  const end = code.indexOf("export async function cancelBotBooking", start);
  const lookup = code.slice(start, end);
  assert.match(lookup, /ownerWhere\(owner\)/);
  assert.match(lookup, /category: "workshop"/);
  assert.match(lookup, /status: "planned"/);
  assert.match(lookup, /dueDate: \{ gte: new Date\(\) \}/);
  assert.doesNotMatch(lookup, /\.create\(|\.update\(|\.upsert\(/, "a failed booking lookup must not create or mutate CRM records");
});

test("captured-phone lookup matches only an existing contact or open lead", () => {
  const code = src("src/lib/botBookingSelfService.ts");
  const resolver = code.slice(code.indexOf("async function resolveBookingOwner"), code.indexOf("function ownerWhere"));
  assert.match(resolver, /phoneTail\(vars\.phone\)/);
  assert.match(resolver, /prisma\.contact\.findFirst/);
  assert.match(resolver, /prisma\.lead\.findFirst/);
  assert.match(resolver, /status: "open"/);
  assert.doesNotMatch(resolver, /\.create\(/);
});

test("cancellation retains history and releases workshop capacity by leaving planned state", () => {
  const code = src("src/lib/botBookingSelfService.ts");
  const cancel = code.slice(code.indexOf("export async function cancelBotBooking"));
  assert.match(cancel, /existing\.status === "cancelled"/);
  assert.match(cancel, /existing\.status !== "planned"/);
  assert.match(cancel, /data: \{ status: "cancelled" \}/);
  assert.doesNotMatch(cancel, /activity\.delete/);
});

test("cancellation is idempotent under retries and concurrent cancellation", () => {
  const code = src("src/lib/botBookingSelfService.ts");
  const cancel = code.slice(code.indexOf("export async function cancelBotBooking"));
  assert.match(cancel, /updateMany/);
  assert.match(cancel, /status: "planned"/);
  assert.match(cancel, /updated\.count !== 1/);
  assert.match(cancel, /after\?\.status === "cancelled"/);
  assert.match(cancel, /alreadyCancelled: true/);
});

test("a booking id alone is never enough to cancel someone else's reservation", () => {
  const code = src("src/lib/botBookingSelfService.ts");
  const cancel = code.slice(code.indexOf("export async function cancelBotBooking"));
  assert.match(cancel, /const scope = ownerWhere\(owner\)/);
  assert.match(cancel, /if \(!scope \|\| !bookingId\) return \{ ok: false \}/);
  assert.match(cancel, /\.\.\.scope/);
});
