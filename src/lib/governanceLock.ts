import "server-only";

import { basePrisma } from "@/lib/db";

type Tx = Parameters<Parameters<typeof basePrisma.$transaction>[0]>[0];

/**
 * Serializes the "at least one administrator must remain" invariant.
 *
 * Every one of those checks counted the OTHER remaining admins and then mutated
 * in a separate statement. Two owners demoting or disabling each other at the
 * same moment both passed their count — each still saw the other — and both
 * writes landed, leaving the workspace with zero active administrators and
 * nobody able to restore one. The same shape guarded role permissions and role
 * assignments in accessControl.ts.
 *
 * A transaction-scoped advisory lock makes the check-and-mutate pair atomic
 * against other holders of the same lock: the second caller waits, then re-runs
 * its count against the first one's committed state and refuses. It is released
 * automatically when the transaction ends, in either direction — there is no
 * unlock to forget or leak on an error path.
 *
 * ONE GLOBAL KEY, deliberately — an earlier version keyed this per tenant, which
 * serialized nothing that mattered:
 *
 *   - The `User.role = 'owner'` checks count owners across the WHOLE install, so
 *     two owners acting from different tenants took different keys, never
 *     blocked each other, and could still remove the last one between them.
 *   - The tenant-scoped counts in accessControl.ts are not independent either:
 *     a global owner counts toward a tenant's admin tally, so a concurrent
 *     demotion elsewhere invalidates a count taken under a tenant-only key.
 *
 * Since the invariant spans tenants, so must the lock. The cost is that two
 * governance changes anywhere serialize — which is the correct behaviour for a
 * rare, deliberate, safety-critical operation.
 *
 * MUST be called INSIDE the transaction that performs the mutation, and BEFORE
 * the read whose result the check depends on. A lock taken after that read
 * guarantees nothing — and so does deciding whether to take it from a value read
 * before it. Take it whenever the REQUESTED end state could remove
 * administration, then re-read the current state under it.
 *
 * `hashtext` is Postgres's own stable string hash.
 */
export async function lockGovernanceAdmins(tx: Tx): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('governance_admins'))`;
}
