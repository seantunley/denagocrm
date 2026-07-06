"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { parseRands } from "@/lib/format";
import { runLeadAutomations } from "@/lib/automations";

function leadData(formData: FormData) {
  const str = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    return v === "" ? null : v;
  };
  return {
    name: String(formData.get("name") ?? "").trim(),
    email: str("email"),
    phone: str("phone"),
    source: str("source") ?? "manual",
    productId: str("productId"),
    color: str("color"),
    notes: str("notes"),
    valueCents: parseRands(str("value")),
    stageId: String(formData.get("stageId") ?? ""),
    contactId: str("contactId"),
  };
}

async function nextPosition(stageId: string) {
  const max = await prisma.lead.aggregate({
    where: { stageId },
    _max: { position: true },
  });
  return (max._max.position ?? 0) + 1;
}

async function buildTitle(data: { name: string; productId: string | null; color: string | null }) {
  if (!data.productId) return data.name;
  const product = await prisma.product.findUnique({ where: { id: data.productId } });
  if (!product) return data.name;
  return [product.name, data.color].filter(Boolean).join(" – ");
}

export async function createLead(formData: FormData) {
  await requireUser();
  const data = leadData(formData);
  if (!data.name) throw new Error("Name is required");
  if (!data.stageId) {
    const first = await prisma.pipelineStage.findFirst({ orderBy: { order: "asc" } });
    if (!first) throw new Error("No pipeline stages configured");
    data.stageId = first.id;
  }
  const title = String(formData.get("title") ?? "").trim() || (await buildTitle(data));
  const lead = await prisma.lead.create({
    data: { ...data, title, position: await nextPosition(data.stageId) },
  });
  await runLeadAutomations("lead_created", lead.id);
  revalidatePath("/leads");
  redirect(`/leads/${lead.id}`);
}

export async function updateLead(id: string, formData: FormData) {
  await requireUser();
  const data = leadData(formData);
  if (!data.name) throw new Error("Name is required");
  const title = String(formData.get("title") ?? "").trim() || (await buildTitle(data));
  const before = await prisma.lead.findUniqueOrThrow({ where: { id } });
  await prisma.lead.update({ where: { id }, data: { ...data, title } });
  if (before.stageId !== data.stageId) {
    await runLeadAutomations("stage_entered", id);
  }
  revalidatePath("/leads");
  revalidatePath(`/leads/${id}`);
  redirect(`/leads/${id}`);
}

export async function moveLead(leadId: string, stageId: string) {
  await requireUser();
  await prisma.lead.update({
    where: { id: leadId },
    data: { stageId, position: await nextPosition(stageId) },
  });
  await runLeadAutomations("stage_entered", leadId);
  revalidatePath("/leads");
}

/** Marks a lead won and ensures it is linked to a contact (creating one if needed). */
export async function markWon(leadId: string) {
  await requireUser();
  const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
  let contactId = lead.contactId;
  if (!contactId) {
    const [firstName, ...rest] = lead.name.split(/\s+/);
    const contact = await prisma.contact.create({
      data: {
        firstName: firstName || lead.name,
        lastName: rest.join(" ") || null,
        email: lead.email,
        phone: lead.phone,
        source: lead.source,
      },
    });
    contactId = contact.id;
  }
  await prisma.lead.update({
    where: { id: leadId },
    data: { status: "won", contactId },
  });
  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
  redirect(`/contacts/${contactId}`);
}

export async function markLost(leadId: string, formData: FormData) {
  await requireUser();
  const reason = String(formData.get("lostReason") ?? "").trim() || null;
  await prisma.lead.update({
    where: { id: leadId },
    data: { status: "lost", lostReason: reason },
  });
  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
}

export async function reopenLead(leadId: string) {
  await requireUser();
  await prisma.lead.update({
    where: { id: leadId },
    data: { status: "open", lostReason: null },
  });
  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
}

export async function linkLeadToContact(leadId: string, formData: FormData) {
  await requireUser();
  const contactId = String(formData.get("contactId") ?? "");
  if (!contactId) return;
  await prisma.lead.update({ where: { id: leadId }, data: { contactId } });
  revalidatePath(`/leads/${leadId}`);
}

export async function deleteLead(leadId: string) {
  await requireUser();
  await prisma.lead.delete({ where: { id: leadId } });
  revalidatePath("/leads");
  redirect("/leads");
}
