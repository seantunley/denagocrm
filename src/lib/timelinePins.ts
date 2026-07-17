import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export type TimelinePinKind = "communication" | "activity";

export type TimelinePin = {
  kind: TimelinePinKind;
  itemId: string;
  pinnedAt: Date;
};

export async function getTimelinePins(
  targets: Array<{ kind: TimelinePinKind; itemId: string }>,
): Promise<TimelinePin[]> {
  const itemIds = [...new Set(targets.map((target) => target.itemId).filter(Boolean))];
  if (itemIds.length === 0) return [];

  const rows = await prisma.$queryRaw<
    Array<{ kind: string; itemId: string; pinnedAt: Date }>
  >(Prisma.sql`
    SELECT "kind", "itemId", "pinnedAt"
    FROM "TimelinePin"
    WHERE "itemId" IN (${Prisma.join(itemIds)})
      AND "kind" IN ('communication', 'activity')
  `);

  const requested = new Set(
    targets.map((target) => `${target.kind}:${target.itemId}`),
  );

  return rows
    .filter(
      (row): row is TimelinePin =>
        (row.kind === "communication" || row.kind === "activity") &&
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
        "id", "kind", "itemId", "pinnedAt", "pinnedById"
      )
      VALUES (
        ${randomUUID()}, ${kind}, ${itemId}, ${pinnedAt}, ${userId}
      )
      ON CONFLICT ("kind", "itemId") DO UPDATE SET
        "pinnedAt" = EXCLUDED."pinnedAt",
        "pinnedById" = EXCLUDED."pinnedById"
    `);

    return { pinned: true, pinnedAt };
  });
}
