"use server";

import { prisma } from "@/lib/db";
import { resolveTenantMemberUser } from "@/lib/tenantActor";
import { currentTenantScope } from "@/lib/tenantScope";
import { createLead } from "@/app/actions/leads";
import { createContact } from "@/app/actions/contacts";
import { scheduleActivity } from "@/app/actions/activities";
import { createVehicle } from "@/app/actions/vehicles";

function formId(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim() || null;
}

async function requireTenantMember(formData: FormData, key: string) {
  const id = formId(formData, key);
  if (!id) return;
  if (!(await resolveTenantMemberUser(id))) {
    throw new Error("That team member is not available in this workspace");
  }
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
    requireTenantMember(formData, "assignedToId"),
    requireTenantRecord(formData, "contactId", "contact"),
    requireTenantRecord(formData, "productId", "product"),
    requireTenantRecord(formData, "stageId", "pipelineStage"),
  ]);
  return createLead(formData);
}

export async function createQuickContact(formData: FormData) {
  await requireTenantMember(formData, "ownerId");
  return createContact(formData);
}

export async function scheduleQuickActivity(formData: FormData) {
  await requireTenantMember(formData, "assignedToId");
  return scheduleActivity(formData);
}

export async function createQuickVehicle(formData: FormData) {
  await Promise.all([
    requireTenantRecord(formData, "contactId", "contact"),
    requireTenantRecord(formData, "productId", "product"),
  ]);
  return createVehicle(formData);
}
