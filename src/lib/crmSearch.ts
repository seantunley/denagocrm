import "server-only";
import { Prisma } from "@prisma/client";
import { prisma, basePrisma } from "./db";
import { actingTenantId } from "./actingTenant";
import { isModuleEnabled } from "./modules/enabled";
import { AUTOMOTIVE_DELIVERY_TAGS } from "./modules/registry";
import { contactName, formatZAR } from "./format";
import { withCurrency } from "./currencyRules";
import { isCustomEntity, type CustomEntity } from "./customFields";
import { getAccessibleActivityIds } from "./activityAccess";
import { searchBotKnowledge } from "./botKnowledge";
import { COMMUNICATION_SEARCH_DOC, searchStems, snippetAround } from "./crmAssistantEvidence";
// From "@/lib/permissions" by that name: the document-scope test checks every read surface asks the same module.
import {
  getAccessibleCaseIds,
  getAccessibleContactIds,
  getAccessibleDocumentIds,
  getAccessibleJobCardIds,
  getAccessibleLeadIds,
  getAccessibleQuoteIds,
  getAccessibleVehicleIds,
  hasAnyPermission,
  type PermissionUser,
} from "@/lib/permissions";
import { MIN_SEARCH_TERM, messageVisible, type SearchHit, type SearchHitType } from "./recordSearch";
import { getRegionalSettings } from "@/lib/settings";

/*
 * ONE SEARCH (2026-11-05): the search menu, the /search page and DAX's search_everything all ask this, as the person
 * searching. There were two copies (the menu's five record types, the page's eight) and DAX searched messages one
 * customer at a time; they had drifted. Each kind reads only what that person may open, through the CRM's own access
 * lists, inside the acting workspace — the same rule as the lists they'd click through to.
 *
 * Records match on their fields (and custom field values); messages and notes match by meaning-less full text on the
 * index DAX's message search uses (Communication_search_idx), so "deliveries" finds "delivered". The knowledge base is
 * the chatbot's approved answers. Nothing here is semantic: words are matched, not ideas.
 */

export const SEARCH_KINDS: readonly SearchHitType[] = [
  "contact", "lead", "quote", "vehicle", "jobcard", "case", "message", "activity", "document", "product", "knowledge",
];
/** What the search menu shortlists (its SEARCH_GROUPS) — records by name, and messages. /search and DAX get everything. */
export const PALETTE_KINDS: readonly SearchHitType[] = ["contact", "lead", "quote", "vehicle", "jobcard", "message"];

type Options = { kinds?: readonly SearchHitType[]; perKind?: number };

export async function searchCrm(user: PermissionUser, rawTerm: string, options: Options = {}): Promise<SearchHit[]> {
  const term = rawTerm.trim().slice(0, 200);
  if (term.length < MIN_SEARCH_TERM) return [];
  const want = new Set(options.kinds ?? SEARCH_KINDS);
  const take = options.perKind ?? 20;
  const tenantId = await actingTenantId();

  const contains = { contains: term, mode: "insensitive" as const };
  const asNumber = parseInt(term.replace(/^[qQcCjJ]-?#?/, ""), 10);
  const numeric = Number.isNaN(asNumber) ? null : asNumber;
  const scoped = (ids: string[] | null) => (ids === null ? {} : { id: { in: ids } });
  /** An empty accessible-id list means "nothing", never "no filter". */
  const empty = (ids: string[] | null) => ids !== null && ids.length === 0;
  const skip = <T,>(): Promise<T[]> => Promise.resolve([]);

  const [automotiveOn, supportOn, commerceOn, contactIds, leadIds, quoteIds, vehicleIds, jobCardIds, documentIds, caseIds, activityIds, canProducts] =
    await Promise.all([
      isModuleEnabled("automotive"),
      isModuleEnabled("support"),
      isModuleEnabled("commerce"),
      getAccessibleContactIds(user),
      getAccessibleLeadIds(user),
      want.has("quote") ? getAccessibleQuoteIds(user) : [],
      want.has("vehicle") ? getAccessibleVehicleIds(user) : [],
      want.has("jobcard") ? getAccessibleJobCardIds(user) : [],
      want.has("document") ? getAccessibleDocumentIds(user) : [],
      want.has("case") ? getAccessibleCaseIds(user) : [],
      want.has("activity") ? getAccessibleActivityIds(user) : [],
      want.has("product") ? hasAnyPermission(user, "stock.view", "stock.manage", "parts.view", "parts.manage", "pipelines.view") : false,
    ]);

  // Custom field values that match, by the kind of record they belong to.
  const custom: Record<CustomEntity, string[]> = { contact: [], lead: [], quote: [], case: [] };
  for (const row of await prisma.customFieldValue.findMany({
    where: { value: contains, def: { entity: { in: ["contact", "lead", "quote", "case"] } } },
    select: { recordId: true, def: { select: { entity: true } } },
    take: 200,
  })) {
    if (isCustomEntity(row.def.entity)) custom[row.def.entity].push(row.recordId);
  }
  const customMatch = (entity: CustomEntity) => (custom[entity].length ? [{ id: { in: custom[entity] } }] : []);

  const stems = searchStems(term);
  const query = stems.join(" or ");
  const doc = Prisma.raw(COMMUNICATION_SEARCH_DOC);
  // A message on a deal needs that DEAL (its customer is not enough — review of #1006, as DAX's own message search);
  // only a message on no deal is decided by its customer. messageVisible below is the same rule, applied again.
  const messageAccess = Prisma.sql`(
      ("leadId" IS NOT NULL AND ${leadIds === null ? Prisma.sql`TRUE` : Prisma.sql`"leadId" = ANY(${leadIds}::text[])`})
      OR ("leadId" IS NULL AND "contactId" IS NOT NULL AND ${contactIds === null ? Prisma.sql`TRUE` : Prisma.sql`"contactId" = ANY(${contactIds}::text[])`})
    )`;

  type MessageRow = { id: string; occurredAt: Date; type: string; direction: string | null; subject: string | null; body: string; leadId: string | null; contactId: string | null };
  type CaseRow = { id: string; number: bigint; subject: string; status: string; contactName: string };

  const [contacts, leads, quotes, vehicles, jobCards, cases, messages, activities, documents, products, knowledge] = await Promise.all([
    want.has("contact") && !empty(contactIds)
      ? prisma.contact.findMany({
          where: { ...scoped(contactIds), OR: [{ firstName: contains }, { lastName: contains }, { company: contains }, { email: contains }, { phone: contains }, { city: contains }, ...customMatch("contact")] },
          select: { id: true, firstName: true, lastName: true, company: true, isCompany: true, email: true, phone: true, city: true },
          orderBy: { updatedAt: "desc" },
          take,
        })
      : skip<never>(),
    want.has("lead") && !empty(leadIds)
      ? prisma.lead.findMany({
          where: { ...scoped(leadIds), OR: [{ title: contains }, { name: contains }, { email: contains }, { phone: contains }, ...customMatch("lead")] },
          select: { id: true, title: true, name: true, status: true, valueCents: true, currency: true, stage: { select: { name: true } } },
          orderBy: { updatedAt: "desc" },
          take,
        })
      : skip<never>(),
    want.has("quote") && !empty(quoteIds)
      ? prisma.quote.findMany({
          where: {
            ...scoped(quoteIds),
            OR: [
              ...(numeric === null ? [] : [{ number: numeric }]),
              { contact: { firstName: contains } }, { contact: { lastName: contains } }, { contact: { company: contains } },
              { lead: { title: contains } },
              ...customMatch("quote"),
            ],
          },
          select: { id: true, number: true, status: true, contact: { select: { firstName: true, lastName: true, company: true, isCompany: true } }, lead: { select: { name: true } } },
          orderBy: { updatedAt: "desc" },
          take,
        })
      : skip<never>(),
    want.has("vehicle") && automotiveOn && !empty(vehicleIds)
      ? prisma.vehicle.findMany({
          where: { ...scoped(vehicleIds), OR: [{ model: contains }, { vin: contains }, { regNumber: contains }] },
          select: { id: true, model: true, regNumber: true, vin: true, contact: { select: { firstName: true, lastName: true, company: true, isCompany: true } } },
          orderBy: { createdAt: "desc" },
          take,
        })
      : skip<never>(),
    want.has("jobcard") && automotiveOn && !empty(jobCardIds)
      ? prisma.jobCard.findMany({
          where: { ...scoped(jobCardIds), OR: [{ description: contains }, ...(numeric === null ? [] : [{ number: numeric }])] },
          select: { id: true, number: true, description: true, vehicle: { select: { model: true } }, contact: { select: { firstName: true, lastName: true, company: true, isCompany: true } } },
          orderBy: { openedAt: "desc" },
          take,
        })
      : skip<never>(),
    // The workspace is named in the statement: this is the bypass client (it joins Contact). The page's own copy
    // matched every workspace's cases for someone who sees all cases — fixed here.
    want.has("case") && supportOn && !empty(caseIds)
      ? basePrisma.$queryRaw<CaseRow[]>(Prisma.sql`
          SELECT c."id", c."number", c."subject", c."status",
            CASE WHEN contact."isCompany" AND contact."company" IS NOT NULL THEN contact."company"
              ELSE TRIM(CONCAT(contact."firstName", ' ', COALESCE(contact."lastName", ''))) END AS "contactName"
          FROM "CustomerCase" c
          JOIN "Contact" contact ON contact."id" = c."contactId"
          WHERE c."tenantId" = ${tenantId}
            AND ${caseIds === null ? Prisma.sql`TRUE` : Prisma.sql`c."id" = ANY(${caseIds}::text[])`}
            AND (c."subject" ILIKE ${`%${term}%`} OR c."description" ILIKE ${`%${term}%`}
              ${numeric === null ? Prisma.empty : Prisma.sql`OR c."number" = ${BigInt(numeric)}`}
              ${custom.case.length ? Prisma.sql`OR c."id" = ANY(${custom.case}::text[])` : Prisma.empty})
          ORDER BY c."updatedAt" DESC
          LIMIT ${take}`)
      : skip<CaseRow>(),
    // Messages and notes, newest first, on the full-text index. Workspace named in the statement.
    want.has("message") && stems.length && !(empty(leadIds) && empty(contactIds))
      ? prisma.$queryRaw<MessageRow[]>`
          SELECT "id", "occurredAt", "type", "direction", "subject", "body", "leadId", "contactId"
            FROM "Communication"
           WHERE "tenantId" = ${tenantId}
             AND to_tsvector('english', ${doc}) @@ websearch_to_tsquery('english', ${query})
             AND ${messageAccess}
           ORDER BY "occurredAt" DESC
           LIMIT ${take}`
      : skip<MessageRow>(),
    want.has("activity") && !empty(activityIds)
      ? prisma.activity.findMany({
          where: { ...scoped(activityIds), OR: [{ summary: contains }, { note: contains }] },
          select: { id: true, summary: true, type: true, dueDate: true, leadId: true, contactId: true, note: true },
          orderBy: { dueDate: "desc" },
          take,
        })
      : skip<never>(),
    want.has("document") && !empty(documentIds)
      ? prisma.document.findMany({
          where: {
            ...scoped(documentIds),
            // The supplier's name finds its papers too ("Wrap Co invoice").
            OR: [{ fileName: contains }, { tag: contains }, { vendor: { is: { name: contains } } }],
            deletedAt: null,
            ...(automotiveOn ? {} : { NOT: { OR: [{ vehicleId: { not: null } }, { jobCardId: { not: null } }, { tag: { in: [...AUTOMOTIVE_DELIVERY_TAGS] } }] } }),
          },
          select: { id: true, fileName: true, tag: true, quoteId: true, vendor: { select: { name: true } }, contact: { select: { firstName: true, lastName: true, company: true, isCompany: true } }, vehicle: { select: { model: true } } },
          orderBy: { createdAt: "desc" },
          take,
        })
      : skip<never>(),
    want.has("product") && commerceOn && canProducts
      ? prisma.product.findMany({ where: { OR: [{ name: contains }, { sku: contains }] }, select: { id: true, name: true, basePriceCents: true }, take: Math.min(take, 10) })
      : skip<never>(),
    want.has("knowledge") ? searchBotKnowledge(term, new Date(), Math.min(take, 6)).catch(() => []) : skip<never>(),
  ]);

  // The same rule as the statement, once more in code: a mistake in either can't show a message on someone else's deal.
  const shownMessages = messages.filter((m) => messageVisible(m, leadIds, contactIds));

  // Names for the messages' and activities' customers and deals, in two reads.
  const leadIdsUsed = [...new Set([...shownMessages, ...activities].map((r) => r.leadId).filter((id): id is string => Boolean(id)))];
  const contactIdsUsed = [...new Set([...shownMessages, ...activities].map((r) => r.contactId).filter((id): id is string => Boolean(id)))];
  // The deal a document is filed on, so a result says "Q-1029 · Mrs Smith" rather than "Unfiled".
  const docQuoteIds = [...new Set(documents.map((d) => d.quoteId).filter((id): id is string => Boolean(id)))];
  const [leadNames, contactNames, docQuotes] = await Promise.all([
    leadIdsUsed.length ? prisma.lead.findMany({ where: { id: { in: leadIdsUsed } }, select: { id: true, title: true, name: true } }) : [],
    contactIdsUsed.length ? prisma.contact.findMany({ where: { id: { in: contactIdsUsed } }, select: { id: true, firstName: true, lastName: true, company: true, isCompany: true } }) : [],
    docQuoteIds.length
      ? prisma.quote.findMany({
          where: { id: { in: docQuoteIds } },
          select: { id: true, number: true, lead: { select: { name: true } }, contact: { select: { firstName: true, lastName: true, company: true, isCompany: true } } },
        })
      : [],
  ]);
  const docDeal = new Map(docQuotes.map((q) => [q.id, [`Q-${q.number}`, q.contact ? contactName(q.contact) : q.lead?.name].filter(Boolean).join(" · ")]));
  const leadName = new Map(leadNames.map((l) => [l.id, l.title || l.name]));
  const customerName = new Map(contactNames.map((c) => [c.id, contactName(c)]));
  const whose = (r: { leadId: string | null; contactId: string | null }) =>
    (r.contactId && customerName.get(r.contactId)) || (r.leadId && leadName.get(r.leadId)) || "Customer";
  const recordHref = (r: { leadId: string | null; contactId: string | null }, tab?: string) =>
    r.leadId ? `/leads/${r.leadId}${tab ? `?tab=${tab}` : ""}` : r.contactId ? `/contacts/${r.contactId}${tab ? `?tab=${tab}` : ""}` : "/calendar";
  const day = (d: Date) => d.toISOString().slice(0, 10);

  const moneyFmt = await getRegionalSettings();
  return [
    ...contacts.map((c) => ({ type: "contact" as const, id: c.id, label: contactName(c), sublabel: [c.email, c.phone, c.city].filter(Boolean).join(" · "), href: `/contacts/${c.id}` })),
    ...leads.map((l) => ({ type: "lead" as const, id: l.id, label: l.title, sublabel: [l.name, l.status === "open" ? l.stage?.name : l.status, l.valueCents ? formatZAR(l.valueCents, withCurrency(moneyFmt, l.currency)) : null].filter(Boolean).join(" · "), href: `/leads/${l.id}` })),
    ...quotes.map((q) => ({ type: "quote" as const, id: q.id, label: `Q-${q.number}`, sublabel: [q.contact ? contactName(q.contact) : q.lead?.name, q.status].filter(Boolean).join(" · "), href: `/quotes/${q.id}` })),
    ...vehicles.map((v) => ({ type: "vehicle" as const, id: v.id, label: v.model, sublabel: [v.regNumber ?? v.vin, contactName(v.contact)].filter(Boolean).join(" · "), href: `/vehicles/${v.id}` })),
    ...jobCards.map((j) => ({ type: "jobcard" as const, id: j.id, label: `Job #${j.number}`, sublabel: [j.vehicle?.model, contactName(j.contact), j.description.slice(0, 60)].filter(Boolean).join(" · "), href: `/jobcards/${j.id}` })),
    ...cases.map((c) => ({ type: "case" as const, id: c.id, label: `C-${c.number.toString()} · ${c.subject}`, sublabel: `${c.contactName} · ${c.status.replaceAll("_", " ")}`, href: `/cases/${c.id}` })),
    ...shownMessages.map((m) => ({
      type: "message" as const, id: m.id,
      label: `${whose(m)} · ${m.type}${m.direction ? ` ${m.direction}` : ""}`,
      sublabel: day(m.occurredAt),
      snippet: snippetAround(`${m.subject ? `${m.subject} — ` : ""}${m.body}`, stems, 200),
      href: recordHref(m),
    })),
    ...activities.map((a) => ({ type: "activity" as const, id: a.id, label: a.summary, sublabel: [a.type, day(a.dueDate), a.leadId || a.contactId ? whose(a) : null].filter(Boolean).join(" · "), snippet: a.note ? snippetAround(a.note, stems, 160) : undefined, href: recordHref(a, "activities") })),
    ...documents.map((d) => ({ type: "document" as const, id: d.id, label: d.fileName, sublabel: [d.tag, d.vendor?.name, (d.quoteId && docDeal.get(d.quoteId)) || (d.contact ? contactName(d.contact) : d.vehicle?.model ?? "Unfiled")].filter(Boolean).join(" · "), href: `/api/files/${d.id}`, newTab: true })),
    ...products.map((p) => ({ type: "product" as const, id: p.id, label: p.name, sublabel: formatZAR(p.basePriceCents, moneyFmt), href: `/products/${p.id}` })),
    ...knowledge.map((k) => ({ type: "knowledge" as const, id: k.id, label: k.title, sublabel: k.sourceLabel ?? "Approved answer", snippet: snippetAround(k.content, stems, 200), href: "/chatbot/knowledge" })),
  ];
}
