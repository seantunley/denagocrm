import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

// Gap audit #34: background queues (signing jobs, the message outbox, campaign
// sends, survey invitations, journey runs) had no screen — their failures only
// showed in the 30-day error log.

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const lib = src("src/lib/queueHealth.ts");

test("every queue is covered: counts, overdue work, and recent failures", () => {
  for (const model of ["signingJob", "botFlowOutbox", "campaignRecipient", "surveyResponse", "journeyRun"]) {
    assert.match(lib, new RegExp(`prisma\\.${model}\\.groupBy\\(`), `${model}: counts`);
    assert.match(lib, new RegExp(`prisma\\.${model}\\.count\\(`), `${model}: overdue`);
    assert.match(lib, new RegExp(`prisma\\.${model}\\.findMany\\(`), `${model}: failures`);
  }
  // The guarded client only — every row is the viewer's workspace.
  assert.doesNotMatch(lib, /basePrisma/);
});

test("work a worker claimed and never finished counts as stuck, not healthy", () => {
  // Review of #736: a worker that died holding leases left the screen green.
  const count = (model: string) => {
    const at = lib.indexOf(`prisma.${model}.count(`);
    return lib.slice(at, lib.indexOf("\n    ]),", at));
  };
  // Lease-based queues use the lease's own expiry, as their workers do — not the
  // 15-minute "overdue" grace (re-review of #736).
  assert.match(lib, /const leaseExpired = new Date\(now\);/);
  assert.match(lib, /\{ status: "running", leaseUntil: \{ lt: leaseExpired \} \}/);
  assert.match(lib, /\{ status: "running", leaseUntil: null \}/);
  const lease = lib.slice(lib.indexOf("const abandonedLease = ["), lib.indexOf("];", lib.indexOf("const abandonedLease = [")));
  assert.doesNotMatch(lease, /overdue/);
  for (const model of ["signingJob", "botFlowOutbox"]) assert.match(count(model), /\.\.\.abandonedLease/, `${model}: expired leases`);
  for (const model of ["campaignRecipient", "surveyResponse"]) {
    assert.match(count(model), /\{ status: "sending", lastAttemptAt: \{ lt: overdue \} \}/, `${model}: stale sending claims`);
  }
  assert.match(count("journeyRun"), /\{ status: "running", updatedAt: \{ lt: overdue \} \}/);
});

test("the outbox shows the classified reason, never the raw provider text (it can quote a number)", () => {
  const outbox = lib.slice(lib.indexOf('key: "outbox"'), lib.indexOf('key: "campaigns"'));
  assert.match(outbox, /deliveryFailureReason\(row\.failureCode\)/);
  assert.doesNotMatch(outbox, /lastError/);
  assert.match(lib, /NOT: \{ failureCode: "blocked_by_earlier_failure" \}/);
});

test("the screen is owner-only and listed in Settings", () => {
  assert.match(src("src/app/(app)/settings/queues/page.tsx"), /await requireOwner\(\);/);
  assert.match(src("src/lib/settings-navigation.ts"), /\{ key: "queues", label: "Background queues", href: "\/settings\/queues",/);
});
