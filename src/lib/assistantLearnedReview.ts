import "server-only";
import { basePrisma } from "./db";
import { logAudit } from "./audit";
import { getWorkspaceSetting, putWorkspaceSetting } from "./settings";
import {
  REVIEW_IN_BRIEF,
  idsFor,
  parseReviewReply,
  readOffer,
  reviewOfferKey,
  reviewSection,
  type LearnedItem,
} from "./assistantLearnedReviewRules";

/*
 * What DAX learned, put in front of the owner where they already are (Sean, 2026-11-20): the morning brief on WhatsApp,
 * answered with "keep 1" / "drop all", and the chat that learned it. The same decisions as Settings → Assistant's
 * Approve and Remove (app/actions/assistantNotes.ts): owner only, under the same lock as learning, audited.
 * A held CONFLICT is not offered here — choosing which of two to keep needs both side by side, in Settings.
 */

type Person = { id: string; name?: string | null; role?: string | null };

/** The workspace owner, as isTenantOwner decides it — by role or the Tenant row — without a session (cron, WhatsApp). */
export async function ownsWorkspace(tenantId: string, user: Person): Promise<boolean> {
  if (user.role === "owner") return true;
  const tenant = await basePrisma.tenant.findUnique({ where: { id: tenantId }, select: { ownerUserId: true } });
  return tenant?.ownerUserId != null && tenant.ownerUserId === user.id;
}

const SELECT = { id: true, kind: true, name: true, description: true, content: true } as const;

/**
 * The morning brief's "To review" section for the owner, oldest first, and the offer it makes saved so a reply's
 * numbers mean these entries. "" for anyone else, or when nothing waits.
 */
export async function briefReviewSection(tenantId: string, user: Person): Promise<string> {
  if (!(await ownsWorkspace(tenantId, user))) return "";
  const where = { tenantId, status: "unreviewed" };
  const [items, total] = await Promise.all([
    basePrisma.assistantNote.findMany({ where, orderBy: { createdAt: "asc" }, take: REVIEW_IN_BRIEF, select: SELECT }),
    basePrisma.assistantNote.count({ where }),
  ]);
  if (!items.length) return "";
  await putWorkspaceSetting(tenantId, reviewOfferKey(user.id), JSON.stringify({ ids: items.map((i) => i.id), at: new Date().toISOString() }));
  return reviewSection(items, total);
}

/**
 * A WhatsApp message that is exactly a reply to the brief's list ("keep 1", "drop 2 and 3", "keep all") → what was done,
 * to send back. Null when it isn't one (or there is no recent list to reply to): then it is a question for DAX.
 */
export async function answerReviewReply(tenantId: string, user: Person, text: string): Promise<string | null> {
  const reply = parseReviewReply(text);
  if (!reply) return null;
  const offer = readOffer(await getWorkspaceSetting(tenantId, reviewOfferKey(user.id)), new Date());
  if (!offer) return null;
  if (!(await ownsWorkspace(tenantId, user))) return "Only the workspace owner can keep or drop what DAX learned.";
  const { ids, unknown } = idsFor(reply, offer);
  const done = await decide(tenantId, user, ids, reply.verdict);
  const left = await basePrisma.assistantNote.count({ where: { tenantId, status: "unreviewed" } });
  return [
    done.length
      ? `${reply.verdict === "keep" ? "Kept — everyone's DAX uses it now" : "Dropped"}: ${done.length === 1 ? "1 thing" : `${done.length} things`}.`
      : "Nothing changed — those were already reviewed or are gone.",
    unknown.length ? `There was no number ${unknown.join(", ")} in the list.` : "",
    left ? `${left} still to review in Settings → Assistant.` : "Nothing left to review.",
  ].filter(Boolean).join(" ");
}

/**
 * Keep (approve) or drop (remove) these entries — only those still unreviewed in this workspace, under the learning
 * lock so a conversation learning at the same moment plans against the result. Returns the ones it changed.
 */
export async function decide(tenantId: string, user: Person, ids: string[], verdict: "keep" | "drop"): Promise<LearnedItem[]> {
  if (!ids.length) return [];
  const changed = await basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`assistant-notes:${tenantId}`})::bigint)`;
    const notes = await tx.assistantNote.findMany({ where: { tenantId, id: { in: ids }, status: "unreviewed" }, select: SELECT });
    if (!notes.length) return [];
    const where = { tenantId, id: { in: notes.map((n) => n.id) }, status: "unreviewed" };
    if (verdict === "drop") {
      await tx.assistantNote.deleteMany({ where });
    } else {
      const now = new Date();
      // As Approve in Settings: a fact's "why it was flagged" goes; a playbook keeps its description.
      await tx.assistantNote.updateMany({ where: { ...where, kind: "playbook" }, data: { status: "approved", conflictsWithId: null, reviewedById: user.id, reviewedAt: now, lastConfirmedAt: now } });
      await tx.assistantNote.updateMany({ where: { ...where, kind: { not: "playbook" } }, data: { status: "approved", conflictsWithId: null, description: null, reviewedById: user.id, reviewedAt: now, lastConfirmedAt: now } });
    }
    return notes;
  });
  for (const note of changed) {
    await logAudit({
      action: verdict === "keep" ? "assistant.note_approved" : "assistant.note_deleted",
      summary: `${verdict === "keep" ? "Approved" : "Removed"} what the assistant learned (${note.kind}${note.name ? ` “${note.name}”` : ""})`,
      user: { id: user.id, name: user.name ?? "" },
    });
  }
  return changed;
}

/**
 * What this person's conversation just taught it: their entries written since `since`, still waiting for review.
 * For the chat to show under the answer — and whether this person may keep or drop them there (the owner).
 */
export async function justLearned(tenantId: string, user: Person, since: Date): Promise<{ notes: LearnedItem[]; canReview: boolean }> {
  const [notes, canReview] = await Promise.all([
    basePrisma.assistantNote.findMany({
      where: { tenantId, createdById: user.id, updatedAt: { gte: since }, status: { in: ["unreviewed", "conflict"] } },
      orderBy: { updatedAt: "asc" },
      take: 5,
      select: SELECT,
    }),
    ownsWorkspace(tenantId, user),
  ]);
  return { notes, canReview };
}
