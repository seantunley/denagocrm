"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireCrm } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

const rand = (v: FormDataEntryValue | null) =>
  Math.round(parseFloat(String(v ?? "0").replace(/[^0-9.]/g, "")) * 100) || 0;
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();
const date = (v: FormDataEntryValue | null) => {
  const s = str(v);
  return s ? new Date(`${s}T00:00:00+02:00`) : null;
};

/** Create a purchase order and its incoming stock units. */
export async function createPurchaseOrder(formData: FormData) {
  const user = await requireCrm();
  const productId = str(formData.get("productId"));
  const qty = Math.max(1, Math.min(200, parseInt(str(formData.get("qty")) || "1", 10)));
  if (!productId) return;
  const color = str(formData.get("color")) || null;
  const costCents = rand(formData.get("cost"));
  const po = await prisma.purchaseOrder.create({
    data: {
      reference: str(formData.get("reference")) || null,
      supplier: str(formData.get("supplier")) || "Denago",
      expectedAt: date(formData.get("expectedAt")),
      notes: str(formData.get("notes")) || null,
      units: {
        create: Array.from({ length: qty }, () => ({
          productId,
          color,
          costCents,
          status: "incoming",
        })),
      },
    },
    include: { units: { include: { product: true } } },
  });
  await logAudit({
    action: "stock.po_created",
    summary: `Purchase order for ${qty}× ${po.units[0]?.product.name ?? "unit"}${
      color ? ` (${color})` : ""
    }${po.reference ? ` — ${po.reference}` : ""}`,
    user,
  });
  revalidatePath("/stock");
}

/** Mark a PO received: its incoming units become available. */
export async function receivePurchaseOrder(id: string) {
  const user = await requireCrm();
  await prisma.stockUnit.updateMany({
    where: { purchaseOrderId: id, status: "incoming", deletedAt: null },
    data: { status: "available", arrivedAt: new Date() },
  });
  await prisma.purchaseOrder.update({ where: { id }, data: { status: "received" } });
  await logAudit({ action: "stock.po_received", summary: `Purchase order received into stock`, user });
  revalidatePath("/stock");
}

/** Cancel a PO: soft-delete any units still on order. */
export async function cancelPurchaseOrder(id: string) {
  const user = await requireCrm();
  await prisma.stockUnit.updateMany({
    where: { purchaseOrderId: id, status: "incoming" },
    data: { deletedAt: new Date() },
  });
  await prisma.purchaseOrder.update({ where: { id }, data: { status: "cancelled" } });
  await logAudit({ action: "stock.po_cancelled", summary: `Purchase order cancelled`, user });
  revalidatePath("/stock");
}

/** Add a single unit already on the floor (no PO). */
export async function addStockUnit(formData: FormData) {
  const user = await requireCrm();
  const productId = str(formData.get("productId"));
  if (!productId) return;
  const u = await prisma.stockUnit.create({
    data: {
      productId,
      color: str(formData.get("color")) || null,
      serial: str(formData.get("serial")) || null,
      costCents: rand(formData.get("cost")),
      notes: str(formData.get("notes")) || null,
      status: "available",
      arrivedAt: new Date(),
    },
    include: { product: true },
  });
  await logAudit({
    action: "stock.unit_added",
    summary: `Added to stock: ${u.product.name}${u.color ? ` (${u.color})` : ""}${
      u.serial ? ` — ${u.serial}` : ""
    }`,
    user,
  });
  revalidatePath("/stock");
}

export async function updateStockUnit(id: string, formData: FormData) {
  await requireCrm();
  await prisma.stockUnit.update({
    where: { id },
    data: {
      serial: str(formData.get("serial")) || null,
      color: str(formData.get("color")) || null,
      costCents: rand(formData.get("cost")),
      notes: str(formData.get("notes")) || null,
    },
  });
  revalidatePath("/stock");
}

/** Reserve an available unit against a lead. */
export async function reserveUnit(id: string, formData: FormData) {
  const user = await requireCrm();
  const leadId = str(formData.get("leadId")) || null;
  const unit = await prisma.stockUnit.update({
    where: { id },
    data: { status: "reserved", reservedForLeadId: leadId },
    include: { product: true, reservedForLead: true },
  });
  await logAudit({
    action: "stock.reserved",
    summary: `Reserved ${unit.product.name}${unit.serial ? ` (${unit.serial})` : ""} for ${
      unit.reservedForLead?.name ?? "a lead"
    }`,
    leadId,
    user,
  });
  revalidatePath("/stock");
}

/** Return a unit to available stock. */
export async function releaseUnit(id: string) {
  await requireCrm();
  await prisma.stockUnit.update({
    where: { id },
    data: { status: "available", reservedForLeadId: null, soldQuoteId: null, soldAt: null },
  });
  revalidatePath("/stock");
}

/** Mark a unit sold, optionally tied to a quote. */
export async function markUnitSold(id: string, formData: FormData) {
  const user = await requireCrm();
  const soldQuoteId = str(formData.get("quoteId")) || null;
  const unit = await prisma.stockUnit.update({
    where: { id },
    data: { status: "sold", soldQuoteId, soldAt: new Date() },
    include: { product: true },
  });
  await logAudit({
    action: "stock.sold",
    summary: `Sold ${unit.product.name}${unit.serial ? ` (${unit.serial})` : ""}`,
    user,
  });
  revalidatePath("/stock");
}

export async function deleteStockUnit(id: string) {
  await requireCrm();
  await prisma.stockUnit.update({ where: { id }, data: { deletedAt: new Date() } });
  revalidatePath("/stock");
}
