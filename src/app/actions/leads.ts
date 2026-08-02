"use server";

import { asActionResult, ActionRefusal, refuse } from "@/lib/actionResult";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { parseRands } from "@/lib/format";
import { emitLeadJourneyEvent } from "@/lib/leadJourneyEvents";
import { recordReferral, markReferralEarned } from "@/lib/referrals";
import { logAudit, logAuditStrict } from "@/lib/audit";
import { softDeleteRecord } from "@/lib/trash";
import { topPosition } from "@/lib/leadPos";
import { triggerSurvey } from "@/lib/surveys";
import { removeTimelinePin } from "@/lib/timelinePins";
import { resolveTenantMemberUser } from "@/lib/tenantActor";
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

async function requireAssignableUser(userId: string) {
  const assignee = await resolveTenantMemberUser(userId);
  if (!assignee) throw new Error("That team member is no longer available.");
  return assignee;
}

async function nextPosition(stageId: string) {
  const max = await prisma.lead.aggregate({
    where: { stageId },
    _max: { position: true },
  });
  return (max._max.position ?? 0) + 1;
}

async function buildTitle(data: {
  name: string;
  productId: string | null;
  color: string | null;
  contactId?: string | null;
  assignedToId?: string | null;
}) {
  if (data.assignedToId) await requireAssignableUser(data.assignedToId);
  if (data.contactId) {
    const contact = await prisma.contact.findUnique({
      where: { id: data.contactId },
      select: { id: true },
    });
    if (!contact) throw new Error("That contact is not available in this workspace");
  }
  if (!data.productId) return data.name;
  const product = await prisma.product.findUnique({
    where: { id: data.productId },
    select: { name: true },
  });
  if (!product) throw new Error("That product is not available in this workspace");
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
  return asActionResult(async () => {
    const user = await requirePermission("leads.create");
    const data = leadData(formData);
    if (!data.name) throw new ActionRefusal("Name is required");
    if (!data.stageId) data.stageId = await defaultOpenStageId();
    await validateOpenStage(data.stageId);

    if (!data.assignedToId) data.assignedToId = user.id;
    if (data.assignedToId !== user.id && !(await hasPermission(user, "leads.assign"))) {
      throw new ActionRefusal("You do not have permission to assign leads to another user");
    }

    const generatedTitle = await buildTitle(data);
    const title = String(formData.get("title") ?? "").trim() || generatedTitle;

    if (!data.contactId) {
      const matchers = [
        ...(data.email ? [{ email: data.email }] : []),
        ...(data.phone ? [{ phone: data.phone }] : []),
      ];
      const existing = matchers.length > 0
        ? await prisma.contact.findFirst({ where: { OR: matchers } })
        : null;
      // Only reuse a contact whose tenantId is null (same as new leads) or whose
      // tenantId already matches. A mismatch would violate the composite FK.
      const canReuse = existing && (existing.tenantId === null);
      if (canReuse && existing) {
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
    await emitLeadJourneyEvent("lead_created", lead.id);
    revalidatePath("/leads");
    revalidatePath("/forecast");
    return { redirectTo: `/leads/${lead.id}` };
  });
}

export async function updateLead(id: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requireLeadAccess(id, "leads.edit");
    const data = leadData(formData);
    if (!data.name) throw new ActionRefusal("Name is required");
    const before = await prisma.lead.findUniqueOrThrow({ where: { id } });
    const beforePipeline = await getLeadPipeline(id);
    const targetStage = await validateOpenStage(data.stageId);

    if (before.assignedToId !== data.assignedToId && !(await hasPermission(user, "leads.assign"))) {
      throw new ActionRefusal("You do not have permission to reassign this lead");
    }
    if (before.stageId !== data.stageId) {
      if (!(await hasPermission(user, "leads.change_stage"))) {
        throw new ActionRefusal("You do not have permission to change the lead stage");
      }
      if (beforePipeline && beforePipeline.pipelineId !== targetStage.pipelineId && !(await hasPermission(user, "leads.change_pipeline"))) {
        throw new ActionRefusal("You do not have permission to move leads between pipelines");
      }
    }

    const generatedTitle = await buildTitle(data);
    const title = String(formData.get("title") ?? "").trim() || generatedTitle;

    if (data.contactId && data.contactId !== before.contactId && before.tenantId) {
      const targetContact = await prisma.contact.findUnique({
        where: { id: data.contactId },
        select: { tenantId: true },
      });
      if (targetContact?.tenantId === null) {
        await prisma.contact.update({
          where: { id: data.contactId },
          data: { tenantId: before.tenantId },
        });
      }
    }

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
    if (before.stageId !== data.stageId) await emitLeadJourneyEvent("stage_entered", id);
    revalidatePath("/leads");
    revalidatePath("/forecast");
    revalidatePath(`/leads/${id}`);
    return { redirectTo: `/leads/${id}` };
  });
}

export async function moveLead(leadId: string, stageId: string) {
  const user = await requireLeadAccess(leadId, "leads.change_stage");
  const before = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
  const currentScope = await getLeadPipeline(leadId);
  const targetStage = await validateOpenStage(stageId);
  if (currentScope && currentScope.pipelineId !== targetStage.pipelineId && !(await hasPermission(user, "leads.change_pipeline"))) {
    throw new Error("You do not have permission to move leads between pipelines");
  }
  if (targetStage.entryAction === "book_test_drive") {
    throw new Error("This stage requires test-drive booking details");
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
  const pipelineStages = await listPipelineStages(targetStage.pipelineId);
  const testDriveStage = pipelineStages.find((stage) => stage.entryAction === "book_test_drive");
  if (testDriveStage && targetStage.order < testDriveStage.order) {
    const booking = await prisma.activity.findFirst({
      where: { leadId, type: "test_drive", status: "planned" },
      orderBy: { dueDate: "desc" },
    });
    if (booking) {
      await removeTimelinePin("activity", booking.id);
      await prisma.activity.delete({ where: { id: booking.id } });
      await logAudit({
        action: "lead.test_drive_cancelled",
        summary: `Cancelled the booked test drive for “${lead.title}” — moved back to ${lead.stage.name}`,
        leadId,
        contactId: lead.contactId,
        user,
      });
    }
  }

  await emitLeadJourneyEvent("stage_entered", leadId);
  revalidatePath("/leads");
  revalidatePath("/forecast");
}

export async function moveLeadToTestDrive(
  leadId: string,
  stageId: string,
  data: { productId: string | null; date: string; time: string; location: string }
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireLeadAccess(leadId, "leads.change_stage");
  const when = new Date(`${data.date}T${data.time || "09:00"}:00+02:00`);
  if (isNaN(when.getTime())) return { ok: false, error: "Pick a valid date and time" };

  const currentScope = await getLeadPipeline(leadId);
  if (!currentScope) return { ok: false, error: "Lead not found." };
  const changingStage = currentScope.stageId !== stageId;
  const targetStage = await validateOpenStage(stageId);
  if (
    currentScope.pipelineId !== targetStage.pipelineId &&
    !(await hasPermission(user, "leads.change_pipeline"))
  ) {
    return { ok: false, error: "You cannot move leads between pipelines." };
  }
  if (targetStage.entryAction !== "book_test_drive") {
    return { ok: false, error: "That stage is not configured for test-drive booking." };
  }

  let productId: string | null = null;
  if (data.productId) {
    const product = await prisma.product.findUnique({
      where: { id: data.productId },
      select: { id: true },
    });
    if (!product) return { ok: false, error: "That model is not available." };
    productId = product.id;
  }

  const position = await nextPosition(stageId);
  const lead = await prisma.$transaction(async (tx) => {
    const updated = await tx.lead.update({
      where: { id: leadId },
      data: {
        ...(changingStage ? { stageId, position, stageEnteredAt: new Date() } : {}),
        ...(productId ? { productId } : {}),
      },
      include: { stage: true, product: true },
    });
    const activityData = {
      type: "test_drive",
      summary: `Test Drive${updated.product ? ` — ${updated.product.name}` : ""}`,
      note: `${changingStage ? "Booked" : "Rescheduled"} from the pipeline board for ${updated.name}.`,
      location: data.location.trim() || null,
      dueDate: when,
      leadId,
      contactId: updated.contactId,
      assignedToId: updated.assignedToId ?? user.id,
      createdById: user.id,
    };
    const existing = await tx.activity.findFirst({
      where: { leadId, type: "test_drive", status: "planned" },
      orderBy: { dueDate: "asc" },
      select: { id: true },
    });
    if (existing) {
      await tx.activity.update({ where: { id: existing.id }, data: activityData });
    } else {
      await tx.activity.create({ data: activityData });
    }
    return updated;
  });

  await logAudit({
    action: "lead.test_drive_booked",
    summary: `${changingStage ? "Booked" : "Rescheduled"} a test drive for “${lead.title}” (${when.toLocaleString("en-ZA", {
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
  if (changingStage) await emitLeadJourneyEvent("stage_entered", leadId);
  revalidatePath("/leads");
  revalidatePath("/calendar");
  return { ok: true };
}

export async function assignLead(leadId: string, assignedToId: string) {
  const user = await requireLeadAccess(leadId, "leads.assign");
  const assignee = await requireAssignableUser(assignedToId).catch(() => null);
  if (!assignee) return { ok: false as const, error: "That team member is no longer available." };

  const before = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
  const lead = await prisma.lead.update({
    where: { id: leadId },
    data: { assignedToId: assignee.id },
  });
  await logAuditStrict({
    action: "lead.assigned",
    summary: `Assigned lead “${lead.title}” to ${assignee.name}`,
    leadId,
    contactId: lead.contactId,
    user,
    before,
    after: lead,
  });
  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/forecast");
  return { ok: true as const, assignee };
}

export async function markLeadViewed(leadId: string) {
  await requireLeadReadAccess(leadId);
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { viewedAt: true } });
  if (lead && !lead.viewedAt) {
    await prisma.lead.update({ where: { id: leadId }, data: { viewedAt: new Date() } });
    revalidatePath("/leads");
  }
}

export async function markWon(leadId: string, formData?: FormData) {
  return asActionResult(async () => {
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
          tenantId: before.tenantId,
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
    await emitLeadJourneyEvent("lead_won", leadId);
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
    // A real success that simply stays put: the win IS recorded, this only skips
    // the hop to the contact. Said explicitly so it cannot be mistaken for one of
    // the silent "nothing happened" returns.
    if (formData?.get("returnTo") === "/leads") return { success: "Marked won" };
    return { redirectTo: `/contacts/${contactId}` };
  });
}

export async function markLost(leadId: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requireLeadAccess(leadId, "leads.mark_lost");
    const reason = String(formData.get("lostReason") ?? "").trim();
    if (!reason) throw new ActionRefusal("A lost reason is required");
    const before = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    const lead = await prisma.lead.update({
      where: { id: leadId },
      data: { status: "lost", lostReason: reason },
    });
    await emitLeadJourneyEvent("lead_lost", leadId);
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
  });
}

export async function reopenLead(leadId: string) {
  return asActionResult(async () => {
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
  });
}

export async function linkLeadToContact(leadId: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requireLeadAccess(leadId, "leads.link_contact");
    const contactId = String(formData.get("contactId") ?? "");
    if (!contactId) refuse("Choose a contact to link.");
    const contact = await prisma.contact.findUnique({ where: { id: contactId }, select: { id: true, tenantId: true } });
    if (!contact) throw new ActionRefusal("Contact not found");
    const before = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    if (contact.tenantId === null && before.tenantId !== null) {
      await prisma.contact.update({ where: { id: contactId }, data: { tenantId: before.tenantId } });
    }
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
  });
}

export async function convertLeadToContact(leadId: string): Promise<{ ok: boolean; error?: string; contactId?: string }> {
  try {
    const user = await requireLeadAccess(leadId, "leads.link_contact");
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });

    if (lead.contactId) return { ok: false, error: "Already linked to a contact" };

    const matchers = [
      ...(lead.email ? [{ email: lead.email }] : []),
      ...(lead.phone ? [{ phone: lead.phone }] : []),
    ];
    const existingMatch = matchers.length > 0
      ? await prisma.contact.findFirst({ where: { OR: matchers } })
      : null;
    // Reuse if tenantId already matches, or if it's null (pre-backfill) — stamp
    // the lead's tenantId onto it so the composite FK is satisfied without
    // creating a duplicate.
    const canReuse = existingMatch && (
      existingMatch.tenantId === lead.tenantId || existingMatch.tenantId === null
    );

    let contactId: string;
    if (canReuse && existingMatch) {
      contactId = existingMatch.id;
      if (existingMatch.tenantId === null && lead.tenantId !== null) {
        await prisma.contact.update({
          where: { id: existingMatch.id },
          data: { tenantId: lead.tenantId },
        });
      }
    } else {
      const [firstName, ...rest] = lead.name.split(/\s+/);
      const contact = await prisma.contact.create({
        data: {
          firstName: firstName || lead.name,
          lastName: rest.join(" ") || null,
          email: lead.email,
          phone: lead.phone,
          source: lead.source,
          tenantId: lead.tenantId,
          createdById: user.id,
          ownerId: lead.assignedToId ?? user.id,
        },
      });
      contactId = contact.id;
      await logAudit({
        action: "contact.created",
        summary: `Created contact ${lead.name} from lead`,
        contactId,
        leadId,
        user,
        after: contact,
      });
    }

    await prisma.lead.update({ where: { id: leadId }, data: { contactId } });
    await logAuditStrict({
      action: "lead.contact_linked",
      summary: `Linked lead "${lead.title}" to contact`,
      leadId,
      contactId,
      user,
      before: { contactId: lead.contactId },
      after: { contactId },
    });

    revalidatePath("/leads");
    revalidatePath("/contacts");
    revalidatePath(`/leads/${leadId}`);

    return { ok: true, contactId };
  } catch (err: unknown) {
    // Re-throw Next.js redirect errors so they navigate properly
    if (err && typeof err === "object" && "digest" in err) {
      const digest = (err as { digest: unknown }).digest;
      if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("[convertLeadToContact]", message);
    return { ok: false, error: message };
  }
}

export async function deleteLead(leadId: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requireLeadAccess(leadId, "leads.delete");
    const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
    const before = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    const lead = await softDeleteRecord("lead", leadId, reason, user.name);
    // Nothing matched — another tenant's id, or already gone. Never audit a
    // deletion that did not happen.
    if (!lead) refuse("That lead could not be found.");
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
    return { redirectTo: "/leads" };
  });
}
