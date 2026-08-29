"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { actingTenantId } from "@/lib/actingTenant";
import { withActingStaffScope } from "@/lib/actingScope";

const rand = (v: FormDataEntryValue | null) =>
  Math.round(parseFloat(String(v ?? "0").replace(/[^0-9.]/g, "")) * 100) || 0;
const int = (v: FormDataEntryValue | null) => parseInt(String(v ?? "").replace(/[^0-9-]/g, ""), 10);
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();

export async function createPart(formData: FormData) {
  return withActingStaffScope(async () => {
    await requirePermission("parts.manage");
    const tenantId = await actingTenantId();
    const name = str(formData.get("name"));
    if (!name) return;
    await prisma.part.create({
      data: {
        tenantId,
        name,
        sku: str(formData.get("sku")) || null,
        priceCents: rand(formData.get("price")),
        costCents: rand(formData.get("cost")),
        stockQty: int(formData.get("stockQty")) || 0,
        reorderAt: Number.isNaN(int(formData.get("reorderAt"))) ? null : int(formData.get("reorderAt")),
        location: str(formData.get("location")) || null,
        notes: str(formData.get("notes")) || null,
      },
    });
    revalidatePath("/parts");
    redirect("/parts");
  });
}

export async function updatePart(id: string, formData: FormData) {
  return withActingStaffScope(async () => {
    await requirePermission("parts.manage");
    const tenantId = await actingTenantId();
    const updated = await prisma.part.updateMany({
      where: { id, tenantId, deletedAt: null },
      data: {
        name: str(formData.get("name")),
        sku: str(formData.get("sku")) || null,
        priceCents: rand(formData.get("price")),
        costCents: rand(formData.get("cost")),
        reorderAt: Number.isNaN(int(formData.get("reorderAt"))) ? null : int(formData.get("reorderAt")),
        location: str(formData.get("location")) || null,
        notes: str(formData.get("notes")) || null,
      },
    });
    if (updated.count !== 1) return;
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
