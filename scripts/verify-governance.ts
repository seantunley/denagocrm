import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

type CountRow = { count: bigint };
type NameCountRow = { name: string; count: bigint };

async function count(query: Promise<CountRow[]>) {
  const rows = await query;
  return Number(rows[0]?.count ?? BigInt(0));
}

async function main() {
  const failures: string[] = [];
  const warnings: string[] = [];

  const activeDefaults = await count(prisma.$queryRaw<CountRow[]>`
    SELECT COUNT(*) AS count FROM "SalesPipeline"
    WHERE "isDefault" = true AND "active" = true AND "deletedAt" IS NULL
  `);
  if (activeDefaults !== 1) failures.push(`Expected exactly one active default pipeline; found ${activeDefaults}`);

  const leadStageMismatches = await count(prisma.$queryRaw<CountRow[]>`
    SELECT COUNT(*) AS count
    FROM "Lead" l JOIN "PipelineStage" s ON s."id" = l."stageId"
    WHERE l."pipelineId" <> s."pipelineId"
  `);
  if (leadStageMismatches > 0) failures.push(`${leadStageMismatches} leads have a pipeline that does not match their stage`);

  const invalidProbabilities = await count(prisma.$queryRaw<CountRow[]>`
    SELECT COUNT(*) AS count FROM "Lead" WHERE "probability" < 0 OR "probability" > 100
  `);
  if (invalidProbabilities > 0) failures.push(`${invalidProbabilities} leads have invalid probabilities`);

  const orphanStages = await count(prisma.$queryRaw<CountRow[]>`
    SELECT COUNT(*) AS count
    FROM "PipelineStage" s LEFT JOIN "SalesPipeline" p ON p."id" = s."pipelineId"
    WHERE p."id" IS NULL
  `);
  if (orphanStages > 0) failures.push(`${orphanStages} pipeline stages are orphaned`);

  const unassignedModuleUsers = await prisma.$queryRaw<NameCountRow[]>`
    SELECT u."name", COUNT(ur."roleId") AS count
    FROM "User" u LEFT JOIN "UserRole" ur ON ur."userId" = u."id"
    WHERE u."role" <> 'owner'
      AND (
        (',' || REPLACE(u."modules", ' ', '') || ',') LIKE '%,crm,%'
        OR (',' || REPLACE(u."modules", ' ', '') || ',') LIKE '%,workshop,%'
      )
    GROUP BY u."id", u."name"
    HAVING COUNT(ur."roleId") = 0
  `;
  if (unassignedModuleUsers.length > 0) {
    failures.push(`Users with CRM/workshop modules but no RBAC role: ${unassignedModuleUsers.map((row) => row.name).join(", ")}`);
  }

  const auditTriggers = await count(prisma.$queryRaw<CountRow[]>`
    SELECT COUNT(*) AS count FROM pg_trigger
    WHERE tgname IN ('AuditEvent_no_update', 'AuditEvent_no_delete') AND NOT tgisinternal
  `);
  if (auditTriggers !== 2) failures.push(`Expected two append-only AuditEvent triggers; found ${auditTriggers}`);

  const leadSyncTrigger = await count(prisma.$queryRaw<CountRow[]>`
    SELECT COUNT(*) AS count FROM pg_trigger
    WHERE tgname = 'Lead_sync_pipeline_forecast' AND NOT tgisinternal
  `);
  if (leadSyncTrigger !== 1) failures.push("Lead pipeline/forecast synchronization trigger is missing");

  const emptyActivePipelines = await prisma.$queryRaw<NameCountRow[]>`
    SELECT p."name", COUNT(s."id") AS count
    FROM "SalesPipeline" p LEFT JOIN "PipelineStage" s ON s."pipelineId" = p."id" AND s."isClosed" = false
    WHERE p."active" = true AND p."deletedAt" IS NULL
    GROUP BY p."id", p."name"
    HAVING COUNT(s."id") = 0
  `;
  for (const pipeline of emptyActivePipelines) warnings.push(`Active pipeline “${pipeline.name}” has no open stage`);

  const summary = {
    activeDefaults,
    leadStageMismatches,
    invalidProbabilities,
    orphanStages,
    usersMissingRoles: unassignedModuleUsers.length,
    auditTriggers,
    leadSyncTrigger,
    warnings,
  };

  console.log(JSON.stringify(summary, null, 2));
  if (failures.length > 0) {
    console.error("Governance verification failed:\n- " + failures.join("\n- "));
    process.exitCode = 1;
  } else {
    console.log("Governance verification passed.");
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
