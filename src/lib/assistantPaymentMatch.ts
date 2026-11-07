import "server-only";
import type { z } from "zod";
import { prisma } from "./db";
import { formatZAR } from "./format";
import { formatInvoiceNumber } from "./invoiceNumber";
import { quotePricing } from "./pricing";
import { outstandingCents } from "./accountStatement";
import { rankPaymentMatches, type MatchReason } from "./paymentMatch";
import type { matchPaymentArgs } from "./crmAssistantPlan";
import { MAX_CHOICES } from "./assistantActions";
import { getAccessibleQuoteIds, hasPermission, type PermissionUser } from "./permissions";
import { getRegionalSettings } from "@/lib/settings";
import { withCurrency } from "./currencyRules";

type Output = { rows: { label: string; detail: string; href: string }[]; data: unknown[]; truncated: boolean };

// ponytail: newest 500 invoiced quotes are the candidates — page through them if a workspace ever holds more.
const CANDIDATES = 500;

/**
 * match_payment: which invoiced quote with money owing a proof of payment is for (paymentMatch.ts ranks). Read-only.
 * Only for someone who may record payments (deliveries.manage, as the record_payment card needs), and only over the
 * quotes they may open, in this workspace (the scoped client and getAccessibleQuoteIds).
 */
export async function matchPayment(user: PermissionUser, args: z.infer<typeof matchPaymentArgs>): Promise<Output> {
  if (!(await hasPermission(user, "deliveries.manage"))) return { truncated: false, rows: [], data: [{ note: "Your role can't record payments, so there is nothing to match." }] };
  const ids = await getAccessibleQuoteIds(user);
  // SAME CURRENCY ONLY (multicurrency module): a ruble payment can't settle a rand invoice because the
  // numbers happen to coincide. The base currency means the quotes with none set, as before the module.
  const { currency: base } = await getRegionalSettings();
  const paidIn = (args.currency ?? base).toUpperCase();
  const quotes = await prisma.quote.findMany({
    where: {
      status: "accepted", supersededAt: null, deletedAt: null, invoicedAt: { not: null }, ...(ids === null ? {} : { id: { in: ids } }),
      ...(paidIn === base ? { OR: [{ currency: null }, { currency: base }] } : { currency: paidIn }),
    },
    orderBy: { invoicedAt: "desc" },
    take: CANDIDATES,
    select: {
      id: true, number: true, status: true, invoiceNumber: true, invoicedAt: true, signedAt: true, createdAt: true, deletedAt: true, supersededAt: true,
      depositPaidAt: true, depositPaidCents: true, taxInclusive: true, depositType: true, depositValue: true, items: true, fees: true, leadId: true,
      contact: { select: { firstName: true, lastName: true, company: true } },
      lead: { select: { name: true } },
    },
  });
  const payments = await prisma.quotePayment.findMany({
    where: { quoteId: { in: quotes.map((q) => q.id) }, voidedAt: null },
    select: { id: true, quoteId: true, amountCents: true, receivedAt: true, method: true, reference: true, voidedAt: true },
  });
  const candidates = quotes.map((quote) => {
    const paid = payments.filter((p) => p.quoteId === quote.id);
    const nothingIn = !quote.depositPaidAt && paid.length === 0;
    const customer = [quote.contact?.firstName, quote.contact?.lastName].filter(Boolean).join(" ") || quote.contact?.company || quote.lead?.name || "no customer";
    return {
      quote, customer,
      quoteNumber: quote.number,
      invoiceNumber: quote.invoiceNumber,
      customerNames: [quote.contact?.firstName, quote.contact?.lastName, quote.contact?.company, quote.lead?.name],
      owingCents: outstandingCents(quote, paid),
      depositDueCents: nothingIn
        ? quotePricing(quote.items, quote.fees, { taxInclusive: quote.taxInclusive ?? undefined, depositType: quote.depositType, depositValue: quote.depositValue }).depositCents
        : 0,
    };
  });
  const amountCents = Math.round(args.amount * 100);
  const { matches, clear } = rankPaymentMatches(candidates, { amountCents, reference: args.reference, payer: args.payer });
  // As many as can be offered as choices.
  const page = matches.slice(0, MAX_CHOICES);
  // The payment and every candidate are in `paidIn`, so they're all said in it.
  const moneyFmt = withCurrency(await getRegionalSettings(), paidIn);
  const why = (r: MatchReason) =>
    r === "reference" ? `the reference "${args.reference}" names it`
      : r === "deposit" ? `${formatZAR(amountCents, moneyFmt)} is its deposit due`
        : r === "balance" ? `${formatZAR(amountCents, moneyFmt)} is its balance owing`
          : "the payer's name matches the customer";
  return {
    truncated: matches.length > page.length || quotes.length === CANDIDATES,
    data: [
      {
        amount: formatZAR(amountCents, moneyFmt), reference: args.reference ?? null, paidOn: args.paidOn ?? null,
        verdict: clear
          ? `ONE CLEAR MATCH: Q-${clear.candidate.quoteNumber} — propose record_payment for it`
          : page.length ? "SEVERAL POSSIBLE — offer them as choices; do not pick one" : "NO MATCH among the invoiced quotes with money owing that this person can open — ask which quote",
      },
      ...page.map(({ candidate: c, reasons }) => ({
        quote: `Q-${c.quoteNumber}`,
        invoice: c.invoiceNumber ? formatInvoiceNumber(c.invoiceNumber) : null,
        link: `/quotes/${c.quote.id}`,
        leadId: c.quote.leadId,
        customer: c.customer,
        owing: formatZAR(c.owingCents, moneyFmt),
        ...(c.depositDueCents ? { depositDue: formatZAR(c.depositDueCents, moneyFmt) } : {}),
        why: reasons.map(why),
      })),
    ],
    rows: page.map(({ candidate: c, reasons }) => ({
      label: `Q-${c.quoteNumber} — ${c.customer}`,
      detail: `${formatZAR(c.owingCents, moneyFmt)} owing · ${reasons.map(why).join("; ")}`,
      href: `/quotes/${c.quote.id}`,
    })),
  };
}
