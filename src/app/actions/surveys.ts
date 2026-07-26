"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { getActiveTenantId } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { sendSurvey } from "@/lib/surveys";
import { submitFrozenSurveyResponse } from "@/lib/governedSurveyRuntime";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveSurveyResponseTenant } from "@/lib/tokenTenant";
import {
  defaultQuestions,
  type SurveyQuestion,
  type SurveyType,
} from "@/lib/surveyTypes";
import {
  createInactiveSurveyDraft,
  updateSurveyDraftRecord,
} from "@/lib/marketingSurveyWorkflow";

export async function createSurvey(formData: FormData) {
  const user = await requirePermission("surveys.manage");
  const tenantId = await getActiveTenantId();
  const title = String(formData.get("title") ?? "").trim();
  const type = (String(formData.get("type") ?? "adhoc") as SurveyType) || "adhoc";
  if (!title) throw new Error("Give the survey a name");

  const id = await createInactiveSurveyDraft({ tenantId, userId: user.id, title, type, questions: defaultQuestions(type) });
  await logAudit({ action: "survey.created", summary: `Created inactive survey draft "${title}"`, user });
  redirect(`/surveys/${id}`);
}

export async function saveSurvey(
  id: string,
  data: {
    title: string;
    intro: string;
    thankYou: string;
    active: boolean;
    trigger: string;
    delayHours: number;
    questions: SurveyQuestion[];
  }
) {
  const user = await requirePermission("surveys.manage");
  const tenantId = await getActiveTenantId();
  await updateSurveyDraftRecord({ id, tenantId, title: data.title, intro: data.intro, thankYou: data.thankYou, delayHours: data.delayHours, questions: data.questions });
  await logAudit({ action: "survey.updated", summary: `Updated survey draft "${data.title}". Activation and triggers require review and publication.`, user });
  revalidatePath(`/surveys/${id}`);
  revalidatePath("/surveys");
  revalidatePath("/marketing/surveys");
  return { ok: true as const };
}

export async function deleteSurvey(formData: FormData) {
  const user = await requirePermission("surveys.manage");
  const id = String(formData.get("id") ?? "");
  const survey = await prisma.survey.findUnique({ where: { id } });
  await prisma.survey.update({ where: { id }, data: { deletedAt: new Date(), active: false, trigger: null } });
  await logAudit({ action: "survey.deleted", summary: `Deleted survey "${survey?.title ?? id}"`, user });
  redirect("/surveys");
}

export type SendResult = { sent: number; skipped: number; test?: boolean; error?: string } | null;

export async function sendToAudience(_prev: SendResult, formData: FormData): Promise<SendResult> {
  const user = await requirePermission("surveys.manage");
  const surveyId = String(formData.get("surveyId") ?? "");
  const segment = String(formData.get("segment") ?? "customers");
  const survey = await prisma.survey.findUniqueOrThrow({ where: { id: surveyId } });
  const lifecycle = survey as typeof survey & { status?: string; publishedVersion?: number | null };
  if (!survey.active || lifecycle.status !== "published" || !lifecycle.publishedVersion) {
    throw new Error("Only an approved, published survey version can be distributed");
  }

  if (segment !== "test") {
    return { sent: 0, skipped: 0, error: "Direct audience sends have been retired. Use Marketing → Surveys → Distributions to create a governed queue." };
  }

  const account = await prisma.user.findUnique({ where: { id: user.id } });
  const ok = account?.email ? await sendSurvey(survey, { name: account.name, email: account.email }) : false;
  await logAudit({ action: "survey.test_sent", summary: `Sent a test for survey "${survey.title}" version ${lifecycle.publishedVersion}`, user });
  revalidatePath(`/surveys/${surveyId}`);
  return { sent: ok ? 1 : 0, skipped: ok ? 0 : 1, test: true };
}

export async function submitSurveyResponse(token: string, answers: Record<string, unknown>) {
  return withTokenTenantScope(
    () => resolveSurveyResponseTenant(token),
    () => submitFrozenSurveyResponse(token, answers),
    () => ({ ok: false as const, error: "not_found" as const }),
  );
}
