"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireCrm } from "@/lib/auth";
import { parseRands } from "@/lib/format";
import { runLeadAutomations } from "@/lib/automations";
import { recordReferral, markReferralEarned } from "@/lib/referrals";
import { logAudit } from "@/lib/audit";
import { softDeleteRecord } from "@/lib/trash";

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
    assignedToId: str("assignedToId"),
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
  const user = await requireCrm();
  const data = leadData(formData);
  if (!data.name) throw new Error("Name is required");
  if (!data.stageId) {
    const first = await prisma.pipelineStage.findFirst({ orderBy: { order: "asc" } });
    if (!first) throw new Error("No pipeline stages configured");
    data.stageId = first.id;
  }
  const title = String(formData.get("title") ?? "").trim() || (await buildTitle(data));

  // Ensure every lead has a contact: link an existing one (matched by
  // email/phone) or create it on the spot.
  if (!data.contactId) {
    const matchers = [
      ...(data.email ? [{ email: data.email }] : []),
      ...(data.phone ? [{ phone: data.phone }] : []),
    ];
    const existing =
      matchers.length > 0
        ? await prisma.contact.findFirst({ where: { OR: matchers } })
        : null;
    if (existing) {
      data.contactId = existing.id;
    } else {
      const [firstName, ...rest] = data.name.split(/\s+/);
      const contact = await prisma.contact.create({
        data: {
          firstName: firstName || data.name,
          lastName: rest.join(" ") || null,
          email: data.email,
          phone: data.phone,
          source: data.source,
          createdById: user.id,
          ownerId: data.assignedToId ?? user.id,
        },
      });
      data.contactId = contact.id;
      await logAudit({
        action: "contact.created",
        summary: `Created contact ${data.name} (with new lead)`,
        contactId: contact.id,
        user,
      });
    }
  }

  const lead = await prisma.lead.create({
    data: { ...data, title, createdById: user.id, position: await nextPosition(data.stageId) },
  });
  await logAudit({
    action: "lead.created",
    summary: `Created lead “${lead.title}”`,
    leadId: lead.id,
    contactId: lead.contactId,
    user,
  });
  const refCode = String(formData.get("referralCode") ?? "").trim();
  if (refCode) await recordReferral(refCode, lead.id).catch(() => {});
  await runLeadAutomations("lead_created", lead.id);
  revalidatePath("/leads");
  redirect(`/leads/${lead.id}`);
}

export async function updateLead(id: string, formData: FormData) {
  const user = await requireCrm();
  const data = leadData(formData);
  if (!data.name) throw new Error("Name is required");
  const title = String(formData.get("title") ?? "").trim() || (await buildTitle(data));
  const before = await prisma.lead.findUniqueOrThrow({ where: { id } });
  const lead = await prisma.lead.update({ where: { id }, data: { ...data, title } });
  await logAudit({
    action: "lead.updated",
    summary: `Updated lead “${lead.title}”`,
    leadId: id,
    contactId: lead.contactId,
    user,
  });
  if (before.stageId !== data.stageId) {
    await runLeadAutomations("stage_entered", id);
  }
  revalidatePath("/leads");
  revalidatePath(`/leads/${id}`);
  redirect(`/leads/${id}`);
}

export async function moveLead(leadId: string, stageId: string) {
  const user = await requireCrm();
  const lead = await prisma.lead.update({
    where: { id: leadId },
    data: { stageId, position: await nextPosition(stageId) },
    include: { stage: true },
  });
  await logAudit({
    action: "lead.stage_changed",
    summary: `Moved “${lead.title}” to ${lead.stage.name}`,
    leadId,
    contactId: lead.contactId,
    user,
  });
  await runLeadAutomations("stage_entered", leadId);
  revalidatePath("/leads");
}

/** Marks a lead won and ensures it is linked to a contact (creating one if needed). */
export async function markWon(leadId: string) {
  const user = await requireCrm();
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
        createdById: user.id,
        ownerId: lead.assignedToId ?? user.id,
      },
    });
    contactId = contact.id;
    await logAudit({
      action: "contact.created",
      summary: `Created contact ${lead.name} from won lead`,
      contactId,
      leadId,
      user,
    });
  }
  await prisma.lead.update({
    where: { id: leadId },
    data: { status: "won", contactId },
  });
  await markReferralEarned(leadId).catch(() => {});
  await runLeadAutomations("lead_won", leadId);
  await logAudit({
    action: "lead.won",
    summary: `Marked lead “${lead.title}” as WON 🎉`,
    leadId,
    contactId,
    user,
  });
  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
  redirect(`/contacts/${contactId}`);
}

export async function markLost(leadId: string, formData: FormData) {
  const user = await requireCrm();
  const reason = String(formData.get("lostReason") ?? "").trim();
  if (!reason) return; // a lost reason is mandatory
  const lead = await prisma.lead.update({
    where: { id: leadId },
    data: { status: "lost", lostReason: reason },
  });
  await runLeadAutomations("lead_lost", leadId);
  await logAudit({
    action: "lead.lost",
    summary: `Marked lead “${lead.title}” as lost — ${reason}`,
    leadId,
    contactId: lead.contactId,
    user,
  });
  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
}

export async function reopenLead(leadId: string) {
  const user = await requireCrm();
  const lead = await prisma.lead.update({
    where: { id: leadId },
    data: { status: "open", lostReason: null },
  });
  await logAudit({
    action: "lead.reopened",
    summary: `Reopened lead “${lead.title}”`,
    leadId,
    contactId: lead.contactId,
    user,
  });
  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
}

export async function linkLeadToContact(leadId: string, formData: FormData) {
  const user = await requireCrm();
  const contactId = String(formData.get("contactId") ?? "");
  if (!contactId) return;
  const lead = await prisma.lead.update({
    where: { id: leadId },
    data: { contactId },
    include: { contact: true },
  });
  await logAudit({
    action: "lead.contact_linked",
    summary: `Linked lead “${lead.title}” to contact ${lead.contact ? `${lead.contact.firstName} ${lead.contact.lastName ?? ""}`.trim() : ""}`,
    leadId,
    contactId,
    user,
  });
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/leads");
}

export async function deleteLead(leadId: string, formData: FormData) {
  const user = await requireCrm();
  const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
  const lead = await softDeleteRecord("lead", leadId, reason, user.name);
  await logAudit({
    action: "trash.deleted",
    summary: `Moved lead “${lead.title}” to trash — ${reason}`,
    leadId,
    contactId: lead.contactId,
    user,
  });
  revalidatePath("/leads");
  redirect("/leads");
}
