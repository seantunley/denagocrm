import "server-only";
import { basePrisma } from "@/lib/db";
import { pickActiveTenant } from "@/lib/tenant";

/**
 * Resolve a user's active tenant id from their `TenantMember` rows. Fail-closed:
 * returns `null` for a user with no membership — callers must treat that as "no
 * tenant access", never a default. DB-backed wrapper over the pure
 * {@link pickActiveTenant}. Session/JWT wiring that reads this at login is a later
 * PR; for now it's used by provisioning to place a new user in their creator's
 * tenant.
 */
export async function getActiveTenantId(userId: string): Promise<string | null> {
  const memberships = await basePrisma.tenantMember.findMany({
    where: { userId },
    select: { tenantId: true, createdAt: true },
  });
  return pickActiveTenant(memberships);
}
