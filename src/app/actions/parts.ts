"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { actingTenantId } from "@/lib/actingTenant";
import { withActingStaffScope } from "@/lib/actingScope";
import { asActionResult, refuse } from "@/lib/actionResult";
import { parseMoneyField } from "@/lib/moneyInput";
import { getRegionalSettings } from "@/lib/settings";

const int = (v: FormDataEntryValue | null) => parseInt(String(v ?? "").replace(/[^0-9-]/g, ""), 10);
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();

/**
 * The part's sell and cost prices, read in the workspace's currency (moneyInput.ts).
 * This used to delete every character but digits and ".", so "4 861,00" saved 486 100.
 */
async function partPrices(formData: FormData): Promise<{ priceCents: number; costCents: number }> {
  const { currency } = await getRegionalSettings();
  const price = parseMoneyField(str(formData.get("price")), currency);
  if (!price.ok) refuse(`Sell price: ${price.error}`);
  const cost = parseMoneyField(str(formData.get("cost")), currency);
  if (!cost.ok) refuse(`Cost: ${cost.error}`);
  return { priceCents: price.cents ?? 0, costCents: cost.cents ?? 0 };
}

export async function createPart(formData: FormData) {
  return asActionResult(async () => {
    await requirePermission("parts.manage");
    const tenantId = await actingTenantId();
    const name = str(formData.get("name"));
    if (!name) refuse("Give the part a name.");
    await prisma.part.create({
      data: {
        tenantId,
        name,
        sku: str(formData.get("sku")) || null,
        ...(await partPrices(formData)),
        stockQty: int(formData.get("stockQty")) || 0,
        reorderAt: Number.isNaN(int(formData.get("reorderAt"))) ? null : int(formData.get("reorderAt")),
        location: str(formData.get("location")) || null,
        notes: str(formData.get("notes")) || null,
      },
    });
    revalidatePath("/parts");
    return { success: `Added ${name}`, redirectTo: "/parts" };
  });
}

export async function updatePart(id: string, formData: FormData) {
  return asActionResult(async () => {
    await requirePermission("parts.manage");
    const tenantId = await actingTenantId();
    const prices = await partPrices(formData);
    const updated = await prisma.part.updateMany({
      where: { id, tenantId, deletedAt: null },
      data: {
        name: str(formData.get("name")),
        sku: str(formData.get("sku")) || null,
        ...prices,
        reorderAt: Number.isNaN(int(formData.get("reorderAt"))) ? null : int(formData.get("reorderAt")),
        location: str(formData.get("location")) || null,
        notes: str(formData.get("notes")) || null,
      },
    });
    if (updated.count !== 1) refuse("That part no longer exists.");
    revalidatePath("/parts");
  });
}

export async function adjustPartStock(id: string, formData: FormData) {
  return withActingStaffScope(async () => {
    const user = await requirePermission("parts.manage");
    const tenantId = await actingTenantId();
    const delta = int(formData.get("delta"));
    if (!delta || Number.isNaN(delta)) return;

    const part = await prisma.$transaction(async (tx) => {
      const updated = await tx.part.updateMany({
        where: { id, tenantId, deletedAt: null },
        data: { stockQty: { increment: delta } },
      });
      if (updated.count !== 1) return null;
      return tx.part.findFirst({
        where: { id, tenantId, deletedAt: null },
        select: { name: true, stockQty: true },
      });
    });
    if (!part) return;

    await logAudit({
      action: "part.stock_adjusted",
      summary: `${delta > 0 ? "+" : ""}${delta} × ${part.name} (now ${part.stockQty} in stock)`,
      user,
    });
    revalidatePath("/parts");
  });
}

export async function deletePart(id: string) {
  return withActingStaffScope(async () => {
    await requirePermission("parts.manage");
    const tenantId = await actingTenantId();
    const deleted = await prisma.part.updateMany({
      where: { id, tenantId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (deleted.count !== 1) return;
    revalidatePath("/parts");
  });
}
