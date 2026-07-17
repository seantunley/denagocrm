import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getCustomStockStatuses } from "@/lib/stockStatuses";

const COMMITTED_STATUSES = new Set(["reserved", "allocated", "pdi", "ready", "sold", "delivered"]);

export async function setCustomStockUnitStatus(input: {
  stockUnitId: string;
  slug: string;
  reason: string;
  actor: { id: string; name: string };
}) {
  const custom = await getCustomStockStatuses();
  if (!custom.some((status) => status.slug === input.slug)) throw new Error("Unknown custom stock status");
  if (!input.reason.trim()) throw new Error("A reason is required");

  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ status: string }>>(Prisma.sql`
      SELECT "status" FROM "StockUnit"
      WHERE "id" = ${input.stockUnitId} AND "deletedAt" IS NULL
      FOR UPDATE
    `);
    const current = rows[0];
    if (!current) throw new Error("Stock unit not found");
    if (COMMITTED_STATUSES.has(current.status)) {
      throw new Error("Committed stock must be released through its reservation, PDI or delivery workflow first");
    }
    await tx.$executeRaw(Prisma.sql`
      UPDATE "StockUnit"
      SET "status" = ${input.slug}, "holdReason" = ${input.reason}, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${input.stockUnitId}
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "StockMovement" (
        "id", "stockUnitId", "eventType", "fromStatus", "toStatus", "reason",
        "performedById", "performedByName"
      ) VALUES (
        ${randomUUID()}, ${input.stockUnitId}, 'custom_status_set', ${current.status}, ${input.slug},
        ${input.reason}, ${input.actor.id}, ${input.actor.name}
      )
    `);
  });
}

export async function restoreUnitsFromRemovedCustomStatus(input: {
  slug: string;
  actor: { id: string; name: string };
}) {
  await prisma.$transaction(async (tx) => {
    const units = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "StockUnit"
      WHERE "status" = ${input.slug} AND "deletedAt" IS NULL
      FOR UPDATE
    `);
    if (units.length === 0) return;
    await tx.$executeRaw(Prisma.sql`
      UPDATE "StockUnit"
      SET "status" = 'available', "holdReason" = NULL, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "status" = ${input.slug} AND "deletedAt" IS NULL
    `);
    for (const unit of units) {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "StockMovement" (
          "id", "stockUnitId", "eventType", "fromStatus", "toStatus", "reason",
          "performedById", "performedByName"
        ) VALUES (
          ${randomUUID()}, ${unit.id}, 'custom_status_removed', ${input.slug}, 'available',
          'Custom status removed; unit restored to available', ${input.actor.id}, ${input.actor.name}
        )
      `);
    }
  });
}
