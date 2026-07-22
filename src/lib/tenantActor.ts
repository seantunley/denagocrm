import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { currentTenantScope } from "./tenantScope";
import { tenantEnforcing } from "./tenantEnforcement";

export type TenantActor = { id: string; name: string; email: string };

/** The tenantId to constrain global-User lookups to, or null when we must not
 * constrain (dormant / system scope / no tenant scope — unchanged behaviour). */
function scopedTenantId(): string | null {
  const scope = currentTenantScope();
  return tenantEnforcing() && scope && !scope.system ? scope.tenantId : null;
}

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
  const tenantId = scopedTenantId();

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

/**
 * Resolve a SPECIFIC user by id, but ONLY if they are a valid actor for the current
 * tenant — an active member of the current tenant scope. Used for EXPLICIT staff
 * assignees (approval steps): a stale or cross-tenant `assigneeUserId` must never be
 * emailed this tenant's document. Dormant / system / no-scope: the unchanged direct
 * lookup. Enforcing + tenant scope: returns null (FAIL CLOSED) when the id is not an
 * active member of that tenant.
 */
export async function resolveTenantMemberUser(userId: string): Promise<TenantActor | null> {
  const tenantId = scopedTenantId();
  if (tenantId) {
    const member = await prisma.tenantMember.findFirst({
      where: { tenantId, userId, tenant: { active: true } },
      select: { user: { select: { id: true, name: true, email: true } } },
    });
    return member?.user ?? null;
  }
  return prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true } });
}

/**
 * A Prisma `User` where-fragment that restricts a staff picker / list to members of
 * the CURRENT tenant scope, so a staff selector can't offer (and then persist) a
 * user from another tenant. Empty `{}` when dormant / system / no-scope (unchanged
 * full list). Spread into an existing `user.findMany` where.
 */
export function currentTenantUserWhere(): Prisma.UserWhereInput {
  const tenantId = scopedTenantId();
  if (!tenantId) return {};
  return { memberships: { some: { tenantId, tenant: { active: true } } } };
}
