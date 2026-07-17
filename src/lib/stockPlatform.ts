import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  ACTIVE_STOCK_STATUSES,
  STOCK_STATUS_LABELS,
  allocateLandedCost,
  canTransitionStock,
  isStockStatus,
  normalizeSerial,
  normalizeStockNumber,
  reorderRecommendation,
  stockAgeDays,
  type StockStatus,
} from "@/lib/stockWorkflow";

export type StockLocationRecord = {
  id: string;
  name: string;
  type: string;
  address: string | null;
  active: boolean;
  isDefault: boolean;
};

export type StockUnitListRow = {
  id: string;
  stockNumber: string | null;
  productId: string;
  productName: string;
  color: string | null;
  serial: string | null;
  status: string;
  condition: string;
  locationId: string | null;
  locationName: string | null;
  costCents: number;
  landedCostCents: number;
  salePriceCents: number;
  arrivedAt: Date | null;
  createdAt: Date;
  pdiStatus: string;
  reservedForLeadId: string | null;
  reservedLeadName: string | null;
  reservationExpiresAt: Date | null;
  soldQuoteId: string | null;
  soldQuoteNumber: number | null;
  soldContactName: string | null;
  holdReason: string | null;
  purchaseOrderReference: string | null;
};

export type StockDemandRow = {
  productId: string;
  productName: string;
  openDemand: number;
  available: number;
  incoming: number;
  reserved: number;
  allocated: number;
  ready: number;
  recommendation: number;
};

export type StockDashboard = {
  units: StockUnitListRow[];
  total: number;
  page: number;
  pageSize: number;
  counts: Record<string, number>;
  values: {
    availableCents: number;
    activeCents: number;
    potentialMarginCents: number;
  };
  alerts: {
    overduePurchaseOrders: number;
    expiringReservations: number;
    agedAvailable: number;
    missingSerials: number;
    pdiWaiting: number;
  };
  demand: StockDemandRow[];
};

export type PurchaseOrderListRow = {
  id: string;
  reference: string | null;
  supplier: string;
  status: string;
  orderedAt: Date;
  expectedAt: Date | null;
  receivedAt: Date | null;
  currency: string;
  supplierInvoiceRef: string | null;
  orderedQty: number;
  receivedQty: number;
  baseCostCents: number;
  landedOverheadCents: number;
  lineCount: number;
};

export type PurchaseOrderDetail = PurchaseOrderListRow & {
  notes: string | null;
  freightCents: number;
  dutiesCents: number;
  otherCostsCents: number;
  lines: Array<{
    id: string;
    productId: string;
    productName: string;
    color: string | null;
    orderedQty: number;
    receivedQty: number;
    unitCostCents: number;
    notes: string | null;
  }>;
  receipts: Array<{
    id: string;
    reference: string | null;
    receivedAt: Date;
    notes: string | null;
    freightCents: number;
    dutiesCents: number;
    otherCostsCents: number;
    totalQty: number;
  }>;
};

export type StockUnitDetail = StockUnitListRow & {
  notes: string | null;
  manufacturingYear: number | null;
  batteryType: string | null;
  batterySerial: string | null;
  chargerSerial: string | null;
  keyCount: number | null;
  odometerKm: number | null;
  operatingHours: number | null;
  pdiChecklist: unknown;
  pdiCompletedAt: Date | null;
  warrantyStartedAt: Date | null;
  warrantyExpiresAt: Date | null;
  consignmentOwner: string | null;
  deliveredAt: Date | null;
  movements: Array<{
    id: string;
    eventType: string;
    fromStatus: string | null;
    toStatus: string | null;
    costBeforeCents: number | null;
    costAfterCents: number | null;
    reason: string | null;
    notes: string | null;
    performedByName: string;
    occurredAt: Date;
    leadId: string | null;
    quoteId: string | null;
  }>;
  attachments: Array<{
    id: string;
    fileName: string;
    storedName: string;
    mimeType: string;
    sizeBytes: number;
    category: string;
    createdAt: Date;
  }>;
  reservation: {
    id: string;
    leadId: string;
    leadName: string;
    quoteId: string | null;
    quoteNumber: number | null;
    reservedAt: Date;
    expiresAt: Date | null;
    depositRequiredCents: number;
    depositReceivedAt: Date | null;
  } | null;
};

type Actor = { id: string; name: string };

type MovementInput = {
  stockUnitId: string;
  eventType: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  costBeforeCents?: number | null;
  costAfterCents?: number | null;
  leadId?: string | null;
  quoteId?: string | null;
  purchaseOrderId?: string | null;
  reason?: string | null;
  notes?: string | null;
  actor: Actor;
};

async function recordMovement(tx: Pick<Prisma.TransactionClient, "$executeRaw">, input: MovementInput) {
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "StockMovement" (
      "id", "stockUnitId", "eventType", "fromStatus", "toStatus",
      "costBeforeCents", "costAfterCents", "leadId", "quoteId",
      "purchaseOrderId", "reason", "notes", "performedById", "performedByName"
    ) VALUES (
      ${randomUUID()}, ${input.stockUnitId}, ${input.eventType},
      ${input.fromStatus ?? null}, ${input.toStatus ?? null},
      ${input.costBeforeCents ?? null}, ${input.costAfterCents ?? null},
      ${input.leadId ?? null}, ${input.quoteId ?? null}, ${input.purchaseOrderId ?? null},
      ${input.reason ?? null}, ${input.notes ?? null}, ${input.actor.id}, ${input.actor.name}
    )
  `);
}

export async function expireStockReservations() {
  await prisma.$transaction(async (tx) => {
    const expired = await tx.$queryRaw<Array<{ id: string; stockUnitId: string; leadId: string }>>(Prisma.sql`
      SELECT "id", "stockUnitId", "leadId"
      FROM "StockReservation"
      WHERE "status" = 'active' AND "expiresAt" IS NOT NULL AND "expiresAt" < CURRENT_TIMESTAMP
      FOR UPDATE
    `);
    for (const reservation of expired) {
      await tx.$executeRaw(Prisma.sql`
        UPDATE "StockReservation"
        SET "status" = 'expired', "releasedAt" = CURRENT_TIMESTAMP,
            "releaseReason" = 'Reservation expired automatically'
        WHERE "id" = ${reservation.id}
      `);
      const units = await tx.$queryRaw<Array<{ status: string }>>(Prisma.sql`
        UPDATE "StockUnit"
        SET "status" = 'available', "reservedForLeadId" = NULL, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${reservation.stockUnitId} AND "status" = 'reserved' AND "deletedAt" IS NULL
        RETURNING "status"
      `);
      if (units.length > 0) {
        await recordMovement(tx, {
          stockUnitId: reservation.stockUnitId,
          eventType: "reservation_expired",
          fromStatus: "reserved",
          toStatus: "available",
          leadId: reservation.leadId,
          reason: "Reservation expiry reached",
          actor: { id: "system", name: "System" },
        });
      }
    }
  });
}

export async function getStockLocations(): Promise<StockLocationRecord[]> {
  return prisma.$queryRaw<StockLocationRecord[]>(Prisma.sql`
    SELECT "id", "name", "type", "address", "active", "isDefault"
    FROM "StockLocation"
    WHERE "active" = true
    ORDER BY "isDefault" DESC, "name" ASC
  `);
}

export async function getStockDashboard(input: {
  query?: string;
  status?: string;
  productId?: string;
  locationId?: string;
  age?: string;
  page?: number;
  pageSize?: number;
}): Promise<StockDashboard> {
  await expireStockReservations();
  const page = Math.max(1, Math.floor(input.page ?? 1));
  const pageSize = Math.max(10, Math.min(100, Math.floor(input.pageSize ?? 30)));
  const offset = (page - 1) * pageSize;
  const where: Prisma.Sql[] = [Prisma.sql`su."deletedAt" IS NULL`];
  const query = String(input.query ?? "").trim();
  if (query) {
    const pattern = `%${query}%`;
    where.push(Prisma.sql`(
      su."stockNumber" ILIKE ${pattern}
      OR su."serial" ILIKE ${pattern}
      OR su."batterySerial" ILIKE ${pattern}
      OR su."chargerSerial" ILIKE ${pattern}
      OR p."name" ILIKE ${pattern}
      OR su."color" ILIKE ${pattern}
      OR po."reference" ILIKE ${pattern}
      OR l."name" ILIKE ${pattern}
    )`);
  }
  if (input.status && input.status !== "all") where.push(Prisma.sql`su."status" = ${input.status}`);
  if (input.productId) where.push(Prisma.sql`su."productId" = ${input.productId}`);
  if (input.locationId) where.push(Prisma.sql`su."locationId" = ${input.locationId}`);
  if (input.age === "30") where.push(Prisma.sql`su."arrivedAt" <= CURRENT_TIMESTAMP - INTERVAL '30 days'`);
  if (input.age === "60") where.push(Prisma.sql`su."arrivedAt" <= CURRENT_TIMESTAMP - INTERVAL '60 days'`);
  if (input.age === "90") where.push(Prisma.sql`su."arrivedAt" <= CURRENT_TIMESTAMP - INTERVAL '90 days'`);
  const predicate = Prisma.join(where, " AND ");

  const [units, totalRows, countRows, valueRows, alertRows, demandRows] = await Promise.all([
    prisma.$queryRaw<StockUnitListRow[]>(Prisma.sql`
      SELECT
        su."id", su."stockNumber", su."productId", p."name" AS "productName",
        su."color", su."serial", su."status", su."condition",
        su."locationId", loc."name" AS "locationName", su."costCents",
        su."landedCostCents", su."salePriceCents", su."arrivedAt", su."createdAt",
        su."pdiStatus", su."reservedForLeadId", l."name" AS "reservedLeadName",
        r."expiresAt" AS "reservationExpiresAt", su."soldQuoteId",
        q."number" AS "soldQuoteNumber",
        COALESCE(c."company", CONCAT_WS(' ', c."firstName", c."lastName")) AS "soldContactName",
        su."holdReason", po."reference" AS "purchaseOrderReference"
      FROM "StockUnit" su
      JOIN "Product" p ON p."id" = su."productId"
      LEFT JOIN "StockLocation" loc ON loc."id" = su."locationId"
      LEFT JOIN "Lead" l ON l."id" = su."reservedForLeadId"
      LEFT JOIN "StockReservation" r ON r."stockUnitId" = su."id" AND r."status" = 'active'
      LEFT JOIN "Quote" q ON q."id" = su."soldQuoteId"
      LEFT JOIN "Contact" c ON c."id" = su."soldContactId"
      LEFT JOIN "PurchaseOrder" po ON po."id" = su."purchaseOrderId"
      WHERE ${predicate}
      ORDER BY
        CASE su."status"
          WHEN 'damaged' THEN 0 WHEN 'hold' THEN 1 WHEN 'ready' THEN 2
          WHEN 'pdi' THEN 3 WHEN 'allocated' THEN 4 WHEN 'reserved' THEN 5
          WHEN 'available' THEN 6 WHEN 'incoming' THEN 7 ELSE 8
        END,
        COALESCE(su."arrivedAt", su."createdAt") ASC
      LIMIT ${pageSize} OFFSET ${offset}
    `),
    prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS "total"
      FROM "StockUnit" su
      JOIN "Product" p ON p."id" = su."productId"
      LEFT JOIN "Lead" l ON l."id" = su."reservedForLeadId"
      LEFT JOIN "PurchaseOrder" po ON po."id" = su."purchaseOrderId"
      WHERE ${predicate}
    `),
    prisma.$queryRaw<Array<{ status: string; count: number }>>(Prisma.sql`
      SELECT "status", COUNT(*)::int AS "count"
      FROM "StockUnit"
      WHERE "deletedAt" IS NULL
      GROUP BY "status"
    `),
    prisma.$queryRaw<Array<{ availableCents: number; activeCents: number; potentialMarginCents: number }>>(Prisma.sql`
      SELECT
        COALESCE(SUM(CASE WHEN "status" = 'available' THEN COALESCE(NULLIF("landedCostCents", 0), "costCents") ELSE 0 END), 0)::int AS "availableCents",
        COALESCE(SUM(CASE WHEN "status" IN ('incoming','available','reserved','allocated','pdi','ready','hold','damaged') THEN COALESCE(NULLIF("landedCostCents", 0), "costCents") ELSE 0 END), 0)::int AS "activeCents",
        COALESCE(SUM(CASE WHEN "salePriceCents" > 0 THEN "salePriceCents" - COALESCE(NULLIF("landedCostCents", 0), "costCents") ELSE 0 END), 0)::int AS "potentialMarginCents"
      FROM "StockUnit"
      WHERE "deletedAt" IS NULL
    `),
    prisma.$queryRaw<Array<{
      overduePurchaseOrders: number;
      expiringReservations: number;
      agedAvailable: number;
      missingSerials: number;
      pdiWaiting: number;
    }>>(Prisma.sql`
      SELECT
        (SELECT COUNT(*)::int FROM "PurchaseOrder" WHERE "deletedAt" IS NULL AND "status" NOT IN ('received','cancelled') AND "expectedAt" IS NOT NULL AND "expectedAt" < CURRENT_TIMESTAMP) AS "overduePurchaseOrders",
        (SELECT COUNT(*)::int FROM "StockReservation" WHERE "status" = 'active' AND "expiresAt" IS NOT NULL AND "expiresAt" <= CURRENT_TIMESTAMP + INTERVAL '72 hours') AS "expiringReservations",
        (SELECT COUNT(*)::int FROM "StockUnit" WHERE "deletedAt" IS NULL AND "status" = 'available' AND "arrivedAt" <= CURRENT_TIMESTAMP - INTERVAL '60 days') AS "agedAvailable",
        (SELECT COUNT(*)::int FROM "StockUnit" WHERE "deletedAt" IS NULL AND "status" NOT IN ('incoming','archived') AND NULLIF(TRIM("serial"), '') IS NULL) AS "missingSerials",
        (SELECT COUNT(*)::int FROM "StockUnit" WHERE "deletedAt" IS NULL AND "status" IN ('allocated','pdi') AND "pdiStatus" <> 'completed') AS "pdiWaiting"
    `),
    prisma.$queryRaw<Array<Omit<StockDemandRow, "recommendation">>>(Prisma.sql`
      SELECT
        p."id" AS "productId", p."name" AS "productName",
        COUNT(DISTINCT l."id") FILTER (WHERE l."status" = 'open' AND l."deletedAt" IS NULL)::int AS "openDemand",
        COUNT(DISTINCT su."id") FILTER (WHERE su."status" = 'available' AND su."deletedAt" IS NULL)::int AS "available",
        COUNT(DISTINCT su."id") FILTER (WHERE su."status" = 'incoming' AND su."deletedAt" IS NULL)::int AS "incoming",
        COUNT(DISTINCT su."id") FILTER (WHERE su."status" = 'reserved' AND su."deletedAt" IS NULL)::int AS "reserved",
        COUNT(DISTINCT su."id") FILTER (WHERE su."status" IN ('allocated','pdi') AND su."deletedAt" IS NULL)::int AS "allocated",
        COUNT(DISTINCT su."id") FILTER (WHERE su."status" = 'ready' AND su."deletedAt" IS NULL)::int AS "ready"
      FROM "Product" p
      LEFT JOIN "Lead" l ON l."productId" = p."id"
      LEFT JOIN "StockUnit" su ON su."productId" = p."id"
      WHERE p."active" = true AND p."deletedAt" IS NULL
      GROUP BY p."id", p."name"
      ORDER BY p."name"
    `),
  ]);

  const counts = Object.fromEntries(countRows.map((row) => [row.status, row.count]));
  for (const status of ACTIVE_STOCK_STATUSES) counts[status] ??= 0;
  return {
    units,
    total: totalRows[0]?.total ?? 0,
    page,
    pageSize,
    counts,
    values: valueRows[0] ?? { availableCents: 0, activeCents: 0, potentialMarginCents: 0 },
    alerts: alertRows[0] ?? {
      overduePurchaseOrders: 0,
      expiringReservations: 0,
      agedAvailable: 0,
      missingSerials: 0,
      pdiWaiting: 0,
    },
    demand: demandRows.map((row) => ({
      ...row,
      recommendation: reorderRecommendation(row),
    })),
  };
}

export async function getPurchaseOrders(): Promise<PurchaseOrderListRow[]> {
  return prisma.$queryRaw<PurchaseOrderListRow[]>(Prisma.sql`
    SELECT
      po."id", po."reference", po."supplier", po."status", po."orderedAt",
      po."expectedAt", po."receivedAt", po."currency", po."supplierInvoiceRef",
      COALESCE(SUM(pol."orderedQty"), legacy."orderedQty", 0)::int AS "orderedQty",
      COALESCE(SUM(pol."receivedQty"), legacy."receivedQty", 0)::int AS "receivedQty",
      COALESCE(SUM(pol."orderedQty" * pol."unitCostCents"), legacy."baseCostCents", 0)::int AS "baseCostCents",
      (po."freightCents" + po."dutiesCents" + po."otherCostsCents")::int AS "landedOverheadCents",
      COUNT(DISTINCT pol."id")::int AS "lineCount"
    FROM "PurchaseOrder" po
    LEFT JOIN "PurchaseOrderLine" pol ON pol."purchaseOrderId" = po."id"
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int AS "orderedQty",
        COUNT(*) FILTER (WHERE su."status" <> 'incoming')::int AS "receivedQty",
        COALESCE(SUM(su."costCents"), 0)::int AS "baseCostCents"
      FROM "StockUnit" su
      WHERE su."purchaseOrderId" = po."id" AND su."deletedAt" IS NULL
    ) legacy ON true
    WHERE po."deletedAt" IS NULL
    GROUP BY po."id", legacy."orderedQty", legacy."receivedQty", legacy."baseCostCents"
    ORDER BY
      CASE po."status" WHEN 'ordered' THEN 0 WHEN 'confirmed' THEN 1 WHEN 'in_transit' THEN 2 WHEN 'partially_received' THEN 3 ELSE 4 END,
      po."expectedAt" NULLS LAST, po."orderedAt" DESC
  `);
}

export async function getPurchaseOrderDetail(id: string): Promise<PurchaseOrderDetail | null> {
  const [orders, lines, receipts] = await Promise.all([
    prisma.$queryRaw<PurchaseOrderListRow[]>(Prisma.sql`
      SELECT
        po."id", po."reference", po."supplier", po."status", po."orderedAt",
        po."expectedAt", po."receivedAt", po."currency", po."supplierInvoiceRef",
        COALESCE(SUM(pol."orderedQty"), 0)::int AS "orderedQty",
        COALESCE(SUM(pol."receivedQty"), 0)::int AS "receivedQty",
        COALESCE(SUM(pol."orderedQty" * pol."unitCostCents"), 0)::int AS "baseCostCents",
        (po."freightCents" + po."dutiesCents" + po."otherCostsCents")::int AS "landedOverheadCents",
        COUNT(pol."id")::int AS "lineCount"
      FROM "PurchaseOrder" po
      LEFT JOIN "PurchaseOrderLine" pol ON pol."purchaseOrderId" = po."id"
      WHERE po."id" = ${id} AND po."deletedAt" IS NULL
      GROUP BY po."id"
    `),
    prisma.$queryRaw<PurchaseOrderDetail["lines"]>(Prisma.sql`
      SELECT pol."id", pol."productId", p."name" AS "productName", pol."color",
        pol."orderedQty", pol."receivedQty", pol."unitCostCents", pol."notes"
      FROM "PurchaseOrderLine" pol
      JOIN "Product" p ON p."id" = pol."productId"
      WHERE pol."purchaseOrderId" = ${id}
      ORDER BY pol."sortOrder", p."name"
    `),
    prisma.$queryRaw<PurchaseOrderDetail["receipts"]>(Prisma.sql`
      SELECT gr."id", gr."reference", gr."receivedAt", gr."notes", gr."freightCents",
        gr."dutiesCents", gr."otherCostsCents", COALESCE(SUM(grl."qty"), 0)::int AS "totalQty"
      FROM "GoodsReceipt" gr
      LEFT JOIN "GoodsReceiptLine" grl ON grl."receiptId" = gr."id"
      WHERE gr."purchaseOrderId" = ${id}
      GROUP BY gr."id"
      ORDER BY gr."receivedAt" DESC
    `),
  ]);
  if (!orders[0]) return null;
  const meta = await prisma.$queryRaw<Array<{
    notes: string | null;
    freightCents: number;
    dutiesCents: number;
    otherCostsCents: number;
  }>>(Prisma.sql`
    SELECT "notes", "freightCents", "dutiesCents", "otherCostsCents"
    FROM "PurchaseOrder" WHERE "id" = ${id}
  `);
  return { ...orders[0], ...(meta[0] ?? { notes: null, freightCents: 0, dutiesCents: 0, otherCostsCents: 0 }), lines, receipts };
}

export async function createMultiLinePurchaseOrder(input: {
  reference: string | null;
  supplier: string;
  expectedAt: Date | null;
  currency: string;
  notes: string | null;
  freightCents: number;
  dutiesCents: number;
  otherCostsCents: number;
  lines: Array<{
    productId: string;
    color: string | null;
    qty: number;
    unitCostCents: number;
    notes: string | null;
  }>;
  actor: Actor;
}): Promise<string> {
  const validLines = input.lines
    .map((line) => ({ ...line, qty: Math.max(1, Math.min(500, Math.floor(line.qty))) }))
    .filter((line) => line.productId);
  if (validLines.length === 0) throw new Error("Add at least one purchase-order line");
  return prisma.$transaction(async (tx) => {
    const id = randomUUID();
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "PurchaseOrder" (
        "id", "reference", "supplier", "status", "expectedAt", "notes", "currency",
        "freightCents", "dutiesCents", "otherCostsCents", "updatedAt"
      ) VALUES (
        ${id}, ${input.reference}, ${input.supplier || "Denago"}, 'ordered', ${input.expectedAt},
        ${input.notes}, ${input.currency || "ZAR"}, ${Math.max(0, input.freightCents)},
        ${Math.max(0, input.dutiesCents)}, ${Math.max(0, input.otherCostsCents)}, CURRENT_TIMESTAMP
      )
    `);
    for (const [index, line] of validLines.entries()) {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "PurchaseOrderLine" (
          "id", "purchaseOrderId", "productId", "color", "orderedQty",
          "unitCostCents", "sortOrder", "notes"
        ) VALUES (
          ${randomUUID()}, ${id}, ${line.productId}, ${line.color}, ${line.qty},
          ${Math.max(0, line.unitCostCents)}, ${index}, ${line.notes}
        )
      `);
    }
    return id;
  });
}

export async function updatePurchaseOrderStatus(input: {
  id: string;
  status: "confirmed" | "in_transit" | "cancelled";
  actor: Actor;
  reason?: string | null;
}) {
  const allowedFrom: Record<typeof input.status, string[]> = {
    confirmed: ["ordered"],
    in_transit: ["ordered", "confirmed"],
    cancelled: ["ordered", "confirmed", "in_transit", "partially_received"],
  };
  const orders = await prisma.$queryRaw<Array<{ status: string }>>(Prisma.sql`
    UPDATE "PurchaseOrder"
    SET "status" = ${input.status},
        "confirmedAt" = CASE WHEN ${input.status} = 'confirmed' THEN CURRENT_TIMESTAMP ELSE "confirmedAt" END,
        "shippedAt" = CASE WHEN ${input.status} = 'in_transit' THEN CURRENT_TIMESTAMP ELSE "shippedAt" END,
        "notes" = CASE WHEN ${input.reason ?? null} IS NULL THEN "notes" ELSE CONCAT_WS(E'\n', "notes", ${input.reason ?? null}) END,
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${input.id}
      AND "deletedAt" IS NULL
      AND "status" IN (${Prisma.join(allowedFrom[input.status])})
    RETURNING "status"
  `);
  if (orders.length !== 1) throw new Error("Purchase order is no longer in a valid state for that action");
}

export async function receivePurchaseOrderLines(input: {
  purchaseOrderId: string;
  reference: string | null;
  notes: string | null;
  locationId: string;
  freightCents: number;
  dutiesCents: number;
  otherCostsCents: number;
  lines: Array<{ lineId: string; qty: number; serials: string[] }>;
  actor: Actor;
}): Promise<string[]> {
  return prisma.$transaction(async (tx) => {
    const poRows = await tx.$queryRaw<Array<{ status: string }>>(Prisma.sql`
      SELECT "status" FROM "PurchaseOrder"
      WHERE "id" = ${input.purchaseOrderId} AND "deletedAt" IS NULL
      FOR UPDATE
    `);
    const po = poRows[0];
    if (!po || ["received", "cancelled"].includes(po.status)) throw new Error("Purchase order cannot receive more stock");

    const requested = input.lines.filter((line) => Math.floor(line.qty) > 0);
    if (requested.length === 0) throw new Error("Enter at least one quantity to receive");
    const lineIds = requested.map((line) => line.lineId);
    const lines = await tx.$queryRaw<Array<{
      id: string;
      productId: string;
      color: string | null;
      orderedQty: number;
      receivedQty: number;
      unitCostCents: number;
    }>>(Prisma.sql`
      SELECT "id", "productId", "color", "orderedQty", "receivedQty", "unitCostCents"
      FROM "PurchaseOrderLine"
      WHERE "purchaseOrderId" = ${input.purchaseOrderId}
        AND "id" IN (${Prisma.join(lineIds)})
      FOR UPDATE
    `);
    const byId = new Map(lines.map((line) => [line.id, line]));
    for (const request of requested) {
      const line = byId.get(request.lineId);
      if (!line) throw new Error("A purchase-order line no longer exists");
      const qty = Math.max(0, Math.floor(request.qty));
      if (qty > line.orderedQty - line.receivedQty) throw new Error("Received quantity exceeds the open purchase-order quantity");
    }

    const receiptId = randomUUID();
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "GoodsReceipt" (
        "id", "purchaseOrderId", "reference", "receivedById", "notes",
        "freightCents", "dutiesCents", "otherCostsCents"
      ) VALUES (
        ${receiptId}, ${input.purchaseOrderId}, ${input.reference}, ${input.actor.id}, ${input.notes},
        ${Math.max(0, input.freightCents)}, ${Math.max(0, input.dutiesCents)}, ${Math.max(0, input.otherCostsCents)}
      )
    `);

    const overhead = Math.max(0, input.freightCents) + Math.max(0, input.dutiesCents) + Math.max(0, input.otherCostsCents);
    const landedByLine = allocateLandedCost(
      requested.map((request) => {
        const line = byId.get(request.lineId)!;
        return { key: request.lineId, qty: Math.floor(request.qty), unitCostCents: line.unitCostCents };
      }),
      overhead,
    );
    const createdIds: string[] = [];
    for (const request of requested) {
      const line = byId.get(request.lineId)!;
      const qty = Math.floor(request.qty);
      const serials = request.serials.map(normalizeSerial).filter((serial): serial is string => Boolean(serial));
      if (serials.length > qty) throw new Error("More serial numbers were supplied than units received");
      if (new Set(serials).size !== serials.length) throw new Error("Duplicate serial numbers were entered in this receipt");
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "GoodsReceiptLine" ("id", "receiptId", "purchaseOrderLineId", "qty", "serialsJson")
        VALUES (${randomUUID()}, ${receiptId}, ${line.id}, ${qty}, ${JSON.stringify(serials)})
      `);
      await tx.$executeRaw(Prisma.sql`
        UPDATE "PurchaseOrderLine"
        SET "receivedQty" = "receivedQty" + ${qty}
        WHERE "id" = ${line.id}
      `);
      for (let index = 0; index < qty; index++) {
        const stockUnitId = randomUUID();
        const stockNumber = `STK-${stockUnitId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
        const serial = serials[index] ?? null;
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "StockUnit" (
            "id", "productId", "color", "serial", "status", "costCents", "landedCostCents",
            "createdAt", "arrivedAt", "purchaseOrderId", "purchaseOrderLineId", "stockNumber",
            "locationId", "condition", "pdiStatus", "updatedAt"
          ) VALUES (
            ${stockUnitId}, ${line.productId}, ${line.color}, ${serial}, 'available', ${line.unitCostCents},
            ${landedByLine[line.id] ?? line.unitCostCents}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
            ${input.purchaseOrderId}, ${line.id}, ${stockNumber}, ${input.locationId}, 'new', 'not_started', CURRENT_TIMESTAMP
          )
        `);
        await recordMovement(tx, {
          stockUnitId,
          eventType: "goods_received",
          fromStatus: "incoming",
          toStatus: "available",
          costAfterCents: landedByLine[line.id] ?? line.unitCostCents,
          purchaseOrderId: input.purchaseOrderId,
          reason: input.reference ? `Goods receipt ${input.reference}` : "Purchase order receipt",
          actor: input.actor,
        });
        createdIds.push(stockUnitId);
      }
    }

    const remainingRows = await tx.$queryRaw<Array<{ remaining: number }>>(Prisma.sql`
      SELECT COALESCE(SUM("orderedQty" - "receivedQty"), 0)::int AS "remaining"
      FROM "PurchaseOrderLine" WHERE "purchaseOrderId" = ${input.purchaseOrderId}
    `);
    const received = (remainingRows[0]?.remaining ?? 0) === 0;
    await tx.$executeRaw(Prisma.sql`
      UPDATE "PurchaseOrder"
      SET "status" = ${received ? "received" : "partially_received"},
          "receivedAt" = CASE WHEN ${received} THEN CURRENT_TIMESTAMP ELSE "receivedAt" END,
          "supplierInvoiceRef" = COALESCE(${input.reference}, "supplierInvoiceRef"),
          "freightCents" = "freightCents" + ${Math.max(0, input.freightCents)},
          "dutiesCents" = "dutiesCents" + ${Math.max(0, input.dutiesCents)},
          "otherCostsCents" = "otherCostsCents" + ${Math.max(0, input.otherCostsCents)},
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${input.purchaseOrderId}
    `);
    return createdIds;
  });
}

export async function getStockUnitDetail(id: string): Promise<StockUnitDetail | null> {
  await expireStockReservations();
  const rows = await prisma.$queryRaw<Array<Omit<StockUnitDetail, "movements" | "attachments" | "reservation">>>(Prisma.sql`
    SELECT
      su."id", su."stockNumber", su."productId", p."name" AS "productName", su."color",
      su."serial", su."status", su."condition", su."locationId", loc."name" AS "locationName",
      su."costCents", su."landedCostCents", su."salePriceCents", su."arrivedAt", su."createdAt",
      su."pdiStatus", su."reservedForLeadId", l."name" AS "reservedLeadName",
      r."expiresAt" AS "reservationExpiresAt", su."soldQuoteId", q."number" AS "soldQuoteNumber",
      COALESCE(c."company", CONCAT_WS(' ', c."firstName", c."lastName")) AS "soldContactName",
      su."holdReason", po."reference" AS "purchaseOrderReference", su."notes",
      su."manufacturingYear", su."batteryType", su."batterySerial", su."chargerSerial",
      su."keyCount", su."odometerKm", su."operatingHours", su."pdiChecklist",
      su."pdiCompletedAt", su."warrantyStartedAt", su."warrantyExpiresAt",
      su."consignmentOwner", su."deliveredAt"
    FROM "StockUnit" su
    JOIN "Product" p ON p."id" = su."productId"
    LEFT JOIN "StockLocation" loc ON loc."id" = su."locationId"
    LEFT JOIN "Lead" l ON l."id" = su."reservedForLeadId"
    LEFT JOIN "StockReservation" r ON r."stockUnitId" = su."id" AND r."status" = 'active'
    LEFT JOIN "Quote" q ON q."id" = su."soldQuoteId"
    LEFT JOIN "Contact" c ON c."id" = su."soldContactId"
    LEFT JOIN "PurchaseOrder" po ON po."id" = su."purchaseOrderId"
    WHERE su."id" = ${id} AND su."deletedAt" IS NULL
  `);
  if (!rows[0]) return null;
  const [movements, attachments, reservations] = await Promise.all([
    prisma.$queryRaw<StockUnitDetail["movements"]>(Prisma.sql`
      SELECT "id", "eventType", "fromStatus", "toStatus", "costBeforeCents",
        "costAfterCents", "reason", "notes", "performedByName", "occurredAt", "leadId", "quoteId"
      FROM "StockMovement"
      WHERE "stockUnitId" = ${id}
      ORDER BY "occurredAt" DESC
      LIMIT 150
    `),
    prisma.$queryRaw<StockUnitDetail["attachments"]>(Prisma.sql`
      SELECT "id", "fileName", "storedName", "mimeType", "sizeBytes", "category", "createdAt"
      FROM "StockAttachment"
      WHERE "stockUnitId" = ${id}
      ORDER BY "createdAt" DESC
    `),
    prisma.$queryRaw<Array<NonNullable<StockUnitDetail["reservation"]>>>(Prisma.sql`
      SELECT r."id", r."leadId", l."name" AS "leadName", r."quoteId", q."number" AS "quoteNumber",
        r."reservedAt", r."expiresAt", r."depositRequiredCents", r."depositReceivedAt"
      FROM "StockReservation" r
      JOIN "Lead" l ON l."id" = r."leadId"
      LEFT JOIN "Quote" q ON q."id" = r."quoteId"
      WHERE r."stockUnitId" = ${id} AND r."status" = 'active'
      LIMIT 1
    `),
  ]);
  return { ...rows[0], movements, attachments, reservation: reservations[0] ?? null };
}

export async function updateStockUnitDetails(input: {
  id: string;
  stockNumber?: string | null;
  serial?: string | null;
  color?: string | null;
  locationId?: string | null;
  condition?: string;
  manufacturingYear?: number | null;
  batteryType?: string | null;
  batterySerial?: string | null;
  chargerSerial?: string | null;
  keyCount?: number | null;
  odometerKm?: number | null;
  operatingHours?: number | null;
  costCents?: number;
  landedCostCents?: number;
  notes?: string | null;
  consignmentOwner?: string | null;
  actor: Actor;
  reason?: string | null;
}) {
  await prisma.$transaction(async (tx) => {
    const current = await tx.$queryRaw<Array<{ costCents: number; landedCostCents: number }>>(Prisma.sql`
      SELECT "costCents", "landedCostCents" FROM "StockUnit"
      WHERE "id" = ${input.id} AND "deletedAt" IS NULL FOR UPDATE
    `);
    if (!current[0]) throw new Error("Stock unit not found");
    const serial = normalizeSerial(input.serial);
    const stockNumber = normalizeStockNumber(input.stockNumber);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "StockUnit" SET
        "stockNumber" = COALESCE(${stockNumber}, "stockNumber"),
        "serial" = ${serial},
        "color" = ${input.color ?? null},
        "locationId" = ${input.locationId ?? null},
        "condition" = ${input.condition ?? "new"},
        "manufacturingYear" = ${input.manufacturingYear ?? null},
        "batteryType" = ${input.batteryType ?? null},
        "batterySerial" = ${normalizeSerial(input.batterySerial)},
        "chargerSerial" = ${normalizeSerial(input.chargerSerial)},
        "keyCount" = ${input.keyCount ?? null},
        "odometerKm" = ${input.odometerKm ?? null},
        "operatingHours" = ${input.operatingHours ?? null},
        "costCents" = ${Math.max(0, input.costCents ?? current[0].costCents)},
        "landedCostCents" = ${Math.max(0, input.landedCostCents ?? current[0].landedCostCents)},
        "notes" = ${input.notes ?? null},
        "consignmentOwner" = ${input.consignmentOwner ?? null},
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${input.id}
    `);
    const newCost = Math.max(0, input.landedCostCents ?? current[0].landedCostCents);
    if (newCost !== current[0].landedCostCents) {
      await recordMovement(tx, {
        stockUnitId: input.id,
        eventType: "cost_adjusted",
        costBeforeCents: current[0].landedCostCents,
        costAfterCents: newCost,
        reason: input.reason ?? "Stock details updated",
        actor: input.actor,
      });
    }
  });
}

export async function createFloorStockUnit(input: {
  productId: string;
  color: string | null;
  serial: string | null;
  locationId: string | null;
  condition: string;
  costCents: number;
  landedCostCents: number;
  notes: string | null;
  actor: Actor;
}): Promise<string> {
  return prisma.$transaction(async (tx) => {
    const id = randomUUID();
    const stockNumber = `STK-${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "StockUnit" (
        "id", "productId", "color", "serial", "status", "costCents", "landedCostCents",
        "notes", "arrivedAt", "stockNumber", "locationId", "condition", "pdiStatus", "updatedAt"
      ) VALUES (
        ${id}, ${input.productId}, ${input.color}, ${normalizeSerial(input.serial)}, 'available',
        ${Math.max(0, input.costCents)}, ${Math.max(0, input.landedCostCents || input.costCents)},
        ${input.notes}, CURRENT_TIMESTAMP, ${stockNumber}, ${input.locationId}, ${input.condition || "new"},
        'not_started', CURRENT_TIMESTAMP
      )
    `);
    await recordMovement(tx, {
      stockUnitId: id,
      eventType: "floor_stock_added",
      fromStatus: null,
      toStatus: "available",
      costAfterCents: Math.max(0, input.landedCostCents || input.costCents),
      actor: input.actor,
    });
    return id;
  });
}

export async function reserveStockUnit(input: {
  stockUnitId: string;
  leadId: string;
  quoteId?: string | null;
  expiresAt?: Date | null;
  depositRequiredCents?: number;
  actor: Actor;
}) {
  await prisma.$transaction(async (tx) => {
    const units = await tx.$queryRaw<Array<{ status: string; productId: string }>>(Prisma.sql`
      SELECT "status", "productId" FROM "StockUnit"
      WHERE "id" = ${input.stockUnitId} AND "deletedAt" IS NULL FOR UPDATE
    `);
    const unit = units[0];
    if (!unit || unit.status !== "available") throw new Error("Only an available stock unit can be reserved");
    const leads = await tx.$queryRaw<Array<{ status: string; productId: string | null }>>(Prisma.sql`
      SELECT "status", "productId" FROM "Lead"
      WHERE "id" = ${input.leadId} AND "deletedAt" IS NULL
    `);
    const lead = leads[0];
    if (!lead || lead.status !== "open") throw new Error("Reservation requires an open lead");
    if (lead.productId && lead.productId !== unit.productId) throw new Error("The stock model does not match the lead's selected model");
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "StockReservation" (
        "id", "stockUnitId", "leadId", "quoteId", "expiresAt", "depositRequiredCents", "reservedById"
      ) VALUES (
        ${randomUUID()}, ${input.stockUnitId}, ${input.leadId}, ${input.quoteId ?? null}, ${input.expiresAt ?? null},
        ${Math.max(0, input.depositRequiredCents ?? 0)}, ${input.actor.id}
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "StockUnit"
      SET "status" = 'reserved', "reservedForLeadId" = ${input.leadId}, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${input.stockUnitId}
    `);
    await recordMovement(tx, {
      stockUnitId: input.stockUnitId,
      eventType: "reserved",
      fromStatus: "available",
      toStatus: "reserved",
      leadId: input.leadId,
      quoteId: input.quoteId ?? null,
      reason: input.expiresAt ? `Reserved until ${input.expiresAt.toISOString()}` : "Reserved without expiry",
      actor: input.actor,
    });
  });
}

export async function markReservationDeposit(input: { stockUnitId: string; actor: Actor }) {
  const changed = await prisma.$executeRaw(Prisma.sql`
    UPDATE "StockReservation"
    SET "depositReceivedAt" = CURRENT_TIMESTAMP
    WHERE "stockUnitId" = ${input.stockUnitId} AND "status" = 'active'
  `);
  if (changed !== 1) throw new Error("No active reservation found");
}

export async function releaseStockReservation(input: {
  stockUnitId: string;
  reason: string;
  actor: Actor;
}) {
  if (!input.reason.trim()) throw new Error("A release reason is required");
  await prisma.$transaction(async (tx) => {
    const reservations = await tx.$queryRaw<Array<{ id: string; leadId: string; quoteId: string | null }>>(Prisma.sql`
      SELECT "id", "leadId", "quoteId" FROM "StockReservation"
      WHERE "stockUnitId" = ${input.stockUnitId} AND "status" = 'active'
      FOR UPDATE
    `);
    const reservation = reservations[0];
    if (!reservation) throw new Error("No active reservation found");
    await tx.$executeRaw(Prisma.sql`
      UPDATE "StockReservation"
      SET "status" = 'released', "releasedAt" = CURRENT_TIMESTAMP, "releaseReason" = ${input.reason}
      WHERE "id" = ${reservation.id}
    `);
    const updated = await tx.$executeRaw(Prisma.sql`
      UPDATE "StockUnit"
      SET "status" = 'available', "reservedForLeadId" = NULL, "soldQuoteId" = NULL,
          "salePriceCents" = 0, "soldContactId" = NULL, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${input.stockUnitId} AND "status" = 'reserved' AND "deletedAt" IS NULL
    `);
    if (updated !== 1) throw new Error("The stock unit is no longer reserved");
    await recordMovement(tx, {
      stockUnitId: input.stockUnitId,
      eventType: "reservation_released",
      fromStatus: "reserved",
      toStatus: "available",
      leadId: reservation.leadId,
      quoteId: reservation.quoteId,
      reason: input.reason,
      actor: input.actor,
    });
  });
}

export async function allocateStockUnitToQuote(input: {
  stockUnitId: string;
  quoteId: string;
  actor: Actor;
}) {
  await prisma.$transaction(async (tx) => {
    const units = await tx.$queryRaw<Array<{ status: string; productId: string; reservedForLeadId: string | null }>>(Prisma.sql`
      SELECT "status", "productId", "reservedForLeadId" FROM "StockUnit"
      WHERE "id" = ${input.stockUnitId} AND "deletedAt" IS NULL FOR UPDATE
    `);
    const unit = units[0];
    if (!unit || !["available", "reserved"].includes(unit.status)) throw new Error("Only available or reserved stock can be allocated");
    const quotes = await tx.$queryRaw<Array<{
      status: string;
      leadId: string | null;
      contactId: string | null;
      depositPaidAt: Date | null;
      totalCents: number;
      matchesProduct: boolean;
    }>>(Prisma.sql`
      SELECT q."status", q."leadId", q."contactId", q."depositPaidAt",
        COALESCE(SUM(qi."qty" * qi."unitPriceCents" * (1 - qi."discountPct" / 100.0)) FILTER (WHERE qi."selected" = true), 0)::int AS "totalCents",
        BOOL_OR(qi."productId" = ${unit.productId}) OR EXISTS (
          SELECT 1 FROM "Lead" l WHERE l."id" = q."leadId" AND l."productId" = ${unit.productId}
        ) AS "matchesProduct"
      FROM "Quote" q
      LEFT JOIN "QuoteItem" qi ON qi."quoteId" = q."id"
      WHERE q."id" = ${input.quoteId} AND q."deletedAt" IS NULL AND q."supersededAt" IS NULL
      GROUP BY q."id"
    `);
    const quote = quotes[0];
    if (!quote || quote.status !== "accepted") throw new Error("Stock can only be allocated to an accepted quote");
    if (!quote.matchesProduct) throw new Error("The quote does not contain this stock model");
    if (unit.reservedForLeadId && quote.leadId && unit.reservedForLeadId !== quote.leadId) {
      throw new Error("The unit is reserved for a different lead");
    }
    const existing = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "StockUnit"
      WHERE "soldQuoteId" = ${input.quoteId}
        AND "deletedAt" IS NULL
        AND "status" IN ('allocated','pdi','ready','sold','delivered')
        AND "id" <> ${input.stockUnitId}
      LIMIT 1
    `);
    if (existing.length > 0) throw new Error("This quote already has an allocated stock unit");
    await tx.$executeRaw(Prisma.sql`
      UPDATE "StockUnit"
      SET "status" = 'allocated', "soldQuoteId" = ${input.quoteId}, "soldContactId" = ${quote.contactId},
          "reservedForLeadId" = COALESCE(${quote.leadId}, "reservedForLeadId"),
          "salePriceCents" = ${Math.max(0, quote.totalCents)}, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${input.stockUnitId}
    `);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "StockReservation"
      SET "quoteId" = ${input.quoteId}, "status" = 'allocated'
      WHERE "stockUnitId" = ${input.stockUnitId} AND "status" = 'active'
    `);
    await recordMovement(tx, {
      stockUnitId: input.stockUnitId,
      eventType: "quote_allocated",
      fromStatus: unit.status,
      toStatus: "allocated",
      leadId: quote.leadId,
      quoteId: input.quoteId,
      reason: quote.depositPaidAt ? "Accepted quote with deposit received" : "Accepted quote allocated before deposit",
      actor: input.actor,
    });
  });
}

export async function transitionStockUnit(input: {
  stockUnitId: string;
  toStatus: StockStatus;
  reason: string;
  notes?: string | null;
  actor: Actor;
}) {
  if (!input.reason.trim()) throw new Error("A reason is required");
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ status: string; pdiStatus: string }>>(Prisma.sql`
      SELECT "status", "pdiStatus" FROM "StockUnit"
      WHERE "id" = ${input.stockUnitId} AND "deletedAt" IS NULL FOR UPDATE
    `);
    const unit = rows[0];
    if (!unit || !isStockStatus(unit.status)) throw new Error("Stock unit not found");
    if (!canTransitionStock(unit.status, input.toStatus)) {
      throw new Error(`Cannot move ${STOCK_STATUS_LABELS[unit.status]} to ${STOCK_STATUS_LABELS[input.toStatus]}`);
    }
    if (input.toStatus === "ready" && unit.pdiStatus !== "completed") throw new Error("Complete the PDI checklist before marking the unit ready");
    await tx.$executeRaw(Prisma.sql`
      UPDATE "StockUnit" SET
        "status" = ${input.toStatus},
        "holdReason" = CASE WHEN ${input.toStatus} IN ('hold','damaged') THEN ${input.reason} ELSE NULL END,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${input.stockUnitId}
    `);
    await recordMovement(tx, {
      stockUnitId: input.stockUnitId,
      eventType: `status_${input.toStatus}`,
      fromStatus: unit.status,
      toStatus: input.toStatus,
      reason: input.reason,
      notes: input.notes ?? null,
      actor: input.actor,
    });
  });
}

export async function startStockPdi(input: { stockUnitId: string; actor: Actor }) {
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ status: string }>>(Prisma.sql`
      SELECT "status" FROM "StockUnit" WHERE "id" = ${input.stockUnitId} AND "deletedAt" IS NULL FOR UPDATE
    `);
    if (!rows[0] || rows[0].status !== "allocated") throw new Error("Only allocated stock can enter PDI");
    await tx.$executeRaw(Prisma.sql`
      UPDATE "StockUnit" SET "status" = 'pdi', "pdiStatus" = 'in_progress', "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${input.stockUnitId}
    `);
    await recordMovement(tx, {
      stockUnitId: input.stockUnitId,
      eventType: "pdi_started",
      fromStatus: "allocated",
      toStatus: "pdi",
      actor: input.actor,
    });
  });
}

export async function completeStockPdi(input: {
  stockUnitId: string;
  checklist: Record<string, boolean | string>;
  notes?: string | null;
  actor: Actor;
}) {
  const required = ["battery", "charger", "tyres", "brakes", "lights", "body", "keys", "roadTest"];
  if (required.some((key) => input.checklist[key] !== true)) throw new Error("Complete every required PDI check before releasing the unit");
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ status: string }>>(Prisma.sql`
      SELECT "status" FROM "StockUnit" WHERE "id" = ${input.stockUnitId} AND "deletedAt" IS NULL FOR UPDATE
    `);
    if (!rows[0] || rows[0].status !== "pdi") throw new Error("The unit is not currently in PDI");
    await tx.$executeRaw(Prisma.sql`
      UPDATE "StockUnit" SET
        "status" = 'ready', "pdiStatus" = 'completed', "pdiChecklist" = ${JSON.stringify(input.checklist)}::jsonb,
        "pdiCompletedAt" = CURRENT_TIMESTAMP, "pdiCompletedById" = ${input.actor.id}, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${input.stockUnitId}
    `);
    await recordMovement(tx, {
      stockUnitId: input.stockUnitId,
      eventType: "pdi_completed",
      fromStatus: "pdi",
      toStatus: "ready",
      notes: input.notes ?? null,
      actor: input.actor,
    });
  });
}

export async function archiveStockUnit(input: { stockUnitId: string; reason: string; actor: Actor }) {
  if (!input.reason.trim()) throw new Error("A removal reason is required");
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ status: string }>>(Prisma.sql`
      SELECT "status" FROM "StockUnit" WHERE "id" = ${input.stockUnitId} AND "deletedAt" IS NULL FOR UPDATE
    `);
    if (!rows[0]) throw new Error("Stock unit not found");
    if (["allocated", "pdi", "ready", "sold", "delivered"].includes(rows[0].status)) {
      throw new Error("Allocated, delivery-ready or delivered stock cannot be removed directly");
    }
    await tx.$executeRaw(Prisma.sql`
      UPDATE "StockUnit"
      SET "status" = 'archived', "deletedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${input.stockUnitId}
    `);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "StockReservation"
      SET "status" = 'cancelled', "releasedAt" = CURRENT_TIMESTAMP, "releaseReason" = ${input.reason}
      WHERE "stockUnitId" = ${input.stockUnitId} AND "status" = 'active'
    `);
    await recordMovement(tx, {
      stockUnitId: input.stockUnitId,
      eventType: "archived",
      fromStatus: rows[0].status,
      toStatus: "archived",
      reason: input.reason,
      actor: input.actor,
    });
  });
}

export async function createStockLocation(input: {
  name: string;
  type: string;
  address?: string | null;
  isDefault?: boolean;
}) {
  const name = input.name.trim();
  if (!name) throw new Error("Location name is required");
  await prisma.$transaction(async (tx) => {
    if (input.isDefault) await tx.$executeRaw(Prisma.sql`UPDATE "StockLocation" SET "isDefault" = false`);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "StockLocation" ("id", "name", "type", "address", "isDefault")
      VALUES (${randomUUID()}, ${name}, ${input.type || "showroom"}, ${input.address ?? null}, ${Boolean(input.isDefault)})
    `);
  });
}

export async function addStockAttachment(input: {
  stockUnitId: string;
  fileName: string;
  storedName: string;
  mimeType: string;
  sizeBytes: number;
  category: string;
  uploadedById: string;
}) {
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "StockAttachment" (
      "id", "stockUnitId", "fileName", "storedName", "mimeType", "sizeBytes", "category", "uploadedById"
    ) VALUES (
      ${randomUUID()}, ${input.stockUnitId}, ${input.fileName}, ${input.storedName}, ${input.mimeType},
      ${input.sizeBytes}, ${input.category}, ${input.uploadedById}
    )
  `);
}

export type QuoteStockAssignment = {
  quoteId: string;
  stockUnitId: string;
  stockNumber: string | null;
  serial: string | null;
  productName: string;
  color: string | null;
  status: string;
  pdiStatus: string;
};

export async function getQuoteStockAssignments(quoteIds: string[]): Promise<QuoteStockAssignment[]> {
  if (quoteIds.length === 0) return [];
  return prisma.$queryRaw<QuoteStockAssignment[]>(Prisma.sql`
    SELECT su."soldQuoteId" AS "quoteId", su."id" AS "stockUnitId", su."stockNumber", su."serial",
      p."name" AS "productName", su."color", su."status", su."pdiStatus"
    FROM "StockUnit" su
    JOIN "Product" p ON p."id" = su."productId"
    WHERE su."soldQuoteId" IN (${Prisma.join(quoteIds)})
      AND su."deletedAt" IS NULL
      AND su."status" IN ('allocated','pdi','ready','sold','delivered')
  `);
}

export async function assertQuoteHasAllocatedStock(quoteId: string) {
  const rows = await getQuoteStockAssignments([quoteId]);
  if (!rows[0]) throw new Error("Allocate a physical stock unit to this quote before scheduling delivery");
  return rows[0];
}

export async function assertQuoteStockReady(quoteId: string) {
  const assignment = await assertQuoteHasAllocatedStock(quoteId);
  if (!["ready", "sold"].includes(assignment.status) || assignment.pdiStatus !== "completed") {
    throw new Error("Complete PDI and mark the allocated stock unit ready before delivery");
  }
  return assignment;
}

export async function completeStockDeliveryForQuote(input: {
  quoteId: string;
  actor: Actor;
}): Promise<{ stockUnitId: string; vehicleId: string | null }> {
  return prisma.$transaction(async (tx) => {
    const assignments = await tx.$queryRaw<Array<QuoteStockAssignment & {
      productId: string;
      landedCostCents: number;
      salePriceCents: number;
      soldContactId: string | null;
    }>>(Prisma.sql`
      SELECT su."soldQuoteId" AS "quoteId", su."id" AS "stockUnitId", su."stockNumber", su."serial",
        p."name" AS "productName", su."productId", su."color", su."status", su."pdiStatus",
        su."landedCostCents", su."salePriceCents", su."soldContactId"
      FROM "StockUnit" su
      JOIN "Product" p ON p."id" = su."productId"
      WHERE su."soldQuoteId" = ${input.quoteId} AND su."deletedAt" IS NULL
      FOR UPDATE
    `);
    const unit = assignments[0];
    if (!unit || !["ready", "sold"].includes(unit.status) || unit.pdiStatus !== "completed") {
      throw new Error("The quote does not have a PDI-complete stock unit ready for delivery");
    }
    const quotes = await tx.$queryRaw<Array<{
      number: number;
      contactId: string | null;
      leadId: string | null;
      deliveredAt: Date | null;
    }>>(Prisma.sql`
      SELECT "number", "contactId", "leadId", "deliveredAt" FROM "Quote"
      WHERE "id" = ${input.quoteId} FOR UPDATE
    `);
    const quote = quotes[0];
    if (!quote || quote.deliveredAt) throw new Error("Quote is not available for delivery completion");
    await tx.$executeRaw(Prisma.sql`
      UPDATE "StockUnit" SET
        "status" = 'delivered', "soldAt" = COALESCE("soldAt", CURRENT_TIMESTAMP),
        "deliveredAt" = CURRENT_TIMESTAMP, "warrantyStartedAt" = CURRENT_TIMESTAMP,
        "warrantyExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '12 months', "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${unit.stockUnitId}
    `);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "StockReservation"
      SET "status" = 'fulfilled', "releasedAt" = CURRENT_TIMESTAMP
      WHERE "stockUnitId" = ${unit.stockUnitId} AND "status" IN ('active','allocated')
    `);
    let vehicleId: string | null = null;
    if (quote.contactId) {
      const existing = unit.serial
        ? await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            SELECT "id" FROM "Vehicle" WHERE UPPER("vin") = ${unit.serial.toUpperCase()} AND "deletedAt" IS NULL LIMIT 1
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
            ${`Created automatically from delivered stock ${unit.stockNumber ?? unit.stockUnitId} / quote Q-${quote.number}`},
            CURRENT_TIMESTAMP, ${quote.contactId}, ${unit.productId}
          )
        `);
      }
    }
    await recordMovement(tx, {
      stockUnitId: unit.stockUnitId,
      eventType: "delivered",
      fromStatus: unit.status,
      toStatus: "delivered",
      quoteId: input.quoteId,
      leadId: quote.leadId,
      reason: `Delivered against quote Q-${quote.number}`,
      actor: input.actor,
    });
    return { stockUnitId: unit.stockUnitId, vehicleId };
  });
}

export async function stockExportRows(): Promise<Array<Record<string, string | number | null>>> {
  const rows = await prisma.$queryRaw<Array<{
    stockNumber: string | null;
    productName: string;
    color: string | null;
    serial: string | null;
    status: string;
    condition: string;
    locationName: string | null;
    arrivedAt: Date | null;
    landedCostCents: number;
    salePriceCents: number;
    leadName: string | null;
    quoteNumber: number | null;
    pdiStatus: string;
  }>>(Prisma.sql`
    SELECT su."stockNumber", p."name" AS "productName", su."color", su."serial", su."status",
      su."condition", loc."name" AS "locationName", su."arrivedAt", su."landedCostCents",
      su."salePriceCents", l."name" AS "leadName", q."number" AS "quoteNumber", su."pdiStatus"
    FROM "StockUnit" su
    JOIN "Product" p ON p."id" = su."productId"
    LEFT JOIN "StockLocation" loc ON loc."id" = su."locationId"
    LEFT JOIN "Lead" l ON l."id" = su."reservedForLeadId"
    LEFT JOIN "Quote" q ON q."id" = su."soldQuoteId"
    WHERE su."deletedAt" IS NULL
    ORDER BY p."name", su."createdAt"
  `);
  return rows.map((row) => ({
    "Stock number": row.stockNumber,
    Model: row.productName,
    Colour: row.color,
    "Serial / VIN": row.serial,
    Status: row.status,
    Condition: row.condition,
    Location: row.locationName,
    "Arrived at": row.arrivedAt?.toISOString() ?? null,
    "Age days": stockAgeDays(row.arrivedAt),
    "Landed cost": row.landedCostCents / 100,
    "Sale value": row.salePriceCents / 100,
    "Reserved lead": row.leadName,
    "Quote number": row.quoteNumber,
    PDI: row.pdiStatus,
  }));
}
