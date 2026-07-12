"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireCrm } from "@/lib/auth";
import { parseRands } from "@/lib/format";
import { runLeadAutomations } from "@/lib/automations";
import { recordReferral, markReferralEarned } from "@/lib/referrals";
import { logAudit, logAuditStrict } from "@/lib/audit";
import { softDeleteRecord } from "@/lib/trash";
import { topPosition } from "@/lib/leadPos";
import { triggerSurvey } from "@/lib/surveys";
import {
  hasPermission,
  requireLeadAccess,
  requireLeadReadAccess,
  requirePermission,
} from "@/lib/permissions";
import {
  getDefaultPipeline,
  getLeadPipeline,
  getPipelineStage,
  listPipelineStages,
} from "@/lib/pipelines";

function leadData(formData: FormData) {
  const str = (key: string) => {
    const value = String(formData.get(key) ?? "").trim();
    return value === "" ? null : value;
  };
  return {
    name: String(formData.get("name") ?? "").trim(),
    email: str("email"),
    phone: str("phone"),
    source: str("source") ?? "manual",
    productId: str("productId"),
    color: str("color"),
    notes: str("notes"),
    quantity: Math.max(1, parseInt(String(formData.get("quantity") ?? "1"), 10) || 1),
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

async function defaultOpenStageId() {
  const pipeline = await getDefaultPipeline();
  if (!pipeline) throw new Error("No active sales pipeline configured");
  const stages = await listPipelineStages(pipeline.id);
  const stage = stages.find((item) => !item.isClosed);
  if (!stage) throw new Error("The default pipeline has no open stage");
  return stage.id;
}

async function validateOpenStage(stageId: string) {
  const stage = await getPipelineStage(stageId);
  if (!stage) throw new Error("Selected pipeline stage does not exist");
  if (stage.isClosed) throw new Error("Use Mark won or Mark lost instead of creating or dragging into a closed stage");
  return stage;
}

export async function createLead(formData: FormData) {
  const user = await requirePermission("leads.create");
  const data = leadData(formData);
  if (!data.name) throw new Error("Name is required");
  if (!data.stageId) data.stageId = await defaultOpenStageId();
  await validateOpenStage(data.stageId);

  if (!data.assignedToId) data.assignedToId = user.id;
  if (data.assignedToId !== user.id && !(await hasPermission(user, "leads.assign"))) {
    throw new Error("You do not have permission to assign leads to another user");
  }

  const title = String(formData.get("title") ?? "").trim() || (await buildTitle(data));

  // Ensure every lead has a contact: link an existing one or create it.
  if (!data.contactId) {
    const matchers = [
      ...(data.email ? [{ email: data.email }] : []),
      ...(data.phone ? [{ phone: data.phone }] : []),
    ];
    const existing = matchers.length > 0
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
        after: { firstName: contact.firstName, lastName: contact.lastName, email: contact.email, phone: contact.phone },
      });
    }
  }

  const lead = await prisma.lead.create({
    data: { ...data, title, createdById: user.id, position: await topPosition(data.stageId) },
  });
  await logAuditStrict({
    action: "lead.created",
    summary: `Created lead “${lead.title}”`,
    leadId: lead.id,
    contactId: lead.contactId,
    user,
    after: lead,
  });
  const refCode = String(formData.get("referralCode") ?? "").trim();
  if (refCode) await recordReferral(refCode, lead.id).catch(() => {});
  await runLeadAutomations("lead_created", lead.id);
  revalidatePath("/leads");
  revalidatePath("/forecast");
  redirect(`/leads/${lead.id}`);
}

export async function updateLead(id: string, formData: FormData) {
  const user = await requireLeadAccess(id, "leads.edit");
  const data = leadData(formData);
  if (!data.name) throw new Error("Name is required");
  const before = await prisma.lead.findUniqueOrThrow({ where: { id } });
  const beforePipeline = await getLeadPipeline(id);
  const targetStage = await validateOpenStage(data.stageId);

  if (before.assignedToId !== data.assignedToId && !(await hasPermission(user, "leads.assign"))) {
    throw new Error("You do not have permission to reassign this lead");
  }
  if (before.stageId !== data.stageId) {
    if (!(await hasPermission(user, "leads.change_stage"))) {
      throw new Error("You do not have permission to change the lead stage");
    }
    if (beforePipeline && beforePipeline.pipelineId !== targetStage.pipelineId && !(await hasPermission(user, "leads.change_pipeline"))) {
      throw new Error("You do not have permission to move leads between pipelines");
    }
  }

  const title = String(formData.get("title") ?? "").trim() || (await buildTitle(data));
  const lead = await prisma.lead.update({
    where: { id },
    data: { ...data, title, ...(before.stageId !== data.stageId ? { stageEnteredAt: new Date() } : {}) },
  });
  await logAuditStrict({
    action: "lead.updated",
    summary: `Updated lead “${lead.title}”`,
    leadId: id,
    contactId: lead.contactId,
    user,
    before,
    after: lead,
  });
  if (before.stageId !== data.stageId) await runLeadAutomations("stage_entered", id);
  revalidatePath("/leads");
  revalidatePath("/forecast");
  revalidatePath(`/leads/${id}`);
  redirect(`/leads/${id}`);
}

export async function moveLead(leadId: string, stageId: string) {
  const user = await requireLeadAccess(leadId, "leads.change_stage");
  const before = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
  const currentScope = await getLeadPipeline(leadId);
  const targetStage = await validateOpenStage(stageId);
  if (currentScope && currentScope.pipelineId !== targetStage.pipelineId && !(await hasPermission(user, "leads.change_pipeline"))) {
    throw new Error("You do not have permission to move leads between pipelines");
  }
  const lead = await prisma.lead.update({
    where: { id: leadId },
    data: { stageId, position: await nextPosition(stageId), stageEnteredAt: new Date() },
    include: { stage: true },
  });
  await logAuditStrict({
    action: "lead.stage_changed",
    summary: `Moved “${lead.title}” to ${lead.stage.name}`,
    leadId,
    contactId: lead.contactId,
    user,
    before: { stageId: before.stageId, position: before.position, pipelineId: currentScope?.pipelineId },
    after: { stageId, position: lead.position, pipelineId: targetStage.pipelineId },
  });
  await runLeadAutomations("stage_entered", leadId);
  revalidatePath("/leads");
  revalidatePath("/forecast");
}

/**
 * Dragging a lead into the test-drive stage: move it AND capture the booking
 * (model, when, where) in one step so the appointment is never lost.
 */
export async function moveLeadToTestDrive(
  leadId: string,
  stageId: string,
  data: { productId: string | null; date: string; time: string; location: string }
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireCrm();
  const when = new Date(`${data.date}T${data.time || "09:00"}:00+02:00`); // SA time
  if (isNaN(when.getTime())) return { ok: false, error: "Pick a valid date and time" };

  const lead = await prisma.lead.update({
    where: { id: leadId },
    data: {
      stageId,
      position: await nextPosition(stageId),
      stageEnteredAt: new Date(),
      // Capture the model they want to drive if it changed / wasn't set
      ...(data.productId ? { productId: data.productId } : {}),
    },
    include: { stage: true, product: true },
  });

  await prisma.activity.create({
    data: {
      type: "test_drive",
      summary: `Test Drive${lead.product ? ` — ${lead.product.name}` : ""}`,
      note: `Booked from the pipeline board for ${lead.name}.`,
      location: data.location.trim() || null,
      dueDate: when,
      leadId,
      contactId: lead.contactId,
      assignedToId: lead.assignedToId ?? user.id,
      createdById: user.id,
    },
  });

  await logAudit({
    action: "lead.test_drive_booked",
    summary: `Booked a test drive for “${lead.title}” (${when.toLocaleString("en-ZA", {
      timeZone: "Africa/Johannesburg",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    })}${data.location ? ` at ${data.location}` : ""})`,
    leadId,
    contactId: lead.contactId,
    user,
  });
  await runLeadAutomations("stage_entered", leadId);
  revalidatePath("/leads");
  revalidatePath("/calendar");
  return { ok: true };
}

/** Mark a lead as opened (clears the NEW pill) and refresh the board. */
export async function markLeadViewed(leadId: string) {
  await requireLeadReadAccess(leadId);
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { viewedAt: true } });
  if (lead && !lead.viewedAt) {
    await prisma.lead.update({ where: { id: leadId }, data: { viewedAt: new Date() } });
    revalidatePath("/leads");
  }
}

/** Marks a lead won and ensures it is linked to a contact. */
export async function markWon(leadId: string) {
  const user = await requireLeadAccess(leadId, "leads.mark_won");
  const before = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
  let contactId = before.contactId;
  if (!contactId) {
    const [firstName, ...rest] = before.name.split(/\s+/);
    const contact = await prisma.contact.create({
      data: {
        firstName: firstName || before.name,
        lastName: rest.join(" ") || null,
        email: before.email,
        phone: before.phone,
        source: before.source,
        createdById: user.id,
        ownerId: before.assignedToId ?? user.id,
      },
    });
    contactId = contact.id;
    await logAudit({
      action: "contact.created",
      summary: `Created contact ${before.name} from won lead`,
      contactId,
      leadId,
      user,
      after: contact,
    });
  }
  const lead = await prisma.lead.update({
    where: { id: leadId },
    data: { status: "won", contactId },
  });
  await markReferralEarned(leadId).catch(() => {});
  await runLeadAutomations("lead_won", leadId);
  await logAuditStrict({
    action: "lead.won",
    summary: `Marked lead “${lead.title}” as WON 🎉`,
    leadId,
    contactId,
    user,
    before,
    after: lead,
  });
  await triggerSurvey("won", { contactId, leadId });
  revalidatePath("/leads");
  revalidatePath("/forecast");
  revalidatePath(`/leads/${leadId}`);
  redirect(`/contacts/${contactId}`);
}

export async function markLost(leadId: string, formData: FormData) {
  const user = await requireLeadAccess(leadId, "leads.mark_lost");
  const reason = String(formData.get("lostReason") ?? "").trim();
  if (!reason) throw new Error("A lost reason is required");
  const before = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
  const lead = await prisma.lead.update({
    where: { id: leadId },
    data: { status: "lost", lostReason: reason },
  });
  await runLeadAutomations("lead_lost", leadId);
  await logAuditStrict({
    action: "lead.lost",
    summary: `Marked lead “${lead.title}” as lost — ${reason}`,
    leadId,
    contactId: lead.contactId,
    user,
    before,
    after: lead,
  });
  revalidatePath("/leads");
  revalidatePath("/forecast");
  revalidatePath(`/leads/${leadId}`);
}

export async function reopenLead(leadId: string) {
  const user = await requireLeadAccess(leadId, "leads.reopen");
  const before = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
  const lead = await prisma.lead.update({
    where: { id: leadId },
    data: { status: "open", lostReason: null },
  });
  await logAuditStrict({
    action: "lead.reopened",
    summary: `Reopened lead “${lead.title}”`,
    leadId,
    contactId: lead.contactId,
    user,
    before,
    after: lead,
  });
  revalidatePath("/leads");
  revalidatePath("/forecast");
  revalidatePath(`/leads/${leadId}`);
}

export async function linkLeadToContact(leadId: string, formData: FormData) {
  const user = await requireLeadAccess(leadId, "leads.link_contact");
  const contactId = String(formData.get("contactId") ?? "");
  if (!contactId) return;
  const contact = await prisma.contact.findUnique({ where: { id: contactId }, select: { id: true } });
  if (!contact) throw new Error("Contact not found");
  const before = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
  const lead = await prisma.lead.update({
    where: { id: leadId },
    data: { contactId },
    include: { contact: true },
  });
  await logAuditStrict({
    action: "lead.contact_linked",
    summary: `Linked lead “${lead.title}” to contact ${lead.contact ? `${lead.contact.firstName} ${lead.contact.lastName ?? ""}`.trim() : ""}`,
    leadId,
    contactId,
    user,
    before: { contactId: before.contactId },
    after: { contactId },
  });
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/leads");
}

export async function deleteLead(leadId: string, formData: FormData) {
  const user = await requireLeadAccess(leadId, "leads.delete");
  const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
  const before = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
  const lead = await softDeleteRecord("lead", leadId, reason, user.name);
  await logAuditStrict({
    action: "trash.deleted",
    summary: `Moved lead “${lead.title}” to trash — ${reason}`,
    leadId,
    contactId: lead.contactId,
    user,
    before,
    after: { deletedAt: lead.deletedAt, deleteReason: reason },
  });
  revalidatePath("/leads");
  revalidatePath("/forecast");
  redirect("/leads");
}
