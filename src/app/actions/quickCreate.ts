"use server";

import { prisma } from "@/lib/db";
import { resolveAssignableUser } from "@/lib/tenantActor";
import { currentTenantScope } from "@/lib/tenantScope";
import { createLead } from "@/app/actions/leads";
import { createContact } from "@/app/actions/contacts";
import { scheduleActivity } from "@/app/actions/activities";
import { createVehicle } from "@/app/actions/vehicles";

function formId(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim() || null;
}

/**
 * This file is a validation gateway: each quick-create action checks the ids on
 * the form and then hands the SAME FormData to the real action. So the check
 * here and the check inside that action are two answers to one question, and
 * they only stay the same answer while they share an implementation — which,
 * until now, they did not. Both are on the shared contract in
 * lib/assignableUser.ts now, so a change to the rule reaches the gateway and the
 * action together.
 *
 * `label` names the field in the refusal, because these three call sites are
 * three different fields: a lead's team member, a contact's owner, an activity's
 * team member. Blank still means "nobody" — `resolveAssignableUser` treats it
 * that way itself, which is what the `if (!id) return` used to do.
 */
async function requireTenantMember(formData: FormData, key: string, label: string) {
  await resolveAssignableUser(formData.get(key), label);
}

async function requireTenantRecord(
  formData: FormData,
  key: string,
  model: "contact" | "product" | "pipelineStage",
) {
  const id = formId(formData, key);
  if (!id) return;
  const tenantId = currentTenantScope()?.tenantId;
  const where = tenantId ? { id, tenantId } : { id };
  const record =
    model === "contact"
      ? await prisma.contact.findUnique({ where, select: { id: true } })
      : model === "product"
        ? await prisma.product.findUnique({ where, select: { id: true } })
        : await prisma.pipelineStage.findUnique({ where, select: { id: true } });
  if (!record) throw new Error("That selection is not available in this workspace");
}

/** Tenant-validation gateway for contextual/global quick-create actions. */
export async function createQuickLead(formData: FormData) {
  await Promise.all([
    requireTenantMember(formData, "assignedToId", "team member"),
    requireTenantRecord(formData, "contactId", "contact"),
    requireTenantRecord(formData, "productId", "product"),
    requireTenantRecord(formData, "stageId", "pipelineStage"),
  ]);
  return createLead(formData);
}

export async function createQuickContact(formData: FormData) {
  await requireTenantMember(formData, "ownerId", "owner");
  return createContact(formData);
}

export async function scheduleQuickActivity(formData: FormData) {
  await requireTenantMember(formData, "assignedToId", "team member");
  return scheduleActivity(formData);
}

export async function createQuickVehicle(formData: FormData) {
  await Promise.all([
    requireTenantRecord(formData, "contactId", "contact"),
    requireTenantRecord(formData, "productId", "product"),
  ]);
  return createVehicle(formData);
}
