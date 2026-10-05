"use server";

import { requireAnyPermission } from "@/lib/permissions";
import { withActingStaffScope } from "@/lib/actingScope";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { assistantTurnsToday } from "@/lib/crmAssistant";
import { getSetting } from "@/lib/settings";
import { isCodexConnected } from "@/lib/codex";
import { ASSISTANT_PROFILE_KEY, parseProfile } from "@/lib/assistantSoul";
import type { ActionCard } from "@/lib/assistantActions";
import { prisma } from "@/lib/db";
import { scheduleFollowUp } from "@/app/actions/activities";
import { addCommunication } from "@/app/actions/communications";
import { assignLead, moveLead } from "@/app/actions/leads";
import { ASSISTANT_PERMISSIONS } from "@/lib/assistantUser";

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
    await requireAnyPermission(...ASSISTANT_PERMISSIONS);
    if (!(await isModuleEnabled("automation"))) {
      return { ok: false, error: "Ask the CRM is part of the Automation & AI module, which is off for this workspace." };
    }
    switch (card?.kind) {
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

/** What the floating bubble needs when it opens: its name, and TODAY's conversation only. */
export async function openAssistantBubble(): Promise<
  { ok: true; name: string; connected: boolean; history: { question: string; answer: string }[] } | { ok: false }
> {
  return withActingStaffScope(async () => {
    const user = await requireAnyPermission(...ASSISTANT_PERMISSIONS);
    if (!(await isModuleEnabled("automation"))) return { ok: false };
    const [profile, connected, history] = await Promise.all([
      getSetting(ASSISTANT_PROFILE_KEY).then(parseProfile),
      isCodexConnected(),
      assistantTurnsToday(user.id),
    ]);
    return { ok: true, name: profile.name, connected, history };
  });
}
