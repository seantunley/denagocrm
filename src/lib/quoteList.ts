import type { Prisma } from "@prisma/client";
import { csvRow } from "./csv";
import { containsText, searchTerms } from "./listPaging";
import { payableTotalCents } from "./pricing";
import { quoteBillTo, type BillToFleet, type BillToQuote } from "./quoteBillTo";

/**
 * The quotes list filter, as ONE database `where` — shared by the list page and
 * the CSV export so the file always holds exactly what the list is showing.
 *
 * It replaced "load the newest 200 quotes, then filter them in memory", which
 * meant searching for an older quote by number or customer returned nothing.
 *
 * Pure: the caller resolves access (`accessibleIds`) and fleet-name matches
 * (`fleetIds`, because `Quote.fleetId` has no relation to filter through), and
 * this only assembles the predicate. Soft-deleted quotes are excluded by the
 * scoped client, which injects `deletedAt: null` into every read.
 */
export function quoteListWhere(input: {
  /** null = may see every quote in the workspace; [] = none. */
  accessibleIds: string[] | null;
  status?: string | null;
  q?: string | null;
  /** Fleets whose name / billing email / billing phone contain the whole query. */
  fleetIds?: string[];
}): Prisma.QuoteWhereInput {
  const terms = searchTerms(input.q);
  const fleetIds = input.fleetIds ?? [];
  return {
    AND: [
      // Only current heads are listed; older revisions live in the version history.
      { supersededAt: null },
      ...(input.accessibleIds ? [{ id: { in: input.accessibleIds } }] : []),
      ...(input.status ? [{ status: input.status }] : []),
      ...(terms.length
        ? [{
            OR: [
              ...(fleetIds.length ? [{ fleetId: { in: fleetIds } }] : []),
              { AND: terms.map(quoteTermWhere) },
            ],
          }]
        : []),
    ],
  };
}

/** "1022", "Q-1022" and "q1022" all mean quote number 1022. */
const QUOTE_NUMBER = /^(?:q-?)?(\d{1,9})$/i;

/** One search term, matched against everything the list shows about a quote. */
function quoteTermWhere(term: string): Prisma.QuoteWhereInput {
  const number = QUOTE_NUMBER.exec(term)?.[1];
  const text = containsText(term);
  return {
    OR: [
      ...(number ? [{ number: Number(number) }] : []),
      { contact: { is: { OR: [{ firstName: text }, { lastName: text }, { company: text }, { email: text }, { phone: text }] } } },
      // lead.title is the MODEL the customer asked for.
      { lead: { is: { OR: [{ name: text }, { title: text }, { email: text }, { phone: text }] } } },
      // …and the line items name the model actually quoted.
      { items: { some: { description: text } } },
    ],
  };
}

export type QuoteExportRow = BillToQuote & Parameters<typeof payableTotalCents>[0] & {
  number: number;
  status: string;
  validUntil: Date | null;
  createdAt: Date;
  fleetId: string | null;
  lead: { title: string; name: string; email: string | null; phone: string | null } | null;
  createdBy: { name: string } | null;
};

export const QUOTE_EXPORT_HEADERS = [
  "Quote", "Status", "Customer", "Attention", "Email", "Phone", "Model / lead",
  "Total (ZAR)", "Valid until", "Created", "Created by",
] as const;

const day = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : "");

/**
 * The export file. Every cell goes through csvRow, which neutralises
 * spreadsheet formulas (`=`, `+`, `-`, `@` …): customer names, emails and lead
 * titles are typed in by the public intake form as often as by staff.
 */
export function quoteCsv(quotes: QuoteExportRow[], fleetsById: Map<string, BillToFleet>): string {
  return [
    csvRow(QUOTE_EXPORT_HEADERS),
    ...quotes.map((quote) => {
      // The same addressee the list row and the PDF print, fleet-aware.
      const billTo = quoteBillTo(quote, fleetsById.get(quote.fleetId ?? "") ?? null);
      return csvRow([
        `Q-${quote.number}`,
        quote.status,
        billTo.name,
        billTo.attention ?? "",
        billTo.email,
        billTo.phone,
        quote.lead?.title ?? "",
        (Math.round(payableTotalCents(quote)) / 100).toFixed(2),
        day(quote.validUntil),
        day(quote.createdAt),
        quote.createdBy?.name ?? "",
      ]);
    }),
  ].join("\r\n");
}
