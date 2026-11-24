"use server";

import { revalidatePath } from "next/cache";
import { asActionResult, ActionRefusal, type ActionResult } from "@/lib/actionResult";
import { basePrisma } from "@/lib/db";
import { requireTenantOwner } from "@/lib/auth";
import { actingOwnerTenantId, withActingStaffScope } from "@/lib/actingScope";
import { logAuditStrict } from "@/lib/audit";
import { putManagedBlob } from "@/lib/storage";
import { putSetting } from "@/lib/settings";
import { COMPANY_KEYS } from "@/lib/companyProfile";

/**
 * The workspace OWNER uploads their own logo (Settings → Company profile) — the same Tenant.brandLogoRef the platform
 * console sets (actions/tenantBranding.ts), so one logo shows on the sign-in page, in the app and on documents.
 *
 * Documents read the Company Profile's logo address first (lib/companyProfile.ts), so an upload clears that address:
 * otherwise a workspace that once typed one would keep printing the old logo after uploading a new one.
 */

const MAX_LOGO_BYTES = 1024 * 1024;
const LOGO_TYPES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/svg+xml", "svg"],
  ["image/webp", "webp"],
]);

export async function uploadMyLogoAction(formData: FormData): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    const tenantId = await actingOwnerTenantId();
    const file = formData.get("logo");
    if (!(file instanceof File) || file.size === 0) throw new ActionRefusal("Choose a logo file.");
    if (file.size > MAX_LOGO_BYTES) throw new ActionRefusal("The logo must be smaller than 1 MB.");
    const ext = LOGO_TYPES.get(file.type);
    if (!ext) throw new ActionRefusal("The logo must be a PNG, JPEG, SVG or WebP image.");

    const tenant = await basePrisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true, brandLogoRef: true } });
    if (!tenant) throw new ActionRefusal("Workspace not found.");
    // Logo file names are logo-<stamp>.<ext> and never overwritten — the logo route serves only that shape.
    const { pathname } = await putManagedBlob(`branding/${tenantId}/logo-${Date.now()}.${ext}`, Buffer.from(await file.arrayBuffer()), file.type);

    await basePrisma.$transaction(async (tx) => {
      await tx.tenant.update({ where: { id: tenantId }, data: { brandLogoRef: pathname } });
      await logAuditStrict(
        { action: "tenant.brand_logo_changed", summary: `Updated the logo for “${tenant.name}”`, entityType: "Tenant", entityId: tenantId, user: { id: user.id, name: user.name }, before: { brandLogoRef: tenant.brandLogoRef }, after: { brandLogoRef: pathname } },
        tx,
      );
    });
    await withActingStaffScope(() => putSetting(COMPANY_KEYS.logoUrl, ""));
    revalidatePath("/settings/company");
    revalidatePath("/login");
    revalidatePath("/", "layout");
    return { success: "Logo updated" };
  });
}
