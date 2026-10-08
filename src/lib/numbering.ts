import "server-only";
import type { Prisma } from "@prisma/client";
import { randomInt } from "node:crypto";

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

/** Raw SQL only: the base client's and the workspace-scoped client's transactions both have these. */
type RawTx = Pick<Tx, "$executeRaw" | "$queryRaw">;

/**
 * Where a workspace's FIRST invoice number lands: a random point, not 1 (Sean,
 * 2026-10-07), so the numbers don't give away how many invoices there have been.
 * 10000–99999, printed INV-010000 … INV-099999; each invoice after counts up by one.
 */
export const INVOICE_START_MIN = 10_000;
export const INVOICE_START_MAX = 99_999;
export const randomInvoiceStart = () => randomInt(INVOICE_START_MIN, INVOICE_START_MAX + 1);

/**
 * Give an accepted quote the workspace's next INVOICE number, if it has none —
 * its own sequence per workspace, never the quote number (lib/invoiceNumber).
 * Run inside the transaction that accepts it. A per-workspace advisory lock
 * serialises "next number" with the write; the (tenantId, invoiceNumber) unique
 * index refuses a duplicate regardless. Idempotent: a number, once issued, stays.
 */
export async function issueInvoiceNumberInTx(tx: RawTx, quoteId: string, tenantId: string | null): Promise<number | null> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invoice-number:${tenantId ?? ""}`})::bigint)`;
  const [quote] = await tx.$queryRaw<{ invoiceNumber: number | null }[]>`
    SELECT "invoiceNumber" FROM "Quote" WHERE id = ${quoteId} AND "tenantId" IS NOT DISTINCT FROM ${tenantId}::text`;
  if (!quote) return null;
  if (quote.invoiceNumber) return quote.invoiceNumber;
  const [{ last }] = await tx.$queryRaw<{ last: number | null }[]>`
    SELECT MAX("invoiceNumber")::int AS last FROM "Quote" WHERE "tenantId" IS NOT DISTINCT FROM ${tenantId}::text`;
  // The first invoice starts at a random point; every one after counts up.
  const next = last ? last + 1 : randomInvoiceStart();
  await tx.$executeRaw`
    UPDATE "Quote" SET "invoiceNumber" = ${next} WHERE id = ${quoteId} AND "tenantId" IS NOT DISTINCT FROM ${tenantId}::text AND "invoiceNumber" IS NULL`;
  return next;
}

/** Next job-card number. Run inside the same transaction that inserts the job card. */
export async function nextJobCardNumber(tx: Tx): Promise<number> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${JOBCARD_NUMBER_LOCK})`;
  const max = await tx.jobCard.aggregate({ _max: { number: true } });
  return (max._max.number ?? 1000) + 1;
}
