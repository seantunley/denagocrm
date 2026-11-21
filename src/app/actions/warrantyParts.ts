"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { getActiveTenantId, requireTenantOwner } from "@/lib/auth";
import { asActionResult, refuse } from "@/lib/actionResult";
import { withActingStaffScope } from "@/lib/actingScope";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { requireVehicleAccess } from "@/lib/permissions";
import { getWorkspaceSetting, putWorkspaceSetting } from "@/lib/settings";
import { formatDate } from "@/lib/format";
import { issueWarrantyCertificate } from "@/lib/warrantyCertificateStore";
import {
  WARRANTY_PARTS_KEY,
  coverOf,
  parsePartList,
  parseTerms,
  termLabel,
  termsFromForm,
  type WarrantyTerm,
} from "@/lib/warrantyParts";

/* Warranty in parts (lib/warrantyParts.ts): the workspace's part list, a product's terms, one vehicle's own cover. */

async function workspace(): Promise<string> {
  if (!(await isModuleEnabled("warranty"))) refuse("Warranty is switched off for this workspace.");
  const tenantId = await getActiveTenantId();
  if (!tenantId) return refuse("No workspace attached to this sign-in — sign out and back in.");
  return tenantId;
}

const said = (terms: readonly WarrantyTerm[]) => (terms.length ? terms.map((t) => `${t.part} ${termLabel(t.months)}`).join(", ") : "none");

/** The part names the warranty dropdowns offer (one per line). Owner only. */
export async function saveWarrantyPartList(formData: FormData) {
  return withActingStaffScope(() =>
    asActionResult(async () => {
      const user = await requireTenantOwner();
      const tenantId = await workspace();
      const parts = parsePartList(String(formData.get("parts") ?? ""));
      if (parts.length === 0) refuse("Keep at least one part — for example Battery.");
      await putWorkspaceSetting(tenantId, WARRANTY_PARTS_KEY, parts.join("\n"));
      await logAudit({ action: "settings.warranty_parts", summary: `Warranty parts: ${parts.join(", ")}`, user });
      revalidatePath("/warranty");
      return { success: "Saved" };
    }),
  );
}

/** A product's warranty terms, copied onto each vehicle at delivery. Owner only, as the rest of the product page. */
export async function saveProductWarrantyTerms(productId: string, formData: FormData) {
  return withActingStaffScope(() =>
    asActionResult(async () => {
      const user = await requireTenantOwner();
      const tenantId = await workspace();
      const product = await prisma.product.findFirst({ where: { id: productId, tenantId }, select: { name: true, warrantyTerms: true } });
      if (!product) refuse("Product not found.");
      const posted = termsFromForm(formData, parsePartList(await getWorkspaceSetting(tenantId, WARRANTY_PARTS_KEY)));
      if (!posted.ok) refuse(posted.error);
      const saved = await prisma.product.updateMany({ where: { id: productId, tenantId }, data: { warrantyTerms: posted.terms } });
      if (saved.count !== 1) refuse("Product not found.");
      await logAudit({
        action: "product.warranty_terms",
        summary: `Warranty for ${product.name}: ${said(posted.terms)} (was ${said(parseTerms(product.warrantyTerms))}). Vehicles already delivered keep theirs.`,
        user,
      });
      revalidatePath(`/products/${productId}`);
      return { success: "Saved" };
    }),
  );
}

/** Issue (or reissue, after a correction) the vehicle's warranty certificate: filed on the customer, not sent. */
export async function issueVehicleCertificate(vehicleId: string) {
  return withActingStaffScope(() =>
    asActionResult(async () => {
      const user = await requireVehicleAccess(vehicleId, "warranty.manage");
      const tenantId = await workspace();
      const issued = await issueWarrantyCertificate({ tenantId, vehicleId, actor: user, why: "reissue" });
      if (!issued) refuse("This vehicle has no warranty recorded — set its cover first.");
      revalidatePath(`/vehicles/${vehicleId}`);
      return { success: `Certificate ${issued.number} filed` };
    }),
  );
}

/**
 * One vehicle's own cover: its parts and the day they run from. With warranty.manage on that vehicle (which also needs
 * the Warranty module). The change is on the vehicle's history with what it was before.
 */
export async function saveVehicleWarranty(vehicleId: string, formData: FormData) {
  return withActingStaffScope(() =>
    asActionResult(async () => {
      const user = await requireVehicleAccess(vehicleId, "warranty.manage");
      const tenantId = await workspace();
      const vehicle = await prisma.vehicle.findFirst({
        where: { id: vehicleId, tenantId, deletedAt: null },
        select: { model: true, contactId: true, warrantyParts: true, warrantyStartsAt: true },
      });
      if (!vehicle) refuse("This vehicle is in the trash or no longer exists.");
      const posted = termsFromForm(formData, parsePartList(await getWorkspaceSetting(tenantId, WARRANTY_PARTS_KEY)));
      if (!posted.ok) refuse(posted.error);
      const startsOn = String(formData.get("startsOn") ?? "").trim();
      const start = /^\d{4}-\d{2}-\d{2}$/.test(startsOn) ? new Date(`${startsOn}T00:00:00`) : null;
      if (posted.terms.length > 0 && (!start || Number.isNaN(start.getTime()))) refuse("Pick the day the warranty starts — usually the delivery day.");
      if (start && start > new Date()) refuse("The warranty can't start in the future.");
      const saved = await prisma.vehicle.updateMany({
        where: { id: vehicleId, tenantId, deletedAt: null },
        data: { warrantyParts: posted.terms, warrantyStartsAt: posted.terms.length ? start : null },
      });
      if (saved.count !== 1) refuse("This vehicle is in the trash or no longer exists.");
      const cover = start ? coverOf(posted.terms, start, new Date()) : [];
      await logAudit({
        action: "vehicle.warranty_changed",
        summary: `Warranty on ${vehicle.model}: ${cover.length ? cover.map((c) => `${c.part} ${termLabel(c.months)}${c.until ? ` until ${formatDate(c.until)}` : ""}`).join(", ") : "none"} (was ${said(parseTerms(vehicle.warrantyParts))}${vehicle.warrantyStartsAt ? ` from ${formatDate(vehicle.warrantyStartsAt)}` : ""})`,
        contactId: vehicle.contactId,
        user,
        before: { warrantyParts: vehicle.warrantyParts, warrantyStartsAt: vehicle.warrantyStartsAt },
        after: { warrantyParts: posted.terms, warrantyStartsAt: start },
      });
      revalidatePath(`/vehicles/${vehicleId}`);
      return { success: "Saved" };
    }),
  );
}
