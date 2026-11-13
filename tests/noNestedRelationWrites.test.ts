import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Under tenant enforcement the scoped `prisma` client REFUSES a nested relation write — `{ attendees: { create } }`,
 * `{ tags: { connect } }` — because its guard can only stamp the top-level row (lib/db.ts refuseNestedRelationWrite).
 * Nothing catches that until the write runs on live: a meeting with Donovan failed at Confirm (2026-11-13, HYT9W5).
 *
 * So every nested relation write in src is listed here, each one checked to run on `basePrisma` (which bypasses the
 * guard and stamps its own tenantId). A new one fails this test: write the related rows flat in the same
 * transaction (as scheduleActivity / updateActivity do for attendees), or use basePrisma with an explicit tenantId.
 */
const ON_BASE_PRISMA = new Set([
  "src/app/actions/quotes.ts", // revise: basePrisma.$transaction
  "src/lib/quoteOutcome.ts", // duplicateQuoteInTx: only ever called inside basePrisma.$transaction (actions/quotes.ts)
  "src/app/actions/checklistTemplates.ts", // basePrisma.$transaction
  "src/app/actions/merge.ts", // basePrisma.$transaction
  "src/app/actions/surveyFollowUps.ts", // basePrisma.customerCase.create
  "src/lib/flowActions.ts", // the chatbot's tag step: basePrisma.contact.update held to the workspace by tenantId
]);

const root = join(__dirname, "..");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });

test("no nested relation write runs on the tenant-guarded client", () => {
  const nested = /\w+:\s*\{\s*(?:create|createMany|connect|connectOrCreate|set|upsert)\s*:/;
  const found = files(join(root, "src"))
    .map((path) => relative(root, path).replace(/\\/g, "/"))
    .filter((rel) => rel !== "src/lib/db.ts" && rel !== "src/lib/tenantGuard.ts")
    .filter((rel) => nested.test(readFileSync(join(root, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")));
  const unlisted = found.filter((rel) => !ON_BASE_PRISMA.has(rel));
  assert.deepEqual(unlisted, [], "write the related rows flat in the same transaction, or use basePrisma with an explicit tenantId");
});

test("a meeting's colleagues are written flat, after the meeting, in the same transaction", () => {
  const actions = readFileSync(join(root, "src/app/actions/activities.ts"), "utf8");
  assert.doesNotMatch(actions, /attendees:\s*\{\s*create/);
  assert.match(actions, /await tx\.activityAttendee\.createMany\(\{\s*data: attendees\.map\(\(person\) => \(\{ activityId: created\.id, userId: person\.id, tenantId: scheduleTenant \}\)\)/);
  const flow = readFileSync(join(root, "src/lib/flowActions.ts"), "utf8");
  assert.match(flow, /basePrisma\.contact\.update\(\{ where: \{ id: match\.contactId, tenantId \}, data: \{ tags: \{ connect/);
});
