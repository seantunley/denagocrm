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
      AND u."disabledAt" IS NULL
      AND (
        (',' || REPLACE(u."modules", ' ', '') || ',') LIKE '%,crm,%'
        OR (',' || REPLACE(u."modules", ' ', '') || ',') LIKE '%,workshop,%'
      )
    GROUP BY u."id", u."name"
    HAVING COUNT(ur."roleId") = 0
  `;
  if (unassignedModuleUsers.length > 0) {
    failures.push(`Active users with CRM/workshop modules but no RBAC role: ${unassignedModuleUsers.map((row) => row.name).join(", ")}`);
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

  const securityColumns = await count(prisma.$queryRaw<CountRow[]>`
    SELECT COUNT(*) AS count
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'User'
      AND column_name IN ('sessionVersion', 'disabledAt', 'lastLoginAt', 'failedLoginCount')
  `);
  if (securityColumns !== 4) failures.push(`Expected four User security columns; found ${securityColumns}`);

  const limiterTable = await count(prisma.$queryRaw<CountRow[]>`
    SELECT COUNT(*) AS count
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'SecurityRateLimit'
  `);
  if (limiterTable !== 1) failures.push("SecurityRateLimit table is missing");

  const activeGovernanceAdmins = await count(prisma.$queryRaw<CountRow[]>`
    SELECT COUNT(DISTINCT u."id") AS count
    FROM "User" u
    WHERE u."disabledAt" IS NULL
      AND (
        u."role" = 'owner'
        OR EXISTS (
          SELECT 1 FROM "UserRole" ur
          JOIN "RolePermission" rp ON rp."roleId" = ur."roleId"
          WHERE ur."userId" = u."id" AND rp."permissionKey" = 'roles.manage'
        )
      )
  `);
  if (activeGovernanceAdmins < 1) failures.push("No active governance administrator remains");

  const requiredAdminPermissions = [
    "roles.view",
    "roles.manage",
    "teams.view",
    "teams.manage",
    "audit.view",
    "audit.export",
  ];
  const missingAdminPermissions = await prisma.$queryRaw<Array<{ permissionKey: string }>>`
    SELECT required."permissionKey"
    FROM UNNEST(${requiredAdminPermissions}::text[]) AS required("permissionKey")
    WHERE NOT EXISTS (
      SELECT 1 FROM "RolePermission" rp
      WHERE rp."roleId" = 'role_crm_admin' AND rp."permissionKey" = required."permissionKey"
    )
  `;
  if (missingAdminPermissions.length) {
    failures.push(`CRM administrator is missing protected permissions: ${missingAdminPermissions.map((item) => item.permissionKey).join(", ")}`);
  }

  const emptyActivePipelines = await prisma.$queryRaw<NameCountRow[]>`
    SELECT p."name", COUNT(s."id") AS count
    FROM "SalesPipeline" p LEFT JOIN "PipelineStage" s ON s."pipelineId" = p."id" AND s."isClosed" = false
    WHERE p."active" = true AND p."deletedAt" IS NULL
    GROUP BY p."id", p."name"
    HAVING COUNT(s."id") = 0
  `;
  for (const pipeline of emptyActivePipelines) warnings.push(`Active pipeline “${pipeline.name}” has no open stage`);

  const disabledTeamManagers = await prisma.$queryRaw<Array<{ name: string }>>`
    SELECT t."name"
    FROM "Team" t JOIN "User" u ON u."id" = t."managerId"
    WHERE t."deletedAt" IS NULL AND t."active" = true AND u."disabledAt" IS NOT NULL
  `;
  for (const team of disabledTeamManagers) warnings.push(`Active team “${team.name}” has a disabled manager`);

  const summary = {
    activeDefaults,
    leadStageMismatches,
    invalidProbabilities,
    orphanStages,
    usersMissingRoles: unassignedModuleUsers.length,
    auditTriggers,
    leadSyncTrigger,
    securityColumns,
    limiterTable,
    activeGovernanceAdmins,
    missingAdminPermissions: missingAdminPermissions.length,
    warnings,
  };

  console.log(JSON.stringify(summary, null, 2));
  if (failures.length > 0) {
    console.error("Governance verification failed:\n- " + failures.join("\n- "));
    process.exitCode = 1;
  } else {
    console.log("Governance and security verification passed.");
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
