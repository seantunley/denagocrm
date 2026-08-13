/**
 * Apply the stage-gates migration to the database STAGE_GATES_DB_URL names.
 *
 * WHY THIS EXISTS RATHER THAN `prisma migrate deploy`: the connection has to be
 * named explicitly. `tsx` loads `.env`, which points at PRODUCTION, while local
 * dev runs on `.env.local` — so a migration tool taking the ambient environment
 * would apply this to the wrong database with no warning. It also REFUSES the
 * production endpoint outright.
 *
 * Every statement is IF NOT EXISTS, exactly as the migration file is, so running
 * it twice is a no-op.
 *
 * Run:  STAGE_GATES_DB_URL="<dev url>" npx tsx scripts/stage-gates-dev-apply.ts
 */
import { PrismaClient } from "@prisma/client";

const url = process.env.STAGE_GATES_DB_URL;
if (!url) {
  console.error("Set STAGE_GATES_DB_URL to the database you mean to change.");
  process.exit(1);
}
// The production endpoint, refused by name. A dev convenience script must not be
// one typo away from altering the live table.
if (url.includes("ep-patient-waterfall")) {
  console.error("REFUSED: that is the production endpoint. This script is for the dev branch.");
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url } } });

async function main() {
  console.log("host:", url!.match(/@([^/]+)/)?.[1] ?? "unknown");

  await prisma.$executeRawUnsafe(`ALTER TABLE "PipelineStage" ADD COLUMN IF NOT EXISTS "entryCriteria" JSONB`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "PipelineStage" ADD COLUMN IF NOT EXISTS "exitCriteria" JSONB`);
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "PipelineStage" ADD COLUMN IF NOT EXISTS "entryGateMode" TEXT NOT NULL DEFAULT 'off'`,
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "PipelineStage" ADD COLUMN IF NOT EXISTS "exitGateMode" TEXT NOT NULL DEFAULT 'off'`,
  );
  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PipelineStage_entryGateMode_check') THEN
        ALTER TABLE "PipelineStage" ADD CONSTRAINT "PipelineStage_entryGateMode_check"
          CHECK ("entryGateMode" IN ('off', 'warn', 'reason', 'block'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PipelineStage_exitGateMode_check') THEN
        ALTER TABLE "PipelineStage" ADD CONSTRAINT "PipelineStage_exitGateMode_check"
          CHECK ("exitGateMode" IN ('off', 'warn', 'reason', 'block'));
      END IF;
    END $$;
  `);

  // Record it in Prisma's ledger so a later `migrate deploy` does not try again
  // and so `migrate status` does not report drift.
  await prisma.$executeRawUnsafe(`
    INSERT INTO "_prisma_migrations" ("id", "checksum", "migration_name", "started_at", "finished_at", "applied_steps_count")
    SELECT gen_random_uuid()::text, 'applied-by-stage-gates-dev-apply', '20260813120000_stage_gates', now(), now(), 1
    WHERE NOT EXISTS (
      SELECT 1 FROM "_prisma_migrations" WHERE "migration_name" = '20260813120000_stage_gates'
    )
  `);

  const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'PipelineStage'
      AND column_name IN ('entryCriteria', 'exitCriteria', 'entryGateMode', 'exitGateMode')
    ORDER BY column_name`;
  console.log("gate columns now:", columns.map((c) => c.column_name).join(", "));
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
