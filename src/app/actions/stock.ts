"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import {
  requireLeadAccess,
  requirePermission,
  requireQuoteAccess,
} from "@/lib/permissions";
import { saveFile } from "@/lib/storage";
import {
  addStockAttachment,
  allocateStockUnitToQuote,
  archiveStockUnit,
  completeStockPdi,
  createFloorStockUnit,
  createMultiLinePurchaseOrder,
  createStockLocation,
  getPurchaseOrderDetail,
  markReservationDeposit,
  receivePurchaseOrderLines,
  releaseStockReservation,
  reserveStockUnit,
  startStockPdi,
  transitionStockUnit,
  updatePurchaseOrderStatus,
  updateStockUnitDetails,
} from "@/lib/stockPlatform";
import { normalizeSerial, type StockStatus } from "@/lib/stockWorkflow";

const MAX_FILE = 6 * 1024 * 1024;

const str = (formData: FormData, key: string) => {
  const value = String(formData.get(key) ?? "").trim();
  return value || null;
};

const integer = (formData: FormData, key: string) => {
  const value = Number.parseInt(String(formData.get(key) ?? ""), 10);
  return Number.isFinite(value) ? value : null;
};

const money = (value: FormDataEntryValue | null) => {
  const parsed = Number.parseFloat(String(value ?? "0").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed * 100)) : 0;
};

const localDate = (raw: string | null) => (raw ? new Date(`${raw}T00:00:00+02:00`) : null);

function actor(user: { id: string; name: string }) {
  return { id: user.id, name: user.name };
}

function refreshStock(id?: string) {
  revalidatePath("/stock");
  revalidatePath("/stock/purchase-orders");
  revalidatePath("/deliveries");
  if (id) revalidatePath(`/stock/${id}`);
}

export async function createPurchaseOrder(formData: FormData) {
  const user = await requirePermission("stock.manage");
  let lines: Array<{
    productId: string;
    color: string | null;
    qty: number;
    unitCostCents: number;
    notes: string | null;
  }> = [];
  const rawLines = str(formData, "lines");
  if (rawLines) {
    try {
      const parsed = JSON.parse(rawLines) as Array<{
        productId?: string;
        color?: string;
        qty?: number;
        unitCost?: string | number;
        notes?: string;
      }>;
      if (Array.isArray(parsed)) {
        lines = parsed.map((line) => ({
          productId: String(line.productId ?? "").trim(),
          color: String(line.color ?? "").trim() || null,
          qty: Math.max(1, Math.floor(Number(line.qty) || 1)),
          unitCostCents: money(String(line.unitCost ?? "0")),
          notes: String(line.notes ?? "").trim() || null,
        }));
      }
    } catch {
      throw new Error("The purchase-order lines could not be read");
    }
  }
  // Backward compatibility with the original single-line purchase order form.
  if (lines.length === 0) {
    const productId = str(formData, "productId");
    if (productId) {
      lines = [{
        productId,
        color: str(formData, "color"),
        qty: Math.max(1, Math.min(500, integer(formData, "qty") ?? 1)),
        unitCostCents: money(formData.get("cost")),
        notes: null,
      }];
    }
  }
  const id = await createMultiLinePurchaseOrder({
    reference: str(formData, "reference"),
    supplier: str(formData, "supplier") ?? "Denago",
    expectedAt: localDate(str(formData, "expectedAt")),
    currency: str(formData, "currency") ?? "ZAR",
    notes: str(formData, "notes"),
    freightCents: money(formData.get("freight")),
    dutiesCents: money(formData.get("duties")),
    otherCostsCents: money(formData.get("otherCosts")),
    lines,
    actor: actor(user),
  });
  await logAudit({
    action: "stock.po_created",
    summary: `Created purchase order${str(formData, "reference") ? ` ${str(formData, "reference")}` : ""} with ${lines.length} line${lines.length === 1 ? "" : "s"}`,
    user,
  });
  refreshStock();
  redirect(`/stock/purchase-orders/${id}`);
}

export async function confirmPurchaseOrder(id: string) {
  const user = await requirePermission("stock.manage");
  await updatePurchaseOrderStatus({ id, status: "confirmed", actor: actor(user) });
  await logAudit({ action: "stock.po_confirmed", summary: "Purchase order confirmed by supplier", user });
  refreshStock();
}

export async function markPurchaseOrderInTransit(id: string) {
  const user = await requirePermission("stock.manage");
  await updatePurchaseOrderStatus({ id, status: "in_transit", actor: actor(user) });
  await logAudit({ action: "stock.po_in_transit", summary: "Purchase order marked in transit", user });
  refreshStock();
}

export async function receivePurchaseOrder(id: string, formData?: FormData) {
  const user = await requirePermission("stock.manage");
  const data = formData ?? new FormData();
  const detail = await getPurchaseOrderDetail(id);
  if (!detail) throw new Error("Purchase order not found");

  // Legacy purchase orders created before multi-line purchasing already contain incoming units.
  if (detail.lines.length === 0) {
    const result = await prisma.$transaction(async (tx) => {
      const changed = await tx.stockUnit.updateMany({
        where: { purchaseOrderId: id, status: "incoming", deletedAt: null },
        data: { status: "available", arrivedAt: new Date() },
      });
      await tx.purchaseOrder.update({ where: { id }, data: { status: "received" } });
      return changed.count;
    });
    await logAudit({
      action: "stock.po_received",
      summary: `Received legacy purchase order into stock (${result} unit${result === 1 ? "" : "s"})`,
      user,
    });
    refreshStock();
    return;
  }

  const raw = str(data, "receiptLines");
  let lines: Array<{ lineId: string; qty: number; serials: string[] }> = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Array<{ lineId?: string; qty?: number; serials?: string | string[] }>;
      lines = parsed.map((line) => ({
        lineId: String(line.lineId ?? ""),
        qty: Math.max(0, Math.floor(Number(line.qty) || 0)),
        serials: Array.isArray(line.serials)
          ? line.serials.map(String)
          : String(line.serials ?? "").split(/[\n,]+/).map((value) => value.trim()).filter(Boolean),
      }));
    } catch {
      throw new Error("The receipt lines could not be read");
    }
  } else {
    lines = detail.lines
      .map((line) => ({
        lineId: line.id,
        qty: Math.max(0, integer(data, `qty-${line.id}`) ?? 0),
        serials: String(data.get(`serials-${line.id}`) ?? "")
          .split(/[\n,]+/)
          .map((value) => value.trim())
          .filter(Boolean),
      }))
      .filter((line) => line.qty > 0);
  }
  const created = await receivePurchaseOrderLines({
    purchaseOrderId: id,
    reference: str(data, "receiptReference"),
    notes: str(data, "notes"),
    locationId: str(data, "locationId") ?? "stock-location-yard",
    freightCents: money(data.get("freight")),
    dutiesCents: money(data.get("duties")),
    otherCostsCents: money(data.get("otherCosts")),
    lines,
    actor: actor(user),
  });
  await logAudit({
    action: "stock.po_received",
    summary: `Received ${created.length} unit${created.length === 1 ? "" : "s"} against purchase order${detail.reference ? ` ${detail.reference}` : ""}`,
    user,
  });
  refreshStock();
  revalidatePath(`/stock/purchase-orders/${id}`);
}

export async function cancelPurchaseOrder(id: string, formData?: FormData) {
  const user = await requirePermission("stock.manage");
  const reason = formData ? str(formData, "reason") : null;
  await updatePurchaseOrderStatus({ id, status: "cancelled", reason, actor: actor(user) });
  await logAudit({
    action: "stock.po_cancelled",
    summary: `Purchase order cancelled${reason ? ` — ${reason}` : ""}`,
    user,
  });
  refreshStock();
}

export async function addStockUnit(formData: FormData) {
  const user = await requirePermission("stock.manage");
  const productId = str(formData, "productId");
  if (!productId) throw new Error("Select a product model");
  const id = await createFloorStockUnit({
    productId,
    color: str(formData, "color"),
    serial: normalizeSerial(str(formData, "serial")),
    locationId: str(formData, "locationId") ?? "stock-location-showroom",
    condition: str(formData, "condition") ?? "new",
    costCents: money(formData.get("cost")),
    landedCostCents: money(formData.get("landedCost")),
    notes: str(formData, "notes"),
    actor: actor(user),
  });
  await logAudit({ action: "stock.unit_added", summary: "Added a physical unit to live stock", user });
  refreshStock(id);
  redirect(`/stock/${id}`);
}

export async function updateStockUnit(id: string, formData: FormData) {
  const user = await requirePermission("stock.manage");
  await updateStockUnitDetails({
    id,
    stockNumber: str(formData, "stockNumber"),
    serial: str(formData, "serial"),
    color: str(formData, "color"),
    locationId: str(formData, "locationId"),
    condition: str(formData, "condition") ?? "new",
    manufacturingYear: integer(formData, "manufacturingYear"),
    batteryType: str(formData, "batteryType"),
    batterySerial: str(formData, "batterySerial"),
    chargerSerial: str(formData, "chargerSerial"),
    keyCount: integer(formData, "keyCount"),
    odometerKm: integer(formData, "odometerKm"),
    operatingHours: integer(formData, "operatingHours"),
    costCents: money(formData.get("cost")),
    landedCostCents: money(formData.get("landedCost")),
    notes: str(formData, "notes"),
    consignmentOwner: str(formData, "consignmentOwner"),
    reason: str(formData, "reason"),
    actor: actor(user),
  });
  await logAudit({ action: "stock.unit_updated", summary: `Updated stock unit ${id}`, user });
  refreshStock(id);
}

export async function reserveUnit(id: string, formData: FormData) {
  const leadId = str(formData, "leadId");
  if (!leadId) throw new Error("Select a lead");
  const user = await requireLeadAccess(leadId, "stock.manage");
  const expiryRaw = str(formData, "expiresAt");
  const expiresAt = expiryRaw
    ? new Date(`${expiryRaw}T23:59:59+02:00`)
    : new Date(Date.now() + Math.max(1, integer(formData, "expiryDays") ?? 3) * 86_400_000);
  await reserveStockUnit({
    stockUnitId: id,
    leadId,
    quoteId: str(formData, "quoteId"),
    expiresAt,
    depositRequiredCents: money(formData.get("depositRequired")),
    actor: actor(user),
  });
  await logAudit({
    action: "stock.reserved",
    summary: `Reserved stock until ${expiresAt.toLocaleDateString("en-ZA")}`,
    leadId,
    user,
  });
  refreshStock(id);
}

export async function recordReservationDeposit(id: string) {
  const user = await requirePermission("stock.manage");
  await markReservationDeposit({ stockUnitId: id, actor: actor(user) });
  await logAudit({ action: "stock.reservation_deposit", summary: "Recorded reservation deposit", user });
  refreshStock(id);
}

export async function releaseUnit(id: string, formData?: FormData) {
  const user = await requirePermission("stock.manage");
  const reason = formData ? str(formData, "reason") : null;
  await releaseStockReservation({
    stockUnitId: id,
    reason: reason ?? "Released manually",
    actor: actor(user),
  });
  await logAudit({ action: "stock.released", summary: `Released stock reservation${reason ? ` — ${reason}` : ""}`, user });
  refreshStock(id);
}

export async function allocateUnitToQuote(id: string, formData: FormData) {
  const quoteId = str(formData, "quoteId");
  if (!quoteId) throw new Error("Select an accepted quote");
  const user = await requireQuoteAccess(quoteId, "stock.manage");
  await allocateStockUnitToQuote({ stockUnitId: id, quoteId, actor: actor(user) });
  await logAudit({ action: "stock.quote_allocated", summary: "Allocated a physical stock unit to an accepted quote", user });
  refreshStock(id);
  revalidatePath(`/quotes/${quoteId}`);
}

export async function beginPdi(id: string) {
  const user = await requirePermission("stock.manage");
  await startStockPdi({ stockUnitId: id, actor: actor(user) });
  await logAudit({ action: "stock.pdi_started", summary: "Started pre-delivery inspection", user });
  refreshStock(id);
}

export async function completePdi(id: string, formData: FormData) {
  const user = await requirePermission("stock.manage");
  const checklist = {
    battery: formData.get("battery") === "on",
    charger: formData.get("charger") === "on",
    tyres: formData.get("tyres") === "on",
    brakes: formData.get("brakes") === "on",
    lights: formData.get("lights") === "on",
    body: formData.get("body") === "on",
    keys: formData.get("keys") === "on",
    roadTest: formData.get("roadTest") === "on",
  };
  await completeStockPdi({
    stockUnitId: id,
    checklist,
    notes: str(formData, "notes"),
    actor: actor(user),
  });
  await logAudit({ action: "stock.pdi_completed", summary: "Completed PDI and released stock for delivery", user });
  refreshStock(id);
}

export async function changeStockStatus(id: string, formData: FormData) {
  const user = await requirePermission("stock.manage");
  const toStatus = str(formData, "toStatus") as StockStatus | null;
  if (!toStatus) throw new Error("Select a destination status");
  const reason = str(formData, "reason");
  if (!reason) throw new Error("Enter a reason");
  await transitionStockUnit({ stockUnitId: id, toStatus, reason, notes: str(formData, "notes"), actor: actor(user) });
  await logAudit({ action: "stock.status_changed", summary: `Changed stock status to ${toStatus} — ${reason}`, user });
  refreshStock(id);
}

// Compatibility action retained for old links and forms. Normal sales should use allocateUnitToQuote.
export async function markUnitSold(id: string, formData: FormData) {
  const quoteId = str(formData, "quoteId");
  if (quoteId) {
    await allocateUnitToQuote(id, formData);
    return;
  }
  const user = await requirePermission("stock.manage");
  const reason = str(formData, "reason") ?? "Manual non-quote sale or disposal";
  await transitionStockUnit({ stockUnitId: id, toStatus: "sold", reason, actor: actor(user) });
  await logAudit({ action: "stock.sold_manual", summary: `Marked stock sold manually — ${reason}`, user });
  refreshStock(id);
}

export async function deleteStockUnit(id: string, formData?: FormData) {
  const user = await requirePermission("stock.manage");
  const reason = formData ? str(formData, "reason") : null;
  await archiveStockUnit({ stockUnitId: id, reason: reason ?? "Removed from active stock", actor: actor(user) });
  await logAudit({ action: "stock.unit_archived", summary: `Archived stock unit — ${reason ?? "Removed from active stock"}`, user });
  refreshStock();
  redirect("/stock");
}

export async function addStockLocation(formData: FormData) {
  await requirePermission("stock.manage");
  await createStockLocation({
    name: str(formData, "name") ?? "",
    type: str(formData, "type") ?? "showroom",
    address: str(formData, "address"),
    isDefault: formData.get("isDefault") === "on",
  });
  refreshStock();
}

export async function uploadStockFiles(id: string, formData: FormData) {
  const user = await requirePermission("stock.manage");
  const files = formData.getAll("files").filter(
    (file): file is File => typeof file === "object" && (file as File).size > 0,
  );
  let saved = 0;
  for (const file of files.slice(0, 12)) {
    if (file.size > MAX_FILE) continue;
    const storedName = await saveFile(Buffer.from(await file.arrayBuffer()), file.name || "stock-file", file.type || "application/octet-stream");
    await addStockAttachment({
      stockUnitId: id,
      fileName: file.name || "Stock attachment",
      storedName,
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      category: str(formData, "category") ?? (file.type.startsWith("image/") ? "photo" : "document"),
      uploadedById: user.id,
    });
    saved++;
  }
  if (saved > 0) {
    await logAudit({ action: "stock.attachments", summary: `Added ${saved} stock attachment${saved === 1 ? "" : "s"}`, user });
  }
  refreshStock(id);
}
