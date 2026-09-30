import "server-only";
import type { Prisma } from "@prisma/client";
import { addDays } from "date-fns";
import { getRegionalSettings, getSetting } from "./settings";
import { DEFAULT_QUOTE_TERMS, quoteValidDays } from "./quoteExpiry";
import type { Regional } from "./format";
import { nextQuoteNumber } from "./numbering";

/**
 * Creating the seeded draft quote a lead implies — as a step that takes a
 * transaction, so it can be one part of a larger atomic operation.
 *
 * ── WHY THIS MOVED OUT OF quotes.ts ─────────────────────────────────────────
 *
 * `createQuoteFromLeadRecord` did the whole job: resolve settings, open its own
 * transaction, allocate the number, insert. That is right for "make me a quote"
 * and unusable for the `attach_quote` stage remedy, which has to create the quote
 * and move the lead TOGETHER — and a transaction cannot be nested inside another.
 *
 * So the parts are separated by what they need rather than by what they are:
 * `quoteFromLeadDefaults()` reads settings and can run anywhere, and
 * `insertQuoteFromLead()` is pure database work against a caller's `tx`. The
 * remedy and the plain create path then share one implementation of what a quote
 * seeded from a lead actually contains, instead of the remedy growing a second
 * copy that drifts the first time someone changes what gets pre-filled.
 *
 * ── THE NUMBER MUST BE ALLOCATED ON THE BYPASS CLIENT ───────────────────────
 *
 * `Quote.number` is `@unique` GLOBALLY — the schema says so, and says the swap to
 * `@@unique([tenantId, number])` is a separate backup-first PR. `nextQuoteNumber`
 * computes `MAX(number) + 1`, so on the tenant-scoped client it would read the
 * maximum *within one workspace* and hand back a number another workspace already
 * holds, failing the unique constraint and losing the work — the exact collision
 * the advisory lock exists to prevent, reintroduced by scoping.
 *
 * That is why `tx` here is a `basePrisma` transaction and why `tenantId` is a
 * required parameter: the bypass client inherits no scope, so every row created
 * has to carry its owner explicitly, and nested creates inherit nothing from the
 * parent either — hence the stamp on the item as well as the quote.
 */

type Tx = Prisma.TransactionClient;

export type QuoteFromLeadDefaults = { validUntil: Date; terms: string; regional: Regional };

/**
 * The validity window, terms and VAT rate a new quote starts with — the ONE
 * place every quote-creating path reads them from (lead, contact, fleet, the
 * editor, revisions), so none of them can drift from Settings → Quotes.
 *
 * Resolved OUTSIDE the transaction on purpose: these are `AppSetting` reads,
 * and holding the quote-number advisory lock across them would serialise every
 * concurrent quote creation behind a settings lookup.
 */
export async function quoteFromLeadDefaults(): Promise<QuoteFromLeadDefaults> {
  const [validDaysRaw, terms, regional] = await Promise.all([
    getSetting("QUOTE_VALID_DAYS"),
    getSetting("QUOTE_TERMS"),
    getRegionalSettings(),
  ]);
  return {
    validUntil: addDays(new Date(), quoteValidDays(validDaysRaw)),
    terms: terms || DEFAULT_QUOTE_TERMS,
    regional,
  };
}

/** The same defaults, shaped for the quote editor (a date input wants yyyy-mm-dd). */
export function editorDefaults(defaults: QuoteFromLeadDefaults) {
  return {
    validUntil: defaults.validUntil.toISOString().slice(0, 10),
    terms: defaults.terms,
    regional: defaults.regional,
  };
}

/** The lead fields a seeded quote is built from. */
export type QuoteSeedLead = {
  id: string;
  contactId: string | null;
  valueCents: number;
  color: string | null;
  product: { id: string; name: string; basePriceCents: number } | null;
};

/**
 * Allocate a number and insert the draft, inside the caller's transaction.
 *
 * MUST be called on a `basePrisma` transaction — see the header — and the number
 * must be allocated and inserted inside the SAME transaction as the advisory
 * lock, or the serialisation guarantee is lost (`numbering.ts` says so too).
 */
export async function insertQuoteFromLead(
  tx: Tx,
  input: {
    lead: QuoteSeedLead;
    tenantId: string;
    createdById: string;
    defaults: QuoteFromLeadDefaults;
  },
): Promise<{ id: string; number: number }> {
  const { lead, tenantId, createdById, defaults } = input;
  const number = await nextQuoteNumber(tx);
  const quote = await tx.quote.create({
    data: {
      number,
      tenantId,
      leadId: lead.id,
      contactId: lead.contactId,
      createdById,
      validUntil: defaults.validUntil,
      terms: defaults.terms,
      items: lead.product
        ? {
            create: [
              {
                tenantId,
                description: lead.product.name,
                qty: 1,
                // The lead's own figure when it has one, else the product's list
                // price. `|| ` rather than `??` is deliberate and pre-existing: a
                // lead worth 0 has not been valued, and the list price is the
                // better starting point than zero.
                unitPriceCents: lead.valueCents || lead.product.basePriceCents,
                productId: lead.product.id,
                colorPreference: lead.color || null,
                // Stamped, not left to the column default: the line keeps the
                // rate it was issued at even if the workspace's VAT changes.
                taxRatePct: defaults.regional.vatRatePct,
              },
            ],
          }
        : undefined,
    },
    select: { id: true, number: true },
  });
  return quote;
}
