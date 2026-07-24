"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/permissions";
import { getActiveTenantId } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { defaultQuestions, type SurveyQuestion, type SurveyType } from "@/lib/surveyTypes";
import {
  createInactiveSurveyDraft,
  createSurveyRevision,
  publishSurveyVersion,
  transitionSurvey,
  updateSurveyDraftRecord,
} from "@/lib/marketingSurveyWorkflow";

function refresh(id?: string) {
  revalidatePath("/marketing/surveys");
  revalidatePath("/surveys");
  if (id) {
    revalidatePath(`/marketing/surveys/${id}`);
    revalidatePath(`/surveys/${id}`);
  }
}

export async function createMarketingSurvey(formData: FormData) {
  const user = await requirePermission("surveys.manage");
  const tenantId = await getActiveTenantId();
  const title = String(formData.get("title") ?? "").trim() || "Untitled survey";
  const type = (String(formData.get("type") ?? "adhoc") as SurveyType) || "adhoc";
  const id = await createInactiveSurveyDraft({
    tenantId,
    userId: user.id,
    title,
    type,
    questions: defaultQuestions(type),
  });
  await logAudit({ action: "survey.draft_created", summary: `Created inactive survey draft “${title}”`, user });
  redirect(`/surveys/${id}`);
}

export async function saveMarketingSurveyDraft(
  id: string,
  data: { title: string; intro: string; thankYou: string; questions: SurveyQuestion[]; delayHours: number },
) {
  const user = await requirePermission("surveys.manage");
  const tenantId = await getActiveTenantId();
  await updateSurveyDraftRecord({ id, tenantId, ...data });
  await logAudit({ action: "survey.draft_saved", summary: `Saved survey draft “${data.title || id}”`, user });
  refresh(id);
  return { ok: true as const };
}

export async function submitSurveyForReview(formData: FormData) {
  const user = await requirePermission("surveys.manage");
  const tenantId = await getActiveTenantId();
  const id = String(formData.get("id") ?? "");
  await transitionSurvey({ id, tenantId, to: "in_review", userId: user.id });
  await logAudit({ action: "survey.submitted", summary: `Submitted survey ${id} for review`, user });
  refresh(id);
}

export async function requestSurveyChanges(formData: FormData) {
  const user = await requirePermission("surveys.manage");
  const tenantId = await getActiveTenantId();
  const id = String(formData.get("id") ?? "");
  const note = String(formData.get("note") ?? "").trim();
  await transitionSurvey({ id, tenantId, to: "changes_requested", userId: user.id, note });
  await logAudit({ action: "survey.changes_requested", summary: `Requested survey changes: ${note}`, user });
  refresh(id);
}

export async function approveSurvey(formData: FormData) {
  const user = await requirePermission("surveys.manage");
  const tenantId = await getActiveTenantId();
  const id = String(formData.get("id") ?? "");
  await transitionSurvey({ id, tenantId, to: "approved", userId: user.id });
  await logAudit({ action: "survey.approved", summary: `Approved survey ${id}`, user });
  refresh(id);
}

export async function publishSurvey(formData: FormData) {
  const user = await requirePermission("surveys.manage");
  const tenantId = await getActiveTenantId();
  const id = String(formData.get("id") ?? "");
  const trigger = String(formData.get("trigger") ?? "").trim() || null;
  const label = String(formData.get("label") ?? "").trim() || null;
  const replaceExisting = String(formData.get("replaceExisting") ?? "") === "true";
  const version = await publishSurveyVersion({ id, tenantId, userId: user.id, trigger, label, replaceExisting });
  await logAudit({ action: "survey.published", summary: `Published survey ${id} version ${version}`, user });
  refresh(id);
}

export async function deactivateSurvey(formData: FormData) {
  const user = await requirePermission("surveys.manage");
  const tenantId = await getActiveTenantId();
  const id = String(formData.get("id") ?? "");
  await transitionSurvey({ id, tenantId, to: "inactive", userId: user.id });
  await logAudit({ action: "survey.deactivated", summary: `Deactivated survey ${id}`, user });
  refresh(id);
}

export async function archiveMarketingSurvey(formData: FormData) {
  const user = await requirePermission("surveys.manage");
  const tenantId = await getActiveTenantId();
  const id = String(formData.get("id") ?? "");
  await transitionSurvey({ id, tenantId, to: "archived", userId: user.id });
  await logAudit({ action: "survey.archived", summary: `Archived survey ${id}`, user });
  refresh(id);
}

export async function reviseSurvey(formData: FormData) {
  const user = await requirePermission("surveys.manage");
  const tenantId = await getActiveTenantId();
  const id = String(formData.get("id") ?? "");
  const revisionId = await createSurveyRevision({ id, tenantId, userId: user.id });
  await logAudit({ action: "survey.revision_created", summary: `Created survey revision from ${id}`, user });
  redirect(`/surveys/${revisionId}`);
}
