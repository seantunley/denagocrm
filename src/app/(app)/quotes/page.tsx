import Link from "next/link";
import { CheckCircle2, CircleDollarSign, Download, FileText, Plus, Search, Send } from "lucide-react";
import { prisma } from "@/lib/db";
import {
  requireAnyPermission,
  getAccessibleLeadIds,
  hasPermission,
} from "@/lib/permissions";
import { pageHref, pageWindow, parsePage } from "@/lib/listPaging";
import { quoteListFilter } from "@/lib/quoteListQuery";
import ListPager from "@/components/ListPager";
import { contactName, formatDate, formatZAR } from "@/lib/format";
import { leadOptionLabels } from "@/lib/leadOption";
import { payableTotalCents } from "@/lib/pricing";
import {
  QUOTE_EDITOR_INCLUDE,
  buildQuoteEditorRecord,
  loadQuoteVersions,
  quoteVersionIndex,
} from "@/lib/quoteEditorRecord";
import { loadBillToFleets, quoteBillTo } from "@/lib/quoteBillTo";
import { editorDefaults, quoteFromLeadDefaults } from "@/lib/quoteFromLead";
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
import QuoteRowActions from "@/components/quotes/QuoteRowActions";
import { quotePrintLinks } from "@/lib/quotePrintLinks";
import {
  DesktopOnly,
  MobileOnly,
  MobileSection,
  MobileStatPair,
  MobileTaskCard,
  MobileTaskList,
  MobileWorkspaceHeader,
} from "@/components/mobile-workspace";

// "Email quote" (in the editor on this page) renders the PDF in headless Chrome
// and sends it — the same budget the PDF routes get.
export const maxDuration = 60;

export default async function QuotesPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string; q?: string; status?: string; page?: string }>;
}) {
  const user = await requireAnyPermission("quotes.view_all", "quotes.view_owned");
  const params = await searchParams;
  const { edit, q, status } = params;
  // RBAC scope + search + status, as one database filter. The export route
  // builds the same one, so the CSV holds exactly what this list shows.
  const { where, all } = await quoteListFilter(user, { q, status });
  /*
   * THE LEAD PICKER NEEDS LEAD RBAC, NOT QUOTE RBAC.
   *
   * Reaching this page needs quotes.view_all or quotes.view_owned. Neither says
   * anything about which LEADS the viewer may see - that is leads.view_all vs
   * leads.view_owned, with its own owner/creator/team rules - and the open-lead
   * query had no scope at all, so the picker offered every open lead in the
   * tenant to anyone who could open a quote.
   *
   * It mattered less while the option showed `title`, which is the vehicle. The
   * label now leads with the CUSTOMER NAME, which turns a scoping gap into a
   * disclosure of customer names for leads the viewer cannot open. Scoping the
   * query is the fix; a label is not the place to hide a record.
   */
  const accessibleLeadIds = await getAccessibleLeadIds(user);
  // Counted first so an out-of-range ?page= (e.g. after deleting the last row
  // on the last page) clamps to the last real page instead of showing nothing.
  const total = await prisma.quote.count({ where });
  const { page, skip, take } = pageWindow(parsePage(params.page), total);
  const [quotes, statusCounts, openQuotes, contacts, openLeads, products, quoteDefaults] = await Promise.all([
    prisma.quote.findMany({
      where,
      // `id` breaks createdAt ties so a row can't appear on two pages.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: QUOTE_EDITOR_INCLUDE,
      skip,
      take,
    }),
    // Headline figures cover every quote this user may see, not just this page.
    prisma.quote.groupBy({ by: ["status"], where: all, _count: { _all: true } }),
    prisma.quote.findMany({
      where: { AND: [all, { status: { notIn: ["declined", "cancelled"] } }] },
      select: { taxInclusive: true, depositType: true, depositValue: true, items: true, fees: true },
    }),
    prisma.contact.findMany({ orderBy: { firstName: "asc" }, take: 500 }),
    // Open leads offered as an optional link when starting a fresh quote.
    prisma.lead.findMany({
      where: {
        status: "open",
        // null means "may see every lead"; an empty array means none, and
        // `id: { in: [] }` correctly matches nothing.
        ...(accessibleLeadIds ? { id: { in: accessibleLeadIds } } : {}),
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, title: true, name: true, contactId: true },
      take: 500,
    }),
    prisma.product.findMany({
      where: { active: true },
      include: { colors: { orderBy: { name: "asc" } } },
      orderBy: { name: "asc" },
    }),
    quoteFromLeadDefaults(),
  ]);

  // Shared with quoteEditorRecord(), the action that loads ONE quote for the
  // editor — a revision, or a deep link to a quote older than this list's cap.
  // Only the version families of the quotes on THIS page, through the same
  // scoped client — no workspace-wide cap for a newer quote to fall off.
  const versionIndex = quoteVersionIndex(await loadQuoteVersions(prisma, quotes.map((quote) => quote.id)));
  // One batched, tenant-scoped lookup for the whole page — a page of rows would
  // otherwise be a round trip per row to print at most a handful of account names.
  const fleetsById = await loadBillToFleets(prisma, quotes.map((quote) => quote.fleetId));
  const fleetNames = new Map([...fleetsById].map(([id, fleet]) => [id, fleet.name]));
  const records: QuoteEditorRecord[] = quotes.map((quote) =>
    buildQuoteEditorRecord(quote, versionIndex, fleetNames, quoteDefaults.regional),
  );

  // Every quote here is already RBAC-scoped by getAccessibleQuoteIds, so the
  // per-quote half of deleteQuote()'s check is satisfied by the query and only
  // the permission is left to ask — once, not per row.
  const [canDelete, canCancel, canDuplicate] = await Promise.all([
    hasPermission(user, "quotes.delete"),
    hasPermission(user, "quotes.change_status"),
    hasPermission(user, "quotes.create"),
  ]);

  const defaults = editorDefaults(quoteDefaults);
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
  // Search and status are applied by the database (quoteListWhere), across every
  // quote — including a fleet quote found by the fleet's name, which the row
  // shows via quoteBillTo.
  const visibleQuotes = quotes;
  const countOf = (value: string) => statusCounts.find((row) => row.status === value)?._count._all ?? 0;
  const draftCount = countOf("draft");
  const sentCount = countOf("sent");
  const acceptedCount = countOf("accepted");
  const quoteCount = statusCounts.reduce((sum, row) => sum + row._count._all, 0);
  const pipelineValue = openQuotes.reduce((sum, quote) => sum + payableTotalCents(quote), 0);
  const filtersActive = Boolean(q?.trim() || status);
  const exportQuery = new URLSearchParams({ ...(q?.trim() ? { q: q.trim() } : {}), ...(status ? { status } : {}) }).toString();

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
      // one page of current heads, so a quote on another page, a superseded revision,
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
          { label: "Current", value: quoteCount },
          { label: "Awaiting decision", value: sentCount },
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
                  meta={`${formatZAR(Math.round(payableTotalCents(quote)))} · valid ${formatDate(quote.validUntil, quoteDefaults.regional)}`}
                  aside={<StatusPill tone={quote.status === "accepted" ? "success" : quote.status === "declined" ? "danger" : quote.status === "sent" ? "info" : "neutral"}>{quote.status}</StatusPill>}
                  // Keeps the page and filters, so closing the editor lands back where you were.
                  href={pageHref("/quotes", { ...params, edit: quote.id }, page)}
                />
              ))}
            </MobileTaskList>
          )}
          <ListPager path="/quotes" page={page} total={total} />
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
            { label: "Open value", value: formatZAR(Math.round(pipelineValue)), detail: `${quoteCount} current quote${quoteCount === 1 ? "" : "s"}`, icon: CircleDollarSign },
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
              <option value="cancelled">Cancelled</option>
            </select>
            <Button variant="secondary" type="submit">Filter</Button>
            {filtersActive && <Link href="/quotes" className={buttonVariants({ variant: "ghost" })}>Clear</Link>}
            {/* Every matching quote, not just this page. A plain <a>: it is a file download, not a page. */}
            <a href={`/api/export/quotes${exportQuery ? `?${exportQuery}` : ""}`} download className={buttonVariants({ variant: "outline" })}>
              <Download className="size-4" />
              Export CSV
            </a>
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
                      actions={quoteContextActions(quote)}
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
                        <MobileDataField label="Valid until">{formatDate(quote.validUntil, quoteDefaults.regional)}</MobileDataField>
                        <MobileDataField label="Lead">
                          {quote.lead ? <Link href={`/leads/${quote.lead.id}`} className="text-primary hover:underline">{quote.lead.title}</Link> : "—"}
                        </MobileDataField>
                        <MobileDataField label="Created">{formatDate(quote.createdAt)}</MobileDataField>
                      </MobileDataFields>
                      <div className="mt-2 flex items-center justify-end gap-3">
                        <Link href={`/deals/${quote.id}`} className={`${buttonVariants({ variant: "outline", size: "sm" })} mr-auto`}>Open deal</Link>
                        <QuoteRowActions quoteId={quote.id} number={quote.number} status={quote.status} signed={Boolean(quote.signedAt)} canCancel={canCancel} canDuplicate={canDuplicate} />
                        <ConfirmDelete action={deleteQuote.bind(null, quote.id)} title={`Delete quote Q-${quote.number}?`} description="Moves the quote to Trash (restorable for 60 days)." trigger="Delete quote" triggerClass="text-xs text-slate-500 hover:text-red-400" disabled={!canDelete} disabledReason="Your role can't delete quotes." />
                      </div>
                    </MobileDataCard>
                    </RecordContextMenu>
                  );
                })}
                <ListPager path="/quotes" page={page} total={total} />
              </MobileDataList>
            }
            desktop={
              <Surface>
                <div className="border-b border-border px-5 py-4">
                  <SectionHeading title="Quote register" description={`${total} proposal${total === 1 ? "" : "s"} match this commercial view.`} />
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
                          actions={quoteContextActions(quote)}
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
                          <td className="text-slate-400">{formatDate(quote.validUntil, quoteDefaults.regional)}</td>
                          <td className="text-slate-400">{formatDate(quote.createdAt)}{quote.createdBy ? ` · ${quote.createdBy.name}` : ""}</td>
                          <td className="whitespace-nowrap text-right">
                            <Link href={`/deals/${quote.id}`} className={`${buttonVariants({ variant: "outline", size: "sm" })} mr-3`}>Open deal</Link>
                            <QuoteRowActions className="mr-3" quoteId={quote.id} number={quote.number} status={quote.status} signed={Boolean(quote.signedAt)} canCancel={canCancel} canDuplicate={canDuplicate} />
                            <ConfirmDelete action={deleteQuote.bind(null, quote.id)} title={`Delete quote Q-${quote.number}?`} description="Moves the quote to Trash (restorable for 60 days)." trigger="Delete" triggerClass="text-xs text-slate-500 hover:text-red-400" disabled={!canDelete} disabledReason="Your role can't delete quotes." />
                          </td>
                        </tr>
                        </RecordContextMenu>
                      );
                    })}
                  </tbody>
                </table>
                </div>
                <ListPager path="/quotes" page={page} total={total} className="border-t border-border" />
              </Surface>
            }
          />
        )}
      </div>
      </DesktopOnly>
    </QuoteEditorProvider>
  );
}

// Every row here came through getAccessibleQuoteIds — the same gate the print
// routes apply with requireQuoteReadAccess.
function quoteContextActions(quote: { id: string; status: string }): RecordContextAction[] {
  return [
    { label: "Open editor", href: `/quotes?edit=${quote.id}`, icon: "edit" },
    { label: "Deal workspace", href: `/deals/${quote.id}`, icon: "quote" },
    { label: "Print / PDF", href: `/quotes/${quote.id}/print`, icon: "print", newTab: true },
    ...quotePrintLinks(quote).map((link) => ({ ...link, icon: "print" as const, newTab: true })),
  ];
}
