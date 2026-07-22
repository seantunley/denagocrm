import "server-only";
import { prisma } from "./db";
import { currentTenantScope } from "./tenantScope";
import { tenantEnforcing } from "./tenantEnforcement";

export type TenantActor = { id: string; name: string; email: string };

/**
 * Resolve a valid acting user for a SYSTEM-GENERATED, tenant-owned record that has
 * no human actor in the request — e.g. the survey-response timeline note
 * (`Communication.userId`), the completed-document uploader (`Document.uploadedById`),
 * or the owner recipient of an approval notification.
 *
 * The legacy pattern (`user.findFirst({ orderBy: { createdAt: "asc" } })`, or the
 * first `role:"owner"`) picks the GLOBAL oldest user. Because `User` is a global
 * model the tenant guard does NOT scope it, so that pick can belong to ANOTHER
 * tenant — and then get stamped onto this tenant's row, or emailed this tenant's
 * document title + token. Under enforcement, with a tenant scope active, restrict
 * the pick to an ACTIVE member of the CURRENT tenant (via `TenantMember`),
 * owner-preferred when asked. Dormant / system scope / no tenant scope: the
 * unchanged global pick, so today's behaviour is byte-for-byte identical.
 *
 * `User` + `TenantMember` are global models, so these reads need no tenant scope
 * and cannot deadlock.
 */
export async function resolveTenantActor(
  opts: { ownerOnly?: boolean } = {},
): Promise<TenantActor | null> {
  const scope = currentTenantScope();
  const tenantId = tenantEnforcing() && scope && !scope.system ? scope.tenantId : null;

  if (tenantId) {
    const member = await prisma.tenantMember.findFirst({
      where: {
        tenantId,
        tenant: { active: true },
        ...(opts.ownerOnly ? { user: { role: "owner" } } : {}),
      },
      orderBy: { user: { createdAt: "asc" } },
      select: { user: { select: { id: true, name: true, email: true } } },
    });
    return member?.user ?? null;
  }

  return prisma.user.findFirst({
    where: opts.ownerOnly ? { role: "owner" } : {},
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, email: true },
  });
}
