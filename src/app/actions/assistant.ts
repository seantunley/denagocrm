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
import { ASK_LIMIT_MESSAGE, ASSISTANT_PERMISSIONS, assistantAskAllowed, assistantImageAllowed } from "@/lib/assistantUser";
import { MAX_IMAGE_BYTES, cleanJpeg, jpegDataUrl } from "@/lib/assistantImage";

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

/**
 * One question in, one answer out. Read-only: nothing here writes a record.
 * `attachment` may carry one image ("image"): checked and cleaned here
 * (assistantImage — JPEG only, metadata stripped, size-capped), read for this
 * question only, and never stored.
 */
export async function askCrmAction(question: string, page?: string, attachment?: FormData): Promise<AssistantResult> {
  return withActingStaffScope(async () => {
    const user = await requireAnyPermission(...ASSISTANT_PERMISSIONS);
    // The page hides it with the module off; the action must refuse on its own.
    if (!(await isModuleEnabled("automation"))) {
      return { ok: false, error: "Ask the CRM is part of the Automation & AI module, which is off for this workspace." };
    }
    const file = attachment instanceof FormData ? attachment.get("image") : null;
    const hasImage = file instanceof File && file.size > 0;
    const q = String(question ?? "").trim().slice(0, 500) || (hasImage ? "What's in this image, and what should I do with it?" : "");
    if (!q) return { ok: false, error: "Type a question first." };
    if (!(await assistantAskAllowed(user.id))) return { ok: false, error: ASK_LIMIT_MESSAGE };
    let images: string[] = [];
    if (hasImage) {
      if (!(await assistantImageAllowed(user.id))) return { ok: false, error: "That's a lot of images this hour — give it a while and try again." };
      if (file.size > MAX_IMAGE_BYTES || file.type !== "image/jpeg") {
        return { ok: false, error: "That image couldn't be used — try a photo or screenshot again." };
      }
      const cleaned = cleanJpeg(new Uint8Array(await file.arrayBuffer()));
      if (!cleaned) return { ok: false, error: "That image couldn't be read — try a photo or screenshot again." };
      images = [jpegDataUrl(cleaned)];
    }
    // `page` is only a hint ("this lead"); pageHint reads a record id out of it
    // and the tools re-check access, so a forged path finds nothing new.
    return askCrm(user, q, typeof page === "string" ? page.slice(0, 200) : null, { images });
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
