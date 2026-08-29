"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { isActingTenantMember } from "@/lib/tenantActor";
import { logAudit } from "@/lib/audit";
import { withActingStaffScope } from "@/lib/actingScope";

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
    if (user.role !== "owner" && row.userId !== user.id) return;
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
    if (user.role !== "owner" && userId !== user.id) return;
    if (!(await isActingTenantMember(userId))) return;
    const target = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    const { count } = await prisma.userSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await logAudit({
      action: "session.revoked_all",
      summary: `Signed out all devices (${count}) for ${target?.name ?? "user"}`,
      user,
    });
    revalidatePath("/settings/sessions");
  });
}
