import Link from "next/link";
import {
  ArrowRight,
  Building2,
  CarFront,
  Grid2X2,
  List,
  Mail,
  Merge,
  Phone,
  Plus,
  Search,
  UserRound,
  UsersRound,
} from "lucide-react";
import { createContact } from "@/app/actions/contacts";
import ContactForm from "@/components/ContactForm";
import ModalTrigger from "@/components/Modal";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { prisma } from "@/lib/db";
import { contactName, formatDate } from "@/lib/format";
import {
  getAccessibleContactIds,
  hasPermission,
  requireAnyPermission,
} from "@/lib/permissions";
import { cn } from "@/lib/utils";

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((word) => word[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; view?: string }>;
}) {
  const user = await requireAnyPermission("contacts.view_all", "contacts.view_owned");
  const { q, view } = await searchParams;
  const cards = view !== "list";
  const [accessibleIds, canCreate, canMerge] = await Promise.all([
    getAccessibleContactIds(user),
    hasPermission(user, "contacts.create"),
    hasPermission(user, "contacts.merge"),
  ]);
  const searchWhere = q
    ? {
        OR: [
          { firstName: { contains: q, mode: "insensitive" as const } },
          { lastName: { contains: q, mode: "insensitive" as const } },
          { company: { contains: q, mode: "insensitive" as const } },
          { email: { contains: q, mode: "insensitive" as const } },
          { phone: { contains: q, mode: "insensitive" as const } },
        ],
      }
    : {};
  const where = {
    AND: [
      ...(accessibleIds === null ? [] : [{ id: { in: accessibleIds } }]),
      searchWhere,
    ],
  };

  const [contacts, users] = await Promise.all([
    prisma.contact.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        tags: true,
        owner: true,
        _count: {
          select: {
            vehicles: { where: { deletedAt: null } },
            leads: { where: { status: "open", deletedAt: null } },
          },
        },
      },
      take: 200,
    }),
    canCreate ? prisma.user.findMany({ orderBy: { name: "asc" } }) : Promise.resolve([]),
  ]);

  const vehicleCount = contacts.reduce((total, contact) => total + contact._count.vehicles, 0);
  const leadCount = contacts.reduce((total, contact) => total + contact._count.leads, 0);
  const queryString = (target: string) =>
    `/contacts?${new URLSearchParams({ ...(q ? { q } : {}), view: target })}`;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Customer relationships"
        description={
          q
            ? `${contacts.length} result${contacts.length === 1 ? "" : "s"} for “${q}”`
            : accessibleIds === null
              ? "Your complete view of every customer, company and conversation."
              : "Customers assigned to you or your teams."
        }
      >
        {canMerge && (
          <Link href="/duplicates" className={buttonVariants({ variant: "outline", size: "sm" })}>
            <Merge className="size-4" />
            Duplicates
          </Link>
        )}
        {canCreate && (
          <ModalTrigger
            label={
              <>
                <Plus className="size-4" />
                New contact
              </>
            }
            title="New contact"
            buttonClass={buttonVariants({ size: "sm" })}
          >
            <ContactForm
              action={createContact}
              submitLabel="Create contact"
              users={users.map((item) => ({ id: item.id, name: item.name }))}
            />
          </ModalTrigger>
        )}
      </PageHeader>

      <section className="relative overflow-hidden rounded-2xl border border-white/[0.07] bg-card shadow-sm">
        <div className="pointer-events-none absolute -left-24 -top-28 size-72 rounded-full bg-orange-500/[0.07] blur-3xl" />
        <div className="relative grid divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <SummaryStat icon={UsersRound} value={contacts.length} label={q ? "Matching contacts" : "Contacts shown"} />
          <SummaryStat icon={CarFront} value={vehicleCount} label="Linked vehicles" />
          <SummaryStat icon={ArrowRight} value={leadCount} label="Open opportunities" accent={leadCount > 0} />
        </div>
      </section>

      <section className="flex flex-col gap-3 rounded-2xl border border-border bg-card/70 p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <form className="flex min-w-0 flex-1 items-center gap-2" role="search">
          {!cards && <input type="hidden" name="view" value="list" />}
          <div className="relative w-full max-w-xl">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              name="q"
              className="h-10 rounded-xl bg-background/50 pl-9 pr-20"
              placeholder="Search name, company, email or phone"
              defaultValue={q ?? ""}
            />
            {q && (
              <Link href={cards ? "/contacts" : "/contacts?view=list"} className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground">
                Clear
              </Link>
            )}
          </div>
          <button className={buttonVariants({ variant: "secondary", size: "default" })}>Search</button>
        </form>

        <div className="flex rounded-lg border border-border bg-background/50 p-1" aria-label="Contact view">
          <ViewToggle href={queryString("cards")} active={cards} icon={Grid2X2}>Cards</ViewToggle>
          <ViewToggle href={queryString("list")} active={!cards} icon={List}>List</ViewToggle>
        </div>
      </section>

      {contacts.length === 0 ? (
        <EmptyState query={q} />
      ) : cards ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {contacts.map((contact) => (
            <ContactCard key={contact.id} contact={contact} />
          ))}
        </div>
      ) : (
        <ContactTable contacts={contacts} />
      )}
    </div>
  );
}

function SummaryStat({ icon: Icon, value, label, accent = false }: { icon: typeof UsersRound; value: number; label: string; accent?: boolean }) {
  return (
    <div className="flex items-center gap-3 px-5 py-4">
      <span className={cn("flex size-9 items-center justify-center rounded-xl border", accent ? "border-orange-400/20 bg-orange-400/10 text-orange-400" : "border-white/[0.06] bg-white/[0.035] text-muted-foreground")}>
        <Icon className="size-[18px]" />
      </span>
      <div>
        <p className="text-xl font-semibold tabular-nums tracking-tight text-foreground">{value}</p>
        <p className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}

function ViewToggle({ href, active, icon: Icon, children }: { href: string; active: boolean; icon: typeof List; children: React.ReactNode }) {
  return (
    <Link href={href} aria-current={active ? "page" : undefined} className={cn("flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition", active ? "bg-accent text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
      <Icon className="size-3.5" />
      {children}
    </Link>
  );
}

type ContactWithRelations = Awaited<ReturnType<typeof prisma.contact.findMany<{
  include: { tags: true; owner: true; _count: { select: { vehicles: true; leads: true } } };
}>>>[number];

function ContactCard({ contact }: { contact: ContactWithRelations }) {
  const name = contactName(contact);
  const context = contact.isCompany ? "Company account" : contact.company || contact.city || "Individual customer";
  return (
    <Link href={`/contacts/${contact.id}`} className="group relative flex min-h-56 flex-col overflow-hidden rounded-2xl border border-border bg-card p-5 shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-orange-500/35 hover:shadow-xl hover:shadow-black/15 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-orange-500/15">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
      <div className="flex items-start gap-3.5">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl border border-orange-400/15 bg-gradient-to-br from-orange-400/15 to-orange-600/5 text-sm font-semibold text-orange-300 shadow-inner">
          {contact.isCompany ? <Building2 className="size-5" /> : initials(name)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold tracking-tight text-foreground transition-colors group-hover:text-orange-300">{name}</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{context}</p>
        </div>
        <ArrowRight className="size-4 -translate-x-1 text-muted-foreground/40 opacity-0 transition-all group-hover:translate-x-0 group-hover:text-orange-400 group-hover:opacity-100" />
      </div>

      <div className="mt-4 flex min-h-6 flex-wrap gap-1.5">
        {contact.tags.slice(0, 3).map((tag) => (
          <Badge key={tag.id} variant="outline" className="border-white/8 bg-white/[0.035] text-[10px] text-muted-foreground">
            <span className="size-1.5 rounded-full" style={{ backgroundColor: tag.color }} />
            {tag.name}
          </Badge>
        ))}
        {contact.tags.length > 3 && <Badge variant="ghost" className="text-[10px] text-muted-foreground">+{contact.tags.length - 3}</Badge>}
      </div>

      <div className="mt-auto grid grid-cols-2 gap-2 pt-5">
        <MiniMetric icon={CarFront} value={contact._count.vehicles} label="Vehicles" />
        <MiniMetric icon={ArrowRight} value={contact._count.leads} label="Open leads" active={contact._count.leads > 0} />
      </div>

      <div className="mt-4 flex items-center gap-3 border-t border-border/70 pt-3 text-[11px] text-muted-foreground">
        {contact.email ? <span className="flex min-w-0 items-center gap-1.5"><Mail className="size-3 shrink-0" /><span className="truncate">{contact.email}</span></span> : contact.phone ? <span className="flex items-center gap-1.5"><Phone className="size-3" />{contact.phone}</span> : <span className="flex items-center gap-1.5"><UserRound className="size-3" />No contact details</span>}
        {contact.owner && <span className="ml-auto shrink-0">{contact.owner.name.split(" ")[0]}</span>}
      </div>
    </Link>
  );
}

function MiniMetric({ icon: Icon, value, label, active = false }: { icon: typeof CarFront; value: number; label: string; active?: boolean }) {
  return <div className="rounded-xl border border-border/70 bg-background/35 px-3 py-2"><div className="flex items-center gap-1.5"><Icon className={cn("size-3.5", active ? "text-orange-400" : "text-muted-foreground")} /><span className="text-sm font-semibold tabular-nums">{value}</span></div><p className="mt-0.5 text-[10px] text-muted-foreground">{label}</p></div>;
}

function ContactTable({ contacts }: { contacts: ContactWithRelations[] }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/25 text-left text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            <tr><th className="px-5 py-3">Customer</th><th className="px-4 py-3">Contact</th><th className="px-4 py-3">Relationship</th><th className="px-4 py-3 text-center">Vehicles</th><th className="px-4 py-3 text-center">Leads</th><th className="px-4 py-3">Added</th><th className="w-10" /></tr>
          </thead>
          <tbody className="divide-y divide-border/70">
            {contacts.map((contact) => {
              const name = contactName(contact);
              return (
                <tr key={contact.id} className="group transition-colors hover:bg-white/[0.025]">
                  <td className="px-5 py-3.5"><Link href={`/contacts/${contact.id}`} className="flex items-center gap-3"><span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-orange-500/10 text-[10px] font-semibold text-orange-300">{contact.isCompany ? <Building2 className="size-4" /> : initials(name)}</span><span><span className="block font-medium text-foreground group-hover:text-orange-300">{name}</span><span className="block text-xs text-muted-foreground">{contact.company || contact.city || (contact.isCompany ? "Company" : "Customer")}</span></span></Link></td>
                  <td className="px-4 py-3.5"><p className="max-w-60 truncate text-xs text-foreground/85">{contact.email || contact.phone || "No details"}</p>{contact.email && contact.phone && <p className="mt-0.5 text-[11px] text-muted-foreground">{contact.phone}</p>}</td>
                  <td className="px-4 py-3.5"><div className="flex flex-wrap gap-1">{contact.tags.slice(0, 2).map((tag) => <Badge key={tag.id} variant="outline" className="text-[10px] text-muted-foreground"><span className="size-1.5 rounded-full" style={{ backgroundColor: tag.color }} />{tag.name}</Badge>)}{contact.owner && <span className="text-[11px] text-muted-foreground">{contact.tags.length ? "· " : ""}{contact.owner.name}</span>}</div></td>
                  <td className="px-4 py-3.5 text-center font-medium tabular-nums">{contact._count.vehicles}</td>
                  <td className="px-4 py-3.5 text-center"><span className={cn("inline-flex min-w-6 justify-center rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums", contact._count.leads ? "bg-orange-400/10 text-orange-300" : "text-muted-foreground")}>{contact._count.leads}</span></td>
                  <td className="whitespace-nowrap px-4 py-3.5 text-xs text-muted-foreground">{formatDate(contact.createdAt)}</td>
                  <td className="pr-4"><Link href={`/contacts/${contact.id}`} aria-label={`Open ${name}`} className="flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition hover:bg-accent hover:text-foreground group-hover:opacity-100 focus:opacity-100"><ArrowRight className="size-3.5" /></Link></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EmptyState({ query }: { query?: string }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-dashed border-border bg-card/50 px-6 py-16 text-center">
      <div className="mx-auto flex size-12 items-center justify-center rounded-2xl border border-white/[0.06] bg-white/[0.035] text-muted-foreground"><UsersRound className="size-5" /></div>
      <h2 className="mt-4 font-semibold text-foreground">{query ? "No matching contacts" : "Build your customer network"}</h2>
      <p className="mx-auto mt-1 max-w-sm text-sm leading-6 text-muted-foreground">{query ? `Nothing matched “${query}”. Try a name, email address, company or phone number.` : "Add your first customer to connect their leads, vehicles, quotes and service history."}</p>
      {query && <Link href="/contacts" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-5")}>Clear search</Link>}
    </div>
  );
}
