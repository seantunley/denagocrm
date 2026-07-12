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
      "staleAfterDays", "isClosed", "closedStatus"
    FROM "PipelineStage"
    WHERE "pipelineId" = ${pipelineId}
    ORDER BY "order" ASC
  `;
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
      await tx.$executeRaw`UPDATE "SalesPipeline" SET "isDefault" = false WHERE "deletedAt" IS NULL`;
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
  await basePrisma.$transaction(async (tx) => {
    if (input.isDefault) {
      await tx.$executeRaw`UPDATE "SalesPipeline" SET "isDefault" = false WHERE "id" <> ${id} AND "deletedAt" IS NULL`;
    }
    await tx.$executeRaw`
      UPDATE "SalesPipeline"
      SET "name" = ${input.name}, "description" = ${input.description ?? null}, "type" = ${input.type ?? "sales"},
        "active" = ${input.active}, "isDefault" = ${input.isDefault}, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${id} AND "deletedAt" IS NULL
    `;
  });
}

export async function addPipelineStage(input: {
  pipelineId: string;
  name: string;
  color: string;
  defaultProbability: number;
  staleAfterDays?: number | null;
  isClosed?: boolean;
  closedStatus?: string | null;
}) {
  const rows = await basePrisma.$queryRaw<Array<{ nextOrder: number }>>`
    SELECT COALESCE(MAX("order"), -1) + 1 AS "nextOrder"
    FROM "PipelineStage"
    WHERE "pipelineId" = ${input.pipelineId}
  `;
  const id = crypto.randomUUID();
  await basePrisma.$executeRaw`
    INSERT INTO "PipelineStage" (
      "id", "name", "order", "color", "pipelineId", "defaultProbability", "staleAfterDays", "isClosed", "closedStatus"
    ) VALUES (
      ${id}, ${input.name}, ${rows[0]?.nextOrder ?? 0}, ${input.color}, ${input.pipelineId},
      ${Math.max(0, Math.min(100, input.defaultProbability))}, ${input.staleAfterDays ?? null},
      ${input.isClosed ?? false}, ${input.closedStatus ?? null}
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
}) {
  await basePrisma.$executeRaw`
    UPDATE "PipelineStage"
    SET "name" = ${input.name}, "color" = ${input.color},
      "defaultProbability" = ${Math.max(0, Math.min(100, input.defaultProbability))},
      "staleAfterDays" = ${input.staleAfterDays ?? null}, "isClosed" = ${input.isClosed},
      "closedStatus" = ${input.closedStatus ?? null}
    WHERE "id" = ${id}
  `;
}

export async function reorderPipelineStages(pipelineId: string, stageIds: string[]) {
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
    FROM "SalesPipeline" p
    LEFT JOIN "Lead" l ON l."pipelineId" = p."id" AND l."deletedAt" IS NULL
    WHERE p."id" = ${id}
    GROUP BY p."isDefault"
  `;
  if (!rows[0]) throw new Error("Pipeline not found");
  if (rows[0].isDefault) throw new Error("The default pipeline cannot be archived");
  if (Number(rows[0].leadCount) > 0) throw new Error("Move or close all leads before archiving this pipeline");
  await basePrisma.$executeRaw`
    UPDATE "SalesPipeline"
    SET "active" = false, "deletedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
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
  return {
    count: leads.length,
    openValueCents: sum(leads),
    weightedValueCents: leads.reduce((total, lead) => total + Math.round(lead.valueCents * lead.probability / 100), 0),
    commitValueCents: sum(leads.filter((lead) => lead.forecastCategory === "commit")),
    bestCaseValueCents: sum(leads.filter((lead) => lead.forecastCategory === "best_case")),
    pipelineValueCents: sum(leads.filter((lead) => lead.forecastCategory === "pipeline")),
    estimatedMarginCents: leads.reduce(
      (total, lead) => total + Math.max(0, lead.valueCents - (lead.estimatedCostCents ?? lead.valueCents)),
      0
    ),
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
  await basePrisma.$executeRaw`
    UPDATE "Lead"
    SET "probability" = ${Math.max(0, Math.min(100, input.probability))},
      "forecastCategory" = ${input.forecastCategory}, "expectedCloseDate" = ${input.expectedCloseDate ?? null},
      "estimatedCostCents" = ${input.estimatedCostCents ?? null}, "teamId" = ${input.teamId ?? null},
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${leadId}
  `;
}

export async function captureForecastSnapshot(input: {
  period: string;
  pipelineId?: string | null;
  teamId?: string | null;
  userId?: string | null;
}) {
  const leads = await listForecastLeads(input);
  const summary = summarizeForecast(leads);
  const snapshotId = crypto.randomUUID();
  await basePrisma.$executeRaw`
    INSERT INTO "ForecastSnapshot" (
      "id", "period", "pipelineId", "teamId", "userId", "openValueCents", "weightedValueCents",
      "commitValueCents", "bestCaseValueCents", "opportunityCount"
    ) VALUES (
      ${snapshotId}, ${input.period}, ${input.pipelineId ?? null}, ${input.teamId ?? null}, ${input.userId ?? null},
      ${BigInt(summary.openValueCents)}, ${BigInt(summary.weightedValueCents)}, ${BigInt(summary.commitValueCents)},
      ${BigInt(summary.bestCaseValueCents)}, ${summary.count}
    )
  `;
  return { id: snapshotId, ...summary };
}
