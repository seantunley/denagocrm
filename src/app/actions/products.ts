"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { withActingTenantWrite } from "@/lib/actingScope";
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
  // the owning tenant (bypass path — the guard won't stamp).
  //
  // USER-ORIGINATED: `requireOwner()` above proves a signed-in owner is doing this,
  // and a product has no parent record — the creating workspace IS the owner. So
  // the tenant is the ACTING workspace. `withTenantWrite` was wrong here for the
  // reason #470 documents: it resolves `writeTenantId() ?? DEFAULT_TENANT_ID`, and
  // `writeTenantId()` is null while enforcement is dormant, so a second workspace's
  // catalogue was written into the founding tenant. The COLOURS take the same
  // tenantId as the product they belong to, from the same transaction, so parent
  // and child can never disagree.
  const product = await withActingTenantWrite(async (tx, tenantId) => {
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
  // Nothing matched — another tenant's id, or already gone. Never audit a
  // deletion that did not happen.
  if (!product) return;
  await logAudit({
    action: "trash.deleted",
    summary: `Moved product ${product.name} to trash — ${reason}`,
    user,
  });
  revalidatePath("/products");
  redirect("/products");
}
