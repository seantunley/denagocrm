import test from "node:test";
import assert from "node:assert/strict";
import { stringifyBackup, reviveBackupBigInts } from "@/lib/backup";

/**
 * WHAT THIS TEST DOES AND DOES NOT ESTABLISH.
 *
 * It was recovered from #81 with its original framing — "the export is
 * column-complete (SELECT *)" — and review was right that the framing is false
 * and the test cannot see it. It hands a hand-built object to stringifyBackup and
 * reviveBackupBigInts, so it proves the SERIALISER carries whatever it is given.
 * It says nothing about what the exporter retrieves.
 *
 * And the exporter is not column-complete. `exportAllModels` walks Prisma's DMMF
 * and calls each model's ordinary `findMany()`, which returns only the fields
 * Prisma declares; just four signing tables use `SELECT *`. A column that exists
 * in the database and not in the Prisma model is silently absent from every
 * backup.
 *
 * That is not hypothetical. `BackupRun.tenantId` exists in production and not in
 * the schema — the RLS coverage migration documents it — so it is missing from
 * the export today.
 *
 * So this test keeps its assertions, which are real and worth having, under an
 * honest title. The retrieval half is guarded by
 * scripts/check-backup-column-drift.ts, which asks the DATABASE what columns
 * exist and fails when one is invisible to the exporter.
 */
test("the backup SERIALISER carries unknown keys and BigInt values intact", () => {
  // Keys a `SELECT *` would produce and a Prisma model would not — the shape the
  // serialiser must not drop, whether or not the exporter currently supplies it.
  const data = {
    Lead: [
      {
        id: "l1",
        name: "Jane",
        teamId: "t1",
        pipelineId: "p1",
        probability: 40,
        forecastCategory: "commit",
        expectedCloseDate: "2026-08-01T00:00:00.000Z",
        estimatedCostCents: 12345,
      },
    ],
    PipelineStage: [
      { id: "s1", name: "New", pipelineId: "p1", defaultProbability: 10, staleAfterDays: 7, isClosed: false },
    ],
    CustomerCase: [{ id: "c1", number: BigInt(7) }],
  };

  const serialized = stringifyBackup({ data });
  const restored = reviveBackupBigInts(JSON.parse(serialized)) as { data: typeof data };

  const lead = restored.data.Lead[0];
  // Out-of-model columns survive to the restore consumer:
  assert.equal(lead.teamId, "t1");
  assert.equal(lead.pipelineId, "p1");
  assert.equal(lead.probability, 40);
  assert.equal(lead.forecastCategory, "commit");
  assert.equal(lead.estimatedCostCents, 12345);
  assert.equal(restored.data.PipelineStage[0].pipelineId, "p1");
  assert.equal(restored.data.PipelineStage[0].defaultProbability, 10);

  // BigInt values are reconstructed as real bigints (not strings/tags):
  assert.equal(typeof restored.data.CustomerCase[0].number, "bigint");
  assert.equal(restored.data.CustomerCase[0].number, BigInt(7));
});
