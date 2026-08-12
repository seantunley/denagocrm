import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { customerRecordTenantId } from "@/lib/customerRecordTenant";

export type TimelinePinKind =
  | "communication"
  | "activity"
  | "contact_note"
  | "lead_note";

/**
 * A pin is written by RAW SQL, and raw SQL is invisible to the db.ts tenant guard
 * — the guard rewrites Prisma `args`, and there are none here. So the INSERT is
 * the only place `tenantId` can be set, and until now it did not set it: every one
 * of the seven TimelinePin rows on production is unowned, and would vanish from
 * its own workspace the moment enforcement is switched on.
 *
 * The owner is derived from THE ITEM BEING PINNED rather than from the session.
 * `itemId` is a polymorphic pointer with no foreign key (see the model comment in
 * schema.prisma), and `kind` is what says which table it points into — so the pin
 * inherits the tenant of the thing it is a pin ON, which is exactly what it means.
 * A pin whose item cannot be resolved is left unowned rather than guessed at.
 */
const PIN_ITEM_REF: Record<TimelinePinKind, "communicationId" | "activityId" | "contactId" | "leadId"> = {
  communication: "communicationId",
  activity: "activityId",
  contact_note: "contactId",
  lead_note: "leadId",
};

function pinTenantId(kind: TimelinePinKind, itemId: string): Promise<string | null> {
  return customerRecordTenantId({ [PIN_ITEM_REF[kind]]: itemId });
}

export type TimelinePin = {
  kind: TimelinePinKind;
  itemId: string;
  pinnedAt: Date;
};

const PIN_KINDS = [
  "communication",
  "activity",
  "contact_note",
  "lead_note",
] as const;

export async function getTimelinePins(
  targets: Array<{ kind: TimelinePinKind; itemId: string }>,
): Promise<TimelinePin[]> {
  const itemIds = [
    ...new Set(targets.map((target) => target.itemId).filter(Boolean)),
  ];
  if (itemIds.length === 0) return [];

  const rows = await prisma.$queryRaw<
    Array<{ kind: string; itemId: string; pinnedAt: Date }>
  >(Prisma.sql`
    SELECT "kind", "itemId", "pinnedAt"
    FROM "TimelinePin"
    WHERE "itemId" IN (${Prisma.join(itemIds)})
      AND "kind" IN ('communication', 'activity', 'contact_note', 'lead_note')
  `);

  const requested = new Set(
    targets.map((target) => `${target.kind}:${target.itemId}`),
  );

  return rows
    .filter(
      (row): row is TimelinePin =>
        PIN_KINDS.includes(row.kind as TimelinePinKind) &&
        requested.has(`${row.kind}:${row.itemId}`),
    )
    .map((row) => ({
      kind: row.kind,
      itemId: row.itemId,
      pinnedAt: row.pinnedAt,
    }));
}

export async function toggleTimelinePin(
  kind: TimelinePinKind,
  itemId: string,
  userId: string,
): Promise<{ pinned: boolean; pinnedAt: Date | null }> {
  // Resolved BEFORE the transaction opens: it is a read on another connection, and
  // an unpin never reaches the INSERT that needs it.
  const tenantId = await pinTenantId(kind, itemId);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "TimelinePin"
      WHERE "kind" = ${kind} AND "itemId" = ${itemId}
      LIMIT 1
    `);

    if (existing.length > 0) {
      await tx.$executeRaw(Prisma.sql`
        DELETE FROM "TimelinePin"
        WHERE "kind" = ${kind} AND "itemId" = ${itemId}
      `);
      return { pinned: false, pinnedAt: null };
    }

    const pinnedAt = new Date();
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "TimelinePin" (
        "id", "kind", "itemId", "pinnedAt", "pinnedById", "tenantId"
      )
      VALUES (
        ${randomUUID()}, ${kind}, ${itemId}, ${pinnedAt}, ${userId}, ${tenantId}
      )
      ON CONFLICT ("kind", "itemId") DO UPDATE SET
        "pinnedAt" = EXCLUDED."pinnedAt",
        "pinnedById" = EXCLUDED."pinnedById",
        "tenantId" = EXCLUDED."tenantId"
    `);

    return { pinned: true, pinnedAt };
  });
}

/**
 * Pins an item unconditionally (never toggles it off). Used to AUTO-PIN a
 * newly-created follow-up so it floats to the top of the timeline. Idempotent:
 * if a pin already exists it is left untouched so an existing pinnedAt / manual
 * unpin decision is preserved.
 */
export async function ensureTimelinePin(
  kind: TimelinePinKind,
  itemId: string,
  userId: string,
): Promise<void> {
  const tenantId = await pinTenantId(kind, itemId);
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "TimelinePin" (
      "id", "kind", "itemId", "pinnedAt", "pinnedById", "tenantId"
    )
    VALUES (
      ${randomUUID()}, ${kind}, ${itemId}, ${new Date()}, ${userId}, ${tenantId}
    )
    ON CONFLICT ("kind", "itemId") DO NOTHING
  `);
}

export async function removeTimelinePin(
  kind: TimelinePinKind,
  itemId: string,
): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    DELETE FROM "TimelinePin"
    WHERE "kind" = ${kind} AND "itemId" = ${itemId}
  `);
}
