import "server-only";
import { prisma } from "./db";
import { ownedWriteTenantId } from "./tenantWrite";
import { getAccessibleQuoteIds, hasAnyPermission, type PermissionUser } from "./permissions";
import { isModuleEnabled } from "./modules/enabled";
import { getRegionalSettings } from "./settings";
import { formatZAR } from "./format";
import { formatTotals, totalsByCurrency, withCurrency } from "./currencyRules";
import { formatInvoiceNumber, parseInvoiceNumber } from "./invoiceNumber";
import { receivedCents, statementInvoiceDate } from "./accountStatement";
import { payableTotalCents } from "./pricing";
import { loadBillToFleets, quoteBillTo } from "./quoteBillTo";
import { xeroStatusLabel } from "./xeroInvoice";
import { johannesburgDateKey } from "./activityDay";
import { ciExactIdFilter } from "./ciExact";

/**
 * INVOICES (Sean, 2026-11-14: "DAX must have knowledge of those things, permission based") — what /invoices holds,
 * read-only. HELD TO THE PAGE'S OWN RULE: deliveries.view or .manage, the Automotive module, only the quotes this
 * person may open (getAccessibleQuoteIds, the page's own list), in the acting workspace. An invoice is an accepted,
 * current quote with an INV number; its total, received and owing are the page's own arithmetic (accountStatement).
 *
 * No due date is stored on an invoice, so nothing here claims "overdue": `olderThanDays` is the age since it was
 * invoiced, and the result says so. Never a payment reference, bank detail or Xero token. Nothing is written,
 * nothing goes to Xero, nothing is logged.
 */

export type InvoicesArgs = {
  status?: "unpaid" | "paid" | "any";
  customer?: string;
  number?: string;
  from?: string;
  to?: string;
  olderThanDays?: number;
  xero?: "not_sent" | "sent" | "excluded";
  limit?: number;
};
type Output = { rows: { label: string; detail: string; href: string }[]; data: unknown[]; truncated: boolean };
const DAY = 86_400_000;
const note = (text: string): Output => ({ rows: [], data: [{ note: text }], truncated: false });
const saDay = johannesburgDateKey;
/** A South African calendar day as a day count — ages are whole calendar days, not 24-hour periods (review of #1109). */
const dayOrdinal = (key: string) => Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10))) / DAY;


export async function invoicesLookup(user: PermissionUser, args: InvoicesArgs): Promise<Output> {
  if (!(await hasAnyPermission(user, "deliveries.view", "deliveries.manage"))) return note("This person can't open Invoices.");
  if (!(await isModuleEnabled("automotive"))) return note("Invoices are switched off in this workspace (Automotive module).");
  const tenantId = ownedWriteTenantId();
  const quoteIds = await getAccessibleQuoteIds(user);
  if (quoteIds !== null && quoteIds.length === 0) return note("There are no invoices this person can open.");
  const asked = args.number === undefined ? undefined : parseInvoiceNumber(args.number);
  if (asked === null) return note(`There is no invoice numbered "${args.number}" — that isn't an invoice number (INV-000123) or a Xero reference.`);
  // Exact, whole, case-folded — ids from ciExact (never ILIKE), then ANDed into the guarded query below.
  const byNumber = !asked ? null : "crm" in asked ? { invoiceNumber: asked.crm } : await ciExactIdFilter("quoteXeroInvoiceNumber", asked.xero);
  const quotes = await prisma.quote.findMany({
    where: {
      tenantId,
      status: "accepted",
      supersededAt: null,
      invoiceNumber: { not: null },
      // AND, never spread: the access list must not be replaced by what was asked for.
      AND: [
        ...(quoteIds === null ? [] : [{ id: { in: quoteIds } }]),
        ...(byNumber ? [byNumber] : []),
      ],
    },
    // Only what the page shows — never payment references, banking or anything of Xero's beyond its number and status.
    select: {
      id: true, number: true, currency: true, invoiceNumber: true, invoicedAt: true, signedAt: true, createdAt: true,
      depositPaidAt: true, depositPaidCents: true, deliveredAt: true, fleetId: true, taxInclusive: true, depositType: true, depositValue: true,
      xeroInvoiceId: true, xeroInvoiceNumber: true, xeroStatus: true, xeroSentAt: true, xeroExcludedAt: true,
      items: true, fees: true,
      contact: { select: { id: true, firstName: true, lastName: true, company: true } },
    },
    orderBy: { invoiceNumber: "desc" },
  });
  const payments = quotes.length
    ? await prisma.quotePayment.findMany({ where: { tenantId, quoteId: { in: quotes.map((q) => q.id) } }, select: { quoteId: true, amountCents: true, voidedAt: true } })
    : [];
  const fleets = await loadBillToFleets(prisma, quotes.map((q) => q.fleetId));
  const moneyFmt = await getRegionalSettings();
  const today = dayOrdinal(johannesburgDateKey(new Date()));
  const words = (args.customer ?? "").toLowerCase().split(/\s+/).filter(Boolean);

  const all = quotes.map((quote) => {
    // invoiceTotalCents' own arithmetic (it is Math.round(payableTotalCents(quote))), on the fields it reads.
    const total = Math.round(payableTotalCents(quote));
    const received = receivedCents(quote, payments.filter((p) => p.quoteId === quote.id));
    const billTo = quoteBillTo(quote, fleets.get(quote.fleetId ?? "") ?? null);
    // Its SA calendar day, and its age in whole calendar days — the same day the dates filter and the answer use.
    const issued = johannesburgDateKey(statementInvoiceDate(quote));
    const age = today - dayOrdinal(issued);
    return { quote, total, received, owing: Math.max(0, total - received), who: billTo.name || "—", issued, age };
  });
  // One invoice asked for by its number is found paid or not; a list defaults to what is still owing.
  const status = args.status ?? (asked ? "any" : "unpaid");
  const matches = all.filter((r) => {
    if (status === "unpaid" && r.owing <= 0) return false;
    if (status === "paid" && r.owing > 0) return false;
    if (args.from && r.issued < args.from) return false;
    if (args.to && r.issued > args.to) return false;
    if (args.olderThanDays && r.age < args.olderThanDays) return false;
    if (args.xero === "not_sent" && (r.quote.xeroInvoiceId || r.quote.xeroExcludedAt)) return false;
    if (args.xero === "sent" && !r.quote.xeroInvoiceId) return false;
    if (args.xero === "excluded" && !r.quote.xeroExcludedAt) return false;
    const name = `${r.who} ${r.quote.contact?.firstName ?? ""} ${r.quote.contact?.lastName ?? ""} ${r.quote.contact?.company ?? ""}`.toLowerCase();
    return words.every((w) => name.includes(w));
  });
  const take = Math.min(args.limit ?? 10, 60);
  const page = matches.slice(0, take);
  // Owing per currency, never added across currencies (currencyRules).
  const outstanding = formatTotals(totalsByCurrency(matches, (r) => ({ cents: r.owing, currency: r.quote.currency }), moneyFmt.currency), moneyFmt);
  const xeroOf = (q: (typeof quotes)[number]) =>
    q.xeroInvoiceId ? `in Xero${q.xeroInvoiceNumber ? ` as ${q.xeroInvoiceNumber}` : ""}, ${xeroStatusLabel(q.xeroStatus).toLowerCase()}${q.xeroSentAt ? `, sent ${saDay(q.xeroSentAt)}` : ""}`
      : q.xeroExcludedAt ? "marked not for Xero" : "not sent to Xero";

  return {
    truncated: matches.length > page.length,
    data: [
      {
        total: matches.length,
        listed: page.length,
        outstanding,
        ...(asked && !matches.length ? { noInvoice: `No invoice numbered "${args.number}" that this person can open.` } : {}),
        note: "Invoices carry no due date in the CRM: 'days since invoiced' is the age, not days overdue. Owing = total less the deposit and payments recorded.",
      },
      ...page.map(({ quote, total, received, owing, who, issued, age }) => {
        const fmt = withCurrency(moneyFmt, quote.currency);
        return {
          invoice: formatInvoiceNumber(quote.invoiceNumber),
          quote: `Q-${quote.number}`,
          link: `/quotes/${quote.id}`,
          customer: who,
          invoiced: issued,
          daysSinceInvoiced: age,
          total: formatZAR(total, fmt),
          received: formatZAR(received, fmt),
          owing: formatZAR(owing, fmt),
          paid: owing <= 0,
          delivered: quote.deliveredAt ? saDay(quote.deliveredAt) : null,
          xero: xeroOf(quote),
        };
      }),
    ],
    rows: page.map(({ quote, owing, who }) => ({
      label: `${formatInvoiceNumber(quote.invoiceNumber)} — ${who}`,
      detail: `owing ${formatZAR(owing, withCurrency(moneyFmt, quote.currency))} · ${xeroOf(quote)}`,
      href: `/quotes/${quote.id}`,
    })),
  };
}
