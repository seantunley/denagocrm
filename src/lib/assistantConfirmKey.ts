import "server-only";
import { Prisma } from "@prisma/client";
import { basePrisma } from "./db";

/**
 * ONE CONFIRM, ONE RECORD — for a card whose action has no confirm key of its own (createLead). Review of #933: a
 * repeated Confirm (the browser lost the first answer, or a retried request) made a second lead.
 *
 * The card's key (CONFIRM_KEY, minted when the card was made) is RESERVED before anything is created — a row whose
 * primary key IS the key, the same record quotes and job cards spend theirs as (a spent AssistantPendingAction) —
 * then COMPLETED with what was made, or RELEASED if nothing was. So:
 *  - a second Confirm finds it done and gets the same record back;
 *  - two at once: one reserves, the other is told it is under way (the primary key decides);
 *  - a failure frees the key, and the same card can be confirmed again.
 * A request that dies between reserving and completing leaves it "under way" — never a second record; it is pruned
 * with the rest after KEPT_MS.
 */
const KEPT_MS = 35 * 24 * 60 * 60 * 1000;

export type Reservation = { state: "reserved" } | { state: "done"; result: Record<string, unknown> } | { state: "busy" };

export async function reserveConfirmKey(tenantId: string, userId: string, key: string, what: string): Promise<Reservation> {
  const now = new Date();
  try {
    await basePrisma.assistantPendingAction.create({
      data: { id: key, tenantId, userId, card: { kind: "confirm_key", what }, confirmedAt: now, expiresAt: new Date(now.getTime() + KEPT_MS) },
    });
    return { state: "reserved" };
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
    // This workspace's row only (a bypass client: the predicate is the boundary).
    const row = await basePrisma.assistantPendingAction.findFirst({ where: { id: key, tenantId }, select: { completedAt: true, card: true } });
    if (row?.completedAt) {
      const result = (row.card as { result?: unknown } | null)?.result;
      return { state: "done", result: result && typeof result === "object" ? (result as Record<string, unknown>) : {} };
    }
    return { state: "busy" };
  }
}

export async function completeConfirmKey(tenantId: string, key: string, what: string, result: Record<string, string>): Promise<void> {
  await basePrisma.assistantPendingAction.updateMany({ where: { id: key, tenantId, completedAt: null }, data: { completedAt: new Date(), card: { kind: "confirm_key", what, result } } });
}

export async function releaseConfirmKey(tenantId: string, key: string): Promise<void> {
  await basePrisma.assistantPendingAction.deleteMany({ where: { id: key, tenantId, completedAt: null } });
}
