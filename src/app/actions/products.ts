"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
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
  await requireUser();
  const data = productData(formData);
  if (!data.name) throw new Error("Product name is required");
  const colors = String(formData.get("colors") ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  const product = await prisma.product.create({
    data: { ...data, colors: { create: colors.map((name) => ({ name })) } },
  });
  revalidatePath("/products");
  redirect(`/products/${product.id}`);
}

export async function updateProduct(id: string, formData: FormData) {
  await requireUser();
  const data = productData(formData);
  if (!data.name) throw new Error("Product name is required");
  await prisma.product.update({ where: { id }, data });
  revalidatePath("/products");
  revalidatePath(`/products/${id}`);
}

export async function addProductColor(productId: string, formData: FormData) {
  await requireUser();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  await prisma.productColor.create({ data: { productId, name } });
  revalidatePath(`/products/${productId}`);
}

export async function deleteProductColor(id: string, productId: string, formData: FormData) {
  await requireUser();
  void formData;
  await prisma.productColor.delete({ where: { id } });
  revalidatePath(`/products/${productId}`);
}

export async function deleteProduct(id: string, formData: FormData) {
  const user = await requireUser();
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
