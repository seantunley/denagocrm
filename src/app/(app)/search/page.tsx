import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { contactName, formatZAR } from "@/lib/format";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requireUser();
  const { q } = await searchParams;
  const term = (q ?? "").trim();

  if (!term) {
    return (
      <div className="space-y-5">
        <h1 className="text-2xl font-semibold tracking-[-0.035em]">Search</h1>
        <p className="text-sm text-slate-400">
          Type in the search box in the sidebar — contacts, leads, quotes, vehicles and job
          cards are all searched at once.
        </p>
      </div>
    );
  }

  const c = { contains: term, mode: "insensitive" as const };
  const asNumber = parseInt(term.replace(/^[qQ]-?/, ""), 10);

  const [contacts, leads, vehicles, jobCards, quotes, products] = await Promise.all([
    prisma.contact.findMany({
      where: {
        OR: [
          { firstName: c }, { lastName: c }, { company: c }, { email: c },
          { phone: c }, { city: c },
        ],
      },
      take: 20,
    }),
    prisma.lead.findMany({
      where: { OR: [{ title: c }, { name: c }, { email: c }, { phone: c }] },
      include: { stage: true },
      take: 20,
    }),
    prisma.vehicle.findMany({
      where: { OR: [{ model: c }, { vin: c }, { regNumber: c }] },
      include: { contact: true },
      take: 20,
    }),
    prisma.jobCard.findMany({
      where: {
        OR: [
          { description: c },
          ...(isNaN(asNumber) ? [] : [{ number: asNumber }]),
        ],
      },
      include: { vehicle: true, contact: true },
      take: 20,
    }),
    prisma.quote.findMany({
      where: isNaN(asNumber) ? { id: "none" } : { number: asNumber },
      include: { contact: true, lead: true },
      take: 10,
    }),
    prisma.product.findMany({ where: { name: c }, take: 10 }),
  ]);

  const total =
    contacts.length + leads.length + vehicles.length + jobCards.length + quotes.length + products.length;

  const Section = ({ title, children, count }: { title: string; count: number; children: React.ReactNode }) =>
    count === 0 ? null : (
      <div className="card">
        <h2 className="font-semibold mb-3">
          {title} <span className="text-slate-500 font-normal">({count})</span>
        </h2>
        <ul className="divide-y divide-slate-800">{children}</ul>
      </div>
    );

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold tracking-[-0.035em]">
        Results for “{term}” <span className="text-slate-500 text-base font-normal">({total})</span>
      </h1>
      {total === 0 && (
        <div className="card text-center py-10">
          <p className="text-slate-400">Nothing found. Try a name, phone number, VIN or Q-number.</p>
        </div>
      )}

      <Section title="Contacts" count={contacts.length}>
        {contacts.map((x) => (
          <li key={x.id} className="py-2">
            <Link href={`/contacts/${x.id}`} className="text-orange-400 hover:underline font-medium">
              {contactName(x)}
            </Link>
            <span className="text-xs text-slate-400 ml-2">
              {[x.email, x.phone, x.city].filter(Boolean).join(" · ")}
            </span>
          </li>
        ))}
      </Section>

      <Section title="Leads" count={leads.length}>
        {leads.map((x) => (
          <li key={x.id} className="py-2">
            <Link href={`/leads/${x.id}`} className="text-orange-400 hover:underline font-medium">
              {x.title}
            </Link>
            <span className="text-xs text-slate-400 ml-2">
              {x.name} · {x.status === "open" ? x.stage.name : x.status} · {formatZAR(x.valueCents)}
            </span>
          </li>
        ))}
      </Section>

      <Section title="Vehicles" count={vehicles.length}>
        {vehicles.map((x) => (
          <li key={x.id} className="py-2">
            <Link href={`/vehicles/${x.id}`} className="text-orange-400 hover:underline font-medium">
              {x.model}
            </Link>
            <span className="text-xs text-slate-400 ml-2">
              {[x.vin, contactName(x.contact)].filter(Boolean).join(" · ")}
            </span>
          </li>
        ))}
      </Section>

      <Section title="Job cards" count={jobCards.length}>
        {jobCards.map((x) => (
          <li key={x.id} className="py-2">
            <Link href={`/jobcards/${x.id}`} className="text-orange-400 hover:underline font-medium">
              #{x.number}
            </Link>
            <span className="text-xs text-slate-400 ml-2">
              {x.vehicle.model} · {contactName(x.contact)} · {x.description.slice(0, 60)}
            </span>
          </li>
        ))}
      </Section>

      <Section title="Quotes" count={quotes.length}>
        {quotes.map((x) => (
          <li key={x.id} className="py-2">
            <Link href={`/quotes/${x.id}`} className="text-orange-400 hover:underline font-medium">
              Q-{x.number}
            </Link>
            <span className="text-xs text-slate-400 ml-2">
              {x.contact ? contactName(x.contact) : x.lead?.name} · {x.status}
            </span>
          </li>
        ))}
      </Section>

      <Section title="Products" count={products.length}>
        {products.map((x) => (
          <li key={x.id} className="py-2">
            <Link href={`/products/${x.id}`} className="text-orange-400 hover:underline font-medium">
              {x.name}
            </Link>
            <span className="text-xs text-slate-400 ml-2">{formatZAR(x.basePriceCents)}</span>
          </li>
        ))}
      </Section>
    </div>
  );
}
