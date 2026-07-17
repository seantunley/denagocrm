"use server";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireLeadAccess, requirePermission, requireQuoteAccess } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import {
  addStockEvent,
  canTransitionStock,
  nextStockNumber,
  type StockActor,
} from "@/lib/stockPlatform";

const rand = (value: FormDataEntryValue | null) => {
  const parsed = Number.parseFloat(String(value ?? "0").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed * 100)) : 0;
};
const integer = (value: FormDataEntryValue | null, fallback = 0) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const str = (value: FormDataEntryValue | null) => String(value ?? "").trim();
const date = (value: FormDataEntryValue | null) => {
  const raw = str(value);
  return raw ? new Date(`${raw}T00:00:00+02:00`) : null;
};
const actor = (user: { id: string; name: string }): StockActor => ({ id: user.id, name: user.name });
const refresh = (id?: string) => {
  revalidatePath("/stock");
  revalidatePath("/stock/purchase-orders");
  if (id) revalidatePath(`/stock/${id}`);
};

async function activeUnit(id: string) {
  const [unit] = await prisma.$queryRaw<Array<{
    id: string; status: string; productId: string; serial: string | null; stockNumber: string | null;
    costCents: number; landedCostCents: number; reservedForLeadId: string | null; soldQuoteId: string | null;
    productName: string; color: string | null;
  }>>(Prisma.sql`
    SELECT su."id", su."status", su."productId", su."serial", su."stockNumber", su."costCents",
      su."landedCostCents", su."reservedForLeadId", su."soldQuoteId", p."name" AS "productName", su."color"
    FROM "StockUnit" su JOIN "Product" p ON p."id" = su."productId"
    WHERE su."id" = ${id} AND su."deletedAt" IS NULL
  `);
  if (!unit) throw new Error("Stock unit not found");
  return unit;
}

async function assertUniqueSerial(serial: string | null, exceptId?: string) {
  if (!serial) return;
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "StockUnit"
    WHERE UPPER("serial") = UPPER(${serial}) AND "deletedAt" IS NULL
      ${exceptId ? Prisma.sql`AND "id" <> ${exceptId}` : Prisma.empty}
    LIMIT 1
  `);
  if (rows.length) throw new Error("That serial/VIN is already assigned to another active stock unit");
}

export async function createPurchaseOrder(formData: FormData) {
  const user = await requirePermission("stock.manage");
  const supplier = str(formData.get("supplier")) || "Denago";
  const reference = str(formData.get("reference")) || null;
  const expectedAt = date(formData.get("expectedAt"));
  const notes = str(formData.get("notes")) || null;
  let lines: Array<{ productId: string; color?: string; qty: number; costCents: number; freightCents?: number; notes?: string }> = [];
  const encoded = str(formData.get("lines"));
  if (encoded) {
    try {
      const parsed = JSON.parse(encoded) as Array<Record<string, unknown>>;
      lines = parsed.map((line) => ({
        productId: String(line.productId ?? ""),
        color: String(line.color ?? "").trim() || undefined,
        qty: Math.max(1, Math.min(200, Number(line.qty) || 1)),
        costCents: Math.max(0, Math.round((Number(line.cost) || 0) * 100)),
        freightCents: Math.max(0, Math.round((Number(line.freight) || 0) * 100)),
        notes: String(line.notes ?? "").trim() || undefined,
      })).filter((line) => line.productId);
    } catch {
      throw new Error("Purchase-order lines are invalid");
    }
  }
  if (!lines.length) {
    const productId = str(formData.get("productId"));
    if (!productId) return;
    lines = [{
      productId,
      color: str(formData.get("color")) || undefined,
      qty: Math.max(1, Math.min(200, integer(formData.get("qty"), 1))),
      costCents: rand(formData.get("cost")),
    }];
  }

  const order = await prisma.$transaction(async (tx) => {
    const po = await tx.purchaseOrder.create({ data: { supplier, reference, expectedAt, notes } });
    for (const line of lines) {
      const lineId = randomUUID();
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "PurchaseOrderLine" (
          "id", "purchaseOrderId", "productId", "color", "orderedQty", "unitCostCents", "freightCents", "notes"
        ) VALUES (
          ${lineId}, ${po.id}, ${line.productId}, ${line.color ?? null}, ${line.qty},
          ${line.costCents}, ${line.freightCents ?? 0}, ${line.notes ?? null}
        )
      `);
      await tx.stockUnit.createMany({
        data: Array.from({ length: line.qty }, () => ({
          productId: line.productId,
          color: line.color ?? null,
          costCents: line.costCents,
          status: "incoming",
          purchaseOrderId: po.id,
        })),
      });
    }
    return po;
  });

  await addStockEvent({
    purchaseOrderId: order.id,
    eventType: "purchase_order.created",
    detail: `${lines.reduce((sum, line) => sum + line.qty, 0)} units across ${lines.length} line${lines.length === 1 ? "" : "s"}`,
    actor: actor(user),
  });
  await logAudit({
    action: "stock.po_created",
    summary: `Created purchase order${reference ? ` ${reference}` : ""} for ${lines.reduce((sum, line) => sum + line.qty, 0)} units`,
    user,
  });
  refresh();
}

/** Receives all outstanding units into inspection. A later inspection releases accepted units to Available. */
export async function receivePurchaseOrder(id: string, formData?: FormData) {
  const user = await requirePermission("stock.manage");
  const receiptReference = formData ? str(formData.get("receiptReference")) || null : null;
  const notes = formData ? str(formData.get("notes")) || null : null;
  const receiptId = randomUUID();
  const received = await prisma.$transaction(async (tx) => {
    const po = await tx.purchaseOrder.findFirst({ where: { id, deletedAt: null } });
    if (!po || !["ordered", "partially_received"].includes(po.status)) throw new Error("This purchase order cannot be received");
    const units = await tx.stockUnit.findMany({ where: { purchaseOrderId: id, status: "incoming", deletedAt: null } });
    if (!units.length) throw new Error("There are no outstanding units on this order");
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "GoodsReceipt" ("id", "purchaseOrderId", "reference", "receivedById", "notes")
      VALUES (${receiptId}, ${id}, ${receiptReference}, ${user.id}, ${notes})
    `);
    for (const unit of units) {
      await tx.stockUnit.update({ where: { id: unit.id }, data: { status: "received_pending_check", arrivedAt: new Date() } });
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "GoodsReceiptLine" ("id", "goodsReceiptId", "stockUnitId", "accepted")
        VALUES (${randomUUID()}, ${receiptId}, ${unit.id}, true)
      `);
    }
    await tx.purchaseOrder.update({ where: { id }, data: { status: "received" } });
    return units;
  });
  for (const unit of received) {
    await addStockEvent({ stockUnitId: unit.id, purchaseOrderId: id, eventType: "goods.received", fromStatus: "incoming", toStatus: "received_pending_check", actor: actor(user) });
  }
  await logAudit({ action: "stock.po_received", summary: `Received ${received.length} units for inspection`, user });
  refresh();
}

export async function cancelPurchaseOrder(id: string, formData?: FormData) {
  const user = await requirePermission("stock.manage");
  const reason = formData ? str(formData.get("reason")) || "Cancelled by user" : "Cancelled by user";
  const count = await prisma.$transaction(async (tx) => {
    const po = await tx.purchaseOrder.findFirst({ where: { id, deletedAt: null } });
    if (!po || !["ordered", "partially_received"].includes(po.status)) throw new Error("Only open purchase orders can be cancelled");
    const result = await tx.stockUnit.updateMany({
      where: { purchaseOrderId: id, status: "incoming", deletedAt: null },
      data: { deletedAt: new Date() },
    });
    await tx.purchaseOrder.update({ where: { id }, data: { status: "cancelled", notes: [po.notes, `Cancellation: ${reason}`].filter(Boolean).join("\n") } });
    return result.count;
  });
  await addStockEvent({ purchaseOrderId: id, eventType: "purchase_order.cancelled", reason, detail: `${count} incoming units removed`, actor: actor(user) });
  await logAudit({ action: "stock.po_cancelled", summary: `Cancelled purchase order — ${reason}`, user });
  refresh();
}

export async function addStockUnit(formData: FormData) {
  const user = await requirePermission("stock.manage");
  const productId = str(formData.get("productId"));
  if (!productId) return;
  const serial = str(formData.get("serial")).toUpperCase() || null;
  await assertUniqueSerial(serial);
  const stockNumber = await nextStockNumber();
  const costCents = rand(formData.get("cost"));
  const unit = await prisma.stockUnit.create({
    data: {
      productId,
      color: str(formData.get("color")) || null,
      serial,
      costCents,
      notes: str(formData.get("notes")) || null,
      status: "available",
      arrivedAt: new Date(),
    },
    include: { product: true },
  });
  await prisma.$executeRaw(Prisma.sql`
    UPDATE "StockUnit" SET "stockNumber" = ${stockNumber}, "landedCostCents" = ${costCents},
      "location" = ${str(formData.get("location")) || null}, "condition" = ${str(formData.get("condition")) || "new"},
      "batterySerial" = ${str(formData.get("batterySerial")) || null}, "chargerSerial" = ${str(formData.get("chargerSerial")) || null},
      "odometerKm" = ${integer(formData.get("odometerKm"), 0) || null}, "updatedAt" = NOW()
    WHERE "id" = ${unit.id}
  `);
  await addStockEvent({ stockUnitId: unit.id, eventType: "unit.created", toStatus: "available", costAfterCents: costCents, detail: stockNumber, actor: actor(user) });
  await logAudit({ action: "stock.unit_added", summary: `Added ${stockNumber}: ${unit.product.name}${serial ? ` — ${serial}` : ""}`, user });
  refresh(unit.id);
  redirect(`/stock/${unit.id}`);
}

export async function updateStockUnit(id: string, formData: FormData) {
  const user = await requirePermission("stock.manage");
  const current = await activeUnit(id);
  const serial = str(formData.get("serial")).toUpperCase() || null;
  await assertUniqueSerial(serial, id);
  const costCents = rand(formData.get("cost"));
  const landedCostCents = rand(formData.get("landedCost")) || costCents;
  await prisma.$executeRaw(Prisma.sql`
    UPDATE "StockUnit" SET
      "serial" = ${serial}, "color" = ${str(formData.get("color")) || null},
      "costCents" = ${costCents}, "landedCostCents" = ${landedCostCents},
      "notes" = ${str(formData.get("notes")) || null}, "location" = ${str(formData.get("location")) || null},
      "condition" = ${str(formData.get("condition")) || "new"},
      "batterySerial" = ${str(formData.get("batterySerial")) || null},
      "chargerSerial" = ${str(formData.get("chargerSerial")) || null},
      "odometerKm" = ${integer(formData.get("odometerKm"), 0) || null}, "updatedAt" = NOW()
    WHERE "id" = ${id} AND "deletedAt" IS NULL
  `);
  await addStockEvent({
    stockUnitId: id,
    eventType: "unit.updated",
    costBeforeCents: current.landedCostCents || current.costCents,
    costAfterCents: landedCostCents,
    detail: "Unit identity, condition, location or cost updated",
    actor: actor(user),
  });
  await logAudit({ action: "stock.unit_updated", summary: `Updated ${current.stockNumber ?? current.productName}`, user });
  refresh(id);
}

export async function inspectReceivedUnit(id: string, formData: FormData) {
  const user = await requirePermission("stock.manage");
  const current = await activeUnit(id);
  if (current.status !== "received_pending_check") throw new Error("Only newly received units can be inspected");
  const accepted = formData.get("accepted") !== "no";
  const serial = str(formData.get("serial")).toUpperCase() || null;
  await assertUniqueSerial(serial, id);
  const stockNumber = current.stockNumber ?? await nextStockNumber();
  const toStatus = accepted ? "available" : "damaged";
  await prisma.$executeRaw(Prisma.sql`
    UPDATE "StockUnit" SET "status" = ${toStatus}, "serial" = ${serial}, "stockNumber" = ${stockNumber},
      "location" = ${str(formData.get("location")) || null}, "notes" = ${str(formData.get("conditionNote")) || null},
      "condition" = ${accepted ? "new" : "damaged"}, "landedCostCents" = CASE WHEN "landedCostCents" = 0 THEN "costCents" ELSE "landedCostCents" END,
      "updatedAt" = NOW() WHERE "id" = ${id} AND "status" = 'received_pending_check' AND "deletedAt" IS NULL
  `);
  await addStockEvent({ stockUnitId: id, eventType: "goods.inspected", fromStatus: current.status, toStatus, reason: str(formData.get("conditionNote")) || null, detail: stockNumber, actor: actor(user) });
  refresh(id);
}

export async function reserveUnit(id: string, formData: FormData) {
  const leadId = str(formData.get("leadId"));
  if (!leadId) throw new Error("Choose a lead");
  const user = await requireLeadAccess(leadId, "stock.manage");
  const current = await activeUnit(id);
  if (current.status !== "available") throw new Error("Only available stock can be reserved");
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, productId: true, status: true } });
  if (!lead || lead.status !== "open") throw new Error("Only an open lead can reserve stock");
  if (lead.productId && lead.productId !== current.productId) throw new Error("This unit does not match the lead's selected product");
  const days = Math.max(1, Math.min(30, integer(formData.get("days"), 3)));
  const expiresAt = new Date(Date.now() + days * 86_400_000);
  const depositRequiredCents = rand(formData.get("depositRequired"));

  const changed = await prisma.$transaction(async (tx) => {
    const result = await tx.stockUnit.updateMany({
      where: { id, status: "available", deletedAt: null },
      data: { status: "reserved", reservedForLeadId: leadId },
    });
    if (result.count !== 1) return false;
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "StockReservation" (
        "id", "stockUnitId", "leadId", "status", "expiresAt", "depositRequiredCents", "reservedById"
      ) VALUES (${randomUUID()}, ${id}, ${leadId}, 'active', ${expiresAt}, ${depositRequiredCents}, ${user.id})
    `);
    return true;
  });
  if (!changed) throw new Error("This unit was reserved by someone else. Refresh and choose another unit.");
  await addStockEvent({ stockUnitId: id, eventType: "reservation.created", fromStatus: "available", toStatus: "reserved", leadId, detail: `Expires ${expiresAt.toISOString()}`, actor: actor(user) });
  await logAudit({ action: "stock.reserved", summary: `Reserved ${current.stockNumber ?? current.productName} for ${lead.name}`, leadId, user });
  refresh(id);
}

export async function recordReservationDeposit(id: string, formData: FormData) {
  const user = await requirePermission("stock.manage");
  const reference = str(formData.get("reference"));
  const rows = await prisma.$queryRaw<Array<{ leadId: string }>>(Prisma.sql`
    UPDATE "StockReservation" SET "depositReceivedAt" = NOW()
    WHERE "stockUnitId" = ${id} AND "status" = 'active' AND "depositReceivedAt" IS NULL
    RETURNING "leadId"
  `);
  if (!rows.length) throw new Error("No active reservation was found");
  await addStockEvent({ stockUnitId: id, eventType: "reservation.deposit_received", leadId: rows[0].leadId, detail: reference || null, actor: actor(user) });
  refresh(id);
}

export async function releaseUnit(id: string, formData?: FormData) {
  const user = await requirePermission("stock.manage");
  const current = await activeUnit(id);
  if (!["reserved", "allocated"].includes(current.status)) throw new Error("Only reserved or allocated stock can be released");
  const reason = formData ? str(formData.get("reason")) || "Released manually" : "Released manually";
  await prisma.$transaction(async (tx) => {
    await tx.stockUnit.update({ where: { id }, data: { status: "available", reservedForLeadId: null, soldQuoteId: null, soldAt: null } });
    await tx.$executeRaw(Prisma.sql`
      UPDATE "StockReservation" SET "status" = 'released', "releasedAt" = NOW(), "releaseReason" = ${reason}
      WHERE "stockUnitId" = ${id} AND "status" = 'active'
    `);
  });
  await addStockEvent({ stockUnitId: id, eventType: "reservation.released", fromStatus: current.status, toStatus: "available", leadId: current.reservedForLeadId, reason, actor: actor(user) });
  await logAudit({ action: "stock.released", summary: `Released ${current.stockNumber ?? current.productName} — ${reason}`, leadId: current.reservedForLeadId, user });
  refresh(id);
}

export async function allocateUnit(id: string, formData: FormData) {
  const quoteId = str(formData.get("quoteId"));
  if (!quoteId) throw new Error("Choose an accepted quote");
  const user = await requireQuoteAccess(quoteId, "stock.manage");
  const current = await activeUnit(id);
  if (!["available", "reserved"].includes(current.status)) throw new Error("This unit cannot be allocated from its current status");
  const quote = await prisma.quote.findUnique({ where: { id: quoteId }, include: { items: true, lead: true, contact: true } });
  if (!quote || quote.status !== "accepted") throw new Error("Stock can only be allocated to an accepted quote");
  const matches = quote.items.some((item) => item.productId === current.productId && item.selected);
  if (!matches) throw new Error("The accepted quote does not contain this product");
  const result = await prisma.stockUnit.updateMany({
    where: { id, status: { in: ["available", "reserved"] }, deletedAt: null },
    data: { status: "allocated", soldQuoteId: quoteId, reservedForLeadId: quote.leadId ?? current.reservedForLeadId },
  });
  if (result.count !== 1) throw new Error("The stock unit changed while you were allocating it");
  await prisma.$executeRaw(Prisma.sql`
    UPDATE "StockReservation" SET "quoteId" = ${quoteId}, "status" = 'converted'
    WHERE "stockUnitId" = ${id} AND "status" = 'active'
  `);
  await addStockEvent({ stockUnitId: id, eventType: "unit.allocated", fromStatus: current.status, toStatus: "allocated", leadId: quote.leadId, quoteId, actor: actor(user) });
  await logAudit({ action: "stock.allocated", summary: `Allocated ${current.stockNumber ?? current.productName} to quote Q-${quote.number}`, leadId: quote.leadId, user });
  refresh(id);
}

export async function transitionStockUnit(id: string, formData: FormData) {
  const user = await requirePermission("stock.manage");
  const current = await activeUnit(id);
  const toStatus = str(formData.get("status"));
  const reason = str(formData.get("reason")) || null;
  if (!canTransitionStock(current.status, toStatus)) throw new Error(`Cannot move stock from ${current.status} to ${toStatus}`);
  const result = await prisma.stockUnit.updateMany({ where: { id, status: current.status, deletedAt: null }, data: { status: toStatus } });
  if (result.count !== 1) throw new Error("The stock unit changed while this action was being processed");
  await prisma.$executeRaw(Prisma.sql`
    UPDATE "StockUnit" SET "updatedAt" = NOW(),
      "pdiStatus" = CASE WHEN ${toStatus} = 'pdi' THEN 'in_progress' ELSE "pdiStatus" END
    WHERE "id" = ${id}
  `);
  await addStockEvent({ stockUnitId: id, eventType: "unit.status_changed", fromStatus: current.status, toStatus, reason, actor: actor(user) });
  refresh(id);
}

export async function completePdi(id: string, formData: FormData) {
  const user = await requirePermission("stock.manage");
  const current = await activeUnit(id);
  if (current.status !== "pdi") throw new Error("The unit must be in PDI before it can be completed");
  const issues = str(formData.get("issues"));
  const passed = formData.get("passed") !== "no";
  const toStatus = passed ? "ready_for_delivery" : "hold";
  await prisma.$executeRaw(Prisma.sql`
    UPDATE "StockUnit" SET "status" = ${toStatus}, "pdiStatus" = ${passed ? "passed" : "failed"},
      "pdiCompletedAt" = NOW(), "updatedAt" = NOW(),
      "notes" = CASE WHEN ${issues || null} IS NULL THEN "notes" ELSE CONCAT_WS(E'\n', "notes", ${issues || null}) END
    WHERE "id" = ${id} AND "status" = 'pdi' AND "deletedAt" IS NULL
  `);
  await addStockEvent({ stockUnitId: id, eventType: "pdi.completed", fromStatus: "pdi", toStatus, reason: issues || null, actor: actor(user) });
  refresh(id);
}

export async function markUnitSold(id: string, formData: FormData) {
  return allocateUnit(id, formData);
}

export async function deliverStockUnit(id: string, formData: FormData) {
  const user = await requirePermission("stock.manage");
  const current = await activeUnit(id);
  if (current.status !== "ready_for_delivery") throw new Error("Only a PDI-passed unit can be delivered");
  if (!current.soldQuoteId) throw new Error("Allocate the unit to an accepted quote before delivery");
  const quote = await prisma.quote.findUnique({
    where: { id: current.soldQuoteId },
    include: { contact: true, lead: { include: { contact: true } }, items: true },
  });
  const contact = quote?.contact ?? quote?.lead?.contact ?? null;
  if (!quote || quote.status !== "accepted" || !contact) throw new Error("The accepted quote must be linked to a contact before delivery");
  const salePriceCents = quote.items.filter((item) => item.productId === current.productId && item.selected)
    .reduce((sum, item) => sum + Math.round(item.qty * item.unitPriceCents * (1 - item.discountPct / 100)), 0);
  const warrantyMonths = Math.max(0, integer(formData.get("warrantyMonths"), 12));
  const deliveredAt = new Date();
  const warrantyEndAt = warrantyMonths ? new Date(deliveredAt.getFullYear(), deliveredAt.getMonth() + warrantyMonths, deliveredAt.getDate()) : null;

  await prisma.$transaction(async (tx) => {
    await tx.stockUnit.update({ where: { id }, data: { status: "sold", soldAt: deliveredAt } });
    await tx.$executeRaw(Prisma.sql`
      UPDATE "StockUnit" SET "status" = 'delivered', "deliveredAt" = ${deliveredAt}, "salePriceCents" = ${salePriceCents},
        "warrantyStartAt" = ${deliveredAt}, "warrantyEndAt" = ${warrantyEndAt}, "updatedAt" = NOW()
      WHERE "id" = ${id}
    `);
    const existing = current.serial ? await tx.vehicle.findUnique({ where: { vin: current.serial } }) : null;
    if (!existing) {
      await tx.vehicle.create({
        data: {
          model: current.productName,
          vin: current.serial,
          color: current.color,
          purchaseDate: deliveredAt,
          warrantyMonths: warrantyMonths || null,
          notes: `Created automatically from stock unit ${current.stockNumber ?? id}`,
          contactId: contact.id,
          productId: current.productId,
        },
      });
    }
  });
  await addStockEvent({ stockUnitId: id, eventType: "unit.delivered", fromStatus: "ready_for_delivery", toStatus: "delivered", leadId: quote.leadId, quoteId: quote.id, detail: `Sale value ${salePriceCents}`, actor: actor(user) });
  await logAudit({ action: "stock.delivered", summary: `Delivered ${current.stockNumber ?? current.productName} to ${contact.firstName}`, contactId: contact.id, leadId: quote.leadId, user });
  revalidatePath(`/contacts/${contact.id}`);
  revalidatePath("/vehicles");
  refresh(id);
}

export async function deleteStockUnit(id: string, formData?: FormData) {
  const user = await requirePermission("stock.manage");
  const current = await activeUnit(id);
  if (["reserved", "allocated", "pdi", "ready_for_delivery", "delivered", "sold"].includes(current.status)) {
    throw new Error("Release or complete this unit's active workflow before removing it");
  }
  const reason = formData ? str(formData.get("reason")) || "Removed from active stock" : "Removed from active stock";
  await prisma.stockUnit.update({ where: { id }, data: { deletedAt: new Date() } });
  await addStockEvent({ stockUnitId: id, eventType: "unit.archived", fromStatus: current.status, reason, actor: actor(user) });
  await logAudit({ action: "stock.unit_removed", summary: `Removed ${current.stockNumber ?? current.productName} — ${reason}`, user });
  refresh();
  redirect("/stock");
}
