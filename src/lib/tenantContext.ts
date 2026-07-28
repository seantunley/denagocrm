import "server-only";
import { Prisma } from "@prisma/client";
import { basePrisma } from "@/lib/db";
import { addTenantMembership } from "@/lib/provisioning";
import { soleActiveTenant, type SoleTenantResult } from "@/lib/tenant";

type Client = typeof basePrisma | Prisma.TransactionClient;

/**
 * Resolve the tenant a user may ACT in when there is no explicit session
 * selection yet. Validates that each candidate membership's tenant EXISTS and is
 * ACTIVE, then applies {@link soleActiveTenant} (one → that tenant, zero →
 * `no_tenant`, 2+ → `ambiguous_tenant`). Read-only (no locks) — use it for a
 * pre-check / friendly error; the WRITE path uses the locking variant below.
 */
export async function resolveActingTenant(
  userId: string,
  client: Client = basePrisma,
): Promise<SoleTenantResult> {
  const memberships = await client.tenantMember.findMany({
    where: { userId, tenant: { active: true } },
    select: { tenantId: true },
  });
  return soleActiveTenant(memberships.map((m) => m.tenantId));
}

/**
 * Same resolution, but LOCKS the candidate `Tenant` + `TenantMember` rows
 * `FOR UPDATE`. This serialises the two mutations that would invalidate the tenant
 * we're about to use — SUSPENSION/deletion of the RETURNED tenant, and DELETION of
 * the RETURNED membership: each either committed before our SELECT (excluded by the
 * `active = true` filter) or blocks until our transaction commits. It does NOT lock
 * absent rows, so a NEW membership being added, or an inactive tenant being
 * activated, can still commit alongside — that doesn't invalidate the tenant chosen
 * at this transaction's linearization point, but it's why the guarantee is scoped
 * to the resolved rows, not "any membership change". A single shared locking
 * protocol (advisory lock or locking the owner `User` row) across provisioning AND
 * membership/tenant administration should replace this before those endpoints ship.
 * Must run inside a transaction.
 */
async function lockActingTenant(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<SoleTenantResult> {
  const rows = await tx.$queryRaw<{ tenantId: string }[]>`
    SELECT m."tenantId" AS "tenantId"
    FROM "TenantMember" m
    JOIN "Tenant" t ON t."id" = m."tenantId"
    WHERE m."userId" = ${userId} AND t."active" = true
    FOR UPDATE OF t, m`;
  return soleActiveTenant(rows.map((r) => r.tenantId));
}

export type ProvisionResult =
  | { user: { id: string }; tenantId: string }
  | { error: "no_tenant" | "ambiguous_tenant" | "context_changed" | "duplicate_email" };

/**
 * Create a user and place them in the OWNER's current tenant, ATOMICALLY. The
 * owner's tenant is resolved and LOCKED inside the write, and compared against the
 * pre-check — so a tenant suspension or membership change between pre-check and
 * write aborts (rolls back) rather than provisioning into a stale/invalid tenant.
 * Returns the tenant ACTUALLY used, for the caller to audit.
 */
export async function createUserInOwnerTenant(
  ownerId: string,
  data: { name: string; email: string; passwordHash: string },
): Promise<ProvisionResult> {
  const pre = await resolveActingTenant(ownerId);
  if ("error" in pre) return pre;
  try {
    return await basePrisma.$transaction(async (tx) => {
      const ctx = await lockActingTenant(tx, ownerId);
      // Abort if the locked tenant is no longer resolvable, or differs from what we
      // pre-checked (membership/suspension changed in between).
      if ("error" in ctx || ctx.tenantId !== pre.tenantId) {
        throw new Error("TENANT_CONTEXT_CHANGED");
      }
      const user = await tx.user.create({ data: { ...data, tenantId: ctx.tenantId } });
      await addTenantMembership(tx, ctx.tenantId, user.id);
      return { user: { id: user.id }, tenantId: ctx.tenantId };
    });
  } catch (e) {
    if (e instanceof Error && e.message === "TENANT_CONTEXT_CHANGED") {
      return { error: "context_changed" };
    }
    // Two concurrent creates for the same email both pass the caller's preliminary
    // lookup; the loser hits the unique constraint. Report it as a normal duplicate
    // (the transaction has already rolled back), not a raw Prisma exception.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { error: "duplicate_email" };
    }
    throw e;
  }
}
