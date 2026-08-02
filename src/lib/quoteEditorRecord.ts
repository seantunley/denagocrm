import "server-only";
import type { Prisma } from "@prisma/client";
import { contactName, formatDate } from "@/lib/format";
import type { QuoteEditorRecord } from "@/components/quotes/QuoteEditorDialog";

/**
 * Building the editor's view of a quote, in one place.
 *
 * The quotes LIST used to be the only thing that built these, so the editor
 * could only ever open a quote that page had already rendered. That held while
 * the editor was reached by clicking a row, and broke the moment anything else
 * could name a quote: creating a revision produced an id that was, by
 * definition, not in the list yet, so the editor opened blank. The list is also
 * capped at 200, so a deep link to an older quote would do the same.
 */

export type QuoteForEditor = Prisma.QuoteGetPayload<{
  include: { items: true; fees: true; lead: true; contact: true; createdBy: true };
}>;

/** The slim version rows the family/successor lookups need. */
export type QuoteVersionRow = {
  id: string;
  number: number;
  status: string;
  createdAt: Date;
  supersededAt: Date | null;
  revisionOfId: string | null;
  deletedAt: Date | null;
};

export const QUOTE_VERSION_SELECT = {
  id: true,
  number: true,
  status: true,
  createdAt: true,
  supersededAt: true,
  revisionOfId: true,
  deletedAt: true,
} as const;

export const QUOTE_EDITOR_INCLUDE = {
  items: true,
  fees: { orderBy: { sortOrder: "asc" } },
  lead: true,
  contact: true,
  createdBy: true,
} as const;

/**
 * Version lookups precomputed once for a batch of quotes. The list builds
 * hundreds of records from one index; doing it per quote would be quadratic.
 */
export type QuoteVersionIndex = {
  rootFor: (id: string) => string;
  familyOf: (id: string) => QuoteVersionRow[];
  successorOf: (id: string) => QuoteVersionRow | null;
};

export function quoteVersionIndex(allVersions: QuoteVersionRow[]): QuoteVersionIndex {
  const versionById = new Map(allVersions.map((version) => [version.id, version]));
  const rootFor = (id: string) => {
    let current = versionById.get(id);
    const seen = new Set<string>();
    while (current?.revisionOfId && !seen.has(current.id)) {
      seen.add(current.id);
      current = versionById.get(current.revisionOfId) ?? current;
      if (!current.revisionOfId) break;
    }
    return current?.id ?? id;
  };
  const versionsByRoot = new Map<string, QuoteVersionRow[]>();
  for (const version of allVersions) {
    const root = rootFor(version.id);
    versionsByRoot.set(root, [...(versionsByRoot.get(root) ?? []), version]);
  }
  return {
    rootFor,
    familyOf: (id) => versionsByRoot.get(rootFor(id)) ?? [],
    successorOf: (id) => allVersions.find((version) => version.revisionOfId === id && !version.deletedAt) ?? null,
  };
}

export function buildQuoteEditorRecord(
  quote: QuoteForEditor,
  index: QuoteVersionIndex,
): QuoteEditorRecord {
  const lockedReason = quote.signToken
    ? "A signing link is active. Revoke it from the signature card before editing."
    : quote.signedAt
      ? "This quote has been signed and is permanently read-only."
      : quote.supersededAt
        ? "This version has been superseded and is permanently read-only."
        : quote.status !== "draft"
          ? "This version has already been customer-facing. Create a revision to change it."
          : null;
  // The revision that superseded this version, so a dead-end read-only quote
  // can point at the live one instead of just saying it is old.
  const successor = quote.supersededAt ? index.successorOf(quote.id) : null;

  return {
    id: quote.id,
    number: quote.number,
    status: quote.status,
    contactId: quote.contactId,
    contactLabel: quote.contact ? contactName(quote.contact) : quote.lead?.name ?? "Unlinked quote",
    leadId: quote.leadId,
    leadLabel: quote.lead?.title ?? null,
    validUntil: quote.validUntil?.toISOString().slice(0, 10) ?? "",
    terms: quote.terms ?? "",
    createdAt: formatDate(quote.createdAt),
    createdByName: quote.createdBy?.name ?? null,
    editable: lockedReason === null,
    lockedReason,
    supersededAt: quote.supersededAt ? formatDate(quote.supersededAt) : null,
    supersededById: successor?.id ?? null,
    supersededByNumber: successor?.number ?? null,
    changeRequestedAt: quote.changeRequestedAt ? formatDate(quote.changeRequestedAt) : null,
    changeRequestNote: quote.changeRequestNote,
    items: quote.items.map((item) => ({
      id: item.id,
      description: item.description,
      qty: item.qty,
      unitPriceCents: item.unitPriceCents,
      productId: item.productId,
      colorPreference: item.colorPreference,
      discountPct: item.discountPct,
      costCents: item.costCents,
      optional: item.optional,
      selected: item.selected,
    })),
    taxInclusive: quote.taxInclusive,
    depositType: quote.depositType,
    depositValue: quote.depositValue,
    fees: quote.fees.map((fee) => ({ id: fee.id, label: fee.label, kind: fee.kind, amountCents: fee.amountCents })),
    versions: index
      .familyOf(quote.id)
      .toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((version) => ({
        id: version.id,
        number: version.number,
        status: version.status,
        createdAt: formatDate(version.createdAt),
        superseded: Boolean(version.supersededAt),
        current: version.id === quote.id,
      })),
  };
}
