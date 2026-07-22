import "server-only";
import { Prisma } from "@prisma/client";
import { basePrisma } from "./db";
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
 * Actor selection for system-generated, tenant-owned records (survey note,
 * signed-document uploader, approval notification recipient) + staff pickers.
 *
 * All selection is RAW SQL through `basePrisma`, for two reasons:
 *  - `User` is a global model, so restricting to the current tenant needs a
 *    `TenantMember` join, not the (no-op) tenant guard.
 *  - `disabledAt` (and `role`) are real `User` columns but are DELIBERATELY not in
 *    the Prisma model — they're the authoritative security state read via raw SQL
 *    (see userSecurity.ts). Every query below filters `u."disabledAt" IS NULL` so a
 *    DISABLED account is never picked, listed, or emailed a live approval token —
 *    consistently, in every mode (a token action needs no login, so disablement
 *    must be enforced at selection time).
 *
 * Under a tenant scope: an active member of that tenant. Dormant / system / no
 * scope: the unchanged global pick (still excluding disabled accounts).
 */
export async function resolveTenantActor(
  opts: { ownerOnly?: boolean } = {},
): Promise<TenantActor | null> {
  const tenantId = scopedTenantId();
  if (tenantId) {
    const owner = opts.ownerOnly ? Prisma.sql`AND u."role" = 'owner'` : Prisma.empty;
    const rows = await basePrisma.$queryRaw<TenantActor[]>`
      SELECT u."id", u."name", u."email"
      FROM "TenantMember" m
      JOIN "User" u ON u."id" = m."userId"
      JOIN "Tenant" t ON t."id" = m."tenantId"
      WHERE m."tenantId" = ${tenantId} AND t."active" = true AND u."disabledAt" IS NULL ${owner}
      ORDER BY u."createdAt" ASC
      LIMIT 1`;
    return rows[0] ?? null;
  }
  const owner = opts.ownerOnly ? Prisma.sql`AND "role" = 'owner'` : Prisma.empty;
  const rows = await basePrisma.$queryRaw<TenantActor[]>`
    SELECT "id", "name", "email" FROM "User"
    WHERE "disabledAt" IS NULL ${owner}
    ORDER BY "createdAt" ASC
    LIMIT 1`;
  return rows[0] ?? null;
}

/**
 * Resolve a SPECIFIC user by id, but ONLY if they are a valid actor for the current
 * tenant — an ACTIVE, NON-DISABLED member of the current tenant scope. Used for
 * EXPLICIT staff assignees (approval steps): a stale, cross-tenant, or disabled
 * `assigneeUserId` must never be emailed this tenant's document. Dormant / system /
 * no-scope: the unchanged direct lookup (still excluding disabled). Returns null
 * (FAIL CLOSED) when the id is not a valid current-tenant member.
 */
export async function resolveTenantMemberUser(userId: string): Promise<TenantActor | null> {
  const tenantId = scopedTenantId();
  if (tenantId) {
    const rows = await basePrisma.$queryRaw<TenantActor[]>`
      SELECT u."id", u."name", u."email"
      FROM "TenantMember" m
      JOIN "User" u ON u."id" = m."userId"
      JOIN "Tenant" t ON t."id" = m."tenantId"
      WHERE m."tenantId" = ${tenantId} AND m."userId" = ${userId}
        AND t."active" = true AND u."disabledAt" IS NULL
      LIMIT 1`;
    return rows[0] ?? null;
  }
  const rows = await basePrisma.$queryRaw<TenantActor[]>`
    SELECT "id", "name", "email" FROM "User"
    WHERE "id" = ${userId} AND "disabledAt" IS NULL
    LIMIT 1`;
  return rows[0] ?? null;
}

/**
 * The list of users eligible to be an approval assignee / staff selection: active,
 * non-disabled members of the current tenant scope (dormant / system / no-scope →
 * all active, non-disabled users). Replaces an unscoped `user.findMany` in the
 * workflow editor picker + runtime staffMap, so a workflow can neither offer nor
 * persist a cross-tenant or disabled user id.
 */
export async function listTenantStaff(): Promise<TenantActor[]> {
  const tenantId = scopedTenantId();
  if (tenantId) {
    return basePrisma.$queryRaw<TenantActor[]>`
      SELECT u."id", u."name", u."email"
      FROM "TenantMember" m
      JOIN "User" u ON u."id" = m."userId"
      JOIN "Tenant" t ON t."id" = m."tenantId"
      WHERE m."tenantId" = ${tenantId} AND t."active" = true AND u."disabledAt" IS NULL
      ORDER BY u."name" ASC`;
  }
  return basePrisma.$queryRaw<TenantActor[]>`
    SELECT "id", "name", "email" FROM "User"
    WHERE "disabledAt" IS NULL
    ORDER BY "name" ASC`;
}
