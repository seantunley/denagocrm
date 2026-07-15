"use server";

import { revalidatePath } from "next/cache";
import {
  getAccessibleLeadScope,
  hasPermission,
  requireLeadAccess,
  requirePermission,
} from "@/lib/permissions";
import {
  addPipelineStage,
  archivePipeline,
  captureForecastSnapshot,
  createPipeline,
  listPipelineStages,
  reorderPipelineStages,
  updateLeadForecast,
  updatePipeline,
  updatePipelineStage,
} from "@/lib/pipelines";
import { logAuditStrict } from "@/lib/audit";
import { basePrisma } from "@/lib/db";
import { parseRands } from "@/lib/format";

const str = (formData: FormData, key: string) => {
  const value = String(formData.get(key) ?? "").trim();
  return value || null;
};
const bool = (formData: FormData, key: string) => formData.get(key) === "on";
const int = (formData: FormData, key: string, fallback = 0) => {
  const value = parseInt(String(formData.get(key) ?? ""), 10);
  return Number.isFinite(value) ? value : fallback;
};

function validDateInput(raw: string | null) {
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error("Expected close date is invalid");
  const date = new Date(`${raw}T12:00:00+02:00`);
  if (Number.isNaN(date.getTime())) throw new Error("Expected close date is invalid");
  return date;
}

function forecastMonth(period: string) {
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error("Forecast period must be YYYY-MM");
  const [year, month] = period.split("-").map(Number);
  return {
    closeFrom: new Date(Date.UTC(year, month - 1, 1)),
    closeTo: new Date(Date.UTC(year, month, 1)),
  };
}

export async function createSalesPipeline(formData: FormData) {
  const user = await requirePermission("pipelines.manage");
  const name = str(formData, "name");
  if (!name) throw new Error("Pipeline name is required");
  const pipelineId = await createPipeline({
    name,
    description: str(formData, "description"),
    type: str(formData, "type") ?? "sales",
    isDefault: bool(formData, "isDefault"),
  });
  await logAuditStrict({
    action: "pipeline.created",
    summary: `Created sales pipeline “${name}”`,
    entityType: "SalesPipeline",
    entityId: pipelineId,
    user,
    after: { name, type: str(formData, "type") ?? "sales", isDefault: bool(formData, "isDefault") },
  });
  revalidatePath("/settings/pipelines");
  revalidatePath("/leads");
}

export async function editSalesPipeline(id: string, formData: FormData) {
  const user = await requirePermission("pipelines.manage");
  const before = await basePrisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT * FROM "SalesPipeline" WHERE "id" = ${id} LIMIT 1
  `;
  if (!before[0]) throw new Error("Pipeline not found");
  const name = str(formData, "name");
  if (!name) throw new Error("Pipeline name is required");
  const after = {
    name,
    description: str(formData, "description"),
    type: str(formData, "type") ?? "sales",
    active: bool(formData, "active"),
    isDefault: bool(formData, "isDefault"),
  };
  await updatePipeline(id, after);
  await logAuditStrict({
    action: "pipeline.updated",
    summary: `Updated sales pipeline “${name}”`,
    entityType: "SalesPipeline",
    entityId: id,
    user,
    before: before[0],
    after,
  });
  revalidatePath("/settings/pipelines");
  revalidatePath("/leads");
  revalidatePath("/forecast");
}

export async function createSalesPipelineStage(pipelineId: string, formData: FormData) {
  const user = await requirePermission("pipelines.manage");
  const name = str(formData, "name");
  if (!name) throw new Error("Stage name is required");
  const after = {
    pipelineId,
    name,
    color: str(formData, "color") ?? "#64748b",
    defaultProbability: int(formData, "defaultProbability", 10),
    staleAfterDays: str(formData, "staleAfterDays") ? int(formData, "staleAfterDays") : null,
    isClosed: bool(formData, "isClosed"),
    closedStatus: str(formData, "closedStatus"),
  };
  const stageId = await addPipelineStage(after);
  await logAuditStrict({
    action: "pipeline.stage_created",
    summary: `Created stage “${name}”`,
    entityType: "PipelineStage",
    entityId: stageId,
    user,
    after,
  });
  revalidatePath("/settings/pipelines");
  revalidatePath("/leads");
  revalidatePath("/forecast");
}

export async function editSalesPipelineStage(id: string, formData: FormData) {
  const user = await requirePermission("pipelines.manage");
  const before = await basePrisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT * FROM "PipelineStage" WHERE "id" = ${id} LIMIT 1
  `;
  if (!before[0]) throw new Error("Pipeline stage not found");
  const name = str(formData, "name");
  if (!name) throw new Error("Stage name is required");
  const after = {
    name,
    color: str(formData, "color") ?? "#64748b",
    defaultProbability: int(formData, "defaultProbability", 10),
    staleAfterDays: str(formData, "staleAfterDays") ? int(formData, "staleAfterDays") : null,
    isClosed: bool(formData, "isClosed"),
    closedStatus: str(formData, "closedStatus"),
  };
  await updatePipelineStage(id, after);
  await logAuditStrict({
    action: "pipeline.stage_updated",
    summary: `Updated stage “${name}”`,
    entityType: "PipelineStage",
    entityId: id,
    user,
    before: before[0],
    after,
  });
  revalidatePath("/settings/pipelines");
  revalidatePath("/leads");
  revalidatePath("/forecast");
}

/** Swap a stage with its neighbour to reorder the pipeline. */
export async function moveStage(pipelineId: string, stageId: string, direction: "up" | "down") {
  const user = await requirePermission("pipelines.manage");
  const stages = await listPipelineStages(pipelineId); // ordered by "order" asc
  const idx = stages.findIndex((s) => s.id === stageId);
  if (idx < 0) return;
  const swapWith = direction === "up" ? idx - 1 : idx + 1;
  if (swapWith < 0 || swapWith >= stages.length) return; // already at the edge

  const ids = stages.map((s) => s.id);
  [ids[idx], ids[swapWith]] = [ids[swapWith], ids[idx]];
  await reorderPipelineStages(pipelineId, ids);

  await logAuditStrict({
    action: "pipeline.stage_reordered",
    summary: `Moved stage “${stages[idx].name}” ${direction}`,
    entityType: "PipelineStage",
    entityId: stageId,
    user,
  });
  revalidatePath("/settings/pipelines");
  revalidatePath("/leads");
  revalidatePath("/forecast");
}

export async function archiveSalesPipeline(id: string, formData: FormData) {
  void formData;
  const user = await requirePermission("pipelines.manage");
  const before = await basePrisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT * FROM "SalesPipeline" WHERE "id" = ${id} LIMIT 1
  `;
  if (!before[0]) throw new Error("Pipeline not found");
  await archivePipeline(id);
  await logAuditStrict({
    action: "pipeline.archived",
    summary: `Archived sales pipeline “${String(before[0].name ?? id)}”`,
    entityType: "SalesPipeline",
    entityId: id,
    user,
    before: before[0],
    after: { archived: true },
  });
  revalidatePath("/settings/pipelines");
  revalidatePath("/leads");
  revalidatePath("/forecast");
}

export async function saveLeadForecast(leadId: string, formData: FormData) {
  const user = await requireLeadAccess(leadId, "forecast.manage");
  const before = await basePrisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT "probability", "forecastCategory", "expectedCloseDate", "estimatedCostCents", "teamId"
    FROM "Lead" WHERE "id" = ${leadId} AND "deletedAt" IS NULL LIMIT 1
  `;
  if (!before[0]) throw new Error("Lead not found");

  const teamId = str(formData, "teamId");
  if ((before[0].teamId ?? null) !== teamId && !(await hasPermission(user, "leads.assign"))) {
    throw new Error("You do not have permission to change the lead team");
  }
  const forecastCategory = str(formData, "forecastCategory") ?? "pipeline";
  if (!["pipeline", "best_case", "commit", "omitted"].includes(forecastCategory)) {
    throw new Error("Invalid forecast category for an open lead");
  }
  const estimatedCost = str(formData, "estimatedCost");
  const after = {
    probability: int(formData, "probability", 10),
    forecastCategory,
    expectedCloseDate: validDateInput(str(formData, "expectedCloseDate")),
    estimatedCostCents: estimatedCost ? Math.max(0, parseRands(estimatedCost)) : null,
    teamId,
  };
  await updateLeadForecast(leadId, after);
  await logAuditStrict({
    action: "lead.forecast_updated",
    summary: `Updated forecast for lead ${leadId}`,
    entityType: "Lead",
    entityId: leadId,
    leadId,
    user,
    before: before[0],
    after,
  });
  revalidatePath("/forecast");
  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
}

export async function snapshotForecast(formData: FormData) {
  const user = await requirePermission("forecast.manage");
  const scope = await getAccessibleLeadScope(user);
  const period = str(formData, "period") ?? new Date().toISOString().slice(0, 7);
  const requestedTeamId = str(formData, "teamId");
  const requestedUserId = str(formData, "userId");

  const teamId = requestedTeamId;
  let userId = requestedUserId;
  if (!scope.viewAll) {
    if (teamId && !scope.teamIds.includes(teamId)) {
      throw new Error("You cannot snapshot a team outside your access scope");
    }
    if (userId && userId !== user.id) {
      throw new Error("You cannot snapshot another user's forecast");
    }
    if (!teamId) userId = user.id;
  }

  const month = forecastMonth(period);
  const input = {
    period,
    pipelineId: str(formData, "pipelineId"),
    teamId,
    userId,
    closeFrom: month.closeFrom,
    closeTo: month.closeTo,
  };
  const result = await captureForecastSnapshot(input);
  await logAuditStrict({
    action: "forecast.snapshot_created",
    summary: `Captured forecast snapshot for ${period}`,
    entityType: "ForecastSnapshot",
    user,
    after: { period, pipelineId: input.pipelineId, teamId, userId, ...result },
  });
  revalidatePath("/forecast");
}
