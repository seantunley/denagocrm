"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { basePrisma } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { requireModuleEnabled } from "@/lib/modules/enabled";
import { getActiveTenantId } from "@/lib/auth";
import { resolveTenantMemberUser } from "@/lib/tenantActor";
import { logAudit } from "@/lib/audit";

function refresh(id?: string) {
  revalidatePath("/marketing/surveys/insights");
  revalidatePath("/marketing/surveys/follow-ups");
  if (id) revalidatePath(`/marketing/surveys/follow-ups/${id}`);
}

async function recoveryContext(permission: "surveys.manage" | "cases.create" = "surveys.manage") {
  await requireModuleEnabled("marketing");
  const user = await requirePermission(permission);
  const tenantId = await getActiveTenantId();
  return { user, tenantId };
}

async function loadFollowUp(id: string, tenantId: string | null) {
  const rows = await basePrisma.$queryRaw<Array<{
    id: string; status: string; contactId: string | null; surveyResponseId: string;
    severity: string; caseId: string | null; score: number | null; comment: string | null;
    surveyTitle: string; distributionId: string | null;
  }>>`
    SELECT f."id", f."status", f."contactId", f."surveyResponseId", f."severity", f."caseId",
      r."score", r."comment", s."title" AS "surveyTitle", f."distributionId"
    FROM "SurveyFollowUp" f
    JOIN "SurveyResponse" r ON r."id" = f."surveyResponseId"
    JOIN "Survey" s ON s."id" = r."surveyId"
    WHERE f."id" = ${id} AND f."tenantId" IS NOT DISTINCT FROM ${tenantId}
    LIMIT 1
  `;
  if (!rows[0]) throw new Error("Feedback follow-up not found");
  return rows[0];
}

export async function assignSurveyFollowUp(formData: FormData) {
  const { user, tenantId } = await recoveryContext();
  const id = String(formData.get("id") ?? "");
  const ownerId = String(formData.get("ownerId") ?? "").trim() || null;
  await loadFollowUp(id, tenantId);
  let ownerName = "Unassigned";
  if (ownerId) {
    const owner = await resolveTenantMemberUser(ownerId);
    if (!owner) throw new Error("That owner is not an active member of this tenant");
    ownerName = owner.name;
  }
  await basePrisma.$executeRaw`
    UPDATE "SurveyFollowUp"
    SET "ownerId" = ${ownerId}, "status" = CASE WHEN "status" = 'open' THEN 'in_progress' ELSE "status" END,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId}
  `;
  await logAudit({ action: "survey.follow_up_assigned", summary: `Assigned feedback follow-up to ${ownerName}`, user });
  refresh(id);
}

export async function resolveSurveyFollowUp(formData: FormData) {
  const { user, tenantId } = await recoveryContext();
  const id = String(formData.get("id") ?? "");
  const note = String(formData.get("note") ?? "").trim();
  if (!note) throw new Error("Record how the feedback was resolved");
  await loadFollowUp(id, tenantId);
  await basePrisma.$executeRaw`
    UPDATE "SurveyFollowUp"
    SET "status" = 'resolved', "note" = ${note}, "resolvedAt" = CURRENT_TIMESTAMP,
      "resolvedById" = ${user.id}, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId}
  `;
  await logAudit({ action: "survey.follow_up_resolved", summary: `Resolved feedback follow-up: ${note}`, user });
  refresh(id);
}

export async function reopenSurveyFollowUp(formData: FormData) {
  const { user, tenantId } = await recoveryContext();
  const id = String(formData.get("id") ?? "");
  await loadFollowUp(id, tenantId);
  await basePrisma.$executeRaw`
    UPDATE "SurveyFollowUp"
    SET "status" = 'open', "resolvedAt" = NULL, "resolvedById" = NULL, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId}
  `;
  await logAudit({ action: "survey.follow_up_reopened", summary: `Reopened feedback follow-up ${id}`, user });
  refresh(id);
}

export async function createCaseFromSurveyFollowUp(formData: FormData) {
  const { user, tenantId } = await recoveryContext("cases.create");
  await requirePermission("surveys.manage");
  const id = String(formData.get("id") ?? "");
  const followUp = await loadFollowUp(id, tenantId);
  if (!followUp.contactId) throw new Error("This response is not linked to a customer contact");
  if (followUp.caseId) redirect(`/cases/${followUp.caseId}`);

  const description = [
    `Closed-loop follow-up created from survey “${followUp.surveyTitle}”.`,
    followUp.score !== null ? `Score: ${followUp.score}` : null,
    followUp.comment ? `Customer comment: ${followUp.comment}` : null,
  ].filter(Boolean).join("\n\n");
  const created = await basePrisma.customerCase.create({
    data: {
      // Stamp the owning tenant explicitly — basePrisma bypasses the scoping guard,
      // so without this the case and its message would be written tenantId=null and
      // be invisible to the tenant that raised the feedback. Every sibling write
      // here scopes on tenantId; this create was the gap.
      tenantId,
      subject: `Survey recovery: ${followUp.surveyTitle}`,
      description,
      type: "support",
      priority: followUp.severity === "critical" ? "urgent" : "high",
      status: "open",
      source: "survey",
      contactId: followUp.contactId,
      assignedToId: user.id,
      lastReplyBy: "staff",
      lastReplyAt: new Date(),
      messages: { create: { tenantId, userId: user.id, direction: "staff", type: "note", body: description } },
    },
    select: { id: true, number: true },
  });
  await basePrisma.$executeRaw`
    UPDATE "SurveyFollowUp"
    SET "caseId" = ${created.id}, "status" = 'escalated', "ownerId" = ${user.id}, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId}
  `;
  await logAudit({ action: "survey.follow_up_case_created", summary: `Created case C-${created.number} from negative survey feedback`, contactId: followUp.contactId, user, entityType: "CustomerCase", entityId: created.id });
  redirect(`/cases/${created.id}`);
}
