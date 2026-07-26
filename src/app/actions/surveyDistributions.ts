"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma, basePrisma } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { requireModuleEnabled } from "@/lib/modules/enabled";
import { getActiveTenantId } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { createSurveyDistribution } from "@/lib/surveyDistributionQueue";

async function distributionContext() {
  await requireModuleEnabled("marketing");
  const user = await requirePermission("surveys.manage");
  return { user, tenantId: await getActiveTenantId() };
}

async function resolveAudience(segment: string) {
  if (segment === "vehicle_owners") {
    const rows = await prisma.vehicle.findMany({ where: { deletedAt: null }, select: { contactId: true }, distinct: ["contactId"], take: 5000 });
    return rows.map((row) => row.contactId).filter((id): id is string => Boolean(id));
  }
  if (segment === "won_leads") {
    const rows = await prisma.lead.findMany({ where: { deletedAt: null, status: "won", contactId: { not: null } }, select: { contactId: true }, distinct: ["contactId"], take: 5000 });
    return rows.map((row) => row.contactId).filter((id): id is string => Boolean(id));
  }
  if (segment.startsWith("tag:")) {
    const tagId = segment.slice(4);
    const rows = await prisma.contact.findMany({ where: { deletedAt: null, tags: { some: { id: tagId } } }, select: { id: true }, take: 5000 });
    return rows.map((row) => row.id);
  }
  const rows = await prisma.contact.findMany({
    where: { deletedAt: null, OR: [{ email: { not: null } }, { phone: { not: null } }, { whatsapp: { not: null } }] },
    select: { id: true }, take: 5000,
  });
  return rows.map((row) => row.id);
}

function refresh(id?: string) {
  revalidatePath("/marketing/surveys/distributions");
  if (id) revalidatePath(`/marketing/surveys/distributions/${id}`);
}

export async function createDistribution(formData: FormData) {
  const { user, tenantId } = await distributionContext();
  const surveyId = String(formData.get("surveyId") ?? "");
  const segment = String(formData.get("segment") ?? "customers");
  const scheduledRaw = String(formData.get("scheduledFor") ?? "").trim();
  const scheduledFor = scheduledRaw ? new Date(scheduledRaw) : null;
  if (scheduledFor && Number.isNaN(scheduledFor.getTime())) throw new Error("Invalid schedule date");
  const contactIds = await resolveAudience(segment);
  const id = await createSurveyDistribution({
    tenantId,
    userId: user.id,
    surveyId,
    name: String(formData.get("name") ?? "").trim(),
    purpose: String(formData.get("purpose") ?? "survey_transactional") === "survey_marketing" ? "survey_marketing" : "survey_transactional",
    channel: ["email", "sms"].includes(String(formData.get("channel"))) ? String(formData.get("channel")) as "email" | "sms" : "any",
    contactIds,
    audienceSnapshot: { segment, resolvedAt: new Date().toISOString(), count: contactIds.length },
    scheduledFor,
    reminderAfterHours: Number(formData.get("reminderAfterHours") ?? 48),
    maxReminders: Number(formData.get("maxReminders") ?? 1),
  });
  await logAudit({ action: "survey.distribution_created", summary: `Created survey distribution ${id} for ${contactIds.length} contacts`, user });
  redirect(`/marketing/surveys/distributions/${id}`);
}

async function distribution(id: string, tenantId: string | null) {
  const rows = await basePrisma.$queryRaw<Array<{ id: string; status: string }>>`
    SELECT "id", "status" FROM "SurveyDistribution"
    WHERE "id" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId}
    LIMIT 1
  `;
  if (!rows[0]) throw new Error("Distribution not found");
  return rows[0];
}

export async function pauseDistribution(formData: FormData) {
  const { user, tenantId } = await distributionContext();
  const id = String(formData.get("id") ?? "");
  const current = await distribution(id, tenantId);
  if (!new Set(["queued", "sending", "scheduled"]).has(current.status)) throw new Error("This distribution cannot be paused");
  await basePrisma.$executeRaw`UPDATE "SurveyDistribution" SET "status" = 'paused', "pausedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId}`;
  await logAudit({ action: "survey.distribution_paused", summary: `Paused survey distribution ${id}`, user });
  refresh(id);
}

export async function resumeDistribution(formData: FormData) {
  const { user, tenantId } = await distributionContext();
  const id = String(formData.get("id") ?? "");
  const current = await distribution(id, tenantId);
  if (current.status !== "paused") throw new Error("Only a paused distribution can be resumed");
  await basePrisma.$executeRaw`UPDATE "SurveyDistribution" SET "status" = 'queued', "pausedAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId}`;
  await logAudit({ action: "survey.distribution_resumed", summary: `Resumed survey distribution ${id}`, user });
  refresh(id);
}

export async function cancelDistribution(formData: FormData) {
  const { user, tenantId } = await distributionContext();
  const id = String(formData.get("id") ?? "");
  const current = await distribution(id, tenantId);
  if (new Set(["completed", "completed_with_errors", "cancelled"]).has(current.status)) throw new Error("This distribution is already closed");
  await basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`UPDATE "SurveyDistribution" SET "status" = 'cancelled', "cancelledAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId}`;
    await tx.$executeRaw`UPDATE "SurveyResponse" SET "status" = 'cancelled', "providerStatus" = 'distribution_cancelled' WHERE "distributionId" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId} AND "status" IN ('queued', 'failed_temporary')`;
  });
  await logAudit({ action: "survey.distribution_cancelled", summary: `Cancelled survey distribution ${id}`, user });
  refresh(id);
}

export async function retryDistributionFailures(formData: FormData) {
  const { user, tenantId } = await distributionContext();
  const id = String(formData.get("id") ?? "");
  await distribution(id, tenantId);
  const count = await basePrisma.$executeRaw`
    UPDATE "SurveyResponse"
    SET "status" = 'queued', "nextAttemptAt" = CURRENT_TIMESTAMP, "providerStatus" = 'manual_retry'
    WHERE "distributionId" = ${id}
      AND "tenantId" IS NOT DISTINCT FROM ${tenantId}
      AND "status" = 'failed_permanent'
  `;
  if (count > 0) {
    await basePrisma.$executeRaw`UPDATE "SurveyDistribution" SET "status" = 'queued', "failedCount" = GREATEST(0, "failedCount" - ${count}), "completedAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId}`;
  }
  await logAudit({ action: "survey.distribution_retried", summary: `Queued ${count} failed survey invites for manual retry`, user });
  refresh(id);
}
