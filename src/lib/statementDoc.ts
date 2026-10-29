/**
 * The customer statement as DOCUMENT-EDITOR merge values — what a statement
 * layout (Settings → Documents → Statement) is filled with when it prints.
 *
 * Pure: a statement (lib/accountStatement.ts) and its addressee in, tokens and
 * rows out, so every figure and word can be tested without a database. The
 * figures are the statement's own; nothing here re-computes a balance.
 *
 * Tokens, as a layout writes them:
 *
 *   {{statement.date}}          the day it was printed
 *   {{statement.accountName}}   who it is for — the fleet account, or the person
 *   {{statement.accountLines}}  attention, phone, email, address, reg and VAT no
 *   {{statement.reference}}     what to quote when paying: the one open invoice's
 *                               number, else the account name
 *   {{statement.invoiced}}      total invoiced
 *   {{statement.paid}}          total deposits + payments received
 *   {{statement.balance}}       the amount owing (or in credit — see the label)
 *   {{statement.balanceLabel}}  BALANCE DUE · IN CREDIT · PAID UP
 *
 * and {{customer.*}} for a layout that addresses the reader by name. The rows
 * fill the layout's statement table (block "statementLines").
 *
 * Variables for conditional blocks: statement.owing / inCredit / paidUp
 * (booleans), statement.openInvoices and statement.lines (counts).
 */
import type { AccountStatement, StatementLine } from "./accountStatement";
import { DEFAULT_REGIONAL, formatDate, formatZAR, type Regional } from "./format";
import type { QuoteBillTo } from "./quoteBillTo";

/** One printed row of the statement table, already formatted. */
export type StatementRow = {
  kind: StatementLine["kind"];
  date: string;
  reference: string;
  description: string;
  /** Empty when the line charges nothing. */
  charges: string;
  /** Empty when the line pays nothing. */
  payments: string;
  balance: string;
};

export function statementRows(statement: AccountStatement, r: Regional = DEFAULT_REGIONAL): StatementRow[] {
  return statement.lines.map((line) => ({
    kind: line.kind,
    date: formatDate(line.date, r),
    reference: line.invoiceLabel,
    description: line.description,
    charges: line.debitCents ? formatZAR(line.debitCents, r) : "",
    payments: line.creditCents ? formatZAR(line.creditCents, r) : "",
    balance: formatZAR(line.balanceCents, r),
  }));
}

/** The address block under the account's name — the same lines the invoice's BILL TO prints. */
export function statementAccountLines(billTo: QuoteBillTo): string {
  return [
    billTo.attention ? `Attention: ${billTo.attention}` : "",
    billTo.phone,
    billTo.email,
    ...(billTo.addressLines?.length ? billTo.addressLines : [billTo.address]),
    billTo.registrationNumber ? `Reg no: ${billTo.registrationNumber}` : "",
    billTo.vatNumber ? `VAT no: ${billTo.vatNumber}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function statementDocTokens(
  statement: AccountStatement,
  billTo: QuoteBillTo,
  statementDate: Date,
  r: Regional = DEFAULT_REGIONAL,
): { tokens: Record<string, string>; vars: Record<string, unknown> } {
  const owing = statement.balanceCents;
  const open = statement.invoices.filter((invoice) => invoice.outstandingCents > 0);
  const balanceLabel = owing > 0 ? "BALANCE DUE" : owing < 0 ? "IN CREDIT" : "PAID UP";
  const tokens: Record<string, string> = {
    "statement.date": formatDate(statementDate, r),
    "statement.accountName": billTo.name,
    "statement.accountLines": statementAccountLines(billTo),
    // One open invoice: pay against it. Several (or none): the account.
    "statement.reference": open.length === 1 ? open[0].invoiceLabel : billTo.name,
    "statement.invoiced": formatZAR(statement.totalInvoicedCents, r),
    "statement.paid": formatZAR(statement.totalPaidCents, r),
    "statement.balance": formatZAR(Math.abs(owing), r),
    "statement.balanceLabel": balanceLabel,
    "customer.name": billTo.name,
    "customer.phone": billTo.phone,
    "customer.email": billTo.email,
    "customer.address": billTo.address,
  };
  return {
    tokens,
    vars: {
      statement: {
        owing: owing > 0,
        inCredit: owing < 0,
        paidUp: owing === 0,
        openInvoices: open.length,
        lines: statement.lines.length,
      },
    },
  };
}

/**
 * Staff-only notes above a printed statement: the warnings (a deposit with no
 * amount, money on a cancelled quote…) and any note about invoices billed to
 * another account. Classed `doc-toolbar`, which the renderer hides in print —
 * so they are on the screen and never on the customer's copy.
 */
export function statementWarningsHtml(warnings: string[], note?: string | null): string {
  if (!warnings.length && !note) return "";
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const list = warnings.length
    ? `<div role="alert" style="border:1px solid #fcd34d;background:#fffbeb;color:#78350f;border-radius:8px;padding:12px 16px;font-size:13px;line-height:1.45">
        <div style="font-weight:700;margin-bottom:4px">Check before sending — this box is not printed</div>
        <ul style="margin:0;padding-left:18px">${warnings.map((warning) => `<li>${esc(warning)}</li>`).join("")}</ul>
      </div>`
    : "";
  const aside = note
    ? `<div style="border:1px solid #e2e8f0;background:#f8fafc;color:#475569;border-radius:8px;padding:10px 14px;font-size:12px;margin-top:${warnings.length ? 8 : 0}px">${esc(note)}</div>`
    : "";
  return `<div class="doc-toolbar" style="max-width:820px;margin:12px auto;padding:0 14px;font-family:Helvetica,Arial,sans-serif">${list}${aside}</div>`;
}

/** The note a person's statement carries when some of their invoices are billed to a fleet account instead. */
export function billedElsewhereNote(entries: { fleetName: string; count: number }[]): string | null {
  if (!entries.length) return null;
  return `Not on this statement: ${entries
    .map((entry) => `${entry.count} invoice${entry.count === 1 ? "" : "s"} billed to ${entry.fleetName}`)
    .join(", ")} — print that account's statement from its fleet page.`;
}
