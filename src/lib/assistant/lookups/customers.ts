import "server-only";
import { prisma } from "../../db";
import { formatZAR } from "../../format";
import { withCurrency } from "../../currencyRules";
import { payableTotalCents } from "../../pricing";
import { quoteSends } from "../../quoteEmailStatus";
import { getRegionalSettings } from "../../settings";
import { ownedWriteTenantId } from "../../tenantWrite";
import { getAccessibleContactIds, getAccessibleQuoteIds, hasAnyPermission } from "../../permissions";
import { closestNames, nameWords } from "../../nearMatch";
import { User, fuzzy, dateKey } from "../lookupKit";
import { quoteContents } from "./quotes";

/**
 * Customer records for a name — whether or not a lead matches it too. A customer
 * and a deal are different things to put a note on, and "the customer John
 * Smith" has to be findable when John also has a lead.
 *
 * Every word of the name must be in the first name, last name or company ("Sean
 * Tunley" is two columns). `ownId` adds one customer by id: the matched lead's
 * own customer (whose name may differ from the lead's), or the customer page the
 * person is looking at. Only customers this person can open — which is their
 * CUSTOMER access, asked on its own, not their lead access. No phone numbers or
 * emails: enough to tell them apart and to address a note, nothing more.
 */
export async function customersNamed(user: User, needle: string, ownId?: string | null) {
  const ids = await getAccessibleContactIds(user);
  if (ids !== null && ids.length === 0) return [];
  const words = needle.split(/\s+/).filter(Boolean).slice(0, 4);
  const byName = words.length ? [{ AND: words.map((word) => ({ OR: [{ firstName: fuzzy(word) }, { lastName: fuzzy(word) }, { company: fuzzy(word) }] })) }] : [];
  const byId = ownId ? [{ id: ownId }] : [];
  if (byName.length + byId.length === 0) return [];
  const found = await prisma.contact.findMany({
    where: {
      deletedAt: null,
      ...(ids === null ? {} : { id: { in: ids } }),
      OR: [...byId, ...byName],
    },
    orderBy: { updatedAt: "desc" },
    take: 5,
    select: { id: true, firstName: true, lastName: true, company: true, city: true, createdAt: true },
  });
  // The named one first: it is the one "this customer" most likely means.
  found.sort((a, b) => Number(b.id === ownId) - Number(a.id === ownId));
  /*
   * THEIR QUOTES TOO. A quote made for a customer directly sits on no lead, so a
   * customer with no deal used to come back as a name and a city — and a quote
   * the person had just been talking about could not be seen at all (Sean,
   * 2026-10-13: asked to rename a fee on Q-1031, the assistant found the
   * customer, saw no quote, and asked HIM for a screenshot of it). Only quotes
   * this person may open, current ones, the newest few — with what is on them.
   */
  const quoteIds = (await hasAnyPermission(user, "quotes.view_all", "quotes.view_owned")) ? await getAccessibleQuoteIds(user) : [];
  const quotes = found.length === 0 || (quoteIds !== null && quoteIds.length === 0) ? [] : await prisma.quote.findMany({
    where: { contactId: { in: found.map((c) => c.id) }, deletedAt: null, supersededAt: null, ...(quoteIds === null ? {} : { id: { in: quoteIds } }) },
    orderBy: { createdAt: "desc" },
    take: 40,
    select: { id: true, number: true, status: true, contactId: true, leadId: true, createdAt: true, taxInclusive: true, currency: true, depositType: true, depositValue: true, items: true, fees: true },
  });
  const sends = await quoteSends(quotes);
  const moneyFmt = await getRegionalSettings();
  return found.map((c) => ({
    contactId: c.id,
    name: [c.firstName, c.lastName].filter(Boolean).join(" "),
    company: c.company,
    city: c.city,
    customerSince: dateKey(c.createdAt),
    quotes: quotes.filter((q) => q.contactId === c.id).slice(0, 5).map((q) => ({
      quote: `Q-${q.number}`,
      link: `/quotes/${q.id}`,
      status: q.status,
      ...(sends.has(q.id) ? { sendStatus: sends.get(q.id)!.status } : {}),
      onADeal: q.leadId != null,
      total: formatZAR(payableTotalCents(q), withCurrency(moneyFmt, q.currency)),
      ...quoteContents(q, withCurrency(moneyFmt, q.currency)),
    })),
  }));
}

/** How many of the closest spellings the database hands nearMatch to rank. */
export const NEAR_CANDIDATES = 40;

/**
 * Deals and customers this person may see whose name is a close spelling of `needle`, closest first (at most five),
 * with ids so DAX can use one once the person picks it.
 *
 * The database ranks EVERY deal and customer this person may open by close spelling (pg_trgm, installed by
 * 20261007092000) and nearMatch.closestNames keeps the ones close enough to offer. It used to look only at names
 * sharing the first three letters of a word asked for, and only the fifty most recently changed, keeping a match
 * only one letter out: "Clive Jammim" never reached an older "Clive Jammine" (Sean, 2026-10-29).
 *
 * Raw SQL passes no guard, so both boundaries are in the query: this person's deals and customers (the same id
 * lists as everywhere else), in this workspace — DAX's own rule (ownedWriteTenantId, as its other searches), plus
 * rows with no workspace only while it is the only workspace (docs/TENANT-ENFORCEMENT-PREREQUISITES.md).
 */
export async function nearlyNamed(user: User, needle: string, leadIds: string[] | null) {
  if (!nameWords(needle).length) return [];
  const contactIds = await getAccessibleContactIds(user);
  const tenantId = ownedWriteTenantId();
  // The workspace predicate is written out in each query (not shared as a fragment) so the tenant-access sweep sees it.
  const [leads, contacts] = await Promise.all([
    leadIds !== null && leadIds.length === 0
      ? Promise.resolve([])
      : prisma.$queryRaw<{ id: string; name: string; title: string; status: string }[]>`
          SELECT "id", "name", "title", "status"
            FROM "Lead"
           WHERE "deletedAt" IS NULL AND ("tenantId" = ${tenantId} OR ("tenantId" IS NULL AND (SELECT count(*) FROM "Tenant") = 1))
             AND (${leadIds === null} OR "id" = ANY(${leadIds ?? []}::text[]))
           ORDER BY GREATEST(word_similarity(${needle}, "name"), similarity("name", ${needle}), word_similarity(${needle}, "title")) DESC, "updatedAt" DESC
           LIMIT ${NEAR_CANDIDATES}`,
    contactIds !== null && contactIds.length === 0
      ? Promise.resolve([])
      : prisma.$queryRaw<{ id: string; firstName: string; lastName: string | null; company: string | null }[]>`
          SELECT "id", "firstName", "lastName", "company"
            FROM "Contact"
           WHERE "deletedAt" IS NULL AND ("tenantId" = ${tenantId} OR ("tenantId" IS NULL AND (SELECT count(*) FROM "Tenant") = 1))
             AND (${contactIds === null} OR "id" = ANY(${contactIds ?? []}::text[]))
           ORDER BY GREATEST(
                      word_similarity(${needle}, concat_ws(' ', "firstName", "lastName")),
                      similarity(concat_ws(' ', "firstName", "lastName"), ${needle}),
                      word_similarity(${needle}, coalesce("company", ''))
                    ) DESC, "updatedAt" DESC
           LIMIT ${NEAR_CANDIDATES}`,
  ]);
  const deals = leads.map((l) => ({ match: { kind: "deal" as const, leadId: l.id, name: l.name, status: l.status }, names: [l.name, l.title] }));
  const people = contacts.map((c) => {
    const person = [c.firstName, c.lastName].filter(Boolean).join(" ");
    return { match: { kind: "customer" as const, contactId: c.id, name: person || c.company || "" }, names: [person, c.company] };
  });
  return closestNames(needle, [...deals, ...people], (candidate) => candidate.names).map((candidate) => candidate.match);
}
