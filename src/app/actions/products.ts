"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { withTenantWrite } from "@/lib/tenantWrite";
import { requireOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { softDeleteRecord } from "@/lib/trash";
import { parseRands } from "@/lib/format";

function productData(formData: FormData) {
  const str = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    return v === "" ? null : v;
  };
  return {
    name: String(formData.get("name") ?? "").trim(),
    sku: str("sku"),
    category: str("category"),
    basePriceCents: parseRands(str("basePrice")),
    description: str("description"),
    active: formData.get("active") !== null ? formData.get("active") === "on" : true,
  };
}

export async function createProduct(formData: FormData) {
  await requireOwner();
  const data = productData(formData);
  if (!data.name) throw new Error("Product name is required");
  const colors = String(formData.get("colors") ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  // Atomic: product + its colours in ONE transaction, each explicitly stamped with
  // the owning tenant (bypass path — the guard won't stamp; founding tenant when
  // enforcement is off so nothing lands tenantless).
  const product = await withTenantWrite(async (tx, tenantId) => {
    const created = await tx.product.create({ data: { ...data, tenantId } });
    if (colors.length > 0) {
      await tx.productColor.createMany({
        data: colors.map((name) => ({ productId: created.id, name, tenantId })),
      });
    }
    return created;
  });
  revalidatePath("/products");
  redirect(`/products/${product.id}`);
}

export async function updateProduct(id: string, formData: FormData) {
  await requireOwner();
  const data = productData(formData);
  if (!data.name) throw new Error("Product name is required");
  await prisma.product.update({ where: { id }, data });
  revalidatePath("/products");
  revalidatePath(`/products/${id}`);
}

export async function addProductColor(productId: string, formData: FormData) {
  await requireOwner();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  await prisma.productColor.create({ data: { productId, name } });
  revalidatePath(`/products/${productId}`);
}

export async function deleteProductColor(id: string, productId: string, formData: FormData) {
  await requireOwner();
  void formData;
  await prisma.productColor.delete({ where: { id } });
  revalidatePath(`/products/${productId}`);
}

export async function deleteProduct(id: string, formData: FormData) {
  const user = await requireOwner();
  const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
  const product = await softDeleteRecord("product", id, reason, user.name);
  await logAudit({
    action: "trash.deleted",
    summary: `Moved product ${product.name} to trash — ${reason}`,
    user,
  });
  revalidatePath("/products");
  redirect("/products");
}
