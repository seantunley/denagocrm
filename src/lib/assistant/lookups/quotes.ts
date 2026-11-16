import "server-only";
import { z } from "zod";
import { prisma } from "../../db";
import { formatZAR, contactName, type MoneyFormat } from "../../format";
import { withCurrency } from "../../currencyRules";
import { payableTotalCents } from "../../pricing";
import { quoteSends } from "../../quoteEmailStatus";
import { getRegionalSettings } from "../../settings";
import { ownedWriteTenantId } from "../../tenantWrite";
import { isCustomerSigner } from "../../signing/quoteMirror";
import { firstCustomerView, memoCustomer } from "../../signing/customerView";
import { getAccessibleQuoteIds, hasAnyPermission } from "../../permissions";
import { countQuoted, modelsNamed, quoteLineWhere } from "../../quotedProducts";
import { quoteArgs } from "../../crmAssistantPlan";
import { DAY, CANDIDATES, ToolOutput, User, dateKey, LIVE_SIGNING, signingFor, viewedByCustomer, quoteFacts, refused } from "../lookupKit";

export async function findQuotes(user: User, raw: z.infer<typeof quoteArgs>): Promise<ToolOutput> {
  if (!(await hasAnyPermission(user, "quotes.view_all", "quotes.view_owned"))) return refused("quotes");
  const args = quoteArgs.parse(raw);
  const ids = await getAccessibleQuoteIds(user);
  // Quotes out for signature in the signing hub (their own status stays "draft").
  const hub = args.awaitingSignature || args.viewed !== undefined
    ? await prisma.signatureRequest.findMany({
        where: { deletedAt: null, quoteId: { not: null }, status: { in: LIVE_SIGNING } },
        select: { quoteId: true, recipients: { select: { role: true, email: true, viewedAt: true } } },
      })
    : [];
  const outForSigning = hub.map((r) => r.quoteId!);
  // "Opened" = opened by the CUSTOMER, not a colleague reviewing or countersigning.
  const isCustomer = memoCustomer((r) => isCustomerSigner(r, ownedWriteTenantId()));
  const openedInHub: string[] = [];
  for (const r of hub) if (await firstCustomerView(r.recipients, isCustomer)) openedInHub.push(r.quoteId!);
  // A quote named by its number: that one quote, whatever its age or status —
  // including one a revision has replaced, which is still the quote they named.
  // The access filter below applies to it like any other.
  const wantedNumber = args.number === undefined ? null : Number(String(args.number).replace(/^Q-?/i, ""));
  // The catalogue models the words name (quotedProducts.modelsNamed) — "Rover XL" is not "Rover XL 6".
  const models = args.product
    ? modelsNamed(await prisma.product.findMany({ where: { deletedAt: null }, select: { id: true, name: true } }), args.product)
    : null;
  const quotes = await prisma.quote.findMany({
    where: {
      deletedAt: null,
      ...(wantedNumber === null ? { supersededAt: null } : { number: wantedNumber }),
      ...(ids === null ? {} : { id: { in: ids } }),
      ...(args.awaitingSignature
        ? {
            signedAt: null,
            declinedAt: null,
            // In an OR, so the id here narrows rather than replaces the access filter.
            OR: [{ status: "sent" }, { id: { in: outForSigning }, status: { in: ["draft", "sent"] } }],
          }
        : args.status ? { status: args.status } : {}),
      // Inside AND: a top-level `id` here would replace the access filter above.
      ...(args.viewed === true
        ? { AND: [{ OR: [{ viewedAt: { not: null } }, { id: { in: openedInHub } }] }] }
        : args.viewed === false ? { AND: [{ viewedAt: null }, { id: { notIn: openedInHub } }] } : {}),
      ...(args.olderThanDays ? { createdAt: { lt: new Date(Date.now() - args.olderThanDays * DAY) } } : {}),
      // "Expiring": still open — draft or sent, nobody has signed or declined —
      // with its validity running out in the window (or already run out today).
      ...(args.expiringWithinDays !== undefined
        ? {
            status: { in: ["draft", "sent"] },
            signedAt: null,
            declinedAt: null,
            validUntil: { gte: new Date(Date.now() - DAY), lte: new Date(Date.now() + args.expiringWithinDays * DAY) },
          }
        : {}),
      ...(args.product || args.colour ? { items: { some: quoteLineWhere(models?.map((m) => m.id) ?? null, args.colour) } } : {}),
    },
    orderBy: args.expiringWithinDays !== undefined ? { validUntil: "asc" } : { createdAt: "desc" },
    take: CANDIDATES,
    select: {
      id: true, number: true, status: true, createdAt: true, viewedAt: true, signedAt: true, validUntil: true,
      taxInclusive: true, currency: true, depositType: true, depositValue: true, items: true, fees: true, contactId: true, leadId: true,
      lead: { select: { id: true, name: true, title: true } },
      contact: { select: { firstName: true, lastName: true } },
    },
  });
  // Totals through payableTotalCents — the figure on the document, fees included.
  const priced = quotes
    .map((quote) => ({ quote, total: payableTotalCents(quote) }))
    .filter(({ total }) => !args.minValue || total >= args.minValue * 100);
  const take = args.limit ?? 10;
  const page = priced.slice(0, take);
  const signing = await signingFor(page.map(({ quote }) => quote.id));
  // "Sent" is only what our side did: whether the email that carried it bounced (quoteEmailStatus.ts).
  const sends = await quoteSends(page.map(({ quote }) => quote));
  const customer = (q: (typeof quotes)[number]) =>
    q.contact ? contactName(q.contact) : q.lead?.name ?? "no customer";
  // "How many white Rover XLs?" — counted over every matching quote, not the page (quotedProducts.ts).
  const matching = args.product || args.colour
    ? {
        models: models ? models.map((m) => m.name) : "any vehicle",
        ...countQuoted(priced.map(({ quote }) => quote), models, args.colour),
        exact: quotes.length < CANDIDATES,
        note: models?.length === 0
          ? `No product in the catalogue is called "${args.product}".`
          : `${quotes.length < CANDIDATES ? "Exact: every matching quote this person may open, superseded revisions left out — not only those listed." : `At least: more than ${CANDIDATES} quotes matched.`} Vehicles only: lines linked to a catalogue product. Free-text lines (often accessories, e.g. "Rain Cover Rover XL") are not counted.`,
      }
    : null;
  const moneyFmt = await getRegionalSettings();
  return {
    // With an exact count, a shorter list is not a cut-off answer: "matching" says how many there are.
    truncated: matching ? !matching.exact : priced.length > take || quotes.length === CANDIDATES,
    data: [...(matching ? [{ matching }] : []), ...page.map(({ quote, total }) => ({
      quote: `Q-${quote.number}`,
      link: `/quotes/${quote.id}`,
      leadId: quote.lead?.id ?? null,
      customer: customer(quote),
      total: formatZAR(total, withCurrency(moneyFmt, quote.currency)),
      ...quoteContents(quote, withCurrency(moneyFmt, quote.currency)),
      created: dateKey(quote.createdAt),
      ...quoteFacts(quote, signing.get(quote.id)),
      ...(sends.has(quote.id) ? { sendStatus: sends.get(quote.id)!.status } : {}),
      viewedByCustomer: viewedByCustomer(quote, signing.get(quote.id)),
      validUntil: quote.validUntil ? dateKey(quote.validUntil) : null,
    }))],
    rows: page.map(({ quote, total }) => ({
      label: `Q-${quote.number} — ${customer(quote)}`,
      detail: `${quoteFacts(quote, signing.get(quote.id)).status}${sends.get(quote.id)?.bounced ? " · email bounced" : ""} · ${formatZAR(total, withCurrency(moneyFmt, quote.currency))} · viewed ${viewedByCustomer(quote, signing.get(quote.id))}`,
      href: `/quotes/${quote.id}`,
    })),
  };
}

/**
 * Why DAX won't price a quote in another currency (multicurrency module): its prices come
 * from the catalogue, which is in the base currency. The person types them in the CRM.
 */
export function foreignCurrencyQuote(subject: string, currency: string): string {
  return `${subject} in ${currency}, and catalogue prices are in the workspace's own currency — add the products in the CRM, where you can type the ${currency} price.`;
}

/**
 * WHAT IS ON A QUOTE: its lines and its fees, as they are named there.
 *
 * A quote used to reach the assistant as a number, a customer and a total. Asked
 * to "make the colour white" on a quote with one vehicle on it, it could not see
 * that there was one vehicle, or what colour it was — so it asked which line, and
 * once proposed a change to a colour the line already had (Sean, 2026-10-13: "If
 * there is only one cart on the quote, why ask the question?"). These are the
 * names quote_change matches against, so they are given exactly as stored.
 */
export function quoteContents(quote: {
  items: { description: string; qty: number; discountPct: number; colorPreference: string | null }[];
  fees: { label: string; amountCents: number }[];
}, moneyFmt: MoneyFormat): { lines: string[]; fees: string[] } {
  return {
    lines: quote.items.slice(0, 12).map((item) =>
      `${item.qty} × ${item.description}${item.colorPreference ? ` — colour ${item.colorPreference}` : ""}${item.discountPct > 0 ? ` — ${item.discountPct}% off` : ""}`),
    fees: quote.fees.slice(0, 12).map((fee) => `${fee.label} — ${formatZAR(fee.amountCents, moneyFmt)}`),
  };
}
