"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { getActiveTenantId } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { sendSurvey, submitResponse } from "@/lib/surveys";
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

  const id = await createInactiveSurveyDraft({
    tenantId,
    userId: user.id,
    title,
    type,
    questions: defaultQuestions(type),
  });
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
  await updateSurveyDraftRecord({
    id,
    tenantId,
    title: data.title,
    intro: data.intro,
    thankYou: data.thankYou,
    delayHours: data.delayHours,
    questions: data.questions,
  });
  await logAudit({
    action: "survey.updated",
    summary: `Updated survey draft "${data.title}". Activation and triggers require review and publication.`,
    user,
  });
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
  await logAudit({
    action: "survey.deleted",
    summary: `Deleted survey "${survey?.title ?? id}"`,
    user,
  });
  redirect("/surveys");
}

async function audienceContactIds(segment: string): Promise<string[]> {
  if (segment === "vehicle_owners") {
    const vs = await prisma.vehicle.findMany({
      select: { contactId: true },
      distinct: ["contactId"],
      take: 3000,
    });
    return vs.map((v) => v.contactId).filter((x): x is string => !!x);
  }
  if (segment === "won_leads") {
    const ls = await prisma.lead.findMany({
      where: { status: "won", contactId: { not: null } },
      select: { contactId: true },
      distinct: ["contactId"],
      take: 3000,
    });
    return ls.map((l) => l.contactId).filter((x): x is string => !!x);
  }
  const cs = await prisma.contact.findMany({
    where: { marketingOptOut: false, OR: [{ email: { not: null } }, { phone: { not: null } }] },
    select: { id: true },
    take: 3000,
  });
  return cs.map((c) => c.id);
}

export type SendResult = { sent: number; skipped: number; test?: boolean } | null;

export async function sendToAudience(_prev: SendResult, formData: FormData): Promise<SendResult> {
  const user = await requirePermission("surveys.manage");
  const surveyId = String(formData.get("surveyId") ?? "");
  const segment = String(formData.get("segment") ?? "customers");
  const survey = await prisma.survey.findUniqueOrThrow({ where: { id: surveyId } });

  const lifecycle = survey as typeof survey & { status?: string; publishedVersion?: number | null };
  if (!survey.active || lifecycle.status !== "published" || !lifecycle.publishedVersion) {
    throw new Error("Only an approved, published survey version can be distributed");
  }

  if (segment === "test") {
    const u = await prisma.user.findUnique({ where: { id: user.id } });
    const ok = u?.email ? await sendSurvey(survey, { name: u.name, email: u.email }) : false;
    revalidatePath(`/surveys/${surveyId}`);
    return { sent: ok ? 1 : 0, skipped: ok ? 0 : 1, test: true };
  }

  const ids = await audienceContactIds(segment);
  let sent = 0;
  let skipped = 0;
  for (const contactId of ids) {
    const ok = await sendSurvey(survey, { contactId }).catch(() => false);
    if (ok) sent += 1;
    else skipped += 1;
  }
  await logAudit({
    action: "survey.blast",
    summary: `Sent "${survey.title}" version ${lifecycle.publishedVersion} to ${sent} recipient(s) (${segment})`,
    user,
  });
  revalidatePath(`/surveys/${surveyId}`);
  return { sent, skipped };
}

export async function submitSurveyResponse(token: string, answers: Record<string, unknown>) {
  return withTokenTenantScope(
    () => resolveSurveyResponseTenant(token),
    () => submitResponse(token, answers),
    () => ({ ok: false as const, error: "not_found" as const }),
  );
}
