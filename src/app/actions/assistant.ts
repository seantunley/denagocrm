"use server";

import { requireAnyPermission } from "@/lib/permissions";
import { withActingStaffScope } from "@/lib/actingScope";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { assistantTurnsToday } from "@/lib/crmAssistant";
import { getSetting } from "@/lib/settings";
import { isCodexConnected } from "@/lib/codex";
import { ASSISTANT_PROFILE_KEY, parseProfile } from "@/lib/assistantSoul";
import { STALE_CARD, type ActionCard } from "@/lib/assistantActions";
import { prisma } from "@/lib/db";
import { cancelActivity, rescheduleActivity, scheduleActivity, scheduleFollowUp } from "@/app/actions/activities";
import { addCommunication } from "@/app/actions/communications";
import { assignLead, markLost, moveLead } from "@/app/actions/leads";
import { createQuoteFromLead } from "@/app/actions/quotes";
import { createTestDriveBooking } from "@/app/actions/testDrives";
import { sendWhatsAppMessage } from "@/app/actions/whatsapp";
import { sendEmailAction } from "@/app/actions/emails";
import { canAccessLead } from "@/lib/permissions";
import { createWatchForUser } from "@/lib/assistantWatch";
import { assistantVoiceRepliesOn } from "@/lib/assistantVoice";
import { ASSISTANT_PERMISSIONS } from "@/lib/assistantUser";
import { MAX_ACTIVE_SCHEDULES, describeSchedule, nextRun, scheduleInput } from "@/lib/assistantSchedule";
import { markScheduledTurnsSeen, withScheduleSlot } from "@/lib/assistantScheduleRun";
import { ownedWriteTenantId } from "@/lib/tenantWrite";
import { logAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";

/**
 * Run a task the assistant proposed, AFTER the person pressed Confirm on it.
 *
 * Deliberately thin: each kind hands straight to the action a person would use
 * by hand — scheduleFollowUp, addCommunication, assignLead, moveLead — so that
 * action's own permission check, lead-access check, stage gates and audit entry
 * all apply unchanged. The card came from the browser, so nothing in it is
 * trusted beyond what those actions re-check. A draft message is never sent
 * from here: the person copies it into the conversation and sends it there.
 */
export async function runAssistantAction(card: ActionCard): Promise<{ ok: boolean; error?: string; success?: string; href?: string }> {
  return withActingStaffScope(async () => {
    const user = await requireAnyPermission(...ASSISTANT_PERMISSIONS);
    if (!(await isModuleEnabled("automation"))) {
      return { ok: false, error: "Ask the CRM is part of the Automation & AI module, which is off for this workspace." };
    }
    // The action it hands to writes its own audit entry; this one records that
    // the change came from the assistant's proposal, on the lead's timeline.
    const confirmed = (what: string, leadId: string) =>
      logAudit({ action: "assistant.action_confirmed", summary: `Confirmed the assistant's proposal: ${what}`, user, leadId });
    switch (card?.kind) {
      case "schedule": {
        // Saved for the SIGNED-IN person, always: nothing on the card says who
        // it is for, and the run re-checks them (assistantUserFor) every time.
        // The timing is re-validated and nextRunAt worked out here, not taken
        // from the browser.
        const parsed = scheduleInput.safeParse({
          question: card.question, cadence: card.cadence, weekday: card.weekday, timeOfDay: card.timeOfDay, onDate: card.onDate,
        });
        if (!parsed.success) return { ok: false, error: "That schedule isn't valid — ask again." };
        const nextRunAt = nextRun(parsed.data, new Date());
        if (!nextRunAt) return { ok: false, error: "That time has already passed — ask again with a new one." };
        const tenantId = ownedWriteTenantId();
        const saved = await withScheduleSlot(user.id, (tx) =>
          tx.assistantSchedule.create({
            data: { tenantId, userId: user.id, ...parsed.data, weekday: parsed.data.weekday ?? null, onDate: parsed.data.onDate ?? null, nextRunAt },
            select: { id: true },
          }),
        );
        if (!saved) {
          return { ok: false, error: `You already have ${MAX_ACTIVE_SCHEDULES} scheduled questions — pause or delete one on the Ask page first.` };
        }
        const when = describeSchedule(parsed.data);
        // The timing in the trail, not the question: it may name a customer.
        await logAudit({ action: "assistant.schedule_created", summary: `Scheduled a question for the assistant (${when})`, user, entityType: "AssistantSchedule", entityId: saved.id });
        revalidatePath("/assistant");
        return { ok: true, success: `Scheduled: ${when}. Manage it on the Ask page.` };
      }
      case "watch": {
        // For the SIGNED-IN person, always; it validates, checks they can open
        // the lead or quote, enforces their cap and audits (assistantWatch).
        const saved = await createWatchForUser(user, card.watch);
        if (!saved.ok) return { ok: false, error: saved.error };
        revalidatePath("/assistant");
        return { ok: true, success: "Watching — it only ever tells you. Manage it on the Ask page." };
      }
      case "follow_up": {
        const lead = await prisma.lead.findUnique({ where: { id: card.leadId }, select: { contactId: true } });
        if (!lead) return { ok: false, error: "That lead is no longer there." };
        const result = await scheduleFollowUp({
          leadId: card.leadId,
          contactId: lead.contactId,
          type: card.activity,
          when: card.when,
          summary: card.summary,
        });
        if (!result.ok) return { ok: false, error: result.error ?? "Couldn't schedule it." };
        await confirmed(`schedule a ${card.activity}`, card.leadId);
        return { ok: true, success: "Follow-up scheduled" };
      }
      case "note": {
        const form = new FormData();
        form.set("leadId", card.leadId);
        form.set("body", card.text);
        form.set("type", "note");
        form.set("revalidate", `/leads/${card.leadId}`);
        const result = await addCommunication(form);
        if (result?.error) return { ok: false, error: result.error };
        await confirmed("add a note", card.leadId);
        return { ok: true, success: "Note added" };
      }
      case "assign": {
        if (!(await stillAsProposed(card))) return { ok: false, error: STALE_CARD };
        const result = await assignLead(card.leadId, card.userId);
        if (!result.ok) return { ok: false, error: result.error };
        await confirmed(`give the lead to ${result.assignee.name}`, card.leadId);
        return { ok: true, success: `Given to ${result.assignee.name}` };
      }
      case "stage": {
        if (!(await stillAsProposed(card))) return { ok: false, error: STALE_CARD };
        const result = await moveLead(card.leadId, card.stageId);
        if (!result.ok) return { ok: false, error: result.error ?? "That move isn't allowed yet." };
        await confirmed("move the lead to another stage", card.leadId);
        return { ok: true, success: "Lead moved" };
      }
      case "meeting": {
        const lead = await prisma.lead.findUnique({ where: { id: card.leadId }, select: { contactId: true } });
        if (!lead) return { ok: false, error: "That lead is no longer there." };
        const form = new FormData();
        form.set("type", "meeting");
        form.set("summary", card.summary);
        form.set("leadId", card.leadId);
        if (lead.contactId) form.set("contactId", lead.contactId);
        form.set("dueDate", card.start);
        form.set("endDate", card.end);
        for (const id of card.attendeeIds) form.append("attendeeIds", id);
        const result = await scheduleActivity(form);
        if (result.error) return { ok: false, error: result.error };
        await confirmed("book a meeting", card.leadId);
        return { ok: true, success: "Meeting booked" };
      }
      case "test_drive": {
        const form = new FormData();
        form.set("contactId", card.contactId);
        form.set("leadId", card.leadId);
        form.set("demoVehicleId", card.demoVehicleId);
        form.set("branch", card.branch);
        form.set("scheduledStart", card.start);
        form.set("expectedReturnAt", card.end);
        const result = await createTestDriveBooking(form);
        if (result.error) return { ok: false, error: result.error };
        await confirmed("book a test drive", card.leadId);
        return { ok: true, success: result.success ?? "Test drive booked" };
      }
      case "reschedule": {
        if (!(await stillAsProposed(card))) return { ok: false, error: STALE_CARD };
        const result = await rescheduleActivity(card.activityId, card.when);
        if (!result.ok) return { ok: false, error: result.error ?? "Couldn't move it." };
        if (card.leadId) await confirmed("reschedule an activity", card.leadId);
        return { ok: true, success: "Moved" };
      }
      case "cancel_activity": {
        if (!(await stillAsProposed(card))) return { ok: false, error: STALE_CARD };
        const result = await cancelActivity(card.activityId, "/assistant");
        if (result.error) return { ok: false, error: result.error };
        if (card.leadId) await confirmed("cancel an activity", card.leadId);
        return { ok: true, success: "Cancelled" };
      }
      case "lost": {
        if (!(await stillAsProposed(card))) return { ok: false, error: STALE_CARD };
        const form = new FormData();
        form.set("lostReason", card.reason);
        const result = await markLost(card.leadId, form);
        if (result.error) return { ok: false, error: result.error };
        await confirmed("mark the deal lost", card.leadId);
        return { ok: true, success: "Marked lost" };
      }
      case "quote": {
        const result = await createQuoteFromLead(card.leadId);
        if (result.error) return { ok: false, error: result.error };
        await confirmed("start a quote", card.leadId);
        return { ok: true, success: "Draft quote started", href: result.redirectTo };
      }
      default:
        return { ok: false, error: "Messages go out only with the Send button on their card." };
    }
  });
}

/**
 * Send a message DAX drafted — ONLY from the Send button on its card, after the
 * person has read it and, if they liked, changed it. The body is the person's
 * own (edited) text from the card, and it goes through the same action as the
 * lead's own message box: sendWhatsAppMessage (inbox.reply, the outbox, the
 * delivery log) or sendEmailAction (the workspace's mailbox, the signature,
 * the timeline). The recipient is read again here from the lead — never taken
 * from the browser — so an edited card can't redirect it.
 */
export async function sendAssistantDraft(input: { leadId: string; channel: "whatsapp" | "email"; subject?: string; body: string; compositionId: string }): Promise<{ ok: boolean; error?: string; success?: string }> {
  return withActingStaffScope(async () => {
    const user = await requireAnyPermission(...ASSISTANT_PERMISSIONS);
    if (!(await isModuleEnabled("automation"))) {
      return { ok: false, error: "Ask the CRM is part of the Automation & AI module, which is off for this workspace." };
    }
    const body = String(input?.body ?? "").trim().slice(0, 4000);
    if (!body) return { ok: false, error: "The message is empty." };
    if (!(await canAccessLead(user, String(input.leadId)))) return { ok: false, error: "That lead is no longer yours to message." };
    const lead = await prisma.lead.findUnique({
      where: { id: input.leadId },
      select: { email: true, phone: true, contactId: true, contact: { select: { email: true, phone: true } } },
    });
    if (!lead) return { ok: false, error: "That lead is no longer there." };
    const form = new FormData();
    form.set("leadId", input.leadId);
    if (lead.contactId) form.set("contactId", lead.contactId);
    let result: { ok?: string; error?: string };
    if (input.channel === "whatsapp") {
      const phone = lead.phone || lead.contact?.phone;
      if (!phone) return { ok: false, error: "There's no WhatsApp number on this lead or its customer." };
      form.set("phone", phone);
      form.set("text", body);
      form.set("compositionId", String(input.compositionId ?? "").slice(0, 80));
      result = await sendWhatsAppMessage(undefined, form);
    } else {
      const to = lead.email || lead.contact?.email;
      if (!to) return { ok: false, error: "There's no email address on this lead or its customer." };
      const subject = String(input.subject ?? "").trim().slice(0, 150);
      if (!subject) return { ok: false, error: "Add a subject first." };
      form.set("to", to);
      form.set("subject", subject);
      form.set("bodyHtml", body.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join(""));
      form.set("revalidate", `/leads/${input.leadId}`);
      result = await sendEmailAction(undefined, form);
    }
    if (result.error) return { ok: false, error: result.error };
    await logAudit({
      action: "assistant.draft_sent",
      summary: `Sent a ${input.channel === "whatsapp" ? "WhatsApp" : "email"} the assistant drafted, after reviewing it`,
      user,
      leadId: input.leadId,
    });
    return { ok: true, success: result.ok ?? "Sent" };
  });
}

/**
 * Is the record still as it was when DAX proposed the card? Only the field the
 * card changes (assistantActions STALE CARDS). Read through the tenant-scoped
 * client; the action that runs next checks access again in full.
 */
async function stillAsProposed(card: ActionCard): Promise<boolean> {
  switch (card.kind) {
    case "stage":
    case "assign":
    case "lost": {
      const lead = await prisma.lead.findUnique({ where: { id: card.leadId }, select: { stageId: true, assignedToId: true, status: true } });
      if (!lead || lead.status !== "open") return false;
      if (card.kind === "stage") return lead.stageId === card.fromStageId;
      if (card.kind === "assign") return lead.assignedToId === card.fromUserId;
      return true;
    }
    case "reschedule":
    case "cancel_activity": {
      const activity = await prisma.activity.findUnique({ where: { id: card.activityId }, select: { status: true, dueDate: true } });
      return Boolean(activity && activity.status === "planned" && activity.dueDate.toISOString() === card.fromDue);
    }
    default:
      return true;
  }
}

const escapeHtml =(s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * 👍 / 👎 on one of the person's OWN answers, with a reason when it was wrong —
 * kept on the turn for the owner to read (Settings → Assistant), never sent
 * anywhere. Their own turns only: the update names the user.
 */
const FEEDBACK_REASONS = ["wrong_facts", "bad_advice", "misunderstood", "other"] as const;
export async function rateAssistantAnswer(turnId: string, rating: "up" | "down", reason?: string): Promise<{ ok: boolean }> {
  return withActingStaffScope(async () => {
    const user = await requireAnyPermission(...ASSISTANT_PERMISSIONS);
    if (rating !== "up" && rating !== "down") return { ok: false };
    const why = rating === "down" && FEEDBACK_REASONS.includes(reason as (typeof FEEDBACK_REASONS)[number]) ? reason! : null;
    const updated = await prisma.assistantTurn.updateMany({
      where: { id: String(turnId), userId: user.id },
      data: { feedback: rating, feedbackReason: why, feedbackAt: new Date() },
    });
    return { ok: updated.count === 1 };
  });
}

/**
 * What the floating bubble needs when it opens: its name, and TODAY's
 * conversation only. Opening it is seeing it: this person's scheduled answers
 * are marked seen, so the unread dot goes on the next page.
 */
export async function openAssistantBubble(): Promise<
  { ok: true; name: string; connected: boolean; listen: boolean; history: { question: string; answer: string; source: string }[] } | { ok: false }
> {
  return withActingStaffScope(async () => {
    const user = await requireAnyPermission(...ASSISTANT_PERMISSIONS);
    if (!(await isModuleEnabled("automation"))) return { ok: false };
    const [profile, connected, history, , listen] = await Promise.all([
      getSetting(ASSISTANT_PROFILE_KEY).then(parseProfile),
      isCodexConnected(),
      assistantTurnsToday(user.id),
      markScheduledTurnsSeen(user.id),
      assistantVoiceRepliesOn().catch(() => false),
    ]);
    return { ok: true, name: profile.name, connected, listen, history };
  });
}
