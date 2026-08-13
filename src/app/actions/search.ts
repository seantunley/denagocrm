"use server";

import { withActingStaffScope } from "@/lib/actingScope";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { contactName } from "@/lib/format";
import { SEARCH_HITS_PER_TYPE, MIN_SEARCH_TERM, type SearchHit } from "@/lib/recordSearch";
import {
  getAccessibleContactIds,
  getAccessibleJobCardIds,
  getAccessibleLeadIds,
  getAccessibleQuoteIds,
  getAccessibleVehicleIds,
} from "@/lib/permissions";

/**
 * Record search for the command palette.
 *
 * WHY THIS EXISTS. The palette searched NOTHING but static navigation — pages,
 * settings entries, quick actions — while its placeholder said "Search…" and its
 * own first item offered "Search accessible records" as a link somewhere else.
 * Typing a customer's name into the one search box in the product returned "No
 * results found", which is the worst possible answer: not "look over there", but
 * a confident nothing.
 *
 * The full-page search at /search already does this properly. This is the same
 * question asked from the palette, trimmed to what a dropdown can usefully show:
 * the five things people look up by name, five hits each, with "see all results"
 * one keystroke away for everything else (documents, products, custom fields).
 *
 * ── TENANT SCOPE ────────────────────────────────────────────────────────────
 *
 * Wrapped in `withActingStaffScope`. A Server Action does NOT inherit the scope a
 * page render establishes, and every read below is tenant-guarded, so without it
 * this throws under enforcement rather than returning results. That is the defect
 * that cost a day on the research action and appeared again in the push test —
 * assume nothing about ambient scope in an action.
 *
 * ── PERMISSIONS ─────────────────────────────────────────────────────────────
 *
 * Scoped by the SAME `getAccessible*Ids` helpers the full-page search and every
 * list page use, with their documented contract: `null` means unrestricted, and
 * an empty array must become an impossible match rather than an absent filter. A
 * second scope resolver written for a search box is how a search box becomes the
 * way to read records you cannot open.
 */

/**
 * The type, the minimum term and the per-type cap live in `@/lib/recordSearch`,
 * NOT here. A `"use server"` module may only export async functions — every other
 * export becomes a client-callable endpoint, so Next refuses the file. That is a
 * build-time rule `tsc` cannot see, and it is how this shipped red.
 */

export async function searchRecords(rawTerm: string): Promise<SearchHit[]> {
  return withActingStaffScope(async () => {
    const user = await requireUser();
    const term = rawTerm.trim();
    if (term.length < MIN_SEARCH_TERM) return [];

    const contains = { contains: term, mode: "insensitive" as const };
    // "Q-1042", "C-17" and "1042" should all find the numbered record. The same
    // parse the full-page search uses.
    const asNumber = parseInt(term.replace(/^[qQcC]-?/, ""), 10);
    const numeric = Number.isNaN(asNumber) ? null : asNumber;
    const scoped = (ids: string[] | null) => (ids === null ? {} : { id: { in: ids } });
    /** An empty accessible-id list means "nothing", never "no filter". */
    const empty = (ids: string[] | null) => ids !== null && ids.length === 0;

    const [automotiveOn, contactIds, leadIds, quoteIds, vehicleIds, jobCardIds] = await Promise.all([
      isModuleEnabled("automotive"),
      getAccessibleContactIds(user),
      getAccessibleLeadIds(user),
      getAccessibleQuoteIds(user),
      getAccessibleVehicleIds(user),
      getAccessibleJobCardIds(user),
    ]);

    const [contacts, leads, quotes, vehicles, jobCards] = await Promise.all([
      empty(contactIds)
        ? []
        : prisma.contact.findMany({
            where: {
              ...scoped(contactIds),
              OR: [
                { firstName: contains },
                { lastName: contains },
                { company: contains },
                { email: contains },
                { phone: contains },
              ],
            },
            select: { id: true, firstName: true, lastName: true, company: true, isCompany: true, email: true, phone: true },
            orderBy: { updatedAt: "desc" },
            take: SEARCH_HITS_PER_TYPE,
          }),
      empty(leadIds)
        ? []
        : prisma.lead.findMany({
            where: {
              ...scoped(leadIds),
              OR: [{ title: contains }, { name: contains }, { email: contains }, { phone: contains }],
            },
            select: { id: true, title: true, name: true, stage: { select: { name: true } } },
            orderBy: { updatedAt: "desc" },
            take: SEARCH_HITS_PER_TYPE,
          }),
      empty(quoteIds)
        ? []
        : prisma.quote.findMany({
            where: {
              ...scoped(quoteIds),
              OR: [
                ...(numeric === null ? [] : [{ number: numeric }]),
                { contact: { firstName: contains } },
                { contact: { lastName: contains } },
                { contact: { company: contains } },
                { lead: { title: contains } },
              ],
            },
            select: {
              id: true,
              number: true,
              status: true,
              contact: { select: { firstName: true, lastName: true, company: true, isCompany: true } },
            },
            orderBy: { updatedAt: "desc" },
            take: SEARCH_HITS_PER_TYPE,
          }),
      // Vehicles and job cards belong to the automotive pack. Searching them for a
      // workspace that has it switched off would surface a record they have no
      // screen to open.
      !automotiveOn || empty(vehicleIds)
        ? []
        : prisma.vehicle.findMany({
            where: {
              ...scoped(vehicleIds),
              OR: [{ model: contains }, { vin: contains }, { regNumber: contains }],
            },
            select: {
              id: true,
              model: true,
              regNumber: true,
              vin: true,
              contact: { select: { firstName: true, lastName: true, company: true, isCompany: true } },
            },
            // Vehicle has no `updatedAt` — only `createdAt`. Ordering by a column
            // the model does not carry is a compile error here and would have been
            // a runtime one in raw SQL.
            orderBy: { createdAt: "desc" },
            take: SEARCH_HITS_PER_TYPE,
          }),
      !automotiveOn || empty(jobCardIds)
        ? []
        : prisma.jobCard.findMany({
            where: {
              ...scoped(jobCardIds),
              OR: [{ description: contains }, ...(numeric === null ? [] : [{ number: numeric }])],
            },
            select: {
              id: true,
              number: true,
              description: true,
              contact: { select: { firstName: true, lastName: true, company: true, isCompany: true } },
            },
            orderBy: { updatedAt: "desc" },
            take: SEARCH_HITS_PER_TYPE,
          }),
    ]);

    const person = (c: { firstName: string; lastName: string | null; company: string | null; isCompany: boolean } | null) =>
      c ? contactName(c) : "";

    return [
      ...contacts.map((c): SearchHit => ({
        id: c.id,
        type: "contact",
        label: contactName(c),
        sublabel: c.email ?? c.phone ?? "Customer",
        href: `/contacts/${c.id}`,
      })),
      ...leads.map((l): SearchHit => ({
        id: l.id,
        type: "lead",
        label: l.title || l.name,
        sublabel: l.stage?.name ?? "Lead",
        href: `/leads/${l.id}`,
      })),
      ...quotes.map((q): SearchHit => ({
        id: q.id,
        type: "quote",
        label: `Q-${q.number}`,
        sublabel: [person(q.contact), q.status].filter(Boolean).join(" · "),
        href: `/quotes/${q.id}`,
      })),
      ...vehicles.map((v): SearchHit => ({
        id: v.id,
        type: "vehicle",
        label: [v.model, v.regNumber].filter(Boolean).join(" · "),
        sublabel: person(v.contact) || v.vin || "Vehicle",
        href: `/vehicles/${v.id}`,
      })),
      ...jobCards.map((j): SearchHit => ({
        id: j.id,
        type: "jobcard",
        label: `Job card #${j.number}`,
        sublabel: [person(j.contact), j.description].filter(Boolean).join(" · ").slice(0, 80),
        href: `/jobcards/${j.id}`,
      })),
    ];
  });
}
