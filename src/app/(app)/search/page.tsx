import Link from "next/link";
import { Prisma } from "@prisma/client";
import { prisma, basePrisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { contactName, formatZAR } from "@/lib/format";
import { getAccessibleDocumentIds } from "@/lib/documentAccess";
import {
  getAccessibleCaseIds,
  getAccessibleContactIds,
  getAccessibleJobCardIds,
  getAccessibleLeadIds,
  getAccessibleQuoteIds,
  getAccessibleVehicleIds,
  hasAnyPermission,
} from "@/lib/permissions";

type CaseSearchRow = {
  id: string;
  number: bigint;
  subject: string;
  status: string;
  contactName: string;
};

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const user = await requireUser();
  const { q } = await searchParams;
  const term = (q ?? "").trim();

  if (!term) {
    return (
      <div className="space-y-5">
        <h1 className="text-2xl font-semibold tracking-[-0.035em]">Search</h1>
        <p className="text-sm text-slate-400">
          Search only the contacts, leads, quotes, vehicles, job cards, cases and documents you are permitted to access.
        </p>
      </div>
    );
  }

  const [contactIds, leadIds, vehicleIds, jobCardIds, quoteIds, documentIds, caseIds, canProducts] =
    await Promise.all([
      getAccessibleContactIds(user),
      getAccessibleLeadIds(user),
      getAccessibleVehicleIds(user),
      getAccessibleJobCardIds(user),
      getAccessibleQuoteIds(user),
      getAccessibleDocumentIds(user),
      getAccessibleCaseIds(user),
      hasAnyPermission(user, "stock.view", "stock.manage", "parts.view", "parts.manage", "pipelines.view"),
    ]);

  const contains = { contains: term, mode: "insensitive" as const };
  const asNumber = parseInt(term.replace(/^[qQcC]-?/, ""), 10);
  const scoped = (ids: string[] | null) => ids === null ? {} : { id: { in: ids } };
  const caseNumberCondition = Number.isNaN(asNumber)
    ? Prisma.empty
    : Prisma.sql`OR c."number" = ${BigInt(asNumber)}`;

  const casesPromise: Promise<CaseSearchRow[]> = caseIds !== null && caseIds.length === 0
    ? Promise.resolve([])
    : basePrisma.$queryRaw<CaseSearchRow[]>(Prisma.sql`
        SELECT c."id", c."number", c."subject", c."status",
          CASE WHEN contact."isCompany" AND contact."company" IS NOT NULL THEN contact."company"
            ELSE TRIM(CONCAT(contact."firstName", ' ', COALESCE(contact."lastName", ''))) END AS "contactName"
        FROM "CustomerCase" c
        JOIN "Contact" contact ON contact."id" = c."contactId"
        WHERE ${caseIds === null ? Prisma.sql`TRUE` : Prisma.sql`c."id" = ANY(${caseIds}::text[])`}
          AND (
            c."subject" ILIKE ${`%${term}%`}
            OR c."description" ILIKE ${`%${term}%`}
            ${caseNumberCondition}
          )
        ORDER BY c."updatedAt" DESC
        LIMIT 20
      `);

  const [contacts, leads, vehicles, jobCards, quotes, products, documents, cases] = await Promise.all([
    contactIds !== null && contactIds.length === 0
      ? Promise.resolve([])
      : prisma.contact.findMany({
          where: {
            ...scoped(contactIds),
            OR: [
              { firstName: contains }, { lastName: contains }, { company: contains }, { email: contains },
              { phone: contains }, { city: contains },
            ],
          },
          take: 20,
        }),
    leadIds !== null && leadIds.length === 0
      ? Promise.resolve([])
      : prisma.lead.findMany({
          where: {
            ...scoped(leadIds),
            OR: [{ title: contains }, { name: contains }, { email: contains }, { phone: contains }],
          },
          include: { stage: true },
          take: 20,
        }),
    vehicleIds !== null && vehicleIds.length === 0
      ? Promise.resolve([])
      : prisma.vehicle.findMany({
          where: { ...scoped(vehicleIds), OR: [{ model: contains }, { vin: contains }, { regNumber: contains }] },
          include: { contact: true },
          take: 20,
        }),
    jobCardIds !== null && jobCardIds.length === 0
      ? Promise.resolve([])
      : prisma.jobCard.findMany({
          where: {
            ...scoped(jobCardIds),
            OR: [{ description: contains }, ...(isNaN(asNumber) ? [] : [{ number: asNumber }])],
          },
          include: { vehicle: true, contact: true },
          take: 20,
        }),
    quoteIds !== null && quoteIds.length === 0
      ? Promise.resolve([])
      : prisma.quote.findMany({
          where: {
            ...scoped(quoteIds),
            OR: [
              ...(isNaN(asNumber) ? [] : [{ number: asNumber }]),
              { contact: { firstName: contains } },
              { contact: { lastName: contains } },
              { lead: { title: contains } },
            ],
          },
          include: { contact: true, lead: true },
          take: 20,
        }),
    canProducts ? prisma.product.findMany({ where: { OR: [{ name: contains }, { sku: contains }] }, take: 10 }) : Promise.resolve([]),
    documentIds !== null && documentIds.length === 0
      ? Promise.resolve([])
      : prisma.document.findMany({
          where: { ...scoped(documentIds), fileName: contains, deletedAt: null },
          include: { contact: true, vehicle: true },
          orderBy: { createdAt: "desc" },
          take: 20,
        }),
    casesPromise,
  ]);

  const total = contacts.length + leads.length + vehicles.length + jobCards.length + quotes.length +
    products.length + documents.length + cases.length;
  const Section = ({ title, children, count }: { title: string; count: number; children: React.ReactNode }) =>
    count === 0 ? null : (
      <div className="card">
        <h2 className="font-semibold mb-3">{title} <span className="text-slate-500 font-normal">({count})</span></h2>
        <ul className="divide-y divide-slate-800">{children}</ul>
      </div>
    );

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold tracking-[-0.035em]">
        Results for “{term}” <span className="text-slate-500 text-base font-normal">({total})</span>
      </h1>
      {total === 0 && <div className="card text-center py-10"><p className="text-slate-400">Nothing accessible matched that search.</p></div>}

      <Section title="Contacts" count={contacts.length}>
        {contacts.map((item) => <li key={item.id} className="py-2"><Link href={`/contacts/${item.id}`} className="text-orange-400 hover:underline font-medium">{contactName(item)}</Link><span className="text-xs text-slate-400 ml-2">{[item.email, item.phone, item.city].filter(Boolean).join(" · ")}</span></li>)}
      </Section>
      <Section title="Leads" count={leads.length}>
        {leads.map((item) => <li key={item.id} className="py-2"><Link href={`/leads/${item.id}`} className="text-orange-400 hover:underline font-medium">{item.title}</Link><span className="text-xs text-slate-400 ml-2">{item.name} · {item.status === "open" ? item.stage.name : item.status} · {formatZAR(item.valueCents)}</span></li>)}
      </Section>
      <Section title="Vehicles" count={vehicles.length}>
        {vehicles.map((item) => <li key={item.id} className="py-2"><Link href={`/vehicles/${item.id}`} className="text-orange-400 hover:underline font-medium">{item.model}</Link><span className="text-xs text-slate-400 ml-2">{[item.vin, contactName(item.contact)].filter(Boolean).join(" · ")}</span></li>)}
      </Section>
      <Section title="Job cards" count={jobCards.length}>
        {jobCards.map((item) => <li key={item.id} className="py-2"><Link href={`/jobcards/${item.id}`} className="text-orange-400 hover:underline font-medium">#{item.number}</Link><span className="text-xs text-slate-400 ml-2">{item.vehicle.model} · {contactName(item.contact)} · {item.description.slice(0, 60)}</span></li>)}
      </Section>
      <Section title="Quotes" count={quotes.length}>
        {quotes.map((item) => <li key={item.id} className="py-2"><Link href={`/quotes/${item.id}`} className="text-orange-400 hover:underline font-medium">Q-{item.number}</Link><span className="text-xs text-slate-400 ml-2">{item.contact ? contactName(item.contact) : item.lead?.name} · {item.status}</span></li>)}
      </Section>
      <Section title="Customer cases" count={cases.length}>
        {cases.map((item) => <li key={item.id} className="py-2"><Link href={`/cases/${item.id}`} className="text-orange-400 hover:underline font-medium">C-{item.number.toString()} · {item.subject}</Link><span className="text-xs text-slate-400 ml-2">{item.contactName} · {item.status.replaceAll("_", " ")}</span></li>)}
      </Section>
      <Section title="Documents" count={documents.length}>
        {documents.map((item) => <li key={item.id} className="py-2"><a href={`/api/files/${item.id}`} target="_blank" rel="noreferrer" className="text-orange-400 hover:underline font-medium">{item.fileName}</a><span className="text-xs text-slate-400 ml-2">{item.contact ? contactName(item.contact) : item.vehicle?.model ?? "Unfiled"}</span></li>)}
      </Section>
      <Section title="Products" count={products.length}>
        {products.map((item) => <li key={item.id} className="py-2"><Link href={`/products/${item.id}`} className="text-orange-400 hover:underline font-medium">{item.name}</Link><span className="text-xs text-slate-400 ml-2">{formatZAR(item.basePriceCents)}</span></li>)}
      </Section>
    </div>
  );
}
