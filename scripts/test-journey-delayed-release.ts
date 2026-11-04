/**
 * A delayed Journey start survives waiting in line, on a real database (PR #976 review):
 * a chatbot follow-up enrolled "in 2 days" behind another open run is released when
 * that run closes — and must still start in 2 days, not the moment it is released.
 *
 *   npm run test:journey-delayed-release   (DATABASE_URL = a disposable, migrated, seeded database)
 */
import assert from "node:assert/strict";

process.env.TENANT_ENFORCEMENT ||= "enforce";
const run = Date.now();
let checks = 0;
const ok = (label: string) => console.log(`  ✓ ${++checks}. ${label}`);

(async () => {
  const { basePrisma } = await import("../src/lib/db");
  const { runInTenantScope } = await import("../src/lib/tenantScope");
  const { releaseBlockedJourneyRuns } = await import("../src/lib/journeyRuns");

  const user = await basePrisma.user.findFirstOrThrow({ where: { tenantId: { not: null } }, select: { tenantId: true } });
  const tenantId = user.tenantId!;
  const journey = await basePrisma.journey.create({ data: { tenantId, name: `Delayed release ${run}` }, select: { id: true } });
  const version = await basePrisma.journeyVersion.create({
    data: { tenantId, journeyId: journey.id, version: 1, triggers: [], trigger: "manual", definition: { startStepId: "w", steps: [] } },
    select: { id: true },
  });
  const newRun = (entityId: string, data: Record<string, unknown>) =>
    basePrisma.journeyRun.create({
      data: { tenantId, journeyId: journey.id, journeyVersionId: version.id, entityType: "contact", entityId, context: {}, idempotencyKey: `delayed-${run}-${entityId}-${Math.random()}`, ...data },
      select: { id: true },
    });
  const read = (id: string) => basePrisma.journeyRun.findUniqueOrThrow({ where: { id }, select: { status: true, nextRunAt: true } });
  const release = () => runInTenantScope({ tenantId, system: false }, () => releaseBlockedJourneyRuns());

  // 1. Scheduled two days out, blocked behind a run that has now finished.
  const inTwoDays = new Date(Date.now() + 2 * 86_400_000);
  const first = await newRun(`a-${run}`, { status: "completed" });
  const delayed = await newRun(`a-${run}`, { status: "blocked", blockedByRunId: first.id, nextRunAt: inTwoDays });
  await release();
  const d = await read(delayed.id);
  assert.equal(d.status, "queued", "released");
  assert.equal(d.nextRunAt.getTime(), inTwoDays.getTime(), "kept its scheduled start");
  ok("a follow-up scheduled in 2 days, released early, still starts in 2 days");

  // 2. An ordinary queued run (its time already passed) starts now.
  const before = Date.now();
  const first2 = await newRun(`b-${run}`, { status: "completed" });
  const plain = await newRun(`b-${run}`, { status: "blocked", blockedByRunId: first2.id, nextRunAt: new Date(Date.now() - 3_600_000) });
  await release();
  const p = await read(plain.id);
  assert.equal(p.status, "queued");
  assert.ok(p.nextRunAt.getTime() >= before - 1000, "starts at release, not an hour in the past");
  ok("an ordinary queued run starts when it is released");

  console.log(`\n${checks} checks passed`);
  await basePrisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
