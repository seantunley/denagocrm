"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { asActionResult, ActionRefusal, type ActionResult } from "@/lib/actionResult";
import { basePrisma } from "@/lib/db";
import { requireTenantOwner } from "@/lib/auth";
import { actingOwnerTenantId } from "@/lib/actingScope";
import { requirePlatformAdminAction } from "@/lib/platformAuth";
import { logAuditStrict } from "@/lib/audit";
import { putManagedBlob } from "@/lib/storage";
import { LOGIN_TEXT_FIELDS, LOGIN_TILE_MAX, cleanText, parseLoginLook, type LoginLook } from "@/lib/loginLook";

/**
 * Saving a workspace's sign-in screen (lib/loginLook.ts): its OWNER from Settings → Company profile, or a platform
 * admin from the console. Both are public HTTP endpoints, so each authorises FIRST; the values are then checked here
 * and again on every read.
 */

const MAX_PICTURE_BYTES = 4 * 1024 * 1024;
const PICTURE_TYPES: Record<string, { ext: string; magic: (b: Buffer) => boolean }> = {
  "image/png": { ext: "png", magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  "image/jpeg": { ext: "jpg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/webp": { ext: "webp", magic: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
};

/** An uploaded picture, stored as an immutable file named for its kind and time — or null when none was chosen. */
async function storePicture(tenantId: string, formData: FormData, field: string, kind: "bg" | "card"): Promise<string | null> {
  const file = formData.get(field);
  if (!(file instanceof File) || file.size === 0) return null;
  if (file.size > MAX_PICTURE_BYTES) throw new ActionRefusal("Pictures must be smaller than 4 MB.");
  const type = PICTURE_TYPES[file.type];
  const bytes = Buffer.from(await file.arrayBuffer());
  // The declared type AND the bytes: a renamed file is refused. No SVG — it is a document that can carry script.
  if (!type || !type.magic(bytes)) throw new ActionRefusal("Pictures must be PNG, JPEG or WebP images.");
  const name = `login-${kind}-${Date.now()}.${type.ext}`;
  await putManagedBlob(`branding/${tenantId}/${name}`, bytes, file.type);
  return name;
}

/** The form's values on top of what is saved; a picture is kept unless replaced or removed. */
async function lookFromForm(tenantId: string, formData: FormData, saved: LoginLook): Promise<LoginLook> {
  const look: LoginLook = { ...saved, cardTiles: [...saved.cardTiles] };
  for (const [field, rule] of Object.entries(LOGIN_TEXT_FIELDS) as [keyof typeof LOGIN_TEXT_FIELDS, { max: number }][]) {
    if (formData.has(field)) look[field] = cleanText(formData.get(field), rule.max);
  }
  look.cardTiles = [0, 1, 2].map((i) => cleanText(formData.get(`cardTile${i}`), LOGIN_TILE_MAX)) as [string, string, string];
  look.cardNumbers = formData.get("cardNumbers") === "on";
  const background = String(formData.get("background") ?? "");
  const card = String(formData.get("card") ?? "");
  if (background === "standard" || background === "image") look.background = background;
  if (card === "dashboard" || card === "image" || card === "none") look.card = card;
  if (formData.get("removeBackgroundImage") === "on") look.backgroundImage = null;
  if (formData.get("removeCardImage") === "on") look.cardImage = null;
  look.backgroundImage = (await storePicture(tenantId, formData, "backgroundImage", "bg")) ?? look.backgroundImage;
  look.cardImage = (await storePicture(tenantId, formData, "cardImage", "card")) ?? look.cardImage;
  if (look.background === "image" && !look.backgroundImage) throw new ActionRefusal("Choose a background picture, or use the standard background.");
  if (look.card === "image" && !look.cardImage) throw new ActionRefusal("Choose a picture for the card's place, or pick another option.");
  // Through the same checks the sign-in page applies, so what is stored is exactly what will show.
  return parseLoginLook(look);
}

async function save(tenantId: string, formData: FormData, audit: { user?: { id: string; name: string }; userName?: string; actorType?: string; metadata?: Record<string, unknown> }) {
  const tenant = await basePrisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true, loginJson: true } });
  if (!tenant) throw new ActionRefusal("Workspace not found.");
  const before = parseLoginLook(tenant.loginJson);
  const after = await lookFromForm(tenantId, formData, before);
  await basePrisma.$transaction(async (tx) => {
    await tx.tenant.update({ where: { id: tenantId }, data: { loginJson: after } });
    await logAuditStrict(
      { action: "tenant.login_look_changed", summary: `Updated the sign-in screen for “${tenant.name}”`, entityType: "Tenant", entityId: tenantId, before, after, ...audit },
      tx,
    );
  });
}

/** The workspace owner, for their own workspace. */
export async function saveMyLoginLookAction(formData: FormData): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    const tenantId = await actingOwnerTenantId();
    await save(tenantId, formData, { user: { id: user.id, name: user.name } });
    revalidatePath("/settings/company");
    revalidatePath("/login");
    return { success: "Sign-in screen saved" };
  });
}

/** A platform admin, for any workspace (console → Tenants → workspace → Brand). */
export async function savePlatformLoginLookAction(tenantId: string, formData: FormData): Promise<ActionResult> {
  return asActionResult(async () => {
    const actor = await requirePlatformAdminAction();
    await save(tenantId, formData, { userName: actor.name, actorType: "platform_admin", metadata: { platformAdminId: actor.id, platformAdminEmail: actor.email } });
    revalidatePath("/platform/tenants");
    revalidatePath("/login");
    return { success: "Sign-in screen saved" };
  });
}

/** Back to the standard sign-in screen. */
export async function resetMyLoginLookAction(): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    const tenantId = await actingOwnerTenantId();
    const tenant = await basePrisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true, loginJson: true } });
    if (!tenant) throw new ActionRefusal("Workspace not found.");
    await basePrisma.$transaction(async (tx) => {
      await tx.tenant.update({ where: { id: tenantId }, data: { loginJson: Prisma.DbNull } });
      await logAuditStrict({ action: "tenant.login_look_changed", summary: `Reset the sign-in screen for “${tenant.name}”`, entityType: "Tenant", entityId: tenantId, user: { id: user.id, name: user.name }, before: parseLoginLook(tenant.loginJson), after: null }, tx);
    });
    revalidatePath("/settings/company");
    revalidatePath("/login");
    return { success: "Sign-in screen reset to the standard one" };
  });
}
