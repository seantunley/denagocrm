"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";

function ruleData(formData: FormData) {
  const str = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    return v === "" ? null : v;
  };
  const int = (k: string) => {
    const v = str(k);
    if (v == null) return null;
    const n = parseInt(v, 10);
    return isNaN(n) ? null : n;
  };
  const name = String(formData.get("name") ?? "").trim();
  const trigger = str("trigger");
  const action = str("action");
  if (!name || !trigger || !action) return null;
  return {
    name,
    trigger,
    triggerStageId: str("triggerStageId"),
    idleDays: int("idleDays"),
    action,
    activityType: str("activityType"),
    activitySummary: str("activitySummary"),
    activityDueDays: int("activityDueDays"),
    emailTemplateId: str("emailTemplateId"),
    targetStageId: str("targetStageId"),
    assignToId: str("assignToId"),
    pushMessage: str("pushMessage"),
    conditionSources: str("conditionSources"),
    minValueCents: int("minValueRands") != null ? int("minValueRands")! * 100 : null,
  };
}

export async function createAutomationRule(formData: FormData) {
  await requireUser();
  const data = ruleData(formData);
  if (!data) return;
  await prisma.automationRule.create({ data });
  revalidatePath("/automations");
}

export async function updateAutomationRule(id: string, formData: FormData) {
  await requireUser();
  const data = ruleData(formData);
  if (!data) return;
  await prisma.automationRule.update({ where: { id }, data });
  revalidatePath("/automations");
}

export async function toggleAutomationRule(id: string) {
  await requireUser();
  const rule = await prisma.automationRule.findUniqueOrThrow({ where: { id } });
  await prisma.automationRule.update({
    where: { id },
    data: { active: !rule.active },
  });
  revalidatePath("/automations");
}

export async function deleteAutomationRule(id: string, formData: FormData) {
  await requireUser();
  void formData;
  await prisma.automationLog.deleteMany({ where: { ruleId: id } });
  await prisma.automationRule.delete({ where: { id } });
  revalidatePath("/automations");
}
