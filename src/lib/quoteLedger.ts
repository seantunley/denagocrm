/**
 * THE MONEY ON ONE QUOTE, CHANGED SAFELY — the one place that records a payment,
 * voids one, or sets the deposit (review of #924).
 *
 * The invoice's balance has two inputs: the deposit (`Quote.depositPaidCents`,
 * deliveries board) and the payments (`QuotePayment`, deal page). Checking only
 * one of them let the other push an invoice past paid: R80 000 recorded as a
 * payment, then a R30 000 deposit, on a R100 000 invoice. So EVERY change to
 * either input goes through here, and every one of them:
 *
 *   1. locks the quote row (FOR UPDATE, in its workspace) — two staff recording
 *      at once are serialised, so neither can pass a check the other has
 *      already invalidated;
 *   2. re-reads the deposit and every live payment under that lock;
 *   3. refuses a change that would take deposit + payments past the invoice.
 *
 * A payment also carries a one-time key from its form. A resubmission (retry
 * after a dropped connection, double click) finds the payment that key already
 * recorded and returns it, rather than recording the money twice; the unique
 * index (tenantId, idempotencyKey) is the backstop for two at the same instant.
 *
 * Takes the transaction client as a parameter and imports nothing server-side,
 * so the database tests (scripts/test-quote-payments.ts) drive exactly this
 * code. Audit entries are written by the calling action in the same transaction.
 */
import { ActionRefusal } from "./actionFailure";
import { invoiceTotalCents, isStatementInvoice, statementInvoiceLabel } from "./accountStatement";
// Type-only: the transaction comes from the caller; this module never opens a client.
import type { prisma } from "./db";

export const LEDGER_QUOTE_GONE = "This quote is no longer available in this workspace.";

/** A form's one-time key: a v4 UUID, as crypto.randomUUID() makes. */
export const IDEMPOTENCY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A transaction on the scoped (RLS / soft-delete aware) client — what every money action opens. */
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
type Money = (cents: number) => string;

function refuse(message: string): never {
  throw new ActionRefusal(message);
}

/** Lock the quote in its workspace and read everything its balance depends on. */
export async function lockQuoteLedger(tx: Tx, quoteId: string, tenantId: string) {
  await tx.$executeRaw`SELECT id FROM "Quote" WHERE id = ${quoteId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  const quote = await tx.quote.findFirst({ where: { id: quoteId, tenantId }, include: { items: true, fees: true } });
  if (!quote) return null;
  const payments = await tx.quotePayment.findMany({ where: { quoteId, tenantId }, orderBy: { receivedAt: "asc" } });
  const totalCents = invoiceTotalCents(quote);
  const paymentsCents = payments.filter((payment) => !payment.voidedAt).reduce((sum, payment) => sum + payment.amountCents, 0);
  const depositCents = quote.depositPaidAt && quote.depositPaidCents ? quote.depositPaidCents : 0;
  return { quote, payments, totalCents, paymentsCents, depositCents, owingCents: totalCents - depositCents - paymentsCents };
}

export type QuoteLedger = NonNullable<Awaited<ReturnType<typeof lockQuoteLedger>>>;

/**
 * Refuse a deposit amount that, with the payments already recorded, would take
 * the invoice past paid. For recording the deposit AND for correcting it.
 */
export function assertDepositFits(ledger: QuoteLedger, depositCents: number, fmt: Money): void {
  if (depositCents + ledger.paymentsCents <= ledger.totalCents) return;
  const room = Math.max(0, ledger.totalCents - ledger.paymentsCents);
  refuse(
    ledger.paymentsCents > 0
      ? `That deposit would take this invoice past paid. ${fmt(ledger.paymentsCents)} has already been recorded in payments on the deal, so the deposit can be at most ${fmt(room)}.`
      : `That deposit is more than the invoice total of ${fmt(ledger.totalCents)}.`,
  );
}

export type RecordPaymentInput = {
  quoteId: string;
  tenantId: string;
  amountCents: number;
  receivedAt: Date;
  method: string;
  reference: string | null;
  note: string | null;
  idempotencyKey: string;
  createdById: string | null;
  createdByName: string;
};

export type RecordPaymentResult =
  | { kind: "recorded"; payment: { id: string; amountCents: number }; ledger: QuoteLedger }
  | { kind: "duplicate"; payment: { id: string; amountCents: number } };

export async function recordPaymentInTx(tx: Tx, input: RecordPaymentInput, fmt: Money): Promise<RecordPaymentResult> {
  if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) refuse("This payment form is out of date. Refresh the page and try again.");
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) refuse("The amount must be more than zero.");

  const ledger = await lockQuoteLedger(tx, input.quoteId, input.tenantId);
  if (!ledger) refuse(LEDGER_QUOTE_GONE);

  // The same form, submitted again: hand back what it already recorded.
  const already = await tx.quotePayment.findFirst({ where: { tenantId: input.tenantId, idempotencyKey: input.idempotencyKey } });
  if (already) {
    if (already.quoteId !== input.quoteId || already.amountCents !== input.amountCents) {
      refuse("This payment form was already used for a different payment. Refresh the page and record it again.");
    }
    return { kind: "duplicate", payment: already };
  }

  if (!isStatementInvoice(ledger.quote)) refuse("Payments can only be recorded against an accepted quote.");
  // A bank reference names one transfer. The same one twice is the same money twice.
  const reference = input.reference?.trim() || null;
  if (reference) {
    const twin = ledger.payments.find((payment) => !payment.voidedAt && payment.reference?.trim().toLowerCase() === reference.toLowerCase());
    if (twin) refuse(`A ${fmt(twin.amountCents)} payment with reference “${reference}” is already recorded on this invoice.`);
  }
  if (ledger.owingCents <= 0) refuse(`Nothing is owing on ${statementInvoiceLabel(ledger.quote)}.`);
  if (input.amountCents > ledger.owingCents) refuse(`That is more than the ${fmt(ledger.owingCents)} still owing on this invoice.`);

  const payment = await tx.quotePayment.create({
    data: {
      // The QUOTE's workspace, verbatim — the payment is the invoice's, not the clerk's.
      tenantId: ledger.quote.tenantId ?? input.tenantId,
      quoteId: input.quoteId,
      amountCents: input.amountCents,
      receivedAt: input.receivedAt,
      method: input.method,
      reference,
      note: input.note,
      idempotencyKey: input.idempotencyKey,
      createdById: input.createdById,
      createdByName: input.createdByName,
    },
    select: { id: true, amountCents: true },
  });
  return { kind: "recorded", payment, ledger };
}

/** Void a payment recorded in error: kept, marked, no longer counted. Under the same lock as everything else. */
export async function voidPaymentInTx(
  tx: Tx,
  input: { quoteId: string; tenantId: string; paymentId: string; reason: string; voidedByName: string },
) {
  const ledger = await lockQuoteLedger(tx, input.quoteId, input.tenantId);
  if (!ledger) refuse(LEDGER_QUOTE_GONE);
  const payment = ledger.payments.find((candidate) => candidate.id === input.paymentId);
  if (!payment) refuse("That payment is no longer available.");
  if (payment.voidedAt) refuse("That payment has already been voided.");
  const voided = await tx.quotePayment.updateMany({
    where: { id: input.paymentId, quoteId: input.quoteId, tenantId: input.tenantId, voidedAt: null },
    data: { voidedAt: new Date(), voidedByName: input.voidedByName, voidReason: input.reason },
  });
  if (voided.count !== 1) refuse("That payment changed while you were editing. Refresh and try again.");
  return { payment, ledger };
}
