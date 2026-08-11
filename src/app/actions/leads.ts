"use server";

import { asActionResult, ActionRefusal, refuse } from "@/lib/actionResult";
import { revalidatePath } from "next/cache";
import { prisma, basePrisma } from "@/lib/db";
import { parseRands } from "@/lib/format";
import { emitLeadJourneyEvent } from "@/lib/leadJourneyEvents";
import { recordReferral, markReferralEarned } from "@/lib/referrals";
import { logAudit, logAuditStrict, GOVERNANCE_TX } from "@/lib/audit";
import { softDeleteRecord } from "@/lib/trash";
import { createLeadRecord } from "@/lib/leadCreate";
import { triggerSurvey } from "@/lib/surveys";
import { removeTimelinePin } from "@/lib/timelinePins";
import { resolveAssignableUser } from "@/lib/tenantActor";
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
  type PipelineStageRow,
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

/**
 * The word this file uses for an assignee when refusing one. `resolveAssignableUser`
 * builds the sentence from it, so "team member" here is the same noun the pipeline
 * already uses in its own copy ("That team member is no longer available.").
 */
const ASSIGNEE_LABEL = "team member";

async function nextPosition(stageId: string) {
  const max = await prisma.lead.aggregate({
    where: { stageId },
    _max: { position: true },
  });
  return (max._max.position ?? 0) + 1;
}

/**
 * Resolve the posted assignee through tenant membership and hand back the id
 * that may actually be written.
 *
 * The check used to live in `buildTitle`, of all places, as this file's own
 * private copy of the membership rule — a fourth implementation of something
 * that now has one home. Two things changed with it. The rule is the shared
 * contract, so it cannot drift away from the other three; and the caller writes
 * what came BACK rather than what was posted, so the unvalidated value has no
 * route into the update at all. It also no longer hides inside a function whose
 * job is to name the lead.
 */
async function resolveLeadAssignee(assignedToId: string | null): Promise<string | null> {
  const assignee = await resolveAssignableUser(assignedToId, ASSIGNEE_LABEL);
  return assignee?.id ?? null;
}

async function buildTitle(data: {
  name: string;
  productId: string | null;
  color: string | null;
  contactId?: string | null;
}) {
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

/**
 * The stage a move is targeting, or the REASON it cannot be — as a value.
 *
 * Next's guidance for Server Functions is explicit: "avoid using try/catch blocks
 * and throw errors. Instead, model expected errors as return values."
 * (node_modules/next/dist/docs/01-app/01-getting-started/10-error-handling.md,
 * "Handling expected errors"). A stage that has been deleted, or one that is
 * closed, is an expected outcome of dragging a card on a board somebody else may
 * have reconfigured — not an exception.
 *
 * The throwing wrapper below stays for the actions that run inside
 * `asActionResult`, which turns a refusal back into a value at the boundary.
 */
async function resolveOpenStage(stageId: string): Promise<{ stage: PipelineStageRow } | { error: string }> {
  const stage = await getPipelineStage(stageId);
  if (!stage) return { error: "Selected pipeline stage does not exist" };
  if (stage.isClosed) {
    return { error: "Use Mark won or Mark lost instead of creating or dragging into a closed stage" };
  }
  return { stage };
}

async function validateOpenStage(stageId: string) {
  const resolved = await resolveOpenStage(stageId);
  // ActionRefusal, not a bare Error: both messages are written to be READ, and
  // `classifyFailure` shows a refusal verbatim while a bare Error is replaced
  // with the generic "did not complete cleanly" line. saveLead already raises the
  // identical pipeline-permission message this way.
  if ("error" in resolved) throw new ActionRefusal(resolved.error);
  return resolved.stage;
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
    // Permission first (may this caller assign to somebody else at all), then
    // membership (is that somebody a member of THIS workspace) — the same order
    // the file already used, now answered by the shared contract.
    data.assignedToId = await resolveLeadAssignee(data.assignedToId);

    let contactTookNotesFromNewLead = false;
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
      // Reuse whatever the lookup found.
      //
      // This used to reuse ONLY a contact whose tenantId was null — a workaround
      // for the composite AuditLog foreign key, since auditing against a
      // stamped contact under a mismatched tenant failed. The comment said "or
      // whose tenantId already matches" but the code never checked that, so
      // every one of the existing (backfilled, stamped) contacts was skipped:
      // creating a lead for a customer already on file silently made a SECOND
      // contact for them.
      //
      // The audit now takes its tenant from the record it describes, so the
      // mismatch cannot arise and the workaround is not needed. Cross-tenant
      // reuse is not a risk here either: the lookup runs on the scoped client,
      // which under enforcement cannot see another tenant's contacts.
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
            // Whatever was typed in the lead's notes follows the customer onto
            // their contact record. Omitting it dropped it silently: the note was
            // captured on a form the person filled in, and then existed nowhere.
            notes: data.notes,
            createdById: user.id,
            ownerId: data.assignedToId ?? user.id,
          },
        });
        data.contactId = contact.id;
        // The lead does not exist yet — its id is stamped onto the contact once
        // createLeadRecord returns, below. Tracked in a local rather than
        // re-derived later, so the two cannot disagree about whether a note was
        // actually copied.
        contactTookNotesFromNewLead = Boolean(data.notes?.trim());
        await logAudit({
          action: "contact.created",
          summary: `Created contact ${data.name} (with new lead)`,
          contactId: contact.id,
          user,
          after: { firstName: contact.firstName, lastName: contact.lastName, email: contact.email, phone: contact.phone },
        });
      }
    }

    // Through the one lead creator (src/lib/leadCreate.ts) — the row, the audit
    // entry and the `lead_created` automations. This path was the COMPLETE one;
    // the inbound channels each had their own partial copy of it, which is how a
    // WhatsApp/DM/bot lead came to run no automations at all.
    const lead = await createLeadRecord({
      ...data,
      title,
      createdById: user.id,
      audit: {
        action: "lead.created",
        summary: `Created lead “${title}”`,
        // Governance path: an unwritable trail fails the create here, unlike the
        // best-effort audit an inbound webhook gets.
        strict: true,
        recordAfter: true,
        user,
      },
      // No push. The only person a "New lead" notification could tell is the one
      // who just typed it in; the inbound channels get it because nobody is
      // watching the door.
      push: null,
    });

    // Now the lead has an id, record that the contact's note came from it. Not a
    // second source of truth: the timeline reads THIS, and never compares text.
    if (contactTookNotesFromNewLead && data.contactId) {
      await prisma.contact.update({
        where: { id: data.contactId },
        data: { notesFromLeadId: lead.id },
      });
    }
    const refCode = String(formData.get("referralCode") ?? "").trim();
    if (refCode) await recordReferral(refCode, lead.id).catch(() => {});
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
    // An edit is the easier of the two attacks: the lead already exists, so a
    // single forged field on an otherwise ordinary save was all it took. The
    // spread below writes `data`, so the resolved id has to land back on it.
    data.assignedToId = await resolveLeadAssignee(data.assignedToId);
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

/**
 * Move a lead to another stage, reporting a refusal AS A VALUE.
 *
 * This threw. Every other action the Kanban calls — `moveLeadToTestDrive`,
 * `assignLead`, `convertLeadToContact` — already returns `{ ok, error }`, and the
 * board reads `result.error`; `moveLead` was the only one out of step, and the
 * optimistic-move rollback added on this branch is the first code that tries to
 * SHOW what it produced. Next's own guidance is the same
 * (`node_modules/next/dist/docs/01-app/01-getting-started/10-error-handling.md`:
 * expected errors are return values, not throws), and a permission refusal is the
 * textbook expected error. A thrown message is also liable to reach the browser
 * as an opaque digest in a production build, which would make the rollback toast
 * read out a hash — but the convention and the inconsistency settle it on their
 * own.
 */
export async function moveLead(leadId: string, stageId: string): Promise<{ ok: boolean; error?: string }> {
  const user = await requireLeadAccess(leadId, "leads.change_stage");
  const before = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
  const currentScope = await getLeadPipeline(leadId);
  const resolved = await resolveOpenStage(stageId);
  if ("error" in resolved) return { ok: false, error: resolved.error };
  const targetStage = resolved.stage;
  if (currentScope && currentScope.pipelineId !== targetStage.pipelineId && !(await hasPermission(user, "leads.change_pipeline"))) {
    return { ok: false, error: "You do not have permission to move leads between pipelines" };
  }
  if (targetStage.entryAction === "book_test_drive") {
    return { ok: false, error: "This stage requires test-drive booking details" };
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
  return { ok: true };
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
  // Same convention as everything else this function returns: a deleted or closed
  // target stage is an expected outcome, and it reached the board as a generic
  // "Something went wrong" only because it was thrown from here.
  const resolved = await resolveOpenStage(stageId);
  if ("error" in resolved) return { ok: false, error: resolved.error };
  const targetStage = resolved.stage;
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
  // Same shared contract as everywhere else, but this call site RETURNS its
  // refusal rather than throwing it, and that difference is deliberate: the
  // kanban board assigns by drag, catches the result and shows `error` in a
  // toast, so a throw here would surface as "Something went wrong" instead of
  // the reason. The catch keeps that shape — and keeps the exact sentence the
  // board has always shown — while the membership question itself is no longer
  // answered by a private copy of the rule.
  const assignee = await resolveAssignableUser(assignedToId, ASSIGNEE_LABEL).catch(() => null);
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
          // Carried, for the same reason as createLead: winning a lead must not
          // be the moment its notes disappear. notesFromLeadId records WHERE the
          // copy came from, so the timeline can show one entry instead of two
          // without comparing sentences — see lib/timelineNotes.ts.
          notes: before.notes,
          notesFromLeadId: before.notes?.trim() ? before.id : null,
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
          // Converting is explicitly "this lead is now a customer". Losing the
          // notes at that point loses the reason the customer exists.
          notes: lead.notes,
          notesFromLeadId: lead.notes?.trim() ? lead.id : null,
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
    // The delete and the audit that records it commit together. Separately, a
    // failing audit left the lead deleted while telling the operator it had not
    // been — and the retry then reported "not found", which is what happened in
    // production on 2026-08-07.
    const lead = await basePrisma.$transaction(async (tx) => {
      const deleted = await softDeleteRecord("lead", leadId, reason, user.name, tx);
      // Nothing matched — another tenant's id, or already gone. Never audit a
      // deletion that did not happen.
      if (!deleted) return null;
      await logAuditStrict({
        action: "trash.deleted",
        summary: `Moved lead “${deleted.title}” to trash — ${reason}`,
        leadId,
        contactId: deleted.contactId,
        user,
        before,
        after: { deletedAt: deleted.deletedAt, deleteReason: reason },
      }, tx);
      return deleted;
    }, GOVERNANCE_TX);
    if (!lead) refuse("That lead could not be found.");
    revalidatePath("/leads");
    revalidatePath("/forecast");
    return { redirectTo: "/leads" };
  });
}
