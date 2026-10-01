"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { withActingTenantWrite } from "@/lib/actingScope";
// asActionResult binds the acting workspace itself (the synchronous tenant
// readers below still see it) AND returns a refusal as { error } for the form.
import { asActionResult, refuse } from "@/lib/actionResult";
import { requireOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { softDeleteRecord } from "@/lib/trash";
import { parseRands } from "@/lib/format";
import { Prisma } from "@prisma/client";
import { deleteFile, saveFile } from "@/lib/storage";
import {
  MAX_VEHICLE_SPECS,
  checkShowcaseImage,
  colourImageRef,
  parseColourImages,
  parseVehicleSpecs,
  uniqueColours,
} from "@/lib/docbuilder/vehicleShowcase";

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
 * Bound (via asActionResult → withActingStaffScope) because this action reads the tenant scope
 * SYNCHRONOUSLY (inheritedTenantId / activeTenantPredicate / writeTenantId), and a
 * sync reader cannot recover a missing scope the way an awaited one can.
 *
 * A Server Action has no React request store, so #513's holder is never filled, and
 * `enterWith` inside the auth chokepoint does not reach the frame that called it —
 * the action body therefore runs with no ambient scope and the sync reader throws.
 * Binding an ENCLOSING frame here is the only shape that reaches it.
 */
export async function createProduct(formData: FormData) {
  return asActionResult(async () => {
  await requireOwner();
  const data = productData(formData);
  if (!data.name) refuse("Product name is required");
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
  return { redirectTo: `/products/${product.id}`, success: `Added ${product.name}` };
  });
}

export async function updateProduct(id: string, formData: FormData) {
  return asActionResult(async () => {
    await requireOwner();
    const data = productData(formData);
    if (!data.name) refuse("Product name is required");
    await prisma.product.update({ where: { id }, data });
    revalidatePath("/products");
    revalidatePath(`/products/${id}`);
  });
}

/**
 * The "Quote showcase" card: the tagline, spec icons and photos the showcase
 * quotation layout shows for this model — a default photo plus one per colour
 * (the quoted colour's photo wins; see showcaseImageRefFor). Photos go to the
 * private store, filed under the PRODUCT's workspace, and are embedded as data
 * URLs when a quote is rendered (lib/docbuilder/vehicleShowcaseLoad.ts).
 */
export async function updateProductShowcase(id: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requireOwner();
    // Tenant-scoped read: another workspace's product id resolves to nothing.
    const product = await prisma.product.findUnique({
      where: { id },
      select: { id: true, tenantId: true, name: true, showcaseImageRef: true, showcaseColourImages: true, colors: { select: { id: true, name: true } } },
    });
    if (!product) refuse("Product not found");

    const specs = parseVehicleSpecs(
      Array.from({ length: MAX_VEHICLE_SPECS }, (_, i) => ({
        icon: String(formData.get(`specIcon${i}`) ?? ""),
        label: String(formData.get(`specLabel${i}`) ?? "").slice(0, 40),
        sub: String(formData.get(`specSub${i}`) ?? "").slice(0, 60),
      })),
    );
    const tagline = String(formData.get("showcaseTagline") ?? "").trim().slice(0, 120) || null;

    const saved: string[] = []; // written by THIS save — removed again if it fails
    // A new upload's ref, `null` when the owner ticked remove, else `current`.
    const photo = async (field: string, removeField: string, current: string | null, slug: string) => {
      const upload = formData.get(field);
      if (upload instanceof File && upload.size > 0) {
        const buffer = Buffer.from(await upload.arrayBuffer());
        let checked: { mime: string; ext: string };
        try {
          checked = checkShowcaseImage(buffer);
        } catch (error) {
          // Its only failures are the two size/format messages written for the owner.
          refuse(error instanceof Error ? error.message : "That photo can't be used.");
        }
        const { mime, ext } = checked;
        const ref = await saveFile(buffer, `product-${product.id}${slug}${ext}`, mime, product.tenantId);
        saved.push(ref);
        return ref;
      }
      return formData.get(removeField) === "on" ? null : current;
    };

    const previousColours = parseColourImages(product.showcaseColourImages);
    const colourImages: Record<string, string> = {};
    const changedColours: string[] = [];
    let imageRef: string | null;
    try {
      imageRef = await photo("showcaseImage", "removeShowcaseImage", product.showcaseImageRef, "");
      // Only the product's own colours: a photo for a colour since removed from
      // the product is dropped here (and its file deleted below).
      for (const colour of uniqueColours(product.colors)) {
        const current = colourImageRef(previousColours, colour.name);
        const next = await photo(`colourImage_${colour.id}`, `removeColourImage_${colour.id}`, current, `-${colour.id}`);
        if (next) colourImages[colour.name] = next;
        if (next !== current) changedColours.push(colour.name);
      }
      await prisma.product.update({
        where: { id },
        data: {
          showcaseTagline: tagline,
          showcaseSpecs: specs.length ? specs : Prisma.DbNull,
          showcaseImageRef: imageRef,
          showcaseColourImages: Object.keys(colourImages).length ? colourImages : Prisma.DbNull,
        },
      });
    } catch (error) {
      await Promise.all(saved.map((ref) => deleteFile(ref).catch(() => {})));
      throw error;
    }
    const kept = new Set([imageRef, ...Object.values(colourImages)]);
    for (const old of [product.showcaseImageRef, ...Object.values(previousColours)]) {
      if (old && !kept.has(old)) await deleteFile(old).catch((error) => console.warn("Unable to remove previous product photo", error));
    }
    await logAudit({
      action: "product.showcase_updated",
      summary: `Updated the quote showcase for ${product.name}${changedColours.length ? ` (colour photos: ${changedColours.join(", ")})` : ""}`,
      user,
      entityType: "product",
      entityId: product.id,
    });
    revalidatePath(`/products/${id}`);
  });
}

export async function addProductColor(productId: string, formData: FormData) {
  return asActionResult(async () => {
    await requireOwner();
    const name = String(formData.get("name") ?? "").trim();
    if (!name) refuse("Enter a colour name.");
    await prisma.productColor.create({ data: { productId, name } });
    revalidatePath(`/products/${productId}`);
  });
}

export async function deleteProductColor(id: string, productId: string, formData: FormData) {
  return asActionResult(async () => {
    await requireOwner();
    void formData;
    await prisma.productColor.delete({ where: { id } });
    revalidatePath(`/products/${productId}`);
  });
}

export async function deleteProduct(id: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requireOwner();
    const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
    const product = await softDeleteRecord("product", id, reason, user.name);
    // Nothing matched — another tenant's id, or already gone. Never audit a
    // deletion that did not happen.
    if (!product) refuse("That product is already gone — refresh the page.");
    await logAudit({
      action: "trash.deleted",
      summary: `Moved product ${product.name} to trash — ${reason}`,
      user,
    });
    revalidatePath("/products");
    return { redirectTo: "/products" };
  });
}
