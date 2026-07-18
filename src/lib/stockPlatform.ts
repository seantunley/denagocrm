import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export const STOCK_STATUSES = [
  "incoming",
  "received_pending_check",
  "available",
  "reserved",
  "allocated",
  "pdi",
  "ready_for_delivery",
  "delivered",
  "hold",
  "damaged",
  "sold",
] as const;

export type StockStatus = (typeof STOCK_STATUSES)[number];

const TRANSITIONS: Record<StockStatus, readonly StockStatus[]> = {
  incoming: ["received_pending_check", "hold", "damaged"],
  received_pending_check: ["available", "hold", "damaged"],
  available: ["reserved", "allocated", "hold", "damaged"],
  reserved: ["available", "allocated", "hold"],
  allocated: ["available", "pdi", "hold"],
  pdi: ["allocated", "ready_for_delivery", "hold", "damaged"],
  ready_for_delivery: ["pdi", "delivered", "hold"],
  delivered: [],
  hold: ["available", "allocated", "pdi", "damaged"],
  damaged: ["hold", "available"],
  sold: ["delivered"],
};

export function canTransitionStock(from: string, to: string): boolean {
  if (!STOCK_STATUSES.includes(from as StockStatus) || !STOCK_STATUSES.includes(to as StockStatus)) return false;
  return TRANSITIONS[from as StockStatus].includes(to as StockStatus);
}

export type StockActor = { id: string; name: string };

export async function addStockEvent(input: {
  stockUnitId?: string | null;
  purchaseOrderId?: string | null;
  eventType: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  leadId?: string | null;
  quoteId?: string | null;
  reason?: string | null;
  detail?: string | null;
  costBeforeCents?: number | null;
  costAfterCents?: number | null;
  actor: StockActor;
}) {
  await prisma.stockEvent.create({
    data: {
      stockUnitId: input.stockUnitId ?? null,
      purchaseOrderId: input.purchaseOrderId ?? null,
      eventType: input.eventType,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      leadId: input.leadId ?? null,
      quoteId: input.quoteId ?? null,
      reason: input.reason ?? null,
      detail: input.detail ?? null,
      costBeforeCents: input.costBeforeCents ?? null,
      costAfterCents: input.costAfterCents ?? null,
      performedById: input.actor.id,
      performedByName: input.actor.name,
    },
  });
}

export type StockUnitRecord = {
  id: string;
  productId: string;
  productName: string;
  color: string | null;
  serial: string | null;
  stockNumber: string | null;
  status: string;
  costCents: number;
  landedCostCents: number;
  salePriceCents: number | null;
  notes: string | null;
  location: string | null;
  condition: string;
  batterySerial: string | null;
  chargerSerial: string | null;
  odometerKm: number | null;
  pdiStatus: string;
  arrivedAt: Date | null;
  soldAt: Date | null;
  deliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  purchaseOrderId: string | null;
  purchaseOrderReference: string | null;
  reservedForLeadId: string | null;
  reservedLeadName: string | null;
  soldQuoteId: string | null;
  quoteNumber: number | null;
  reservationExpiresAt: Date | null;
  reservationDepositReceivedAt: Date | null;
  ageDays: number;
};

export async function listStockUnits(filters: {
  status?: string;
  query?: string;
  productId?: string;
  location?: string;
  age?: string;
  limit?: number;
  offset?: number;
}): Promise<StockUnitRecord[]> {
  const conditions: Prisma.Sql[] = [Prisma.sql`su."deletedAt" IS NULL`];
  if (filters.status && filters.status !== "all") conditions.push(Prisma.sql`su."status" = ${filters.status}`);
  if (filters.productId) conditions.push(Prisma.sql`su."productId" = ${filters.productId}`);
  if (filters.location) conditions.push(Prisma.sql`COALESCE(su."location", '') = ${filters.location}`);
  const q = filters.query?.trim();
  if (q) {
    const like = `%${q}%`;
    conditions.push(Prisma.sql`(
      p."name" ILIKE ${like} OR COALESCE(su."serial", '') ILIKE ${like} OR
      COALESCE(su."stockNumber", '') ILIKE ${like} OR COALESCE(su."color", '') ILIKE ${like} OR
      COALESCE(po."reference", '') ILIKE ${like} OR COALESCE(l."name", '') ILIKE ${like}
    )`);
  }
  if (filters.age === "30") conditions.push(Prisma.sql`COALESCE(su."arrivedAt", su."createdAt") <= NOW() - INTERVAL '30 days'`);
  if (filters.age === "60") conditions.push(Prisma.sql`COALESCE(su."arrivedAt", su."createdAt") <= NOW() - INTERVAL '60 days'`);
  if (filters.age === "90") conditions.push(Prisma.sql`COALESCE(su."arrivedAt", su."createdAt") <= NOW() - INTERVAL '90 days'`);
  const limit = Math.max(1, Math.min(filters.limit ?? 100, 250));
  const offset = Math.max(0, filters.offset ?? 0);

  return prisma.$queryRaw<StockUnitRecord[]>(Prisma.sql`
    SELECT
      su."id", su."productId", p."name" AS "productName", su."color", su."serial",
      su."stockNumber", su."status", su."costCents", su."landedCostCents", su."salePriceCents",
      su."notes", su."location", su."condition", su."batterySerial", su."chargerSerial",
      su."odometerKm", su."pdiStatus", su."arrivedAt", su."soldAt", su."deliveredAt",
      su."createdAt", su."updatedAt", su."purchaseOrderId", po."reference" AS "purchaseOrderReference",
      su."reservedForLeadId", l."name" AS "reservedLeadName", su."soldQuoteId",
      q."number" AS "quoteNumber", r."expiresAt" AS "reservationExpiresAt",
      r."depositReceivedAt" AS "reservationDepositReceivedAt",
      GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - COALESCE(su."arrivedAt", su."createdAt"))) / 86400))::int AS "ageDays"
    FROM "StockUnit" su
    JOIN "Product" p ON p."id" = su."productId"
    LEFT JOIN "PurchaseOrder" po ON po."id" = su."purchaseOrderId"
    LEFT JOIN "Lead" l ON l."id" = su."reservedForLeadId"
    LEFT JOIN "Quote" q ON q."id" = su."soldQuoteId"
    LEFT JOIN "StockReservation" r ON r."stockUnitId" = su."id" AND r."status" = 'active'
    WHERE ${Prisma.join(conditions, " AND ")}
    ORDER BY
      CASE su."status"
        WHEN 'hold' THEN 0 WHEN 'damaged' THEN 1 WHEN 'ready_for_delivery' THEN 2
        WHEN 'pdi' THEN 3 WHEN 'allocated' THEN 4 WHEN 'reserved' THEN 5
        WHEN 'available' THEN 6 WHEN 'received_pending_check' THEN 7 WHEN 'incoming' THEN 8
        ELSE 9 END,
      COALESCE(su."arrivedAt", su."createdAt") ASC
    LIMIT ${limit} OFFSET ${offset}
  `);
}

export type StockDashboard = {
  totalUnits: number;
  available: number;
  incoming: number;
  reserved: number;
  allocated: number;
  pdi: number;
  ready: number;
  delivered: number;
  hold: number;
  availableValueCents: number;
  incomingValueCents: number;
  averageAgeDays: number;
  aged60: number;
  expiringReservations: number;
  overduePurchaseOrders: number;
  missingSerial: number;
};

export async function stockDashboard(): Promise<StockDashboard> {
  const [row] = await prisma.$queryRaw<StockDashboard[]>(Prisma.sql`
    SELECT
      COUNT(*)::int AS "totalUnits",
      COUNT(*) FILTER (WHERE su."status" = 'available')::int AS "available",
      COUNT(*) FILTER (WHERE su."status" IN ('incoming', 'received_pending_check'))::int AS "incoming",
      COUNT(*) FILTER (WHERE su."status" = 'reserved')::int AS "reserved",
      COUNT(*) FILTER (WHERE su."status" = 'allocated')::int AS "allocated",
      COUNT(*) FILTER (WHERE su."status" = 'pdi')::int AS "pdi",
      COUNT(*) FILTER (WHERE su."status" = 'ready_for_delivery')::int AS "ready",
      COUNT(*) FILTER (WHERE su."status" IN ('delivered', 'sold'))::int AS "delivered",
      COUNT(*) FILTER (WHERE su."status" IN ('hold', 'damaged'))::int AS "hold",
      COALESCE(SUM(COALESCE(NULLIF(su."landedCostCents", 0), su."costCents")) FILTER (WHERE su."status" = 'available'), 0)::int AS "availableValueCents",
      COALESCE(SUM(COALESCE(NULLIF(su."landedCostCents", 0), su."costCents")) FILTER (WHERE su."status" IN ('incoming', 'received_pending_check')), 0)::int AS "incomingValueCents",
      COALESCE(AVG(GREATEST(0, EXTRACT(EPOCH FROM (NOW() - COALESCE(su."arrivedAt", su."createdAt"))) / 86400)) FILTER (WHERE su."status" NOT IN ('delivered', 'sold')), 0)::int AS "averageAgeDays",
      COUNT(*) FILTER (WHERE su."status" = 'available' AND COALESCE(su."arrivedAt", su."createdAt") <= NOW() - INTERVAL '60 days')::int AS "aged60",
      (SELECT COUNT(*)::int FROM "StockReservation" r WHERE r."status" = 'active' AND r."expiresAt" BETWEEN NOW() AND NOW() + INTERVAL '24 hours') AS "expiringReservations",
      (SELECT COUNT(*)::int FROM "PurchaseOrder" po WHERE po."deletedAt" IS NULL AND po."status" IN ('ordered', 'partially_received') AND po."expectedAt" < CURRENT_DATE) AS "overduePurchaseOrders",
      COUNT(*) FILTER (WHERE su."serial" IS NULL AND su."status" NOT IN ('incoming', 'delivered', 'sold'))::int AS "missingSerial"
    FROM "StockUnit" su
    WHERE su."deletedAt" IS NULL
  `);
  return row ?? {
    totalUnits: 0, available: 0, incoming: 0, reserved: 0, allocated: 0,
    pdi: 0, ready: 0, delivered: 0, hold: 0, availableValueCents: 0,
    incomingValueCents: 0, averageAgeDays: 0, aged60: 0, expiringReservations: 0,
    overduePurchaseOrders: 0, missingSerial: 0,
  };
}

export async function expireReservations(actor: StockActor) {
  // StockReservation is authoritative; the unit's cached status/reservedForLeadId is
  // cleared in the same transaction so the two never diverge.
  const due = await prisma.stockReservation.findMany({
    where: { status: "active", expiresAt: { lt: new Date() } },
    select: { id: true, stockUnitId: true, leadId: true },
  });
  let expired = 0;
  for (const reservation of due) {
    const done = await prisma.$transaction(async (tx) => {
      const claim = await tx.stockReservation.updateMany({
        where: { id: reservation.id, status: "active" },
        data: { status: "expired", releasedAt: new Date(), releaseReason: "Reservation expired automatically" },
      });
      if (claim.count !== 1) return false;
      await tx.stockUnit.updateMany({
        where: { id: reservation.stockUnitId, status: "reserved", deletedAt: null },
        data: { status: "available", reservedForLeadId: null },
      });
      return true;
    });
    if (!done) continue;
    expired += 1;
    await addStockEvent({
      stockUnitId: reservation.stockUnitId,
      eventType: "reservation.expired",
      fromStatus: "reserved",
      toStatus: "available",
      leadId: reservation.leadId,
      reason: "Reservation expired automatically",
      actor,
    });
  }
  return expired;
}

export async function nextStockNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const [row] = await prisma.$queryRaw<Array<{ next: number }>>(Prisma.sql`
    SELECT COALESCE(MAX(NULLIF(REGEXP_REPLACE("stockNumber", '\\D', '', 'g'), '')::int), 0) + 1 AS "next"
    FROM "StockUnit"
    WHERE "stockNumber" LIKE ${`STK-${year}-%`}
  `);
  return `STK-${year}-${String(row?.next ?? 1).padStart(4, "0")}`;
}

export async function stockEvents(stockUnitId: string) {
  return prisma.$queryRaw<Array<{
    id: string; eventType: string; fromStatus: string | null; toStatus: string | null;
    reason: string | null; detail: string | null; performedByName: string; occurredAt: Date;
  }>>(Prisma.sql`
    SELECT "id", "eventType", "fromStatus", "toStatus", "reason", "detail", "performedByName", "occurredAt"
    FROM "StockEvent" WHERE "stockUnitId" = ${stockUnitId}
    ORDER BY "occurredAt" DESC
  `);
}
