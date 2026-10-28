/**
 * A CUSTOMER ACCOUNT STATEMENT — what the account was invoiced, what it has paid,
 * and what it still owes, line by line with a running balance.
 *
 * Pure: rows in, statement out. The loader (accountStatementLoader.ts) decides
 * WHICH quotes and payments belong to the account and is where the tenant and
 * access boundaries live; this file only does the arithmetic, so every rule
 * below is a unit test rather than a hope.
 *
 * WHERE THE MONEY COMES FROM. Two sources, each the authority for its own kind:
 *
 *   - The DEPOSIT is `Quote.depositPaidCents` / `depositPaidAt`, recorded (and
 *     corrected, audited) on the deliveries board. It stays there because
 *     delivery readiness, the deal page and DAX all read those columns.
 *   - EVERY OTHER PAYMENT is a `QuotePayment` row, recorded on the deal page.
 *     A voided payment is kept for the record but counts for nothing.
 *
 * WHAT COUNTS AS AN INVOICE. An accepted quote that is not trashed and not
 * superseded — acceptance is when the invoice number is issued (numbering.ts).
 * Its amount is the PAYABLE total (lines + fees + delivery), the same figure
 * the printed invoice shows.
 *
 * MONEY THAT CANNOT BE PLACED IS NEVER SILENTLY DROPPED. A deposit marked
 * received without an amount, or money recorded against a quote that is no
 * longer an invoice (cancelled, superseded, trashed), is left OFF the customer's
 * figures — we cannot say what it should do to them — and reported as a warning
 * for staff, so the statement is corrected before it is sent rather than after.
 */
import { formatInvoiceNumber } from "./invoiceNumber";
import { payableTotalCents, type FeeLine, type PricedLine } from "./pricing";

export const PAYMENT_METHODS = {
  eft: "EFT / bank transfer",
  card: "Card",
  cash: "Cash",
  finance: "Finance payout",
  other: "Other",
} as const;

export type PaymentMethod = keyof typeof PAYMENT_METHODS;

export function isPaymentMethod(value: string): value is PaymentMethod {
  return Object.prototype.hasOwnProperty.call(PAYMENT_METHODS, value);
}

export function paymentMethodLabel(method: string): string {
  return isPaymentMethod(method) ? PAYMENT_METHODS[method] : method;
}

/** The Quote columns a statement reads. Nothing else. */
export type StatementQuote = {
  id: string;
  number: number;
  status: string;
  invoiceNumber: number | null;
  invoicedAt: Date | null;
  signedAt: Date | null;
  createdAt: Date;
  deletedAt: Date | null;
  supersededAt: Date | null;
  depositPaidAt: Date | null;
  depositPaidCents: number | null;
  taxInclusive: boolean | null;
  depositType: string | null;
  depositValue: number | null;
  items: PricedLine[];
  fees: FeeLine[];
};

/** The QuotePayment columns a statement reads. */
export type StatementPayment = {
  id: string;
  quoteId: string;
  amountCents: number;
  receivedAt: Date;
  method: string;
  reference: string | null;
  voidedAt: Date | null;
};

export type StatementLine = {
  key: string;
  kind: "invoice" | "deposit" | "payment";
  date: Date;
  quoteId: string;
  /** The invoice this line belongs to, as printed: INV-000123 (or Q-45 for an
   *  invoice accepted before invoice numbers existed). */
  invoiceLabel: string;
  description: string;
  debitCents: number;
  creditCents: number;
  /** Running balance after this line. Positive = the customer owes. */
  balanceCents: number;
};

export type StatementInvoice = {
  quoteId: string;
  quoteNumber: number;
  invoiceLabel: string;
  date: Date;
  totalCents: number;
  paidCents: number;
  outstandingCents: number;
};

export type AccountStatement = {
  lines: StatementLine[];
  invoices: StatementInvoice[];
  totalInvoicedCents: number;
  totalPaidCents: number;
  /** What the account owes. Negative = the account is in credit. */
  balanceCents: number;
  /** For staff only — never printed on the customer's copy. */
  warnings: string[];
};

/** An accepted quote that still stands is an invoice the customer owes. */
export function isStatementInvoice(quote: Pick<StatementQuote, "status" | "deletedAt" | "supersededAt">): boolean {
  return quote.status === "accepted" && !quote.deletedAt && !quote.supersededAt;
}

export function statementInvoiceLabel(quote: Pick<StatementQuote, "number" | "invoiceNumber">): string {
  return quote.invoiceNumber ? formatInvoiceNumber(quote.invoiceNumber) : `Q-${quote.number}`;
}

/**
 * The date an invoice goes on the statement: when it was invoiced on the
 * deliveries board, else when the customer signed it, else the quote's own date.
 * A quote accepted by hand records no acceptance time of its own.
 */
export function statementInvoiceDate(quote: Pick<StatementQuote, "invoicedAt" | "signedAt" | "createdAt">): Date {
  return quote.invoicedAt ?? quote.signedAt ?? quote.createdAt;
}

/** The payable total of one invoice, in whole cents. */
export function invoiceTotalCents(quote: StatementQuote): number {
  return Math.round(payableTotalCents(quote));
}

/** Money received against one quote: the recorded deposit plus every live payment. */
export function receivedCents(
  quote: Pick<StatementQuote, "depositPaidAt" | "depositPaidCents">,
  payments: Pick<StatementPayment, "amountCents" | "voidedAt">[],
): number {
  const deposit = quote.depositPaidAt && quote.depositPaidCents ? quote.depositPaidCents : 0;
  return deposit + payments.filter((payment) => !payment.voidedAt).reduce((sum, payment) => sum + payment.amountCents, 0);
}

/** What is still owed on one quote after its deposit and payments. */
export function outstandingCents(quote: StatementQuote, payments: StatementPayment[]): number {
  return invoiceTotalCents(quote) - receivedCents(quote, payments.filter((payment) => payment.quoteId === quote.id));
}

// Same day: the invoice first, then the deposit, then payments — so a statement
// never shows a payment arriving before the invoice it pays.
const KIND_ORDER: Record<StatementLine["kind"], number> = { invoice: 0, deposit: 1, payment: 2 };

export function buildAccountStatement(
  quotes: StatementQuote[],
  payments: StatementPayment[],
  fmt: (cents: number) => string = (cents) => (cents / 100).toFixed(2),
): AccountStatement {
  const warnings: string[] = [];
  const unsorted: Omit<StatementLine, "balanceCents">[] = [];
  const invoices: StatementInvoice[] = [];
  const quoteIds = new Set(quotes.map((quote) => quote.id));

  for (const quote of quotes) {
    const label = statementInvoiceLabel(quote);
    const live = payments.filter((payment) => payment.quoteId === quote.id && !payment.voidedAt);

    if (!isStatementInvoice(quote)) {
      const held = receivedCents(quote, live);
      if (held > 0) {
        const why = quote.deletedAt ? "in the trash" : quote.supersededAt ? "superseded by a revision" : `${quote.status}, not accepted`;
        warnings.push(
          `Q-${quote.number} is ${why} but has ${fmt(held)} recorded as received. It is not on this statement — refund or move that money, then re-print.`,
        );
      }
      continue;
    }

    const date = statementInvoiceDate(quote);
    const totalCents = invoiceTotalCents(quote);
    unsorted.push({
      key: `invoice:${quote.id}`,
      kind: "invoice",
      date,
      quoteId: quote.id,
      invoiceLabel: label,
      description: `Invoice ${label}${quote.invoiceNumber ? ` (quote Q-${quote.number})` : ""}`,
      debitCents: totalCents,
      creditCents: 0,
    });

    if (quote.depositPaidAt) {
      if (quote.depositPaidCents == null) {
        warnings.push(
          `${label}: the deposit was marked received on ${quote.depositPaidAt.toISOString().slice(0, 10)} without an amount, so it has NOT been deducted. Enter the amount on the deliveries board, then re-print.`,
        );
      } else if (quote.depositPaidCents > 0) {
        unsorted.push({
          key: `deposit:${quote.id}`,
          kind: "deposit",
          date: quote.depositPaidAt,
          quoteId: quote.id,
          invoiceLabel: label,
          description: `Deposit received — ${label}`,
          debitCents: 0,
          creditCents: quote.depositPaidCents,
        });
      }
    }

    for (const payment of live) {
      unsorted.push({
        key: `payment:${payment.id}`,
        kind: "payment",
        date: payment.receivedAt,
        quoteId: quote.id,
        invoiceLabel: label,
        description: `Payment received — ${label} · ${paymentMethodLabel(payment.method)}${payment.reference ? ` · ${payment.reference}` : ""}`,
        debitCents: 0,
        creditCents: payment.amountCents,
      });
    }

    const paid = receivedCents(quote, live);
    invoices.push({
      quoteId: quote.id,
      quoteNumber: quote.number,
      invoiceLabel: label,
      date,
      totalCents,
      paidCents: paid,
      outstandingCents: totalCents - paid,
    });
    if (paid > totalCents) {
      warnings.push(`${label} has been paid ${fmt(paid - totalCents)} more than its total. Check the deposit and payments on the deal.`);
    }
  }

  // A payment whose quote was not handed in cannot be placed. The loader should
  // never do this; if it does, say so rather than lose the money.
  const orphaned = payments.filter((payment) => !payment.voidedAt && !quoteIds.has(payment.quoteId));
  if (orphaned.length) {
    warnings.push(`${orphaned.length} payment${orphaned.length === 1 ? " is" : "s are"} recorded against a quote that is not on this account. They are not on this statement.`);
  }

  unsorted.sort(
    (a, b) =>
      a.date.getTime() - b.date.getTime() ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.invoiceLabel.localeCompare(b.invoiceLabel),
  );

  let running = 0;
  const lines: StatementLine[] = unsorted.map((line) => {
    running += line.debitCents - line.creditCents;
    return { ...line, balanceCents: running };
  });

  invoices.sort((a, b) => a.date.getTime() - b.date.getTime() || a.quoteNumber - b.quoteNumber);
  const totalInvoicedCents = invoices.reduce((sum, invoice) => sum + invoice.totalCents, 0);
  const totalPaidCents = invoices.reduce((sum, invoice) => sum + invoice.paidCents, 0);

  return {
    lines,
    invoices,
    totalInvoicedCents,
    totalPaidCents,
    balanceCents: totalInvoicedCents - totalPaidCents,
    warnings,
  };
}
