import "server-only";
import type { Prisma } from "@prisma/client";

// Quote and job-card `number` columns are UNIQUE, but the create paths computed
// MAX(number)+1 and inserted separately — two concurrent creates read the same
// max and one insert then fails the unique constraint (losing otherwise-valid
// work). Serialize allocation with a transaction-scoped Postgres advisory lock:
// it is held until the surrounding transaction commits/rolls back, so only one
// allocator runs at a time. Distinct keys so quotes and job cards don't contend.
// No schema change required. Callers MUST allocate and insert inside the SAME
// transaction as the lock, or the guarantee is lost.
const QUOTE_NUMBER_LOCK = 815001;
const JOBCARD_NUMBER_LOCK = 815002;

type Tx = Prisma.TransactionClient;

/** Next quote number. Run inside the same transaction that inserts the quote. */
export async function nextQuoteNumber(tx: Tx): Promise<number> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${QUOTE_NUMBER_LOCK})`;
  const max = await tx.quote.aggregate({ _max: { number: true } });
  return (max._max.number ?? 1000) + 1;
}

/** Next job-card number. Run inside the same transaction that inserts the job card. */
export async function nextJobCardNumber(tx: Tx): Promise<number> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${JOBCARD_NUMBER_LOCK})`;
  const max = await tx.jobCard.aggregate({ _max: { number: true } });
  return (max._max.number ?? 1000) + 1;
}
