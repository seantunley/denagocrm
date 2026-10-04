"use server";

import { requireAnyPermission } from "@/lib/permissions";
import { withActingStaffScope } from "@/lib/actingScope";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { askCrm, assistantTurnsToday, type AssistantResult } from "@/lib/crmAssistant";
import { getSetting } from "@/lib/settings";
import { isCodexConnected } from "@/lib/codex";
import { ASSISTANT_PROFILE_KEY, parseProfile } from "@/lib/assistantSoul";
import type { ActionCard } from "@/lib/assistantActions";
import { prisma } from "@/lib/db";
import { scheduleFollowUp } from "@/app/actions/activities";
import { addCommunication } from "@/app/actions/communications";
import { assignLead, moveLead } from "@/app/actions/leads";
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
export async function runAssistantAction(card: ActionCard): Promise<{ ok: boolean; error?: string; success?: string }> {
  return withActingStaffScope(async () => {
    const user = await requireAnyPermission(...ASSISTANT_PERMISSIONS);
    if (!(await isModuleEnabled("automation"))) {
      return { ok: false, error: "Ask the CRM is part of the Automation & AI module, which is off for this workspace." };
    }
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
        return result.ok ? { ok: true, success: "Follow-up scheduled" } : { ok: false, error: result.error ?? "Couldn't schedule it." };
      }
      case "note": {
        const form = new FormData();
        form.set("leadId", card.leadId);
        form.set("body", card.text);
        form.set("type", "note");
        form.set("revalidate", `/leads/${card.leadId}`);
        const result = await addCommunication(form);
        return result?.error ? { ok: false, error: result.error } : { ok: true, success: "Note added" };
      }
      case "assign": {
        const result = await assignLead(card.leadId, card.userId);
        return result.ok ? { ok: true, success: `Given to ${result.assignee.name}` } : { ok: false, error: result.error };
      }
      case "stage": {
        const result = await moveLead(card.leadId, card.stageId);
        return result.ok ? { ok: true, success: "Lead moved" } : { ok: false, error: result.error ?? "That move isn't allowed yet." };
      }
      default:
        return { ok: false, error: "Drafts are copied and sent by you — nothing is sent from here." };
    }
  });
}

/** One question in, one answer out. Read-only: nothing here writes a record. */
export async function askCrmAction(question: string, page?: string): Promise<AssistantResult> {
  return withActingStaffScope(async () => {
    const user = await requireAnyPermission(...ASSISTANT_PERMISSIONS);
    // The page hides it with the module off; the action must refuse on its own.
    if (!(await isModuleEnabled("automation"))) {
      return { ok: false, error: "Ask the CRM is part of the Automation & AI module, which is off for this workspace." };
    }
    const q = String(question ?? "").trim().slice(0, 500);
    if (!q) return { ok: false, error: "Type a question first." };
    // `page` is only a hint ("this lead"); pageHint reads a record id out of it
    // and the tools re-check access, so a forged path finds nothing new.
    return askCrm(user, q, typeof page === "string" ? page.slice(0, 200) : null);
  });
}

/**
 * What the floating bubble needs when it opens: its name, and TODAY's
 * conversation only. Opening it is seeing it: this person's scheduled answers
 * are marked seen, so the unread dot goes on the next page.
 */
export async function openAssistantBubble(): Promise<
  { ok: true; name: string; connected: boolean; history: { question: string; answer: string; source: string }[] } | { ok: false }
> {
  return withActingStaffScope(async () => {
    const user = await requireAnyPermission(...ASSISTANT_PERMISSIONS);
    if (!(await isModuleEnabled("automation"))) return { ok: false };
    const [profile, connected, history] = await Promise.all([
      getSetting(ASSISTANT_PROFILE_KEY).then(parseProfile),
      isCodexConnected(),
      assistantTurnsToday(user.id),
      markScheduledTurnsSeen(user.id),
    ]);
    return { ok: true, name: profile.name, connected, history };
  });
}
