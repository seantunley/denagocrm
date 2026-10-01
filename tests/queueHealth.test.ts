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
