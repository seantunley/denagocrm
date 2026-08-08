import "server-only";
import { randomUUID } from "node:crypto";
import { basePrisma } from "./db";
import { DRAFT_COLLISION_WINDOW_MS, type DraftCollision } from "./conversationDraft";

/**
 * Taking ownership of a conversation's reply draft, ATOMICALLY.
 *
 * The first version read the draft, decided in JavaScript whether it collided,
 * and then upserted. Two people can interleave that:
 *
 *   Sean                        Jane
 *   ─────                       ────
 *   read → no draft
 *                               read → no draft
 *   collision? no
 *                               collision? no
 *   upsert Sean's draft
 *                               upsert Jane's draft   ← silently wins
 *
 * Neither gets a warning and one draft is gone. Autosave firing 1.5s after each
 * keystroke makes that interleaving ordinary rather than unlucky, and the whole
 * point of the feature is to stop two people replying to one customer at once —
 * so the check failing quietly is worse than not having it.
 *
 * The decision therefore happens in ONE statement, in the database, where the row
 * lock is. `ON CONFLICT … DO UPDATE … WHERE` updates only when the existing draft
 * is the caller's own or has gone stale; when the WHERE rejects it, Postgres
 * reports zero rows affected and nothing was written. There is no window between
 * deciding and writing because they are the same statement.
 *
 * This is the shape the repo already uses for this class of bug: lock the owning
 * row, do it in one transaction, check the count.
 */

export type DraftClaim = { ok: true } | { ok: false; collision: DraftCollision };

export async function claimConversationDraft(
  conversationId: string,
  ownerId: string,
  body: string,
): Promise<DraftClaim> {
  const windowSeconds = DRAFT_COLLISION_WINDOW_MS / 1000;

  // tenantId is SELECTed from the parent conversation rather than passed in, so
  // the composite FK (tenantId, conversationId) → Conversation(tenantId, id) is
  // satisfied by construction. A draft cannot end up stamped with a tenant its
  // conversation does not have — the failure that broke lead creation on
  // 2026-08-07 came from exactly that mismatch.
  //
  // Staleness is measured with the DATABASE clock on both sides (now() vs
  // updatedAt), so two app instances with skewed clocks cannot disagree about
  // whether a draft has expired.
  const affected = await basePrisma.$executeRaw`
    INSERT INTO "ConversationDraft" ("id", "tenantId", "conversationId", "ownerId", "body", "updatedAt", "createdAt")
    SELECT ${randomUUID()}, c."tenantId", c."id", ${ownerId}, ${body}, now(), now()
      FROM "Conversation" c
     WHERE c."id" = ${conversationId}
    ON CONFLICT ("conversationId") DO UPDATE
       SET "ownerId"   = EXCLUDED."ownerId",
           "body"      = EXCLUDED."body",
           "updatedAt" = now()
     WHERE "ConversationDraft"."ownerId" = EXCLUDED."ownerId"
        OR "ConversationDraft"."updatedAt" <= now() - make_interval(secs => ${windowSeconds})
  `;

  if (affected > 0) return { ok: true };

  // Zero rows means the WHERE refused: somebody else holds a draft that is not
  // stale. Read the holder to name them. The collision is NOT re-derived from the
  // window here — the database already made that decision, and evaluating it a
  // second time in JavaScript is how the two answers drift apart.
  const holder = await basePrisma.conversationDraft.findUnique({
    where: { conversationId },
    select: { ownerId: true, updatedAt: true, owner: { select: { name: true } } },
  });
  if (!holder || holder.ownerId === ownerId) {
    // Neither a collision nor a success: no draft row and nothing written means
    // the conversation itself is gone (the SELECT found nothing). Reported as a
    // collision-shaped refusal rather than a silent success, because claiming the
    // draft saved when no row exists is the lie that matters here.
    return { ok: false, collision: { ownerName: "another session", updatedAt: new Date().toISOString() } };
  }
  return {
    ok: false,
    collision: { ownerName: holder.owner.name, updatedAt: holder.updatedAt.toISOString() },
  };
}

/** Discard the caller's OWN draft. Never a colleague's. */
export async function discardOwnConversationDraft(conversationId: string, ownerId: string): Promise<void> {
  await basePrisma.conversationDraft.deleteMany({ where: { conversationId, ownerId } });
}
