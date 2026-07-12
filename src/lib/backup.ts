import { basePrisma as prisma } from "./db";

async function queryOrEmpty<T>(query: () => Promise<T[]>): Promise<T[]> {
  try {
    return await query();
  } catch {
    // Supports rolling deployments where the application code can exist briefly
    // before a newly-added table has been migrated.
    return [];
  }
}

/** Full-database export (including trashed records) for backups. */
export async function exportAllData() {
  const [
    salesPipelines,
    pipelineStageGovernance,
    leadForecastState,
    teams,
    teamMembers,
    roles,
    permissions,
    rolePermissions,
    userRoles,
    forecastSnapshots,
    auditEvents,
  ] = await Promise.all([
    queryOrEmpty(() => prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT * FROM "SalesPipeline" ORDER BY "createdAt"
    `),
    queryOrEmpty(() => prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT "id", "pipelineId", "defaultProbability", "staleAfterDays", "isClosed", "closedStatus"
      FROM "PipelineStage" ORDER BY "pipelineId", "order"
    `),
    queryOrEmpty(() => prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT "id", "pipelineId", "teamId", "probability", "forecastCategory",
        "expectedCloseDate", "estimatedCostCents", "wonAt", "lostAt"
      FROM "Lead" ORDER BY "createdAt"
    `),
    queryOrEmpty(() => prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT * FROM "Team" ORDER BY "createdAt"
    `),
    queryOrEmpty(() => prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT * FROM "TeamMember" ORDER BY "createdAt"
    `),
    queryOrEmpty(() => prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT * FROM "Role" ORDER BY "createdAt"
    `),
    queryOrEmpty(() => prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT * FROM "Permission" ORDER BY "category", "key"
    `),
    queryOrEmpty(() => prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT * FROM "RolePermission" ORDER BY "roleId", "permissionKey"
    `),
    queryOrEmpty(() => prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT * FROM "UserRole" ORDER BY "userId", "roleId"
    `),
    queryOrEmpty(() => prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT "id", "period", "pipelineId", "teamId", "userId",
        "openValueCents"::text AS "openValueCents", "weightedValueCents"::text AS "weightedValueCents",
        "commitValueCents"::text AS "commitValueCents", "bestCaseValueCents"::text AS "bestCaseValueCents",
        "opportunityCount", "capturedAt"
      FROM "ForecastSnapshot" ORDER BY "capturedAt"
    `),
    queryOrEmpty(() => prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT * FROM "AuditEvent" ORDER BY "createdAt"
    `),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    users: await prisma.user.findMany(),
    appSettings: await prisma.appSetting.findMany(),
    products: await prisma.product.findMany({ include: { colors: true } }),
    tags: await prisma.tag.findMany(),
    contacts: await prisma.contact.findMany({ include: { tags: { select: { id: true } } } }),
    pipelineStages: await prisma.pipelineStage.findMany(),
    leads: await prisma.lead.findMany(),
    vehicles: await prisma.vehicle.findMany(),
    mileageLogs: await prisma.mileageLog.findMany(),
    jobCards: await prisma.jobCard.findMany({ include: { items: true } }),
    serviceRecords: await prisma.serviceRecord.findMany(),
    communications: await prisma.communication.findMany(),
    activities: await prisma.activity.findMany(),
    documents: await prisma.document.findMany(),
    emailTemplates: await prisma.emailTemplate.findMany(),
    libraryDocuments: await prisma.libraryDocument.findMany({ include: { versions: true } }),
    quotes: await prisma.quote.findMany({ include: { items: true } }),
    automationRules: await prisma.automationRule.findMany(),
    automationLogs: await prisma.automationLog.findMany(),
    governance: {
      salesPipelines,
      pipelineStageGovernance,
      leadForecastState,
      teams,
      teamMembers,
      roles,
      permissions,
      rolePermissions,
      userRoles,
      forecastSnapshots,
      auditEvents,
    },
  };
}
