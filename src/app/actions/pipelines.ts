"use server";

import { revalidatePath } from "next/cache";
import { requirePermission, requireLeadAccess } from "@/lib/permissions";
import {
  addPipelineStage,
  archivePipeline,
  captureForecastSnapshot,
  createPipeline,
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
}

export async function createSalesPipelineStage(pipelineId: string, formData: FormData) {
  const user = await requirePermission("pipelines.manage");
  const name = str(formData, "name");
  if (!name) throw new Error("Stage name is required");
  const stageId = await addPipelineStage({
    pipelineId,
    name,
    color: str(formData, "color") ?? "#64748b",
    defaultProbability: int(formData, "defaultProbability", 10),
    staleAfterDays: str(formData, "staleAfterDays") ? int(formData, "staleAfterDays") : null,
    isClosed: bool(formData, "isClosed"),
    closedStatus: str(formData, "closedStatus"),
  });
  await logAuditStrict({
    action: "pipeline.stage_created",
    summary: `Created stage “${name}”`,
    entityType: "PipelineStage",
    entityId: stageId,
    user,
    after: { pipelineId, name },
  });
  revalidatePath("/settings/pipelines");
  revalidatePath("/leads");
}

export async function editSalesPipelineStage(id: string, formData: FormData) {
  const user = await requirePermission("pipelines.manage");
  const before = await basePrisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT * FROM "PipelineStage" WHERE "id" = ${id} LIMIT 1
  `;
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
}

export async function archiveSalesPipeline(id: string, formData: FormData) {
  void formData;
  const user = await requirePermission("pipelines.manage");
  const before = await basePrisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT * FROM "SalesPipeline" WHERE "id" = ${id} LIMIT 1
  `;
  await archivePipeline(id);
  await logAuditStrict({
    action: "pipeline.archived",
    summary: `Archived sales pipeline “${String(before[0]?.name ?? id)}”`,
    entityType: "SalesPipeline",
    entityId: id,
    user,
    before: before[0],
    after: { archived: true },
  });
  revalidatePath("/settings/pipelines");
  revalidatePath("/leads");
}

export async function saveLeadForecast(leadId: string, formData: FormData) {
  const user = await requireLeadAccess(leadId, "forecast.manage");
  const before = await basePrisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT "probability", "forecastCategory", "expectedCloseDate", "estimatedCostCents", "teamId"
    FROM "Lead" WHERE "id" = ${leadId} LIMIT 1
  `;
  const closeDate = str(formData, "expectedCloseDate");
  const after = {
    probability: int(formData, "probability", 10),
    forecastCategory: str(formData, "forecastCategory") ?? "pipeline",
    expectedCloseDate: closeDate ? new Date(`${closeDate}T12:00:00+02:00`) : null,
    estimatedCostCents: parseRands(str(formData, "estimatedCost")),
    teamId: str(formData, "teamId"),
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
  revalidatePath(`/leads/${leadId}`);
}

export async function snapshotForecast(formData: FormData) {
  const user = await requirePermission("forecast.manage");
  const period = str(formData, "period") ?? new Date().toISOString().slice(0, 7);
  const input = {
    period,
    pipelineId: str(formData, "pipelineId"),
    teamId: str(formData, "teamId"),
    userId: str(formData, "userId"),
  };
  const result = await captureForecastSnapshot(input);
  await logAuditStrict({
    action: "forecast.snapshot_created",
    summary: `Captured forecast snapshot for ${period}`,
    entityType: "ForecastSnapshot",
    user,
    after: { ...input, ...result },
  });
  revalidatePath("/forecast");
}
