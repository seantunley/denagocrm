/**
 * Is the stage-gates migration present on the database this URL points at?
 *
 * Takes its connection from STAGE_GATES_DB_URL rather than the ambient .env,
 * because `tsx` loads `.env` — which points at PRODUCTION — while local dev runs
 * on `.env.local`. A check that silently answered for the wrong database is
 * exactly the kind of thing this repo has been bitten by.
 *
 * Run:  STAGE_GATES_DB_URL="<dev url>" npx tsx scripts/stage-gates-dev-check.ts
 */
import { PrismaClient } from "@prisma/client";

const url = process.env.STAGE_GATES_DB_URL;
if (!url) {
  console.error("Set STAGE_GATES_DB_URL to the database you mean to inspect.");
  process.exit(1);
}

const host = url.match(/@([^/]+)/)?.[1] ?? "unknown";
const prisma = new PrismaClient({ datasources: { db: { url } } });

async function main() {
  console.log("host:", host);
  const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'PipelineStage'
      AND column_name IN ('entryCriteria', 'exitCriteria', 'entryGateMode', 'exitGateMode')
    ORDER BY column_name`;
  const found = columns.map((c) => c.column_name);
  console.log("gate columns present:", found.length ? found.join(", ") : "NONE");
  console.log(found.length === 4 ? "READY" : "MIGRATION NEEDED");
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
