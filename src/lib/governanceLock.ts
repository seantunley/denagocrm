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
 * The key is per-tenant so one workspace's governance change never blocks
 * another's. `hashtext` is Postgres's own stable string hash.
 *
 * MUST be called INSIDE the transaction that performs the mutation, and BEFORE
 * the count that guards it — a lock taken after the count guarantees nothing.
 */
export async function lockGovernanceAdmins(tx: Tx, tenantId: string | null): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`governance_admins:${tenantId ?? "global"}`}))`;
}
