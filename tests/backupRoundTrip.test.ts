import test from "node:test";
import assert from "node:assert/strict";
import { stringifyBackup, reviveBackupBigInts } from "@/lib/backup";

// The export is column-complete (SELECT *), but a backup is only useful if a
// restore can *consume* those columns. There is no automated DB-restore importer
// (Neon PITR is the primary recovery mechanism); "restore" here means a consumer
// reading the portable export. This proves that consumer round-trips the
// out-of-model columns AND BigInt values intact.
test("backup round-trips out-of-model columns and BigInt values (restore-ready)", () => {
  // Shape a `data` payload as SELECT * would produce: includes columns absent
  // from the Prisma models (Lead.teamId/pipelineId/forecast, PipelineStage.pipelineId)
  // and a BigInt (CustomerCase.number).
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
    CustomerCase: [{ id: "c1", number: 7n }],
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
  assert.equal(restored.data.CustomerCase[0].number, 7n);
});
