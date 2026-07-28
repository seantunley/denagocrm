import "server-only";

import { basePrisma } from "@/lib/db";
import { logAuditStrict } from "@/lib/audit";

/**
 * Serialisation for every mutation that can change how many platform admins are
 * ACTIVE, plus atomic audit for those mutations.
 *
 * WHY A SINGLE GLOBAL LOCK, not a row lock.
 * Locking only the row being changed does not hold the invariant. If admin A
 * disables B while B disables A, the two transactions lock DIFFERENT rows, each
 * counts the other as still active, and both commit — leaving zero active admins
 * and an unadministrable platform. The count is a property of the whole TABLE, so
 * the lock has to cover the whole table's admin-state, not one row.
 *
 * `pg_advisory_xact_lock` on a fixed key gives exactly that: every admin-state
 * mutation queues behind the same lock and releases it automatically when the
 * transaction ends (commit OR rollback), so a crashed request cannot wedge it.
 * An advisory lock is preferred over `LOCK TABLE` because it does not block
 * ordinary reads of PlatformAdmin — the console list stays responsive while a
 * mutation is in flight.
 *
 * The active-count check MUST be re-read inside the callback, after the lock is
 * held. A count taken before the lock is exactly the stale read this exists to
 * prevent.
 */

/**
 * Fixed advisory-lock key for platform-admin state. Arbitrary but must never
 * collide with another advisory lock in the codebase; the rate limiter uses
 * `hashtext(<string key>)`, so a small hand-picked integer cannot clash with it.
 */
const PLATFORM_ADMIN_LOCK_KEY = 4_820_133;

type Tx = Parameters<Parameters<typeof basePrisma.$transaction>[0]>[0];

/**
 * Run `fn` holding the platform-admin lock, inside one transaction.
 *
 * `fn` receives the transaction and a helper that counts OTHER currently-active
 * admins — read under the lock, so it cannot be stale. Audit writes issued on the
 * same `tx` commit with the mutation.
 */
export async function withPlatformAdminLock<T>(
  fn: (ctx: {
    tx: Tx;
    /** Active admins excluding `excludeId`, read under the lock. */
    otherActiveCount: (excludeId: string) => Promise<number>;
    /** Audit on THIS transaction, so mutation and trail commit together. */
    audit: (entry: Parameters<typeof logAuditStrict>[0]) => Promise<void>;
  }) => Promise<T>,
): Promise<T> {
  return basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLATFORM_ADMIN_LOCK_KEY})`;

    return fn({
      tx,
      otherActiveCount: (excludeId: string) =>
        tx.platformAdmin.count({ where: { id: { not: excludeId }, disabledAt: null } }),
      audit: (entry) => logAuditStrict(entry, tx),
    });
  });
}
