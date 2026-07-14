import Link from "next/link";
import { FileText, Plus } from "lucide-react";
import { prisma } from "@/lib/db";
import { requireAnyPermission, getAccessibleQuoteIds } from "@/lib/permissions";
import { contactName, formatDate, formatZAR } from "@/lib/format";
import { getSetting } from "@/lib/settings";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState, StatusPill } from "@/components/visual-system";
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
  const [quotes, contacts, products, allVersions, validDaysRaw, quoteTerms] = await Promise.all([
    prisma.quote.findMany({
      // Only current heads appear in the list. Older revisions remain available
      // from the editor's version history and the full record. RBAC-scoped.
      where: { supersededAt: null, ...(accessibleQuoteIds ? { id: { in: accessibleQuoteIds } } : {}) },
      orderBy: { createdAt: "desc" },
      include: { items: true, lead: true, contact: true, createdBy: true },
      take: 200,
    }),
    prisma.contact.findMany({ orderBy: { firstName: "asc" }, take: 500 }),
    prisma.product.findMany({
      where: { active: true },
      include: { colors: { orderBy: { name: "asc" } } },
      orderBy: { name: "asc" },
    }),
    prisma.quote.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        number: true,
        status: true,
        createdAt: true,
        supersededAt: true,
        revisionOfId: true,
      },
      take: 2_000,
    }),
    getSetting("QUOTE_VALID_DAYS"),
    getSetting("QUOTE_TERMS"),
  ]);

  const versionById = new Map(allVersions.map((version) => [version.id, version]));
  const rootFor = (id: string) => {
    let current = versionById.get(id);
    const seen = new Set<string>();
    while (current?.revisionOfId && !seen.has(current.id)) {
      seen.add(current.id);
      current = versionById.get(current.revisionOfId) ?? current;
      if (!current.revisionOfId) break;
    }
    return current?.id ?? id;
  };
  const versionsByRoot = new Map<string, typeof allVersions>();
  for (const version of allVersions) {
    const root = rootFor(version.id);
    versionsByRoot.set(root, [...(versionsByRoot.get(root) ?? []), version]);
  }

  const records: QuoteEditorRecord[] = quotes.map((quote) => {
    const lockedReason = quote.signToken
      ? "A signing link is active. Revoke it from the full quote record before editing."
      : quote.signedAt
        ? "This quote has been signed and is permanently read-only."
        : quote.supersededAt
          ? "This version has been superseded and is permanently read-only."
          : quote.status !== "draft"
            ? "This version has already been customer-facing. Create a revision from the full quote record to change it."
            : null;
    const family = versionsByRoot.get(rootFor(quote.id)) ?? [];
    return {
      id: quote.id,
      number: quote.number,
      status: quote.status,
      contactId: quote.contactId,
      contactLabel: quote.contact ? contactName(quote.contact) : quote.lead?.name ?? "Unlinked quote",
      leadLabel: quote.lead?.title ?? null,
      validUntil: quote.validUntil?.toISOString().slice(0, 10) ?? "",
      terms: quote.terms ?? "",
      createdAt: formatDate(quote.createdAt),
      editable: lockedReason === null,
      lockedReason,
      items: quote.items.map((item) => ({
        id: item.id,
        description: item.description,
        qty: item.qty,
        unitPriceCents: item.unitPriceCents,
        productId: item.productId,
        colorPreference: item.colorPreference,
        discountPct: item.discountPct,
      })),
      versions: family
        .toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((version) => ({
          id: version.id,
          number: version.number,
          status: version.status,
          createdAt: formatDate(version.createdAt),
          superseded: Boolean(version.supersededAt),
          current: version.id === quote.id,
        })),
    };
  });

  const validDays = Number.parseInt(validDaysRaw ?? "7", 10);
  const defaults = {
    validUntil: inputDate(Number.isFinite(validDays) ? validDays : 7),
    terms: quoteTerms || "Prices include VAT. Delivery arranged on acceptance. E&OE.",
  };
  const contactOptions = contacts.map((contact) => ({ id: contact.id, label: contactName(contact) }));
  const productOptions = products.map((product) => ({
    id: product.id,
    name: product.name,
    basePriceCents: product.basePriceCents,
    colors: product.colors.map((colour) => colour.name),
  }));

  return (
    <QuoteEditorProvider
      contacts={contactOptions}
      products={productOptions}
      defaults={defaults}
      records={records}
      initialQuoteId={records.some((record) => record.id === edit) ? edit : undefined}
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
                  const total = quote.items.reduce((sum, item) => sum + item.qty * item.unitPriceCents, 0);
                  return (
                    <MobileDataCard key={quote.id}>
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
                    </MobileDataCard>
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
                    </tr>
                  </thead>
                  <tbody>
                    {quotes.map((quote) => {
                      const total = quote.items.reduce((sum, item) => sum + item.qty * item.unitPriceCents, 0);
                      return (
                        <tr key={quote.id}>
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
                        </tr>
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
