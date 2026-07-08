"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireWorkshop } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

const rand = (v: FormDataEntryValue | null) =>
  Math.round(parseFloat(String(v ?? "0").replace(/[^0-9.]/g, "")) * 100) || 0;
const int = (v: FormDataEntryValue | null) => parseInt(String(v ?? "").replace(/[^0-9-]/g, ""), 10);
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();

export async function createPart(formData: FormData) {
  await requireWorkshop();
  const name = str(formData.get("name"));
  if (!name) return;
  await prisma.part.create({
    data: {
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
}

export async function updatePart(id: string, formData: FormData) {
  await requireWorkshop();
  await prisma.part.update({
    where: { id },
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
  revalidatePath("/parts");
}

/** Adjust stock by a signed delta (e.g. +10 restock, -2 correction). */
export async function adjustPartStock(id: string, formData: FormData) {
  const user = await requireWorkshop();
  const delta = int(formData.get("delta"));
  if (!delta || Number.isNaN(delta)) return;
  const part = await prisma.part.update({
    where: { id },
    data: { stockQty: { increment: delta } },
  });
  await logAudit({
    action: "part.stock_adjusted",
    summary: `${delta > 0 ? "+" : ""}${delta} × ${part.name} (now ${part.stockQty} in stock)`,
    user,
  });
  revalidatePath("/parts");
}

export async function deletePart(id: string) {
  await requireWorkshop();
  await prisma.part.update({ where: { id }, data: { deletedAt: new Date() } });
  revalidatePath("/parts");
}
