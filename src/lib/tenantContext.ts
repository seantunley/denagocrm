import "server-only";
import type { Prisma } from "@prisma/client";
import { basePrisma } from "@/lib/db";
import { soleActiveTenant, type SoleTenantResult } from "@/lib/tenant";

type Client = typeof basePrisma | Prisma.TransactionClient;

/**
 * Resolve the tenant a user may ACT in when there is no explicit session
 * selection yet (the session-selected tenant lands in a later PR). This is NOT
 * "the user's tenant" inferred from an old membership — it validates that each
 * candidate membership's tenant EXISTS and is ACTIVE, then applies the
 * {@link soleActiveTenant} rule:
 *   - `{ tenantId }`            — exactly one active-tenant membership
 *   - `{ error: "no_tenant" }` — none (a suspended-only user counts as none)
 *   - `{ error: "ambiguous_tenant" }` — more than one → explicit selection needed
 *
 * Fail-closed. Pass a transaction client to re-validate INSIDE a write, so a
 * concurrent tenant suspension or membership removal between a pre-check and the
 * write can't provision into a now-invalid tenant.
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
