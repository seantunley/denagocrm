import Link from "next/link";
import { CheckCircle2, CircleDollarSign, FileText, Plus, Search, Send } from "lucide-react";
import { prisma } from "@/lib/db";
import { requireAnyPermission, getAccessibleQuoteIds, hasPermission } from "@/lib/permissions";
import { contactName, formatDate, formatZAR } from "@/lib/format";
import { leadOptionLabels } from "@/lib/leadOption";
import { payableTotalCents } from "@/lib/pricing";
import {
  QUOTE_EDITOR_INCLUDE,
  QUOTE_VERSION_SELECT,
  buildQuoteEditorRecord,
  quoteVersionIndex,
} from "@/lib/quoteEditorRecord";
import { loadBillToFleets, quoteBillTo } from "@/lib/quoteBillTo";
import { getSetting } from "@/lib/settings";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, SectionHeading, StatusPill, Surface, WorkspaceToolbar } from "@/components/visual-system";
import { WorkspaceHero } from "@/components/workspace-hero";
import ConfirmDelete from "@/components/ConfirmDelete";
import { deleteQuote } from "@/app/actions/quotes";
import {
  MobileDataCard,
  MobileDataField,
  MobileDataFields,
  MobileDataHeader,
  MobileDataList,
  ResponsiveDataView,
} from "@/components/responsive-patterns";
import {
  QuoteEditorProvider,
  QuoteEditorTrigger,
  type QuoteEditorRecord,
} from "@/components/quotes/QuoteEditorDialog";
import RecordContextMenu, { type RecordContextAction } from "@/components/RecordContextMenu";
import {
  DesktopOnly,
  MobileOnly,
  MobileSection,
  MobileStatPair,
  MobileTaskCard,
  MobileTaskList,
  MobileWorkspaceHeader,
} from "@/components/mobile-workspace";

function inputDate(daysFromNow: number) {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  return date.toISOString().slice(0, 10);
}

export default async function QuotesPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string; q?: string; status?: string }>;
}) {
  const user = await requireAnyPermission("quotes.view_all", "quotes.view_owned");
  const accessibleQuoteIds = await getAccessibleQuoteIds(user);
  const { edit, q, status } = await searchParams;
  const [quotes, contacts, openLeads, products, allVersions, validDaysRaw, quoteTerms] = await Promise.all([
    prisma.quote.findMany({
      // Only current heads appear in the list. Older revisions remain available
      // from the editor's version history and the full record. RBAC-scoped.
      where: { supersededAt: null, ...(accessibleQuoteIds ? { id: { in: accessibleQuoteIds } } : {}) },
      orderBy: { createdAt: "desc" },
      include: QUOTE_EDITOR_INCLUDE,
      take: 200,
    }),
    prisma.contact.findMany({ orderBy: { firstName: "asc" }, take: 500 }),
    // Open leads offered as an optional link when starting a fresh quote.
    prisma.lead.findMany({
      where: { status: "open" },
      orderBy: { createdAt: "desc" },
      select: { id: true, title: true, name: true, contactId: true },
      take: 500,
    }),
    prisma.product.findMany({
      where: { active: true },
      include: { colors: { orderBy: { name: "asc" } } },
      orderBy: { name: "asc" },
    }),
    prisma.quote.findMany({
      orderBy: { createdAt: "asc" },
      select: QUOTE_VERSION_SELECT,
      take: 2_000,
    }),
    getSetting("QUOTE_VALID_DAYS"),
    getSetting("QUOTE_TERMS"),
  ]);

  // Shared with quoteEditorRecord(), the action that loads ONE quote for the
  // editor — a revision, or a deep link to a quote older than this list's cap.
  const versionIndex = quoteVersionIndex(allVersions);
  // One batched, tenant-scoped lookup for the whole page — 200 rows would
  // otherwise be 200 round trips to print at most a handful of account names.
  const fleetsById = await loadBillToFleets(prisma, quotes.map((quote) => quote.fleetId));
  const fleetNames = new Map([...fleetsById].map(([id, fleet]) => [id, fleet.name]));
  const records: QuoteEditorRecord[] = quotes.map((quote) =>
    buildQuoteEditorRecord(quote, versionIndex, fleetNames),
  );

  // Every quote here is already RBAC-scoped by getAccessibleQuoteIds, so the
  // per-quote half of deleteQuote()'s check is satisfied by the query and only
  // the permission is left to ask — once, not per row.
  const canDelete = await hasPermission(user, "quotes.delete");

  const validDays = Number.parseInt(validDaysRaw ?? "7", 10);
  const defaults = {
    validUntil: inputDate(Number.isFinite(validDays) ? validDays : 7),
    terms: quoteTerms || "Prices include VAT. Delivery arranged on acceptance. E&OE.",
  };
  const contactOptions = contacts.map((contact) => ({ id: contact.id, label: contactName(contact) }));
  // `lead.title` is the MODEL someone wants, and a dealership sells the same few
  // models repeatedly — so preferring it made every option in the picker read
  // the same. leadOptionLabel leads with the customer and appends a short id,
  // which is the only thing that separates two open leads for the same customer
  // and the same model.
  // Labelled as a LIST, not one at a time: the reference only guarantees
  // uniqueness if it is chosen against the other options on offer.
  const leadOptions = leadOptionLabels(openLeads).map((lead) => ({
    id: lead.id,
    label: lead.label,
    contactId: lead.contactId,
  }));
  const productOptions = products.map((product) => ({
    id: product.id,
    name: product.name,
    basePriceCents: product.basePriceCents,
    colors: product.colors.map((colour) => colour.name),
  }));
  const needle = q?.trim().toLowerCase() ?? "";
  const visibleQuotes = quotes.filter((quote) => {
    const matchesStatus = !status || quote.status === status;
    // The SAME resolver the row renders with, not a second copy of the rule.
    // Deciding the addressee here independently meant a fleet quote could not be
    // found by the fleet's name — the row showed "Acme Logistics" and the search
    // only ever matched the manager whose contact record is attached to it.
    const customer = quoteBillTo(quote, fleetsById.get(quote.fleetId ?? "") ?? null).name;
    const matchesSearch = !needle || [
      `q-${quote.number}`,
      customer,
      quote.lead?.title ?? "",
    ].some((value) => value.toLowerCase().includes(needle));
    return matchesStatus && matchesSearch;
  });
  const draftCount = quotes.filter((quote) => quote.status === "draft").length;
  const sentCount = quotes.filter((quote) => quote.status === "sent").length;
  const acceptedCount = quotes.filter((quote) => quote.status === "accepted").length;
  const pipelineValue = quotes
    .filter((quote) => quote.status !== "declined")
    .reduce((total, quote) => total + payableTotalCents(quote), 0);
  const filtersActive = Boolean(needle || status);

  return (
    <QuoteEditorProvider
      contacts={contactOptions}
      leads={leadOptions}
      products={productOptions}
      defaults={defaults}
      records={records}
      // Passed straight through, NOT filtered against `records`. That check made
      // sense while a missing record was indistinguishable from "new quote", and
      // became the hole this whole redirect was meant to close: `records` holds
      // the newest 200 current heads, so an older quote, a superseded revision,
      // and every bookmark or already-delivered notification pointing at one
      // landed silently on the list. The provider fetches whatever it is given
      // through quoteEditorRecord(), which enforces its own access and reports a
      // quote that isn't there.
      initialQuoteId={edit}
    >
      <MobileOnly className="space-y-4">
        <MobileWorkspaceHeader
          title="Quotes"
          description="Create a proposal or check the latest customer decisions."
          action={
            <QuoteEditorTrigger className={buttonVariants({ size: "sm" })}>
              <Plus className="size-4" /> New
            </QuoteEditorTrigger>
          }
        />
        <MobileStatPair items={[
          { label: "Current", value: quotes.length },
          { label: "Awaiting decision", value: quotes.filter((quote) => quote.status === "sent").length },
        ]} />
        <MobileSection title="Recent quotes" detail="Tap to review">
          {quotes.length === 0 ? (
            <EmptyState icon={FileText} title="No quotes yet" description="Create the first customer proposal." />
          ) : (
            <MobileTaskList>
              {quotes.map((quote) => (
                <MobileTaskCard
                  key={quote.id}
                  icon={FileText}
                  title={`Quote Q-${quote.number}`}
                  detail={quoteBillTo(quote, fleetsById.get(quote.fleetId ?? "") ?? null).name || "Unlinked quote"}
                  meta={`${formatZAR(Math.round(payableTotalCents(quote)))} · valid ${formatDate(quote.validUntil)}`}
                  aside={<StatusPill tone={quote.status === "accepted" ? "success" : quote.status === "declined" ? "danger" : quote.status === "sent" ? "info" : "neutral"}>{quote.status}</StatusPill>}
                  href={`/quotes?edit=${quote.id}`}
                />
              ))}
            </MobileTaskList>
          )}
        </MobileSection>
      </MobileOnly>
      <DesktopOnly>
      <div className="space-y-5">
        <WorkspaceHero
          icon={FileText}
          eyebrow="Commercial pipeline"
          title="Quotes"
          description="Build accurate proposals, track customer decisions and keep the value of every live opportunity visible."
          stats={[
            { label: "Draft", value: draftCount, detail: "Proposals being prepared", icon: FileText, tone: "primary" },
            { label: "Sent", value: sentCount, detail: "With customers for review", icon: Send, tone: sentCount > 0 ? "warning" : "default" },
            { label: "Accepted", value: acceptedCount, detail: "Current accepted quotes", icon: CheckCircle2, tone: "success" },
            { label: "Open value", value: formatZAR(Math.round(pipelineValue)), detail: `${quotes.length} current quote${quotes.length === 1 ? "" : "s"}`, icon: CircleDollarSign },
          ]}
          actions={
          <QuoteEditorTrigger className={buttonVariants({ size: "sm" })}>
            <Plus className="size-4" />
            New quote
          </QuoteEditorTrigger>
          }
        />

        <WorkspaceToolbar>
          <form action="/quotes" role="search" className="flex flex-col gap-2 lg:flex-row lg:items-center">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input name="q" defaultValue={q ?? ""} placeholder="Search quote, customer or lead" className="h-10 rounded-xl bg-background/50 pl-9" />
            </div>
            <select name="status" defaultValue={status ?? ""} className="input h-10 rounded-xl bg-background/50 lg:w-44">
              <option value="">All statuses</option>
              <option value="draft">Draft</option>
              <option value="sent">Sent</option>
              <option value="accepted">Accepted</option>
              <option value="declined">Declined</option>
            </select>
            <Button variant="secondary" type="submit">Filter</Button>
            {filtersActive && <Link href="/quotes" className={buttonVariants({ variant: "ghost" })}>Clear</Link>}
          </form>
        </WorkspaceToolbar>

        {visibleQuotes.length === 0 ? (
          <EmptyState
            icon={filtersActive ? Search : FileText}
            title={filtersActive ? "No matching quotes" : "No quotes yet"}
            description={filtersActive ? "Try a broader search, another status, or clear the current filters." : "Build the first customer proposal without leaving this page."}
            action={
              filtersActive
                ? <Link href="/quotes" className={buttonVariants({ variant: "outline", size: "sm" })}>Clear filters</Link>
                : <QuoteEditorTrigger className={buttonVariants({ size: "sm" })}><Plus className="size-4" />Create quote</QuoteEditorTrigger>
            }
          />
        ) : (
          <ResponsiveDataView
            mobile={
              <MobileDataList>
                {visibleQuotes.map((quote) => {
                  const total = payableTotalCents(quote);
                  return (
                    <RecordContextMenu
                      key={quote.id}
                      label={`Quote Q-${quote.number}`}
                      href={`/quotes/${quote.id}`}
                      actions={quoteContextActions(quote.id)}
                    >
                    <MobileDataCard>
                      <MobileDataHeader
                        title={
                          <QuoteEditorTrigger quoteId={quote.id} className="text-left text-primary hover:underline">
                            Quote Q-{quote.number}
                          </QuoteEditorTrigger>
                        }
                        // The account it is addressed to, resolved the same way
                        // the PDF resolves it, so the list and the document
                        // cannot name two different customers.
                        detail={
                          quoteBillTo(quote, fleetsById.get(quote.fleetId ?? "") ?? null).name ||
                          "Unlinked quote"
                        }
                        aside={
                          <StatusPill tone={quote.status === "accepted" ? "success" : quote.status === "declined" ? "danger" : quote.status === "sent" ? "info" : "neutral"}>
                            {quote.status}
                          </StatusPill>
                        }
                      />
                      <MobileDataFields>
                        <MobileDataField label="Total">{formatZAR(Math.round(total))}</MobileDataField>
                        <MobileDataField label="Valid until">{formatDate(quote.validUntil)}</MobileDataField>
                        <MobileDataField label="Lead">
                          {quote.lead ? <Link href={`/leads/${quote.lead.id}`} className="text-primary hover:underline">{quote.lead.title}</Link> : "—"}
                        </MobileDataField>
                        <MobileDataField label="Created">{formatDate(quote.createdAt)}</MobileDataField>
                      </MobileDataFields>
                      <div className="mt-2 flex justify-end">
                        <ConfirmDelete action={deleteQuote.bind(null, quote.id)} title={`Delete quote Q-${quote.number}?`} description="Moves the quote to Trash (restorable for 60 days)." trigger="Delete quote" triggerClass="text-xs text-slate-500 hover:text-red-400" disabled={!canDelete} disabledReason="Your role can't delete quotes." />
                      </div>
                    </MobileDataCard>
                    </RecordContextMenu>
                  );
                })}
              </MobileDataList>
            }
            desktop={
              <Surface>
                <div className="border-b border-border px-5 py-4">
                  <SectionHeading title="Quote register" description={`${visibleQuotes.length} proposal${visibleQuotes.length === 1 ? "" : "s"} match this commercial view.`} />
                </div>
                <div className="overflow-x-auto">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Customer</th>
                      <th>Lead</th>
                      <th>Total</th>
                      <th>Status</th>
                      <th>Valid until</th>
                      <th>Created</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {visibleQuotes.map((quote) => {
                      const total = payableTotalCents(quote);
                      return (
                        <RecordContextMenu
                          key={quote.id}
                          label={`Quote Q-${quote.number}`}
                          href={`/quotes/${quote.id}`}
                          actions={quoteContextActions(quote.id)}
                        >
                        <tr tabIndex={0} className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary">
                          <td>
                            <QuoteEditorTrigger quoteId={quote.id} className="font-medium text-orange-400 hover:underline">
                              Q-{quote.number}
                            </QuoteEditorTrigger>
                          </td>
                          <td>
                            {quote.contact ? <Link href={`/contacts/${quote.contact.id}`} className="text-orange-400 hover:underline">{contactName(quote.contact)}</Link> : quote.lead?.name ?? "—"}
                          </td>
                          <td className="max-w-56 truncate">
                            {quote.lead ? <Link href={`/leads/${quote.lead.id}`} className="text-orange-400 hover:underline">{quote.lead.title}</Link> : "—"}
                          </td>
                          <td className="font-medium">{formatZAR(Math.round(total))}</td>
                          <td>
                            <StatusPill tone={quote.status === "accepted" ? "success" : quote.status === "declined" ? "danger" : quote.status === "sent" ? "info" : "neutral"}>
                              {quote.status}
                            </StatusPill>
                          </td>
                          <td className="text-slate-400">{formatDate(quote.validUntil)}</td>
                          <td className="text-slate-400">{formatDate(quote.createdAt)}{quote.createdBy ? ` · ${quote.createdBy.name}` : ""}</td>
                          <td className="text-right">
                            <ConfirmDelete action={deleteQuote.bind(null, quote.id)} title={`Delete quote Q-${quote.number}?`} description="Moves the quote to Trash (restorable for 60 days)." trigger="Delete" triggerClass="text-xs text-slate-500 hover:text-red-400" disabled={!canDelete} disabledReason="Your role can't delete quotes." />
                          </td>
                        </tr>
                        </RecordContextMenu>
                      );
                    })}
                  </tbody>
                </table>
                </div>
              </Surface>
            }
          />
        )}
      </div>
      </DesktopOnly>
    </QuoteEditorProvider>
  );
}

function quoteContextActions(quoteId: string): RecordContextAction[] {
  return [
    { label: "Open editor", href: `/quotes?edit=${quoteId}`, icon: "edit" },
    { label: "Print / PDF", href: `/quotes/${quoteId}/print`, icon: "print", newTab: true },
  ];
}
