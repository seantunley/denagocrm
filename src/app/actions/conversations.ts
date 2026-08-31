"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireConversationAccess } from "@/lib/permissions";
import { listActingTenantStaff } from "@/lib/tenantActor";
import { logAudit } from "@/lib/audit";
import { markConversationRead } from "@/lib/conversations";
import { asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { type DraftCollision } from "@/lib/conversationDraft";
import { claimConversationDraft, discardOwnConversationDraft } from "@/lib/conversationDraftStore";
import {
  botIdentityForConversation,
  pauseBotConversation,
  resumeBotConversation,
} from "@/lib/botConversationControl";

/**
 * Shared-inbox collaboration: assignment, staff notes, reply drafts and explicit
 * human/bot ownership. Every mutation is guarded per conversation.
 */

/** Assign a conversation to a member of staff, or clear the assignment. */
export async function assignConversation(
  conversationId: string,
  userId: string | null,
): Promise<ActionResult> {
  return asActionResult(async () => {
    const actor = await requireConversationAccess(conversationId, "inbox.reply");

    let assigneeName: string | null = null;
    if (userId) {
      const staff = await listActingTenantStaff();
      const member = staff.find((person) => person.id === userId);
      if (!member) refuse("That person is not a member of your team.");
      assigneeName = member.name;
    }

    const conversation = await prisma.conversation.update({
      where: { id: conversationId },
      data: { assignedToId: userId, assignedAt: userId ? new Date() : null },
      select: { id: true, assignedToId: true },
    });

    await logAudit({
      action: "conversation.assign",
      summary: assigneeName
        ? `Assigned a conversation to ${assigneeName}`
        : "Removed a conversation's assignment",
      entityType: "Conversation",
      entityId: conversation.id,
      user: actor,
    });
    revalidatePath("/inbox");
    return { success: assigneeName ? `Assigned to ${assigneeName}` : "Assignment cleared" };
  });
}

/**
 * Choose who owns the next inbound turn.
 *
 * `human`: pause the SAME BotSession the runtime checks, preserving its current
 * graph snapshot in case staff later need it for diagnosis. The explicit pause
 * lasts seven days unless staff return the thread to automation sooner.
 *
 * `bot`: clear the paused/stale session. The next customer message deliberately
 * starts a fresh conversation on the current published flow rather than jumping
 * back into a graph step that the human may have superseded while talking.
 */
export async function setConversationBotMode(
  conversationId: string,
  mode: "human" | "bot",
): Promise<ActionResult> {
  return asActionResult(async () => {
    const actor = await requireConversationAccess(conversationId, "inbox.reply");
    const identity = await botIdentityForConversation(conversationId);
    if (!identity) refuse("Automation control is not available for this conversation.");

    if (mode === "human") {
      await pauseBotConversation(identity);
      // Claiming an unassigned handoff also claims its inbox work item. Never
      // overwrite a colleague who was explicitly assigned before the click.
      await prisma.conversation.updateMany({
        where: { id: conversationId, assignedToId: null },
        data: { assignedToId: actor.id, assignedAt: new Date() },
      });
    }
    else await resumeBotConversation(identity);

    await logAudit({
      action: mode === "human" ? "conversation.bot_paused" : "conversation.bot_resumed",
      summary: mode === "human"
        ? "Human took ownership of a customer conversation; chatbot paused"
        : "Conversation returned to chatbot; next inbound starts a fresh published flow",
      entityType: "Conversation",
      entityId: conversationId,
      user: actor,
    });
    revalidatePath("/inbox");
    revalidatePath("/messages");
    return { success: mode === "human" ? "You have taken over — chatbot paused" : "Returned to chatbot" };
  });
}

/** Add a staff-only note. Never sent to the customer. */
export async function addConversationNote(
  conversationId: string,
  body: string,
  mentions: string[] = [],
): Promise<ActionResult> {
  return asActionResult(async () => {
    const actor = await requireConversationAccess(conversationId, "inbox.reply");
    const clean = body.trim();
    if (!clean) refuse("Write something before saving the note.");

    const staff = await listActingTenantStaff();
    const staffIds = new Set(staff.map((person) => person.id));
    const named = [...new Set(mentions)].filter((id) => staffIds.has(id));

    const note = await prisma.conversationNote.create({
      data: { conversationId, authorId: actor.id, body: clean, mentions: named },
      select: { id: true },
    });

    await logAudit({
      action: "conversation.note",
      summary: "Added an internal note to a conversation",
      entityType: "Conversation",
      entityId: conversationId,
      user: actor,
    });
    revalidatePath("/inbox");
    void note;
    return { success: "Note added" };
  });
}

export type DraftSaveResult = ActionResult & { collision?: DraftCollision };

/**
 * Save the in-progress reply, taking ownership.
 * If a colleague is actively drafting, report the collision instead of overwriting.
 */
export async function saveConversationDraft(
  conversationId: string,
  body: string,
): Promise<DraftSaveResult> {
  return asActionResult(async () => {
    const actor = await requireConversationAccess(conversationId, "inbox.reply");
    const claim = await claimConversationDraft(conversationId, actor.id, body);
    if (!claim.ok) {
      return {
        collision: claim.collision,
        error: `${claim.collision.ownerName} is already replying to this conversation.`,
      };
    }
    return {};
  }) as Promise<DraftSaveResult>;
}

/** Discard the signed-in user's own draft. */
export async function discardConversationDraft(conversationId: string): Promise<ActionResult> {
  return asActionResult(async () => {
    const actor = await requireConversationAccess(conversationId, "inbox.reply");
    await discardOwnConversationDraft(conversationId, actor.id);
    return {};
  });
}

/** Clear the unread flag when a staff member opens a thread. */
export async function markConversationReadAction(conversationId: string): Promise<ActionResult> {
  return asActionResult(async () => {
    await requireConversationAccess(conversationId, "inbox.view");
    await markConversationRead(conversationId);
    revalidatePath("/inbox");
    return {};
  });
}
