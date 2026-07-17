"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireLeadAccess, requirePermission, requireQuoteAccess } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import {
  getCustomStockStatuses,
  getStockStatuses,
  isSystemStockStatus,
  saveCustomStockStatuses,
  slugifyStatus,
  type StockStatusOption,
} from "@/lib/stockStatuses";

const rand = (value: FormDataEntryValue | null) =>
  Math.round(parseFloat(String(value ?? "0").replace(/[^0-9.]/g, "")) * 100) || 0;
const str = (value: FormDataEntryValue | null) => String(value ?? "").trim();
const date = (value: FormDataEntryValue | null) => {
  const raw = str(value);
  return raw ? new Date(`${raw}T00:00:00+02:00`) : null;
};

/* ── Custom stock statuses ─────────────────────────────────────────────────
   Built-in statuses (incoming/available/reserved/sold) are fixed; these manage
   the user's own organizational labels. */

export async function addStockStatus(formData: FormData) {
  const user = await requirePermission("stock.manage");
  const label = str(formData.get("label"));
  const color = str(formData.get("color")) || "#64748b";
  if (!label) return;
  const slug = slugifyStatus(label);
  if (!slug || isSystemStockStatus(slug)) {
    throw new Error("That status name is reserved — pick another.");
  }
  const custom = await getCustomStockStatuses();
  if (custom.some((s) => s.slug === slug)) return; // already exists — no-op
  const next: StockStatusOption[] = [...custom, { slug, label, color, system: false }];
  await saveCustomStockStatuses(next);
  await logAudit({ action: "stock.status_added", summary: `Added stock status “${label}”`, user });
  revalidatePath("/stock");
}

export async function removeStockStatus(slug: string) {
  const user = await requirePermission("stock.manage");
  if (isSystemStockStatus(slug)) throw new Error("Built-in statuses can't be removed.");
  const custom = await getCustomStockStatuses();
  await saveCustomStockStatuses(custom.filter((s) => s.slug !== slug));
  // Don't strand units on a label that no longer exists — move them back to Available.
  await prisma.stockUnit.updateMany({ where: { status: slug }, data: { status: "available" } });
  await logAudit({
    action: "stock.status_removed",
    summary: `Removed stock status “${slug}” — any units on it were set to Available`,
    user,
  });
  revalidatePath("/stock");
}

export async function setStockStatus(unitId: string, formData: FormData) {
  const user = await requirePermission("stock.manage");
  const slug = str(formData.get("status"));
  // Reserving / selling carry lead + quote linkage, so they must go through their own
  // flows (Reserve / Mark sold). Manual set is for incoming/available/custom labels.
  if (slug === "reserved" || slug === "sold") {
    throw new Error("Use Reserve or Mark sold for those statuses.");
  }
  const statuses = await getStockStatuses();
  if (!statuses.some((s) => s.slug === slug)) throw new Error("Unknown status.");
  await prisma.stockUnit.update({
    where: { id: unitId },
    data: { status: slug, reservedForLeadId: null, soldQuoteId: null, soldAt: null },
  });
  await logAudit({ action: "stock.status_set", summary: `Changed a stock unit's status to “${slug}”`, user });
  revalidatePath("/stock");
}

export async function createPurchaseOrder(formData: FormData) {
  const user = await requirePermission("stock.manage");
  const productId = str(formData.get("productId"));
  const qty = Math.max(1, Math.min(200, parseInt(str(formData.get("qty")) || "1", 10)));
  if (!productId) return;
  const color = str(formData.get("color")) || null;
  const costCents = rand(formData.get("cost"));
  const order = await prisma.purchaseOrder.create({
    data: {
      reference: str(formData.get("reference")) || null,
      supplier: str(formData.get("supplier")) || "Denago",
      expectedAt: date(formData.get("expectedAt")),
      notes: str(formData.get("notes")) || null,
      units: {
        create: Array.from({ length: qty }, () => ({ productId, color, costCents, status: "incoming" })),
      },
    },
    include: { units: { include: { product: true } } },
  });
  await logAudit({
    action: "stock.po_created",
    summary: `Purchase order for ${qty}× ${order.units[0]?.product.name ?? "unit"}${color ? ` (${color})` : ""}${order.reference ? ` — ${order.reference}` : ""}`,
    user,
  });
  revalidatePath("/stock");
}

export async function receivePurchaseOrder(id: string) {
  const user = await requirePermission("stock.manage");
  await prisma.stockUnit.updateMany({
    where: { purchaseOrderId: id, status: "incoming", deletedAt: null },
    data: { status: "available", arrivedAt: new Date() },
  });
  await prisma.purchaseOrder.update({ where: { id }, data: { status: "received" } });
  await logAudit({ action: "stock.po_received", summary: "Purchase order received into stock", user });
  revalidatePath("/stock");
}

export async function cancelPurchaseOrder(id: string) {
  const user = await requirePermission("stock.manage");
  await prisma.stockUnit.updateMany({
    where: { purchaseOrderId: id, status: "incoming" },
    data: { deletedAt: new Date() },
  });
  await prisma.purchaseOrder.update({ where: { id }, data: { status: "cancelled" } });
  await logAudit({ action: "stock.po_cancelled", summary: "Purchase order cancelled", user });
  revalidatePath("/stock");
}

export async function addStockUnit(formData: FormData) {
  const user = await requirePermission("stock.manage");
  const productId = str(formData.get("productId"));
  if (!productId) return;
  const unit = await prisma.stockUnit.create({
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
    summary: `Added to stock: ${unit.product.name}${unit.color ? ` (${unit.color})` : ""}${unit.serial ? ` — ${unit.serial}` : ""}`,
    user,
  });
  revalidatePath("/stock");
  redirect("/stock");
}

export async function updateStockUnit(id: string, formData: FormData) {
  await requirePermission("stock.manage");
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

export async function reserveUnit(id: string, formData: FormData) {
  const leadId = str(formData.get("leadId")) || null;
  const user = leadId
    ? await requireLeadAccess(leadId, "stock.manage")
    : await requirePermission("stock.manage");
  const unit = await prisma.stockUnit.update({
    where: { id },
    data: { status: "reserved", reservedForLeadId: leadId },
    include: { product: true, reservedForLead: true },
  });
  await logAudit({
    action: "stock.reserved",
    summary: `Reserved ${unit.product.name}${unit.serial ? ` (${unit.serial})` : ""} for ${unit.reservedForLead?.name ?? "a lead"}`,
    leadId,
    user,
  });
  revalidatePath("/stock");
}

export async function releaseUnit(id: string) {
  await requirePermission("stock.manage");
  await prisma.stockUnit.update({
    where: { id },
    data: { status: "available", reservedForLeadId: null, soldQuoteId: null, soldAt: null },
  });
  revalidatePath("/stock");
}

export async function markUnitSold(id: string, formData: FormData) {
  const soldQuoteId = str(formData.get("quoteId")) || null;
  const user = soldQuoteId
    ? await requireQuoteAccess(soldQuoteId, "stock.manage")
    : await requirePermission("stock.manage");
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
  await requirePermission("stock.manage");
  await prisma.stockUnit.update({ where: { id }, data: { deletedAt: new Date() } });
  revalidatePath("/stock");
}
