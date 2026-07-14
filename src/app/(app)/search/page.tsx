import Link from "next/link";
import {
  ArrowRight,
  CarFront,
  Compass,
  FileText,
  Package,
  Search,
  SearchX,
  SquareKanban,
  UsersRound,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { contactName, formatZAR } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { EmptyState, Surface } from "@/components/visual-system";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getSearchDestinations, matchSearchDestinations } from "@/lib/search-destinations";

function SearchBar({ term = "" }: { term?: string }) {
  return (
    <Surface inset className="p-3">
      <form className="flex items-center gap-2" role="search">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            name="q"
            defaultValue={term}
            autoFocus={!term}
            className="h-11 rounded-xl bg-background/50 pl-10"
            placeholder="Search pages, settings, customers, vehicles, quotes or job cards"
          />
        </div>
        <Button className="h-11 rounded-xl px-5">Search</Button>
      </form>
    </Surface>
  );
}

function ResultSection({
  title,
  icon: Icon,
  count,
  children,
}: {
  title: string;
  icon: LucideIcon;
  count: number;
  children: React.ReactNode;
}) {
  if (!count) return null;
  return (
    <Surface>
      <div className="flex items-center gap-3 border-b border-border px-5 py-4">
        <span className="grid size-9 place-items-center rounded-xl border border-primary/15 bg-primary/10 text-primary">
          <Icon className="size-[17px]" />
        </span>
        <div>
          <h2 className="font-semibold tracking-tight">{title}</h2>
          <p className="text-xs text-muted-foreground">{count} result{count === 1 ? "" : "s"}</p>
        </div>
      </div>
      <ul className="divide-y divide-border/70">{children}</ul>
    </Surface>
  );
}

function ResultRow({
  href,
  title,
  meta,
  badge,
}: {
  href: string;
  title: string;
  meta: React.ReactNode;
  badge?: React.ReactNode;
}) {
  return (
    <li>
      <Link href={href} className="group flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-white/[0.025]">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground transition-colors group-hover:text-primary">{title}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">{meta}</div>
        </div>
        {badge}
        <ArrowRight className="size-4 shrink-0 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
      </Link>
    </li>
  );
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const currentUser = await requireUser();
  const { q } = await searchParams;
  const term = (q ?? "").trim();

  if (!term) {
    return (
      <div className="space-y-6">
        <PageHeader title="Search everything" description="Find records across the entire workspace from one place." />
        <SearchBar />
        <EmptyState
          icon={Search}
          title="One search, every module"
          description="Try a page or setting such as Library, or search by customer, email, phone, VIN, registration, Q-number or job card."
        />
      </div>
    );
  }

  const contains = { contains: term, mode: "insensitive" as const };
  const asNumber = parseInt(term.replace(/^[qQ]-?/, ""), 10);
  const destinations = matchSearchDestinations(
    term,
    getSearchDestinations({
      modules: currentUser.modules,
      isAdmin: currentUser.role === "owner",
    }),
  );

  const [contacts, leads, vehicles, jobCards, quotes, products] = await Promise.all([
    prisma.contact.findMany({
      where: { OR: [{ firstName: contains }, { lastName: contains }, { company: contains }, { email: contains }, { phone: contains }, { city: contains }] },
      take: 20,
    }),
    prisma.lead.findMany({
      where: { OR: [{ title: contains }, { name: contains }, { email: contains }, { phone: contains }] },
      include: { stage: true },
      take: 20,
    }),
    prisma.vehicle.findMany({
      where: { OR: [{ model: contains }, { vin: contains }, { regNumber: contains }] },
      include: { contact: true },
      take: 20,
    }),
    prisma.jobCard.findMany({
      where: { OR: [{ description: contains }, ...(isNaN(asNumber) ? [] : [{ number: asNumber }])] },
      include: { vehicle: true, contact: true },
      take: 20,
    }),
    prisma.quote.findMany({
      where: isNaN(asNumber) ? { id: "none" } : { number: asNumber },
      include: { contact: true, lead: true },
      take: 10,
    }),
    prisma.product.findMany({ where: { name: contains }, take: 10 }),
  ]);

  const total = destinations.length + contacts.length + leads.length + vehicles.length + jobCards.length + quotes.length + products.length;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Results for “${term}”`}
        description={total ? `${total} result${total === 1 ? "" : "s"} across your workspace.` : "No matching records were found."}
      />
      <SearchBar term={term} />

      {!total && (
        <EmptyState
          icon={SearchX}
          title="Nothing matched this search"
          description="Check the spelling or try a page, setting, broader name, phone number, VIN, registration, Q-number or job-card number."
          action={<Button asChild variant="outline" size="sm"><Link href="/search">Clear search</Link></Button>}
        />
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <ResultSection title="Pages & settings" icon={Compass} count={destinations.length}>
          {destinations.map((item) => (
            <ResultRow
              key={item.href}
              href={item.href}
              title={item.label}
              meta={item.group}
              badge={<span className="rounded-md border border-border bg-background/50 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Page</span>}
            />
          ))}
        </ResultSection>

        <ResultSection title="Customers" icon={UsersRound} count={contacts.length}>
          {contacts.map((item) => <ResultRow key={item.id} href={`/contacts/${item.id}`} title={contactName(item)} meta={[item.email, item.phone, item.city].filter(Boolean).join(" · ") || "No contact details"} />)}
        </ResultSection>

        <ResultSection title="Leads" icon={SquareKanban} count={leads.length}>
          {leads.map((item) => <ResultRow key={item.id} href={`/leads/${item.id}`} title={item.title} meta={<><span>{item.name}</span><span>·</span><span>{item.status === "open" ? item.stage.name : item.status}</span></>} badge={<span className="text-xs font-semibold tabular-nums text-emerald-400">{formatZAR(item.valueCents)}</span>} />)}
        </ResultSection>

        <ResultSection title="Vehicles" icon={CarFront} count={vehicles.length}>
          {vehicles.map((item) => <ResultRow key={item.id} href={`/vehicles/${item.id}`} title={item.model} meta={[item.regNumber, item.vin, contactName(item.contact)].filter(Boolean).join(" · ")} />)}
        </ResultSection>

        <ResultSection title="Job cards" icon={Wrench} count={jobCards.length}>
          {jobCards.map((item) => <ResultRow key={item.id} href={`/jobcards/${item.id}`} title={`Job card #${item.number}`} meta={`${item.vehicle.model} · ${contactName(item.contact)} · ${item.description.slice(0, 60)}`} />)}
        </ResultSection>

        <ResultSection title="Quotes" icon={FileText} count={quotes.length}>
          {quotes.map((item) => <ResultRow key={item.id} href={`/quotes/${item.id}`} title={`Quote Q-${item.number}`} meta={`${item.contact ? contactName(item.contact) : item.lead?.name ?? "Unlinked"} · ${item.status}`} />)}
        </ResultSection>

        <ResultSection title="Products" icon={Package} count={products.length}>
          {products.map((item) => <ResultRow key={item.id} href={`/products/${item.id}`} title={item.name} meta="Product catalogue" badge={<span className="text-xs font-semibold tabular-nums text-foreground">{formatZAR(item.basePriceCents)}</span>} />)}
        </ResultSection>
      </div>
    </div>
  );
}
