"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireTenantOwner } from "@/lib/auth";
import { actingTenantId } from "@/lib/actingTenant";
import { logAudit } from "@/lib/audit";
import { asActionResult, refuse, type ActionResult } from "@/lib/actionResult";

/** Settings → Suppliers: the businesses a deal's supplier documents name. Owner only; every change audited. */

const PAGE = "/settings/vendors";
const field = (formData: FormData, key: string, max: number) => String(formData.get(key) ?? "").trim().slice(0, max) || null;

export async function saveVendor(id: string | null, formData: FormData): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    const tenantId = await actingTenantId();
    const name = field(formData, "name", 120);
    if (!name) refuse("Give the supplier a name.");
    const data = { name, phone: field(formData, "phone", 40), email: field(formData, "email", 160), notes: field(formData, "notes", 1000) };
    // A workspace has a handful of suppliers: compared here, ignoring case, rather than with an ILIKE.
    const others = await prisma.vendor.findMany({ where: { tenantId, deletedAt: null, ...(id ? { NOT: { id } } : {}) }, select: { name: true } });
    if (others.some((other) => other.name.toLowerCase() === name.toLowerCase())) refuse(`There is already a supplier called “${name}”.`);
    if (id) {
      const changed = await prisma.vendor.updateMany({ where: { id, tenantId, deletedAt: null }, data });
      if (changed.count !== 1) refuse("That supplier is no longer there — refresh the page.");
    } else {
      await prisma.vendor.create({ data: { tenantId, ...data } });
    }
    await logAudit({ action: id ? "vendor.updated" : "vendor.created", summary: `${id ? "Updated" : "Added"} supplier “${name}”`, user });
    revalidatePath(PAGE);
    return { success: id ? "Supplier saved" : "Supplier added" };
  });
}

/** To the Trash (restorable). Its documents keep naming it, so a deal's file still reads right. */
export async function deleteVendor(id: string, formData: FormData): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    const tenantId = await actingTenantId();
    const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
    const vendor = await prisma.vendor.findFirst({ where: { id, tenantId, deletedAt: null }, select: { name: true } });
    if (!vendor) refuse("That supplier is already gone — refresh the page.");
    await prisma.vendor.updateMany({ where: { id, tenantId, deletedAt: null }, data: { deletedAt: new Date() } });
    await logAudit({ action: "trash.deleted", summary: `Moved supplier “${vendor.name}” to trash — ${reason}`, user });
    revalidatePath(PAGE);
    return { success: "Moved to trash" };
  });
}
