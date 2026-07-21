"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireLeadAccess, requirePermission, requireQuoteAccess } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import {
  addStockEvent,
  canTransitionStock,
  nextStockNumber,
  type StockActor,
} from "@/lib/stockPlatform";
import { getStockLabels, saveStockLabels, slugifyLabel } from "@/lib/stockLabels";

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

/** The active (non-deleted) unit with its product name — typed, so callers get the real columns. */
async function activeUnit(id: string) {
  const unit = await prisma.stockUnit.findFirst({
    where: { id, deletedAt: null },
    include: { product: { select: { name: true } } },
  });
  if (!unit) throw new Error("Stock unit not found");
  return unit;
}

/** Case-insensitive active-serial guard (mirrors the UPPER(serial) partial unique index). */
async function assertUniqueSerial(serial: string | null, exceptId?: string) {
  if (!serial) return;
  const clash = await prisma.stockUnit.findFirst({
    where: {
      serial: { equals: serial, mode: "insensitive" },
      deletedAt: null,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });
  if (clash) throw new Error("That serial/VIN is already assigned to another active stock unit");
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
      const poLine = await tx.purchaseOrderLine.create({
        data: {
          purchaseOrderId: po.id,
          productId: line.productId,
          color: line.color ?? null,
          orderedQty: line.qty,
          unitCostCents: line.costCents,
          freightCents: line.freightCents ?? 0,
          notes: line.notes ?? null,
        },
      });
      await tx.stockUnit.createMany({
        data: Array.from({ length: line.qty }, () => ({
          productId: line.productId,
          color: line.color ?? null,
          costCents: line.costCents,
          status: "incoming",
          purchaseOrderId: po.id,
          purchaseOrderLineId: poLine.id,
        })),
      });
    }
    return po;
  });

  const totalUnits = lines.reduce((sum, line) => sum + line.qty, 0);
  await addStockEvent({
    purchaseOrderId: order.id,
    eventType: "purchase_order.created",
    detail: `${totalUnits} units across ${lines.length} line${lines.length === 1 ? "" : "s"}`,
    actor: actor(user),
  });
  await logAudit({
    action: "stock.po_created",
    summary: `Created purchase order${reference ? ` ${reference}` : ""} for ${totalUnits} units`,
    user,
  });
  refresh();
}

/**
 * Receives units into inspection. Genuine partial receiving: an optional per-line
 * quantity map (JSON `{ [lineId]: qty }`) or an overall `qty` receives only that many
 * of the still-incoming units; the PO ends "received" only once nothing is outstanding,
 * otherwise "partially_received". A later inspection releases accepted units to Available.
 */
export async function receivePurchaseOrder(id: string, formData?: FormData) {
  const user = await requirePermission("stock.manage");
  const receiptReference = formData ? str(formData.get("receiptReference")) || null : null;
  const notes = formData ? str(formData.get("notes")) || null : null;

  // Optional per-line quantities: { purchaseOrderLineId: qtyToReceive }
  let perLine: Record<string, number> | null = null;
  const linesRaw = formData ? str(formData.get("receiveLines")) : "";
  if (linesRaw) {
    try {
      const parsed = JSON.parse(linesRaw) as Record<string, unknown>;
      perLine = Object.fromEntries(
        Object.entries(parsed).map(([k, v]) => [k, Math.max(0, Number(v) || 0)]),
      );
    } catch {
      throw new Error("Receiving quantities are invalid");
    }
  }
  const overallQty = formData ? integer(formData.get("qty"), 0) : 0;

  const received = await prisma.$transaction(async (tx) => {
    // Lock the PO row FOR UPDATE up front so concurrent receipts serialize. Unit
    // claiming (SKIP LOCKED) stops the same unit being received twice, but two
    // receipts claiming DIFFERENT units could each read the other's uncommitted
    // units as still incoming and both settle on "partially_received", leaving a
    // fully-received order stuck partial. Serializing status calc here fixes that.
    await tx.$executeRaw`SELECT id FROM "PurchaseOrder" WHERE id = ${id} FOR UPDATE`;
    const po = await tx.purchaseOrder.findFirst({ where: { id, deletedAt: null } });
    if (!po || !["ordered", "partially_received"].includes(po.status)) {
      throw new Error("This purchase order cannot be received");
    }

    // Pick which incoming units to receive.
    const incoming = await tx.stockUnit.findMany({
      where: { purchaseOrderId: id, status: "incoming", deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true, purchaseOrderLineId: true },
    });
    if (!incoming.length) throw new Error("There are no outstanding units on this order");

    let chosen = incoming;
    if (perLine) {
      chosen = [];
      const byLine = new Map<string | null, typeof incoming>();
      for (const unit of incoming) {
        const key = unit.purchaseOrderLineId ?? null;
        (byLine.get(key) ?? byLine.set(key, []).get(key)!).push(unit);
      }
      for (const [lineId, qty] of Object.entries(perLine)) {
        const bucket = byLine.get(lineId) ?? [];
        chosen.push(...bucket.slice(0, qty));
      }
    } else if (overallQty > 0) {
      chosen = incoming.slice(0, overallQty);
    }
    if (!chosen.length) throw new Error("Choose at least one unit to receive");

    // Claim the chosen units atomically. FOR UPDATE SKIP LOCKED locks only the
    // ones still `incoming` and NOT already locked by a concurrent receipt, so we
    // operate solely on rows we truly own — two receipts can no longer both
    // receive the same unit and double-count receivedQty. (The old code updated
    // by id with no status guard and no lock.)
    const chosenIds = chosen.map((u) => u.id);
    const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT "id" FROM "StockUnit"
      WHERE "id" IN (${Prisma.join(chosenIds)}) AND "status" = 'incoming' AND "deletedAt" IS NULL
      FOR UPDATE SKIP LOCKED`);
    const claimedIds = new Set(locked.map((r) => r.id));
    const claimed = chosen.filter((u) => claimedIds.has(u.id));
    if (!claimed.length) throw new Error("Those units were just received by someone else — refresh and try again.");

    const receipt = await tx.goodsReceipt.create({
      data: { purchaseOrderId: id, reference: receiptReference, receivedById: user.id, notes },
    });
    await tx.stockUnit.updateMany({
      where: { id: { in: claimed.map((u) => u.id) }, status: "incoming" },
      data: { status: "received_pending_check", arrivedAt: new Date() },
    });
    await tx.goodsReceiptLine.createMany({
      data: claimed.map((u) => ({
        goodsReceiptId: receipt.id,
        purchaseOrderLineId: u.purchaseOrderLineId,
        stockUnitId: u.id,
        accepted: true,
      })),
    });
    // Keep per-line receivedQty in step — only for the units we actually claimed.
    for (const [lineId, count] of countByLine(claimed)) {
      if (lineId) await tx.purchaseOrderLine.update({ where: { id: lineId }, data: { receivedQty: { increment: count } } });
    }

    const stillOutstanding = await tx.stockUnit.count({
      where: { purchaseOrderId: id, status: "incoming", deletedAt: null },
    });
    await tx.purchaseOrder.update({
      where: { id },
      data: { status: stillOutstanding > 0 ? "partially_received" : "received" },
    });
    return claimed;
  });

  for (const unit of received) {
    await addStockEvent({
      stockUnitId: unit.id, purchaseOrderId: id, eventType: "goods.received",
      fromStatus: "incoming", toStatus: "received_pending_check", actor: actor(user),
    });
  }
  await logAudit({ action: "stock.po_received", summary: `Received ${received.length} units for inspection`, user });
  refresh();
}

function countByLine(units: Array<{ purchaseOrderLineId: string | null }>): Array<[string | null, number]> {
  const map = new Map<string | null, number>();
  for (const u of units) map.set(u.purchaseOrderLineId, (map.get(u.purchaseOrderLineId) ?? 0) + 1);
  return [...map.entries()];
}

export async function cancelPurchaseOrder(id: string, formData?: FormData) {
  const user = await requirePermission("stock.manage");
  const reason = formData ? str(formData.get("reason")) || "Cancelled by user" : "Cancelled by user";
  const count = await prisma.$transaction(async (tx) => {
    // Lock the PO row FOR UPDATE, same as receiving, so a cancel can't read
    // "ordered", wait behind an active receipt, and then overwrite the receipt's
    // committed "received"/"partially_received" status with "cancelled".
    await tx.$executeRaw`SELECT id FROM "PurchaseOrder" WHERE id = ${id} FOR UPDATE`;
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
      landedCostCents: costCents,
      notes: str(formData.get("notes")) || null,
      status: "available",
      arrivedAt: new Date(),
      stockNumber,
      location: str(formData.get("location")) || null,
      condition: str(formData.get("condition")) || "new",
      batterySerial: str(formData.get("batterySerial")) || null,
      chargerSerial: str(formData.get("chargerSerial")) || null,
      odometerKm: integer(formData.get("odometerKm"), 0) || null,
    },
    include: { product: true },
  });
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
  await prisma.stockUnit.update({
    where: { id },
    data: {
      serial,
      color: str(formData.get("color")) || null,
      costCents,
      landedCostCents,
      notes: str(formData.get("notes")) || null,
      location: str(formData.get("location")) || null,
      condition: str(formData.get("condition")) || "new",
      batterySerial: str(formData.get("batterySerial")) || null,
      chargerSerial: str(formData.get("chargerSerial")) || null,
      odometerKm: integer(formData.get("odometerKm"), 0) || null,
    },
  });
  await addStockEvent({
    stockUnitId: id,
    eventType: "unit.updated",
    costBeforeCents: current.landedCostCents || current.costCents,
    costAfterCents: landedCostCents,
    detail: "Unit identity, condition, location or cost updated",
    actor: actor(user),
  });
  await logAudit({ action: "stock.unit_updated", summary: `Updated ${current.stockNumber ?? current.product.name}`, user });
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
  const conditionNote = str(formData.get("conditionNote")) || null;
  const result = await prisma.stockUnit.updateMany({
    where: { id, status: "received_pending_check", deletedAt: null },
    data: {
      status: toStatus,
      serial,
      stockNumber,
      location: str(formData.get("location")) || null,
      notes: conditionNote,
      condition: accepted ? "new" : "damaged",
      landedCostCents: current.landedCostCents === 0 ? current.costCents : current.landedCostCents,
    },
  });
  if (result.count !== 1) throw new Error("The unit changed while it was being inspected");
  await addStockEvent({ stockUnitId: id, eventType: "goods.inspected", fromStatus: current.status, toStatus, reason: conditionNote, detail: stockNumber, actor: actor(user) });
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

  // StockReservation is the source of truth; reservedForLeadId is a cache written
  // inside the same transaction so the two can never diverge.
  const changed = await prisma.$transaction(async (tx) => {
    const result = await tx.stockUnit.updateMany({
      where: { id, status: "available", deletedAt: null },
      data: { status: "reserved", reservedForLeadId: leadId },
    });
    if (result.count !== 1) return false;
    await tx.stockReservation.create({
      data: { stockUnitId: id, leadId, status: "active", expiresAt, depositRequiredCents, reservedById: user.id },
    });
    return true;
  });
  if (!changed) throw new Error("This unit was reserved by someone else. Refresh and choose another unit.");
  await addStockEvent({ stockUnitId: id, eventType: "reservation.created", fromStatus: "available", toStatus: "reserved", leadId, detail: `Expires ${expiresAt.toISOString()}`, actor: actor(user) });
  await logAudit({ action: "stock.reserved", summary: `Reserved ${current.stockNumber ?? current.product.name} for ${lead.name}`, leadId, user });
  refresh(id);
}

export async function recordReservationDeposit(id: string, formData: FormData) {
  const user = await requirePermission("stock.manage");
  const reference = str(formData.get("reference"));
  const reservation = await prisma.stockReservation.findFirst({
    where: { stockUnitId: id, status: "active", depositReceivedAt: null },
    select: { id: true, leadId: true },
  });
  if (!reservation) throw new Error("No active reservation was found");
  await prisma.stockReservation.update({ where: { id: reservation.id }, data: { depositReceivedAt: new Date() } });
  await addStockEvent({ stockUnitId: id, eventType: "reservation.deposit_received", leadId: reservation.leadId, detail: reference || null, actor: actor(user) });
  refresh(id);
}

export async function releaseUnit(id: string, formData?: FormData) {
  const user = await requirePermission("stock.manage");
  const current = await activeUnit(id);
  if (!["reserved", "allocated"].includes(current.status)) throw new Error("Only reserved or allocated stock can be released");
  const reason = formData ? str(formData.get("reason")) || "Released manually" : "Released manually";
  await prisma.$transaction(async (tx) => {
    await tx.stockUnit.update({ where: { id }, data: { status: "available", reservedForLeadId: null, soldQuoteId: null, soldAt: null } });
    await tx.stockReservation.updateMany({
      where: { stockUnitId: id, status: "active" },
      data: { status: "released", releasedAt: new Date(), releaseReason: reason },
    });
  });
  await addStockEvent({ stockUnitId: id, eventType: "reservation.released", fromStatus: current.status, toStatus: "available", leadId: current.reservedForLeadId, reason, actor: actor(user) });
  await logAudit({ action: "stock.released", summary: `Released ${current.stockNumber ?? current.product.name} — ${reason}`, leadId: current.reservedForLeadId, user });
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

  const changed = await prisma.$transaction(async (tx) => {
    const result = await tx.stockUnit.updateMany({
      where: { id, status: { in: ["available", "reserved"] }, deletedAt: null },
      data: { status: "allocated", soldQuoteId: quoteId, reservedForLeadId: quote.leadId ?? current.reservedForLeadId },
    });
    if (result.count !== 1) return false;
    await tx.stockReservation.updateMany({
      where: { stockUnitId: id, status: "active" },
      data: { quoteId, status: "converted" },
    });
    return true;
  });
  if (!changed) throw new Error("The stock unit changed while you were allocating it");
  await addStockEvent({ stockUnitId: id, eventType: "unit.allocated", fromStatus: current.status, toStatus: "allocated", leadId: quote.leadId, quoteId, actor: actor(user) });
  await logAudit({ action: "stock.allocated", summary: `Allocated ${current.stockNumber ?? current.product.name} to quote Q-${quote.number}`, leadId: quote.leadId, user });
  refresh(id);
}

export async function transitionStockUnit(id: string, formData: FormData) {
  const user = await requirePermission("stock.manage");
  const current = await activeUnit(id);
  const toStatus = str(formData.get("status"));
  const reason = str(formData.get("reason")) || null;
  if (!canTransitionStock(current.status, toStatus)) throw new Error(`Cannot move stock from ${current.status} to ${toStatus}`);
  const result = await prisma.stockUnit.updateMany({
    where: { id, status: current.status, deletedAt: null },
    data: { status: toStatus, ...(toStatus === "pdi" ? { pdiStatus: "in_progress" } : {}) },
  });
  if (result.count !== 1) throw new Error("The stock unit changed while this action was being processed");
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
  const result = await prisma.stockUnit.updateMany({
    where: { id, status: "pdi", deletedAt: null },
    data: {
      status: toStatus,
      pdiStatus: passed ? "passed" : "failed",
      pdiCompletedAt: new Date(),
      ...(issues ? { notes: [current.notes, issues].filter(Boolean).join("\n") } : {}),
    },
  });
  if (result.count !== 1) throw new Error("The unit changed while PDI was being completed");
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
  // Per-UNIT selling price for this one physical cart — NOT the whole quote line
  // (qty × price), which would over-state revenue for multi-quantity quotes.
  const saleLine = quote.items.find((item) => item.productId === current.productId && item.selected);
  const salePriceCents = saleLine ? Math.round(saleLine.unitPriceCents * (1 - saleLine.discountPct / 100)) : 0;
  const warrantyMonths = Math.max(0, integer(formData.get("warrantyMonths"), 12));
  const deliveredAt = new Date();
  const warrantyEndAt = warrantyMonths ? new Date(deliveredAt.getFullYear(), deliveredAt.getMonth() + warrantyMonths, deliveredAt.getDate()) : null;

  await prisma.$transaction(async (tx) => {
    await tx.stockUnit.update({
      where: { id },
      data: {
        status: "delivered",
        soldAt: deliveredAt,
        deliveredAt,
        salePriceCents,
        warrantyStartAt: deliveredAt,
        warrantyEndAt,
      },
    });
    const existing = current.serial ? await tx.vehicle.findUnique({ where: { vin: current.serial } }) : null;
    if (!existing) {
      await tx.vehicle.create({
        data: {
          model: current.product.name,
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
  await logAudit({ action: "stock.delivered", summary: `Delivered ${current.stockNumber ?? current.product.name} to ${contact.firstName}`, contactId: contact.id, leadId: quote.leadId, user });
  revalidatePath(`/contacts/${contact.id}`);
  revalidatePath("/vehicles");
  refresh(id);
}

/* ── Organisational labels (distinct from lifecycle status) ─────────────── */

export async function addStockLabel(formData: FormData) {
  const user = await requirePermission("stock.manage");
  const label = str(formData.get("label"));
  const color = str(formData.get("color")) || "#64748b";
  if (!label) return;
  const slug = slugifyLabel(label);
  if (!slug) throw new Error("Give the label a name");
  const labels = await getStockLabels();
  if (labels.some((l) => l.slug === slug)) return; // already exists
  await saveStockLabels([...labels, { slug, label, color }]);
  await logAudit({ action: "stock.label_added", summary: `Added stock label “${label}”`, user });
  revalidatePath("/stock");
  revalidatePath("/settings");
}

export async function removeStockLabel(slug: string) {
  const user = await requirePermission("stock.manage");
  const labels = await getStockLabels();
  await saveStockLabels(labels.filter((l) => l.slug !== slug));
  // Clear the label from any units carrying it so none are left on a missing label.
  await prisma.stockUnit.updateMany({ where: { label: slug }, data: { label: null } });
  await logAudit({ action: "stock.label_removed", summary: `Removed stock label “${slug}”`, user });
  revalidatePath("/stock");
  revalidatePath("/settings");
}

export async function setStockUnitLabel(id: string, formData: FormData) {
  const user = await requirePermission("stock.manage");
  const current = await activeUnit(id);
  const slug = str(formData.get("label")) || null;
  if (slug) {
    const labels = await getStockLabels();
    if (!labels.some((l) => l.slug === slug)) throw new Error("Unknown stock label");
  }
  await prisma.stockUnit.update({ where: { id }, data: { label: slug } });
  await addStockEvent({
    stockUnitId: id,
    eventType: "unit.labelled",
    detail: slug ? `Label set to ${slug}` : "Label cleared",
    actor: actor(user),
  });
  await logAudit({ action: "stock.unit_labelled", summary: `${slug ? `Labelled ${current.stockNumber ?? current.product.name} “${slug}”` : `Cleared the label on ${current.stockNumber ?? current.product.name}`}`, user });
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
  await logAudit({ action: "stock.unit_removed", summary: `Removed ${current.stockNumber ?? current.product.name} — ${reason}`, user });
  refresh();
  redirect("/stock");
}
