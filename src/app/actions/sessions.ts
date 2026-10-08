"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { isTenantOwner, requireUser } from "@/lib/auth";
import { isActingTenantMember } from "@/lib/tenantActor";
import { logAudit } from "@/lib/audit";
import { withActingStaffScope } from "@/lib/actingScope";

/**
 * Yourself always; anyone else only as the WORKSPACE's owner (requireTenantOwner's
 * predicate — `role === "owner"` alone is the platform owner, so other workspaces'
 * owners could not sign out a lost phone), and never a platform owner's devices
 * unless you are one (the same rule as security.ts's assertManageableUser).
 */
async function mayManageSessionsOf(
  user: { id: string; role: string },
  targetId: string,
  targetRole: string | null | undefined,
): Promise<boolean> {
  if (targetId === user.id) return true;
  if (!(await isTenantOwner())) return false;
  return user.role === "owner" || targetRole !== "owner";
}

/**
 * Revoke one device. Owners can revoke anyone's; users their own.
 *
 * "Anyone" means anyone IN THIS WORKSPACE. `UserSession` hangs off the global
 * `User` table, so the id alone reaches every session on the platform, and both
 * actions here are POST endpoints — reachable without the page that lists the
 * ones you are allowed to see. Being an owner of workspace A said nothing about
 * workspace B until this check existed.
 */
export async function revokeSession(id: string) {
  return withActingStaffScope(async () => {
    const user = await requireUser();
    const row = await prisma.userSession.findUnique({ where: { id }, include: { user: true } });
    if (!row) return;
    if (!(await mayManageSessionsOf(user, row.userId, row.user.role))) return;
    if (!(await isActingTenantMember(row.userId))) return;
    await prisma.userSession.update({ where: { id }, data: { revokedAt: new Date() } });
    await logAudit({
      action: "session.revoked",
      summary: `Signed out a ${row.platform} device of ${row.user.name}`,
      user,
    });
    revalidatePath("/settings/sessions");
  });
}

/** Sign out EVERY device of a user (lost phone / offboarding). */
export async function revokeAllForUser(userId: string) {
  return withActingStaffScope(async () => {
    const user = await requireUser();
    const target = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, role: true } });
    if (!(await mayManageSessionsOf(user, userId, target?.role))) return;
    if (!(await isActingTenantMember(userId))) return;
    const { count } = await prisma.userSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    // "All devices" includes a phone linked to the assistant — a sign-in by
    // another route. This revokes sessions without bumping the version that
    // would otherwise end the link, so it ends it here (this workspace only:
    // the tenant-scoped client).
    const phone = await prisma.assistantPhoneLink.deleteMany({ where: { userId } });
    await logAudit({
      action: "session.revoked_all",
      summary: `Signed out all devices (${count}) for ${target?.name ?? "user"}${phone.count ? ", and unlinked their WhatsApp from the assistant" : ""}`,
      user,
    });
    revalidatePath("/settings/sessions");
  });
}
