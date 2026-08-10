import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { basePrisma } from "./db";
import { actingTenantId } from "./actingTenant";
import { pipelineScopeFor, pipelineScopeSql, stageTenantId } from "./pipelineTenantRule";
import { currentScopeClass, writeTenantId } from "./tenantWrite";

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

/**
 * SalesPipeline's own tenant predicate, resolved from the ACTING WORKSPACE.
 *
 * `tenantFilter` below returns Prisma.empty while enforcement is dormant — which
 * is today — because it defers to the guard's scope. That is fine for a filter
 * layered on top of an already-scoped client, and useless here: every SalesPipeline
 * path uses `basePrisma`, the documented RLS BYPASS. So these queries had no tenant
 * boundary from any direction.
 *
 * The consequences were not only a read leak:
 *
 *   - `listSalesPipelines`/`listActiveSalesPipelines`/`getDefaultPipeline` returned
 *     other tenants' pipelines, while the STAGE query beside them was scoped —
 *     which is the asymmetry that gives the game away;
 *   - `createPipeline` and `updatePipeline` run `UPDATE "SalesPipeline" SET
 *     "isDefault" = false WHERE "deletedAt" IS NULL` with no tenant predicate, so
 *     making a pipeline default in one workspace CLEARED THE DEFAULT IN EVERY
 *     OTHER ONE — a cross-tenant write, silent, on a foundational lead-creation
 *     dependency;
 *   - `createPipeline` stamped no tenantId at all, so a pipeline created from a
 *     tenant's own UI was born tenantless.
 *
 * The decision itself — STRICT equality, with no "NULL means the founding tenant"
 * fallback — lives in {@link pipelineScopeFor}, which a test executes with two
 * concrete tenant ids. This function is only the seam that turns it into SQL.
 */
async function pipelineTenantFilter(alias: '"tenantId"' | 'p."tenantId"' = '"tenantId"') {
  return pipelineScopeSql(pipelineScopeFor({ actingTenantId: await actingTenantId() }), alias);
}

/** A pipeline as its OWNER row: the id, the owning tenant, and whether it is live. */
export type OwnedPipeline = { id: string; tenantId: string | null; active: boolean };

/**
 * Load a pipeline THROUGH the tenant boundary, or refuse.
 *
 * The single gate every pipeline-scoped mutation goes through, because the id
 * always arrives from the client — a route param, a bound server-action argument,
 * a form post — and is therefore forgeable. Returning the row's `tenantId` is the
 * point: children stamped from it (see {@link stageTenantId}) inherit the parent's
 * owner rather than the editor's, and the value is already inside the caller's
 * boundary because this is the query that established the boundary.
 */
async function requireOwnedPipeline(id: string): Promise<OwnedPipeline> {
  const scope = await pipelineTenantFilter();
  const rows = await basePrisma.$queryRaw<OwnedPipeline[]>`
    SELECT "id", "tenantId", "active" FROM "SalesPipeline"
    WHERE "id" = ${id} AND "deletedAt" IS NULL ${scope}
    LIMIT 1
  `;
  const pipeline = rows[0];
  if (!pipeline) throw new Error("Pipeline not found");
  return pipeline;
}

/**
 * The full pipeline row for an audit `before` snapshot, scoped to the caller.
 *
 * The unscoped `SELECT * FROM "SalesPipeline" WHERE "id" = $1` this replaces was
 * not harmless just because the mutation beside it refused: it copied another
 * workspace's entire row — name, description, type, ownership — into the caller's
 * own audit trail, where it stays and is readable.
 */
export async function getOwnedPipelineRow(id: string): Promise<Record<string, unknown> | null> {
  const scope = await pipelineTenantFilter();
  const rows = await basePrisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT * FROM "SalesPipeline" WHERE "id" = ${id} AND "deletedAt" IS NULL ${scope} LIMIT 1
  `;
  return rows[0] ?? null;
}

function tenantFilter(column: '"tenantId"' | 'l."tenantId"' | 's."tenantId"') {
  const scope = currentScopeClass();
  if (scope.mode === "closed") return Prisma.sql`AND FALSE`;
  if (scope.mode === "tenant") {
    return Prisma.sql`AND ${Prisma.raw(column)} = ${scope.tenantId}`;
  }
  return Prisma.empty;
}

export async function listSalesPipelines(activeOnly = false): Promise<SalesPipelineRow[]> {
  if (activeOnly) return listActiveSalesPipelines();
  const scope = await pipelineTenantFilter();
  return basePrisma.$queryRaw<SalesPipelineRow[]>`
    SELECT "id", "name", "description", "type", "active", "isDefault", "createdAt", "updatedAt"
    FROM "SalesPipeline"
    WHERE "deletedAt" IS NULL ${scope}
    ORDER BY "isDefault" DESC, "name" ASC
  `;
}

export async function listActiveSalesPipelines(): Promise<SalesPipelineRow[]> {
  const scope = await pipelineTenantFilter();
  return basePrisma.$queryRaw<SalesPipelineRow[]>`
    SELECT "id", "name", "description", "type", "active", "isDefault", "createdAt", "updatedAt"
    FROM "SalesPipeline"
    WHERE "deletedAt" IS NULL AND "active" = true ${scope}
    ORDER BY "isDefault" DESC, "name" ASC
  `;
}

export async function getDefaultPipeline(): Promise<SalesPipelineRow | null> {
  const scope = await pipelineTenantFilter();
  const rows = await basePrisma.$queryRaw<SalesPipelineRow[]>`
    SELECT "id", "name", "description", "type", "active", "isDefault", "createdAt", "updatedAt"
    FROM "SalesPipeline"
    WHERE "deletedAt" IS NULL AND "active" = true ${scope}
    ORDER BY "isDefault" DESC, "createdAt" ASC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function listPipelineStages(pipelineId: string): Promise<PipelineStageRow[]> {
  const scope = tenantFilter('"tenantId"');
  return basePrisma.$queryRaw<PipelineStageRow[]>`
    SELECT "id", "name", "order", "color", "pipelineId", "defaultProbability",
      "staleAfterDays", "isClosed", "closedStatus", "entryAction"
    FROM "PipelineStage"
    WHERE "pipelineId" = ${pipelineId} ${scope}
    ORDER BY "order" ASC
  `;
}

export async function getPipelineStage(stageId: string): Promise<PipelineStageRow | null> {
  const scope = tenantFilter('"tenantId"');
  const rows = await basePrisma.$queryRaw<PipelineStageRow[]>`
    SELECT "id", "name", "order", "color", "pipelineId", "defaultProbability",
      "staleAfterDays", "isClosed", "closedStatus", "entryAction"
    FROM "PipelineStage"
    WHERE "id" = ${stageId} ${scope}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function getLeadPipeline(leadId: string): Promise<{ pipelineId: string; stageId: string; teamId: string | null } | null> {
  const scope = tenantFilter('"tenantId"');
  const rows = await basePrisma.$queryRaw<Array<{ pipelineId: string; stageId: string; teamId: string | null }>>`
    SELECT "pipelineId", "stageId", "teamId"
    FROM "Lead"
    WHERE "id" = ${leadId} AND "deletedAt" IS NULL ${scope}
    LIMIT 1
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
  // The owner, resolved once: the insert stamps it and the default-clear is
  // confined to it. Unconfined, making a pipeline default here cleared the
  // default in every other tenant's workspace.
  const tenantId = await actingTenantId();
  const scope = await pipelineTenantFilter();
  await basePrisma.$transaction(async (tx) => {
    if (input.isDefault) {
      await tx.$executeRaw`UPDATE "SalesPipeline" SET "isDefault" = false, "updatedAt" = CURRENT_TIMESTAMP WHERE "deletedAt" IS NULL ${scope}`;
    }
    await tx.$executeRaw`
      INSERT INTO "SalesPipeline" ("id", "name", "description", "type", "isDefault", "tenantId")
      VALUES (${id}, ${input.name}, ${input.description ?? null}, ${input.type ?? "sales"}, ${input.isDefault ?? false}, ${tenantId})
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
  const scope = await pipelineTenantFilter();
  const current = await basePrisma.$queryRaw<Array<{ isDefault: boolean }>>`
    SELECT "isDefault" FROM "SalesPipeline" WHERE "id" = ${id} AND "deletedAt" IS NULL ${scope} LIMIT 1
  `;
  if (!current[0]) throw new Error("Pipeline not found");
  if (input.isDefault && !input.active) throw new Error("The default pipeline must remain active");
  if (current[0].isDefault && !input.isDefault) {
    const other = await basePrisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count FROM "SalesPipeline"
      WHERE "id" <> ${id} AND "isDefault" = true AND "active" = true AND "deletedAt" IS NULL ${scope}
    `;
    if (Number(other[0]?.count ?? 0) === 0) {
      throw new Error("Set another active pipeline as default before removing this default");
    }
  }

  await basePrisma.$transaction(async (tx) => {
    if (input.isDefault) {
      await tx.$executeRaw`UPDATE "SalesPipeline" SET "isDefault" = false, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" <> ${id} AND "deletedAt" IS NULL ${scope}`;
    }
    await tx.$executeRaw`
      UPDATE "SalesPipeline"
      SET "name" = ${input.name}, "description" = ${input.description ?? null}, "type" = ${input.type ?? "sales"},
        "active" = ${input.active}, "isDefault" = ${input.isDefault}, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${id} AND "deletedAt" IS NULL ${scope}
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
  const scope = tenantFilter('"tenantId"');
  const existing = await basePrisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "PipelineStage"
    WHERE "pipelineId" = ${pipelineId}
      AND "entryAction" = ${entryAction}
      AND (${excludeStageId ?? null}::text IS NULL OR "id" <> ${excludeStageId ?? null})
      ${scope}
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
  const scope = tenantFilter('"tenantId"');
  // The pipeline this stage is being attached to must be one this workspace owns.
  // Unscoped, a known pipeline id was enough to add a stage to another tenant's
  // process — the acceptance gate the review names explicitly.
  const pipeline = await requireOwnedPipeline(input.pipelineId);
  // The stage's owner is the PIPELINE's owner. It used to be `writeTenantId()`,
  // which is null while enforcement is dormant, so every stage created since the
  // 20260722130000 backfill was born unowned and would go invisible to its own
  // workspace at the flip — the parent was moved onto `actingTenantId()` and the
  // child was left behind.
  const tenantId = stageTenantId({ pipelineTenantId: pipeline.tenantId, actingTenantId: await actingTenantId() });
  const rows = await basePrisma.$queryRaw<Array<{ nextOrder: number }>>`
    SELECT COALESCE(MAX("order"), -1) + 1 AS "nextOrder"
    FROM "PipelineStage"
    WHERE "pipelineId" = ${input.pipelineId} ${scope}
  `;
  const closed = normalizeClosedStage(input);
  if (closed.isClosed && input.entryAction) {
    throw new Error("Closed stages cannot require an entry action");
  }
  await assertEntryActionAvailable(input.pipelineId, input.entryAction);
  const id = crypto.randomUUID();
  await basePrisma.$executeRaw`
    INSERT INTO "PipelineStage" (
      "id", "name", "order", "color", "pipelineId", "defaultProbability", "staleAfterDays", "isClosed", "closedStatus", "entryAction", "tenantId"
    ) VALUES (
      ${id}, ${input.name}, ${rows[0]?.nextOrder ?? 0}, ${input.color}, ${input.pipelineId},
      ${Math.max(0, Math.min(100, input.defaultProbability))}, ${input.staleAfterDays ?? null},
      ${closed.isClosed}, ${closed.closedStatus}, ${input.entryAction ?? null}, ${tenantId}
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
  writeTenantId();
  const scope = tenantFilter('"tenantId"');
  const closed = normalizeClosedStage(input);
  if (closed.isClosed && input.entryAction) {
    throw new Error("Closed stages cannot require an entry action");
  }
  const current = await basePrisma.$queryRaw<Array<{ pipelineId: string }>>`
    SELECT "pipelineId" FROM "PipelineStage" WHERE "id" = ${id} ${scope} LIMIT 1
  `;
  if (!current[0]) throw new Error("Pipeline stage not found");
  // `tenantFilter` is Prisma.empty while enforcement is dormant, so the lookup
  // above reaches every workspace's stages. The pipeline the stage hangs off is
  // what carries a real boundary — resolve it, and refuse if it is not ours.
  const pipeline = await requireOwnedPipeline(current[0].pipelineId);
  await assertEntryActionAvailable(current[0].pipelineId, input.entryAction, id);
  await basePrisma.$executeRaw`
    UPDATE "PipelineStage"
    SET "name" = ${input.name}, "color" = ${input.color},
      "defaultProbability" = ${Math.max(0, Math.min(100, input.defaultProbability))},
      "staleAfterDays" = ${input.staleAfterDays ?? null}, "isClosed" = ${closed.isClosed},
      "closedStatus" = ${closed.closedStatus}, "entryAction" = ${input.entryAction ?? null},
      "tenantId" = ${stageTenantId({ pipelineTenantId: pipeline.tenantId, actingTenantId: await actingTenantId() })}
    WHERE "id" = ${id} AND "pipelineId" = ${pipeline.id} ${scope}
  `;
}

export async function reorderPipelineStages(pipelineId: string, stageIds: string[]) {
  writeTenantId();
  const scope = tenantFilter('"tenantId"');
  // Same gate as add/update: reordering is a write to a pipeline's shape, and the
  // pipelineId arrives from the client.
  await requireOwnedPipeline(pipelineId);
  const actual = await basePrisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "PipelineStage"
    WHERE "pipelineId" = ${pipelineId} ${scope}
    ORDER BY "order"
  `;
  const actualIds = new Set(actual.map((row) => row.id));
  if (actualIds.size !== stageIds.length || stageIds.some((id) => !actualIds.has(id))) {
    throw new Error("Stage order does not match the pipeline");
  }
  await basePrisma.$transaction(
    stageIds.map((stageId, index) =>
      basePrisma.$executeRaw`UPDATE "PipelineStage" SET "order" = ${1000 + index} WHERE "id" = ${stageId} AND "pipelineId" = ${pipelineId} ${scope}`
    )
  );
  await basePrisma.$transaction(
    stageIds.map((stageId, index) =>
      basePrisma.$executeRaw`UPDATE "PipelineStage" SET "order" = ${index} WHERE "id" = ${stageId} AND "pipelineId" = ${pipelineId} ${scope}`
    )
  );
}

export async function archivePipeline(id: string) {
  const scope = await pipelineTenantFilter('p."tenantId"');
  const rows = await basePrisma.$queryRaw<Array<{ isDefault: boolean; leadCount: bigint }>>`
    SELECT p."isDefault", COUNT(l."id") AS "leadCount"
    FROM "SalesPipeline" p LEFT JOIN "Lead" l ON l."pipelineId" = p."id" AND l."deletedAt" IS NULL
    WHERE p."id" = ${id} ${scope} GROUP BY p."isDefault"
  `;
  if (!rows[0]) throw new Error("Pipeline not found");
  if (rows[0].isDefault) throw new Error("The default pipeline cannot be archived");
  if (Number(rows[0].leadCount) > 0) throw new Error("Move or close all leads before archiving this pipeline");
  const writeScope = await pipelineTenantFilter();
  await basePrisma.$executeRaw`
    UPDATE "SalesPipeline" SET "active" = false, "deletedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${id} ${writeScope}
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
  const scope = tenantFilter('l."tenantId"');
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
    WHERE l."deletedAt" IS NULL AND l."status" = 'open' ${scope}
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
  writeTenantId();
  const leadScope = tenantFilter('"tenantId"');
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
    WHERE "id" = ${leadId} AND "deletedAt" IS NULL ${leadScope}
  `;
}

export async function captureForecastSnapshot(input: {
  period: string;
  pipelineId?: string | null;
  teamId?: string | null;
  userId?: string | null;
}) {
  if (!/^\d{4}-\d{2}$/.test(input.period)) throw new Error("Forecast period must be YYYY-MM");
  // Same class as the two named reads: `pipelineId` arrives from a form post, and
  // was written straight into the snapshot's FK without ever being checked against
  // the caller's workspace. And the snapshot itself was inserted with NO tenantId
  // at all — a row born unowned, on a table the 20260725160000 backfill has
  // already claimed, so nothing else would ever pick it up.
  if (input.pipelineId) await requireOwnedPipeline(input.pipelineId);
  const tenantId = await actingTenantId();
  const leads = await listForecastLeads(input);
  const summary = summarizeForecast(leads);
  await basePrisma.$executeRaw`
    INSERT INTO "ForecastSnapshot" (
      "id", "period", "pipelineId", "teamId", "userId", "openValueCents", "weightedValueCents",
      "commitValueCents", "bestCaseValueCents", "opportunityCount", "tenantId"
    ) VALUES (
      ${crypto.randomUUID()}, ${input.period}, ${input.pipelineId ?? null}, ${input.teamId ?? null}, ${input.userId ?? null},
      ${BigInt(summary.openValueCents)}, ${BigInt(summary.weightedValueCents)}, ${BigInt(summary.commitValueCents)},
      ${BigInt(summary.bestCaseValueCents)}, ${summary.count}, ${tenantId}
    )
  `;
  return summary;
}
