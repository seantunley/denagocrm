import "server-only";
import { Prisma } from "@prisma/client";
import { basePrisma } from "./db";
import { currentScopeClass } from "./tenantWrite";

export type TenantActor = { id: string; name: string; email: string };

// Actor selection classifies the current scope exactly like every other unguarded
// tenant-owned path — via the shared {@link currentScopeClass}. `global` → the
// unchanged pick (dormant OR trusted system), `tenant` → a member of that tenant,
// `closed` → resolve NOTHING (fail closed), never a global user.
const actorScope = currentScopeClass;

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
 * Scope handling is via {@link actorScope}: a tenant scope → an active member of
 * that tenant; dormant or an explicit `system` scope → the unchanged global pick
 * (still excluding disabled); enforcement on with NO scope or a null non-system
 * scope → resolve NOTHING (fail closed), never a global user.
 */
export async function resolveTenantActor(
  opts: { ownerOnly?: boolean } = {},
): Promise<TenantActor | null> {
  const s = actorScope();
  if (s.mode === "closed") return null;
  if (s.mode === "tenant") {
    const owner = opts.ownerOnly ? Prisma.sql`AND u."role" = 'owner'` : Prisma.empty;
    const rows = await basePrisma.$queryRaw<TenantActor[]>`
      SELECT u."id", u."name", u."email"
      FROM "TenantMember" m
      JOIN "User" u ON u."id" = m."userId"
      JOIN "Tenant" t ON t."id" = m."tenantId"
      WHERE m."tenantId" = ${s.tenantId} AND t."active" = true AND u."disabledAt" IS NULL ${owner}
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
 * `assigneeUserId` must never be emailed this tenant's document. Scope handling via
 * {@link actorScope}: dormant or an explicit `system` scope → direct lookup (still
 * excluding disabled); a tenant scope → membership-checked lookup; enforcement with
 * no scope or a null non-system scope → null (fail closed). Returns null whenever
 * the id is not a valid current-tenant member.
 */
export async function resolveTenantMemberUser(userId: string): Promise<TenantActor | null> {
  const s = actorScope();
  if (s.mode === "closed") return null;
  if (s.mode === "tenant") {
    const rows = await basePrisma.$queryRaw<TenantActor[]>`
      SELECT u."id", u."name", u."email"
      FROM "TenantMember" m
      JOIN "User" u ON u."id" = m."userId"
      JOIN "Tenant" t ON t."id" = m."tenantId"
      WHERE m."tenantId" = ${s.tenantId} AND m."userId" = ${userId}
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
 * non-disabled members of the current tenant scope. Via {@link actorScope}: dormant
 * or an explicit `system` scope → all active, non-disabled users; enforcement with
 * no scope or a null non-system scope → empty (fail closed). Replaces an unscoped
 * `user.findMany` in the workflow editor picker + runtime staffMap, so a workflow
 * can neither offer nor persist a cross-tenant or disabled user id.
 */
export async function listTenantStaff(): Promise<TenantActor[]> {
  const s = actorScope();
  if (s.mode === "closed") return [];
  if (s.mode === "tenant") {
    return basePrisma.$queryRaw<TenantActor[]>`
      SELECT u."id", u."name", u."email"
      FROM "TenantMember" m
      JOIN "User" u ON u."id" = m."userId"
      JOIN "Tenant" t ON t."id" = m."tenantId"
      WHERE m."tenantId" = ${s.tenantId} AND t."active" = true AND u."disabledAt" IS NULL
      ORDER BY u."name" ASC`;
  }
  return basePrisma.$queryRaw<TenantActor[]>`
    SELECT "id", "name", "email" FROM "User"
    WHERE "disabledAt" IS NULL
    ORDER BY "name" ASC`;
}
