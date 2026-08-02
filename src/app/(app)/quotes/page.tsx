import Link from "next/link";
import { FileText, Plus } from "lucide-react";
import { prisma } from "@/lib/db";
import { requireAnyPermission, getAccessibleQuoteIds, hasPermission } from "@/lib/permissions";
import { contactName, formatDate, formatZAR } from "@/lib/format";
import { payableTotalCents } from "@/lib/pricing";
import {
  QUOTE_EDITOR_INCLUDE,
  QUOTE_VERSION_SELECT,
  buildQuoteEditorRecord,
  quoteVersionIndex,
} from "@/lib/quoteEditorRecord";
import { getSetting } from "@/lib/settings";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState, StatusPill } from "@/components/visual-system";
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

function inputDate(daysFromNow: number) {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  return date.toISOString().slice(0, 10);
}

export default async function QuotesPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string }>;
}) {
  const user = await requireAnyPermission("quotes.view_all", "quotes.view_owned");
  const accessibleQuoteIds = await getAccessibleQuoteIds(user);
  const { edit } = await searchParams;
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
  const records: QuoteEditorRecord[] = quotes.map((quote) => buildQuoteEditorRecord(quote, versionIndex));

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
  const leadOptions = openLeads.map((lead) => ({
    id: lead.id,
    label: lead.title || lead.name,
    contactId: lead.contactId,
  }));
  const productOptions = products.map((product) => ({
    id: product.id,
    name: product.name,
    basePriceCents: product.basePriceCents,
    colors: product.colors.map((colour) => colour.name),
  }));

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
      <div className="space-y-5">
        <PageHeader title="Quotes" description={`${quotes.length} current quotes · Create, price and send every customer proposal.`}>
          <QuoteEditorTrigger className={buttonVariants({ size: "sm" })}>
            <Plus className="size-4" />
            New quote
          </QuoteEditorTrigger>
        </PageHeader>

        {quotes.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="No quotes yet"
            description="Build the first customer proposal without leaving this page."
            action={
              <QuoteEditorTrigger className={buttonVariants({ size: "sm" })}>
                <Plus className="size-4" />
                Create quote
              </QuoteEditorTrigger>
            }
          />
        ) : (
          <ResponsiveDataView
            mobile={
              <MobileDataList>
                {quotes.map((quote) => {
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
                        detail={quote.contact ? contactName(quote.contact) : quote.lead?.name ?? "Unlinked quote"}
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
              <div className="card overflow-x-auto p-0">
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
                    {quotes.map((quote) => {
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
            }
          />
        )}
      </div>
    </QuoteEditorProvider>
  );
}

function quoteContextActions(quoteId: string): RecordContextAction[] {
  return [
    { label: "Open editor", href: `/quotes?edit=${quoteId}`, icon: "edit" },
    { label: "Print / PDF", href: `/quotes/${quoteId}/print`, icon: "print", newTab: true },
  ];
}
