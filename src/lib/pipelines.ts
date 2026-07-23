import crypto from "crypto";
import { basePrisma } from "./db";

export type SalesPipelineRow = {
  id: string;
  name: string;
  description: string | null;
  type: string;
  active: boolean;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type PipelineStageRow = {
  id: string;
  name: string;
  order: number;
  color: string;
  pipelineId: string;
  defaultProbability: number;
  staleAfterDays: number | null;
  isClosed: boolean;
  closedStatus: string | null;
  entryAction: string | null;
};

export type ForecastLeadRow = {
  id: string;
  title: string;
  name: string;
  status: string;
  valueCents: number;
  estimatedCostCents: number | null;
  probability: number;
  forecastCategory: string;
  expectedCloseDate: Date | null;
  pipelineId: string;
  pipelineName: string;
  stageId: string;
  stageName: string;
  assignedToId: string | null;
  assignedToName: string | null;
  teamId: string | null;
  teamName: string | null;
  updatedAt: Date;
};

export async function listSalesPipelines(activeOnly = false): Promise<SalesPipelineRow[]> {
  if (activeOnly) return listActiveSalesPipelines();
  return basePrisma.$queryRaw<SalesPipelineRow[]>`
    SELECT "id", "name", "description", "type", "active", "isDefault", "createdAt", "updatedAt"
    FROM "SalesPipeline"
    WHERE "deletedAt" IS NULL
    ORDER BY "isDefault" DESC, "name" ASC
  `;
}

export async function listActiveSalesPipelines(): Promise<SalesPipelineRow[]> {
  return basePrisma.$queryRaw<SalesPipelineRow[]>`
    SELECT "id", "name", "description", "type", "active", "isDefault", "createdAt", "updatedAt"
    FROM "SalesPipeline"
    WHERE "deletedAt" IS NULL AND "active" = true
    ORDER BY "isDefault" DESC, "name" ASC
  `;
}

export async function getDefaultPipeline(): Promise<SalesPipelineRow | null> {
  const rows = await basePrisma.$queryRaw<SalesPipelineRow[]>`
    SELECT "id", "name", "description", "type", "active", "isDefault", "createdAt", "updatedAt"
    FROM "SalesPipeline"
    WHERE "deletedAt" IS NULL AND "active" = true
    ORDER BY "isDefault" DESC, "createdAt" ASC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function listPipelineStages(pipelineId: string): Promise<PipelineStageRow[]> {
  return basePrisma.$queryRaw<PipelineStageRow[]>`
    SELECT "id", "name", "order", "color", "pipelineId", "defaultProbability",
      "staleAfterDays", "isClosed", "closedStatus", "entryAction"
    FROM "PipelineStage"
    WHERE "pipelineId" = ${pipelineId}
    ORDER BY "order" ASC
  `;
}

export async function getPipelineStage(stageId: string): Promise<PipelineStageRow | null> {
  const rows = await basePrisma.$queryRaw<PipelineStageRow[]>`
    SELECT "id", "name", "order", "color", "pipelineId", "defaultProbability",
      "staleAfterDays", "isClosed", "closedStatus", "entryAction"
    FROM "PipelineStage" WHERE "id" = ${stageId} LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function getLeadPipeline(leadId: string): Promise<{ pipelineId: string; stageId: string; teamId: string | null } | null> {
  const rows = await basePrisma.$queryRaw<Array<{ pipelineId: string; stageId: string; teamId: string | null }>>`
    SELECT "pipelineId", "stageId", "teamId" FROM "Lead" WHERE "id" = ${leadId} AND "deletedAt" IS NULL LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function createPipeline(input: {
  name: string;
  description?: string | null;
  type?: string;
  isDefault?: boolean;
}) {
  const id = crypto.randomUUID();
  await basePrisma.$transaction(async (tx) => {
    if (input.isDefault) {
      await tx.$executeRaw`UPDATE "SalesPipeline" SET "isDefault" = false, "updatedAt" = CURRENT_TIMESTAMP WHERE "deletedAt" IS NULL`;
    }
    await tx.$executeRaw`
      INSERT INTO "SalesPipeline" ("id", "name", "description", "type", "isDefault")
      VALUES (${id}, ${input.name}, ${input.description ?? null}, ${input.type ?? "sales"}, ${input.isDefault ?? false})
    `;
  });
  return id;
}

export async function updatePipeline(id: string, input: {
  name: string;
  description?: string | null;
  type?: string;
  active: boolean;
  isDefault: boolean;
}) {
  const current = await basePrisma.$queryRaw<Array<{ isDefault: boolean }>>`
    SELECT "isDefault" FROM "SalesPipeline" WHERE "id" = ${id} AND "deletedAt" IS NULL LIMIT 1
  `;
  if (!current[0]) throw new Error("Pipeline not found");
  if (input.isDefault && !input.active) throw new Error("The default pipeline must remain active");
  if (current[0].isDefault && !input.isDefault) {
    const other = await basePrisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count FROM "SalesPipeline"
      WHERE "id" <> ${id} AND "isDefault" = true AND "active" = true AND "deletedAt" IS NULL
    `;
    if (Number(other[0]?.count ?? 0) === 0) {
      throw new Error("Set another active pipeline as default before removing this default");
    }
  }

  await basePrisma.$transaction(async (tx) => {
    if (input.isDefault) {
      await tx.$executeRaw`UPDATE "SalesPipeline" SET "isDefault" = false, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" <> ${id} AND "deletedAt" IS NULL`;
    }
    await tx.$executeRaw`
      UPDATE "SalesPipeline"
      SET "name" = ${input.name}, "description" = ${input.description ?? null}, "type" = ${input.type ?? "sales"},
        "active" = ${input.active}, "isDefault" = ${input.isDefault}, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${id} AND "deletedAt" IS NULL
    `;
  });
}

function normalizeClosedStage(input: { isClosed?: boolean; closedStatus?: string | null }) {
  if (!input.isClosed) return { isClosed: false, closedStatus: null };
  if (!input.closedStatus || !["won", "lost"].includes(input.closedStatus)) {
    throw new Error("A closed stage must be marked won or lost");
  }
  return { isClosed: true, closedStatus: input.closedStatus };
}

async function assertEntryActionAvailable(
  pipelineId: string,
  entryAction: string | null | undefined,
  excludeStageId?: string,
) {
  if (!entryAction) return;
  const existing = await basePrisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "PipelineStage"
    WHERE "pipelineId" = ${pipelineId}
      AND "entryAction" = ${entryAction}
      AND (${excludeStageId ?? null}::text IS NULL OR "id" <> ${excludeStageId ?? null})
    LIMIT 1
  `;
  if (existing[0]) {
    throw new Error("This pipeline already has a stage with that required action");
  }
}

export async function addPipelineStage(input: {
  pipelineId: string;
  name: string;
  color: string;
  defaultProbability: number;
  staleAfterDays?: number | null;
  isClosed?: boolean;
  closedStatus?: string | null;
  entryAction?: string | null;
}) {
  const pipeline = await basePrisma.$queryRaw<Array<{ active: boolean }>>`
    SELECT "active" FROM "SalesPipeline" WHERE "id" = ${input.pipelineId} AND "deletedAt" IS NULL LIMIT 1
  `;
  if (!pipeline[0]) throw new Error("Pipeline not found");
  const rows = await basePrisma.$queryRaw<Array<{ nextOrder: number }>>`
    SELECT COALESCE(MAX("order"), -1) + 1 AS "nextOrder" FROM "PipelineStage" WHERE "pipelineId" = ${input.pipelineId}
  `;
  const closed = normalizeClosedStage(input);
  if (closed.isClosed && input.entryAction) {
    throw new Error("Closed stages cannot require an entry action");
  }
  await assertEntryActionAvailable(input.pipelineId, input.entryAction);
  const id = crypto.randomUUID();
  await basePrisma.$executeRaw`
    INSERT INTO "PipelineStage" (
      "id", "name", "order", "color", "pipelineId", "defaultProbability", "staleAfterDays", "isClosed", "closedStatus", "entryAction"
    ) VALUES (
      ${id}, ${input.name}, ${rows[0]?.nextOrder ?? 0}, ${input.color}, ${input.pipelineId},
      ${Math.max(0, Math.min(100, input.defaultProbability))}, ${input.staleAfterDays ?? null},
      ${closed.isClosed}, ${closed.closedStatus}, ${input.entryAction ?? null}
    )
  `;
  return id;
}

export async function updatePipelineStage(id: string, input: {
  name: string;
  color: string;
  defaultProbability: number;
  staleAfterDays?: number | null;
  isClosed: boolean;
  closedStatus?: string | null;
  entryAction?: string | null;
}) {
  const closed = normalizeClosedStage(input);
  if (closed.isClosed && input.entryAction) {
    throw new Error("Closed stages cannot require an entry action");
  }
  const current = await basePrisma.$queryRaw<Array<{ pipelineId: string }>>`
    SELECT "pipelineId" FROM "PipelineStage" WHERE "id" = ${id} LIMIT 1
  `;
  if (!current[0]) throw new Error("Pipeline stage not found");
  await assertEntryActionAvailable(current[0].pipelineId, input.entryAction, id);
  await basePrisma.$executeRaw`
    UPDATE "PipelineStage"
    SET "name" = ${input.name}, "color" = ${input.color},
      "defaultProbability" = ${Math.max(0, Math.min(100, input.defaultProbability))},
      "staleAfterDays" = ${input.staleAfterDays ?? null}, "isClosed" = ${closed.isClosed},
      "closedStatus" = ${closed.closedStatus}, "entryAction" = ${input.entryAction ?? null}
    WHERE "id" = ${id}
  `;
}

export async function reorderPipelineStages(pipelineId: string, stageIds: string[]) {
  const actual = await basePrisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "PipelineStage" WHERE "pipelineId" = ${pipelineId} ORDER BY "order"
  `;
  const actualIds = new Set(actual.map((row) => row.id));
  if (actualIds.size !== stageIds.length || stageIds.some((id) => !actualIds.has(id))) {
    throw new Error("Stage order does not match the pipeline");
  }
  await basePrisma.$transaction(
    stageIds.map((stageId, index) =>
      basePrisma.$executeRaw`UPDATE "PipelineStage" SET "order" = ${1000 + index} WHERE "id" = ${stageId} AND "pipelineId" = ${pipelineId}`
    )
  );
  await basePrisma.$transaction(
    stageIds.map((stageId, index) =>
      basePrisma.$executeRaw`UPDATE "PipelineStage" SET "order" = ${index} WHERE "id" = ${stageId} AND "pipelineId" = ${pipelineId}`
    )
  );
}

export async function archivePipeline(id: string) {
  const rows = await basePrisma.$queryRaw<Array<{ isDefault: boolean; leadCount: bigint }>>`
    SELECT p."isDefault", COUNT(l."id") AS "leadCount"
    FROM "SalesPipeline" p LEFT JOIN "Lead" l ON l."pipelineId" = p."id" AND l."deletedAt" IS NULL
    WHERE p."id" = ${id} GROUP BY p."isDefault"
  `;
  if (!rows[0]) throw new Error("Pipeline not found");
  if (rows[0].isDefault) throw new Error("The default pipeline cannot be archived");
  if (Number(rows[0].leadCount) > 0) throw new Error("Move or close all leads before archiving this pipeline");
  await basePrisma.$executeRaw`
    UPDATE "SalesPipeline" SET "active" = false, "deletedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${id}
  `;
}

export async function listForecastLeads(input: {
  pipelineId?: string | null;
  teamId?: string | null;
  userId?: string | null;
  closeFrom?: Date | null;
  closeTo?: Date | null;
}): Promise<ForecastLeadRow[]> {
  const pipelineId = input.pipelineId ?? null;
  const teamId = input.teamId ?? null;
  const userId = input.userId ?? null;
  const closeFrom = input.closeFrom ?? null;
  const closeTo = input.closeTo ?? null;
  return basePrisma.$queryRaw<ForecastLeadRow[]>`
    SELECT l."id", l."title", l."name", l."status", l."valueCents", l."estimatedCostCents",
      l."probability", l."forecastCategory", l."expectedCloseDate", l."pipelineId", p."name" AS "pipelineName",
      l."stageId", s."name" AS "stageName", l."assignedToId", u."name" AS "assignedToName",
      l."teamId", t."name" AS "teamName", l."updatedAt"
    FROM "Lead" l
    JOIN "SalesPipeline" p ON p."id" = l."pipelineId"
    JOIN "PipelineStage" s ON s."id" = l."stageId"
    LEFT JOIN "User" u ON u."id" = l."assignedToId"
    LEFT JOIN "Team" t ON t."id" = l."teamId"
    WHERE l."deletedAt" IS NULL AND l."status" = 'open'
      AND (${pipelineId}::text IS NULL OR l."pipelineId" = ${pipelineId})
      AND (${teamId}::text IS NULL OR l."teamId" = ${teamId})
      AND (${userId}::text IS NULL OR l."assignedToId" = ${userId})
      AND (${closeFrom}::timestamp IS NULL OR l."expectedCloseDate" >= ${closeFrom})
      AND (${closeTo}::timestamp IS NULL OR l."expectedCloseDate" < ${closeTo})
    ORDER BY l."expectedCloseDate" ASC NULLS LAST, l."valueCents" DESC
  `;
}

export function summarizeForecast(leads: ForecastLeadRow[]) {
  const sum = (items: ForecastLeadRow[]) => items.reduce((total, lead) => total + lead.valueCents, 0);
  const knownCost = leads.filter((lead) => lead.estimatedCostCents != null);
  return {
    count: leads.length,
    openValueCents: sum(leads),
    weightedValueCents: leads.reduce((total, lead) => total + Math.round(lead.valueCents * lead.probability / 100), 0),
    commitValueCents: sum(leads.filter((lead) => lead.forecastCategory === "commit")),
    bestCaseValueCents: sum(leads.filter((lead) => lead.forecastCategory === "best_case")),
    pipelineValueCents: sum(leads.filter((lead) => lead.forecastCategory === "pipeline")),
    estimatedMarginCents: knownCost.reduce((total, lead) => total + (lead.valueCents - (lead.estimatedCostCents ?? 0)), 0),
    marginDealCount: knownCost.length,
  };
}

export async function updateLeadForecast(leadId: string, input: {
  probability: number;
  forecastCategory: string;
  expectedCloseDate?: Date | null;
  estimatedCostCents?: number | null;
  teamId?: string | null;
}) {
  const allowed = new Set(["pipeline", "best_case", "commit", "closed", "omitted"]);
  if (!allowed.has(input.forecastCategory)) throw new Error("Invalid forecast category");
  if (input.teamId) {
    const team = await basePrisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Team" WHERE "id" = ${input.teamId} AND "active" = true AND "deletedAt" IS NULL LIMIT 1
    `;
    if (!team[0]) throw new Error("Selected team is not active");
  }
  await basePrisma.$executeRaw`
    UPDATE "Lead"
    SET "probability" = ${Math.max(0, Math.min(100, input.probability))},
      "forecastCategory" = ${input.forecastCategory}, "expectedCloseDate" = ${input.expectedCloseDate ?? null},
      "estimatedCostCents" = ${input.estimatedCostCents ?? null}, "teamId" = ${input.teamId ?? null},
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${leadId} AND "deletedAt" IS NULL
  `;
}

export async function captureForecastSnapshot(input: {
  period: string;
  pipelineId?: string | null;
  teamId?: string | null;
  userId?: string | null;
}) {
  if (!/^\d{4}-\d{2}$/.test(input.period)) throw new Error("Forecast period must be YYYY-MM");
  const leads = await listForecastLeads(input);
  const summary = summarizeForecast(leads);
  await basePrisma.$executeRaw`
    INSERT INTO "ForecastSnapshot" (
      "id", "period", "pipelineId", "teamId", "userId", "openValueCents", "weightedValueCents",
      "commitValueCents", "bestCaseValueCents", "opportunityCount"
    ) VALUES (
      ${crypto.randomUUID()}, ${input.period}, ${input.pipelineId ?? null}, ${input.teamId ?? null}, ${input.userId ?? null},
      ${BigInt(summary.openValueCents)}, ${BigInt(summary.weightedValueCents)}, ${BigInt(summary.commitValueCents)},
      ${BigInt(summary.bestCaseValueCents)}, ${summary.count}
    )
  `;
  return summary;
}
