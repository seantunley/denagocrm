"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireConversationAccess } from "@/lib/permissions";
import { listTenantStaff } from "@/lib/tenantActor";
import { logAudit } from "@/lib/audit";
import { markConversationRead } from "@/lib/conversations";
import { asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { draftCollision, type DraftCollision } from "@/lib/conversationDraft";

/**
 * Shared-inbox collaboration: assignment, staff notes, reply drafts.
 *
 * Rebuilt from PR #17, which never reached main. Two things are deliberately
 * different from the original.
 *
 * EVERY ACTION IS GUARDED PER CONVERSATION. The original checked only that the
 * caller held an inbox permission, then trusted the conversation id it was given
 * — so a user scoped to their own contacts could assign, note or draft on any
 * thread in the business by naming its id. The list query has always been
 * scoped; the actions were not. `requireConversationAccess` is the per-record
 * guard the other entities already had (requireLeadAccess, requireQuoteAccess…)
 * and the inbox did not.
 *
 * REFUSALS ARE VALUES. These return ActionResult so the reason arrives in the
 * browser instead of being digested into a generic failure — see lib/actionResult.
 */

/** Assign a conversation to a member of staff, or clear the assignment. */
export async function assignConversation(
  conversationId: string,
  userId: string | null,
): Promise<ActionResult> {
  return asActionResult(async () => {
    const actor = await requireConversationAccess(conversationId, "inbox.reply");

    // The assignee must be someone in THIS tenant's staff. Without this the id
    // travels straight from the client into assignedToId, which the FK would
    // happily satisfy with any User row in the database — including, once a
    // second tenant exists, one belonging to somebody else.
    let assigneeName: string | null = null;
    if (userId) {
      const staff = await listTenantStaff();
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

/** Add a staff-only note. Never sent to the customer. */
export async function addConversationNote(
  conversationId: string,
  body: string,
  mentions: string[] = [],
): Promise<ActionResult> {
  return asActionResult(async () => {
    const actor = await requireConversationAccess(conversationId, "inbox.reply");
    const clean = body.trim();
    // Refused rather than silently ignored: the original returned early on an
    // empty note, so the form reported a save that never happened.
    if (!clean) refuse("Write something before saving the note.");

    // Only real teammates may be mentioned, so `mentions` cannot be used to
    // probe for user ids or to address a notification outside the tenant.
    const staff = await listTenantStaff();
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
 *
 * If a colleague is actively drafting, reports the collision instead of
 * overwriting, so the UI can warn before two replies go to one customer.
 */
export async function saveConversationDraft(
  conversationId: string,
  body: string,
): Promise<DraftSaveResult> {
  return asActionResult(async () => {
    const actor = await requireConversationAccess(conversationId, "inbox.reply");
    const existing = await prisma.conversationDraft.findUnique({
      where: { conversationId },
      select: { ownerId: true, updatedAt: true, owner: { select: { name: true } } },
    });

    const collision = draftCollision(
      existing ? { ownerId: existing.ownerId, ownerName: existing.owner.name, updatedAt: existing.updatedAt } : null,
      actor.id,
      new Date(),
    );
    if (collision) {
      // NOT a refusal: nothing is wrong with what the user typed, and the caller
      // needs the owner's name to say who is already replying.
      return { collision, error: `${collision.ownerName} is already replying to this conversation.` };
    }

    await prisma.conversationDraft.upsert({
      where: { conversationId },
      create: { conversationId, ownerId: actor.id, body },
      update: { ownerId: actor.id, body },
    });
    return {};
  }) as Promise<DraftSaveResult>;
}

/** Discard the draft — e.g. once the reply has been sent. */
export async function discardConversationDraft(conversationId: string): Promise<ActionResult> {
  return asActionResult(async () => {
    const actor = await requireConversationAccess(conversationId, "inbox.reply");
    // deleteMany scoped to the actor's OWN draft. The send-success path calls this
    // unconditionally, and a plain delete would clobber the teammate's draft that
    // the collision check just went to the trouble of protecting.
    await prisma.conversationDraft.deleteMany({ where: { conversationId, ownerId: actor.id } });
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
