"use server";

import { revalidatePath } from "next/cache";
import sharp from "sharp";
import { asActionResult, ActionRefusal, type ActionResult } from "@/lib/actionResult";
import { basePrisma } from "@/lib/db";
import { requireTenantOwner } from "@/lib/auth";
import { actingOwnerTenantId } from "@/lib/actingScope";
import { requirePlatformAdminAction } from "@/lib/platformAuth";
import { logAuditStrict } from "@/lib/audit";
import { putManagedBlob } from "@/lib/storage";

/*
 * A workspace's square app icon (lib/appIcon.ts): the tab, the installed app and its notifications. Uploaded by the
 * workspace owner (Settings → Company profile) or a platform admin (the console). No SVG — a document, not pixels.
 * Old icons are kept, like logos: a file name is an identifier, never overwritten.
 */

const MAX_ICON_BYTES = 1024 * 1024;
const ICON_TYPES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
]);

type Audit = { user?: { id: string; name: string }; userName?: string; actorType?: string; metadata?: Record<string, unknown> };

async function storeIcon(tenantId: string, formData: FormData, audit: Audit) {
  const file = formData.get("icon");
  if (!(file instanceof File) || file.size === 0) throw new ActionRefusal("Choose an icon file.");
  if (file.size > MAX_ICON_BYTES) throw new ActionRefusal("The icon must be smaller than 1 MB.");
  const ext = ICON_TYPES.get(file.type);
  if (!ext) throw new ActionRefusal("The icon must be a PNG, JPEG or WebP image.");
  const bytes = Buffer.from(await file.arrayBuffer());
  // The bytes, not just the declared type: it must open as that picture, and be big enough for a home screen.
  const meta = await sharp(bytes).metadata().catch(() => null);
  if (!meta?.width || !meta.height || meta.format !== (ext === "jpg" ? "jpeg" : ext)) throw new ActionRefusal("That file isn't a readable PNG, JPEG or WebP image.");
  if (Math.min(meta.width, meta.height) < 192) throw new ActionRefusal("The icon must be at least 192 × 192 pixels (512 × 512 is best).");

  const tenant = await basePrisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true, brandIconRef: true } });
  if (!tenant) throw new ActionRefusal("Workspace not found.");
  const { pathname } = await putManagedBlob(`branding/${tenantId}/icon-${Date.now()}.${ext}`, bytes, file.type);
  await basePrisma.$transaction(async (tx) => {
    await tx.tenant.update({ where: { id: tenantId }, data: { brandIconRef: pathname } });
    await logAuditStrict(
      { action: "tenant.brand_icon_changed", summary: `Updated the app icon for “${tenant.name}”`, entityType: "Tenant", entityId: tenantId, before: { brandIconRef: tenant.brandIconRef }, after: { brandIconRef: pathname }, ...audit },
      tx,
    );
  });
  revalidatePath("/", "layout");
}

async function clearIcon(tenantId: string, audit: Audit) {
  const tenant = await basePrisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true, brandIconRef: true } });
  if (!tenant) throw new ActionRefusal("Workspace not found.");
  await basePrisma.$transaction(async (tx) => {
    await tx.tenant.update({ where: { id: tenantId }, data: { brandIconRef: null } });
    await logAuditStrict(
      { action: "tenant.brand_icon_changed", summary: `Removed the app icon for “${tenant.name}”`, entityType: "Tenant", entityId: tenantId, before: { brandIconRef: tenant.brandIconRef }, after: { brandIconRef: null }, ...audit },
      tx,
    );
  });
  revalidatePath("/", "layout");
}

export async function uploadMyAppIconAction(formData: FormData): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    await storeIcon(await actingOwnerTenantId(), formData, { user: { id: user.id, name: user.name } });
    return { success: "App icon updated" };
  });
}

export async function removeMyAppIconAction(): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    await clearIcon(await actingOwnerTenantId(), { user: { id: user.id, name: user.name } });
    return { success: "App icon removed" };
  });
}

export async function setTenantAppIconAction(tenantId: string, formData: FormData): Promise<ActionResult> {
  return asActionResult(async () => {
    const actor = await requirePlatformAdminAction();
    await storeIcon(tenantId, formData, { userName: actor.name, actorType: "platform_admin", metadata: { platformAdminId: actor.id, platformAdminEmail: actor.email } });
    revalidatePath("/platform/tenants");
    return { success: "App icon updated" };
  });
}

export async function clearTenantAppIconAction(tenantId: string): Promise<ActionResult> {
  return asActionResult(async () => {
    const actor = await requirePlatformAdminAction();
    await clearIcon(tenantId, { userName: actor.name, actorType: "platform_admin", metadata: { platformAdminId: actor.id, platformAdminEmail: actor.email } });
    revalidatePath("/platform/tenants");
    return { success: "App icon removed" };
  });
}
