/**
 * Fencing for the chatbot's durable leases.
 *
 * Both the inbound event ledger and the outbound message queue hand a row to one
 * worker for a bounded time. A row id alone is NOT ownership: the lease expires,
 * a later worker reclaims the SAME row — same id, same `status = 'running'` — and
 * a stalled first worker waking up afterwards would satisfy `{id, status}` and
 * complete or release a lease it no longer holds.
 *
 * Every reclaim increments `attempts`, so `attempts` doubles as the lease
 * generation. Pinning a terminal write to the generation that claimed it makes
 * the stale write match zero rows instead of stealing the new worker's lease.
 *
 * This lives in its own module with no imports so the rule can be executed by a
 * test rather than pattern-matched in source.
 */
export type LeaseFence = {
  id: string;
  tenantId: string;
  status: "running";
  attempts: number;
};

/** The WHERE that pins a lease mutation to exactly the attempt that took it. */
export function leaseFence(rowId: string, tenantId: string, leaseAttempt: number): LeaseFence {
  return { id: rowId, tenantId, status: "running", attempts: leaseAttempt };
}

/** A row as the fence sees it — the columns that decide ownership. */
export type LeasedRow = { id: string; tenantId: string; status: string; attempts: number };

/**
 * Does `row` satisfy `fence`? This is the `updateMany` semantics the database
 * applies, stated once so a test can exercise the real rule instead of asserting
 * that a string appears in a source file.
 */
export function leaseFenceMatches(row: LeasedRow, fence: LeaseFence): boolean {
  return (
    row.id === fence.id &&
    row.tenantId === fence.tenantId &&
    row.status === fence.status &&
    row.attempts === fence.attempts
  );
}
