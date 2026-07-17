import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export async function finalizeStockBackedDelivery(input: {
  quoteId: string;
  deliveredByName: string | null;
  deliveryChecklist: object | undefined;
  deliverySignatureRef: string | null;
  actor: { id: string; name: string };
}): Promise<{ stockUnitId: string; vehicleId: string | null; quoteNumber: number }> {
  return prisma.$transaction(async (tx) => {
    const quotes = await tx.$queryRaw<Array<{
      number: number;
      contactId: string | null;
      leadId: string | null;
      deliveredAt: Date | null;
      deliveryScheduledFor: Date | null;
    }>>(Prisma.sql`
      SELECT "number", "contactId", "leadId", "deliveredAt", "deliveryScheduledFor"
      FROM "Quote"
      WHERE "id" = ${input.quoteId} AND "deletedAt" IS NULL
      FOR UPDATE
    `);
    const quote = quotes[0];
    if (!quote || !quote.deliveryScheduledFor || quote.deliveredAt) {
      throw new Error("Quote is not available for delivery completion");
    }

    const units = await tx.$queryRaw<Array<{
      id: string;
      stockNumber: string | null;
      serial: string | null;
      color: string | null;
      status: string;
      pdiStatus: string;
      productId: string;
      productName: string;
    }>>(Prisma.sql`
      SELECT su."id", su."stockNumber", su."serial", su."color", su."status", su."pdiStatus",
        su."productId", p."name" AS "productName"
      FROM "StockUnit" su
      JOIN "Product" p ON p."id" = su."productId"
      WHERE su."soldQuoteId" = ${input.quoteId} AND su."deletedAt" IS NULL
      FOR UPDATE
    `);
    const unit = units[0];
    if (!unit || !["ready", "sold"].includes(unit.status) || unit.pdiStatus !== "completed") {
      throw new Error("The allocated stock unit must be PDI-complete and ready before delivery");
    }

    await tx.$executeRaw(Prisma.sql`
      UPDATE "Quote" SET
        "deliveredAt" = CURRENT_TIMESTAMP,
        "deliveredByName" = ${input.deliveredByName},
        "deliveryChecklist" = ${input.deliveryChecklist ? JSON.stringify(input.deliveryChecklist) : null}::jsonb,
        "deliverySignatureRef" = ${input.deliverySignatureRef}
      WHERE "id" = ${input.quoteId}
    `);

    await tx.$executeRaw(Prisma.sql`
      UPDATE "StockUnit" SET
        "status" = 'delivered',
        "soldAt" = COALESCE("soldAt", CURRENT_TIMESTAMP),
        "deliveredAt" = CURRENT_TIMESTAMP,
        "warrantyStartedAt" = CURRENT_TIMESTAMP,
        "warrantyExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '12 months',
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${unit.id}
    `);

    await tx.$executeRaw(Prisma.sql`
      UPDATE "StockReservation" SET
        "status" = 'fulfilled', "releasedAt" = CURRENT_TIMESTAMP
      WHERE "stockUnitId" = ${unit.id} AND "status" IN ('active','allocated')
    `);

    let vehicleId: string | null = null;
    if (quote.contactId) {
      const existing = unit.serial
        ? await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            SELECT "id" FROM "Vehicle"
            WHERE UPPER("vin") = ${unit.serial.toUpperCase()} AND "deletedAt" IS NULL
            LIMIT 1
          `)
        : [];
      if (existing[0]) {
        vehicleId = existing[0].id;
      } else {
        vehicleId = randomUUID();
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "Vehicle" (
            "id", "model", "vin", "color", "purchaseDate", "warrantyMonths", "notes",
            "createdAt", "contactId", "productId"
          ) VALUES (
            ${vehicleId}, ${unit.productName}, ${unit.serial}, ${unit.color}, CURRENT_TIMESTAMP, 12,
            ${`Created automatically from delivered stock ${unit.stockNumber ?? unit.id} / quote Q-${quote.number}`},
            CURRENT_TIMESTAMP, ${quote.contactId}, ${unit.productId}
          )
        `);
      }
    }

    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "StockMovement" (
        "id", "stockUnitId", "eventType", "fromStatus", "toStatus", "leadId", "quoteId",
        "reason", "performedById", "performedByName"
      ) VALUES (
        ${randomUUID()}, ${unit.id}, 'delivered', ${unit.status}, 'delivered', ${quote.leadId}, ${input.quoteId},
        ${`Delivered against quote Q-${quote.number}`}, ${input.actor.id}, ${input.actor.name}
      )
    `);

    return { stockUnitId: unit.id, vehicleId, quoteNumber: quote.number };
  });
}
