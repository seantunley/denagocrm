"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireInbox } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { markConversationRead } from "@/lib/conversations";

/** A staff member actively drafting elsewhere blocks an overwrite for this long. */
const COLLISION_WINDOW_MS = 5 * 60 * 1000;

export type DraftResult =
  | { ok: true }
  | { collision: { ownerName: string; updatedAt: string } };

/** Assign a conversation to a staff member (or unassign with null). */
export async function assignConversation(conversationId: string, userId: string | null): Promise<void> {
  const actor = await requireInbox();
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { assignedToId: userId, assignedAt: userId ? new Date() : null },
  });
  await logAudit({
    action: "conversation.assign",
    summary: userId ? "Assigned a conversation" : "Unassigned a conversation",
    user: actor,
  });
  revalidatePath("/inbox");
}

/**
 * Save the in-progress reply draft, taking ownership. If another staff member is
 * actively drafting (a recent draft with a different owner), returns a collision
 * instead of overwriting so the UI can warn.
 */
export async function saveConversationDraft(conversationId: string, body: string): Promise<DraftResult> {
  const actor = await requireInbox();
  const existing = await prisma.conversationDraft.findUnique({
    where: { conversationId },
    include: { owner: { select: { name: true } } },
  });
  if (
    existing &&
    existing.ownerId !== actor.id &&
    Date.now() - existing.updatedAt.getTime() < COLLISION_WINDOW_MS
  ) {
    return { collision: { ownerName: existing.owner.name, updatedAt: existing.updatedAt.toISOString() } };
  }
  await prisma.conversationDraft.upsert({
    where: { conversationId },
    create: { conversationId, ownerId: actor.id, body },
    update: { ownerId: actor.id, body },
  });
  return { ok: true };
}

/** Discard the draft (e.g. after the reply is sent). */
export async function discardConversationDraft(conversationId: string): Promise<void> {
  await requireInbox();
  await prisma.conversationDraft.deleteMany({ where: { conversationId } });
}

/**
 * Add a staff-only note to a conversation (never sent to the customer), with
 * @mentions stored for later notification/filtering.
 */
export async function addConversationNote(
  conversationId: string,
  body: string,
  mentions: string[] = []
): Promise<void> {
  const actor = await requireInbox();
  const clean = body.trim();
  if (!clean) return;
  await prisma.conversationNote.create({
    data: { conversationId, authorId: actor.id, body: clean, mentions: [...new Set(mentions)] },
  });
  await logAudit({ action: "conversation.note", summary: "Added an internal note", user: actor });
  revalidatePath("/inbox");
}

/** Mark a conversation read (clears the unread flag when staff open it). */
export async function markConversationReadAction(conversationId: string): Promise<void> {
  await requireInbox();
  await markConversationRead(conversationId);
  revalidatePath("/inbox");
}
