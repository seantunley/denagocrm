"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { withActingTenantWrite, withActingStaffScope } from "@/lib/actingScope";
import { requireOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { softDeleteRecord } from "@/lib/trash";
import { parseRands } from "@/lib/format";
import { Prisma } from "@prisma/client";
import { deleteFile, saveFile } from "@/lib/storage";
import { detectProfileImageMime } from "@/lib/profile";
import { MAX_VEHICLE_SPECS, parseVehicleSpecs } from "@/lib/docbuilder/vehicleShowcase";

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

/**
 * Bound with {@link withActingStaffScope} because this action reads the tenant scope
 * SYNCHRONOUSLY (inheritedTenantId / activeTenantPredicate / writeTenantId), and a
 * sync reader cannot recover a missing scope the way an awaited one can.
 *
 * A Server Action has no React request store, so #513's holder is never filled, and
 * `enterWith` inside the auth chokepoint does not reach the frame that called it —
 * the action body therefore runs with no ambient scope and the sync reader throws.
 * Binding an ENCLOSING frame here is the only shape that reaches it.
 */
export async function createProduct(formData: FormData) {
  return withActingStaffScope(async () => {
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
  });
}

export async function updateProduct(id: string, formData: FormData) {
  return withActingStaffScope(async () => {
    await requireOwner();
    const data = productData(formData);
    if (!data.name) throw new Error("Product name is required");
    await prisma.product.update({ where: { id }, data });
    revalidatePath("/products");
    revalidatePath(`/products/${id}`);
  });
}

/** Product photos are embedded into every quote PDF that shows them, so keep them modest. */
const SHOWCASE_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The "Quote showcase" card: the tagline, spec icons and photo the showcase
 * quotation layout shows for this model. The photo goes to the private store,
 * filed under the PRODUCT's workspace, and is embedded as a data URL when a
 * quote is rendered (lib/docbuilder/vehicleShowcaseLoad.ts).
 */
export async function updateProductShowcase(id: string, formData: FormData) {
  return withActingStaffScope(async () => {
    await requireOwner();
    // Tenant-scoped read: another workspace's product id resolves to nothing.
    const product = await prisma.product.findUnique({ where: { id }, select: { id: true, tenantId: true, showcaseImageRef: true } });
    if (!product) throw new Error("Product not found");

    const specs = parseVehicleSpecs(
      Array.from({ length: MAX_VEHICLE_SPECS }, (_, i) => ({
        icon: String(formData.get(`specIcon${i}`) ?? ""),
        label: String(formData.get(`specLabel${i}`) ?? "").slice(0, 40),
        sub: String(formData.get(`specSub${i}`) ?? "").slice(0, 60),
      })),
    );
    const tagline = String(formData.get("showcaseTagline") ?? "").trim().slice(0, 120) || null;

    let imageRef = product.showcaseImageRef;
    const upload = formData.get("showcaseImage");
    if (upload instanceof File && upload.size > 0) {
      if (upload.size > SHOWCASE_IMAGE_MAX_BYTES) throw new Error("Product photos must be 4 MB or smaller.");
      const buffer = Buffer.from(await upload.arrayBuffer());
      const mime = detectProfileImageMime(buffer); // sniffed from the bytes, not the browser's say-so
      if (!mime) throw new Error("That file is not a PNG, JPG or WebP image.");
      const ext = mime === "image/jpeg" ? ".jpg" : mime === "image/png" ? ".png" : ".webp";
      imageRef = await saveFile(buffer, `product-${product.id}${ext}`, mime, product.tenantId);
    } else if (formData.get("removeShowcaseImage") === "on") {
      imageRef = null;
    }

    try {
      await prisma.product.update({
        where: { id },
        data: { showcaseTagline: tagline, showcaseSpecs: specs.length ? specs : Prisma.DbNull, showcaseImageRef: imageRef },
      });
    } catch (error) {
      if (imageRef && imageRef !== product.showcaseImageRef) await deleteFile(imageRef).catch(() => {});
      throw error;
    }
    if (product.showcaseImageRef && product.showcaseImageRef !== imageRef) {
      await deleteFile(product.showcaseImageRef).catch((error) => console.warn("Unable to remove previous product photo", error));
    }
    revalidatePath(`/products/${id}`);
  });
}

export async function addProductColor(productId: string, formData: FormData) {
  return withActingStaffScope(async () => {
    await requireOwner();
    const name = String(formData.get("name") ?? "").trim();
    if (!name) return;
    await prisma.productColor.create({ data: { productId, name } });
    revalidatePath(`/products/${productId}`);
  });
}

export async function deleteProductColor(id: string, productId: string, formData: FormData) {
  return withActingStaffScope(async () => {
    await requireOwner();
    void formData;
    await prisma.productColor.delete({ where: { id } });
    revalidatePath(`/products/${productId}`);
  });
}

export async function deleteProduct(id: string, formData: FormData) {
  return withActingStaffScope(async () => {
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
  });
}
