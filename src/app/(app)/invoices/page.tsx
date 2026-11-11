import Link from "next/link";
import { Wallet, FileText, RefreshCw, Truck } from "lucide-react";
import { prisma } from "@/lib/db";
import { getAccessibleQuoteIds, hasPermission, requireRoute } from "@/lib/permissions";
import { WorkspaceHero } from "@/components/workspace-hero";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import XeroInvoiceControl from "@/components/XeroInvoiceControl";
import { refreshAllXeroInvoices } from "@/app/actions/xero";
import { actingTenantId } from "@/lib/actingTenant";
import { getRegionalSettings, resolveIntegrationField } from "@/lib/settings";
import { withCurrency } from "@/lib/currencyRules";
import { formatDate, formatZAR } from "@/lib/format";
import { formatInvoiceNumber } from "@/lib/invoiceNumber";
import { invoiceTotalCents, receivedCents, statementInvoiceDate } from "@/lib/accountStatement";
import { loadBillToFleets, quoteBillTo } from "@/lib/quoteBillTo";
import { xeroStatusLabel } from "@/lib/xeroInvoice";
import { ResponsiveEntityTable } from "@/components/responsive-patterns";

export const metadata = { title: "Invoices" };

const FILTERS = { open: "Owing", xero: "Not in Xero", all: "All" } as const;
type Filter = keyof typeof FILTERS;

/** Where the delivery is — the same steps as the Deliveries board's columns. */
function deliveryStage(quote: { invoicedAt: Date | null; depositPaidAt: Date | null; deliveryScheduledFor: Date | null; deliveredAt: Date | null }): string {
  if (quote.deliveredAt) return `Delivered ${formatDate(quote.deliveredAt)}`;
  if (!quote.invoicedAt || !quote.depositPaidAt) return "Awaiting payment";
  if (!quote.deliveryScheduledFor) return "Ready to schedule";
  return `Scheduled ${formatDate(quote.deliveryScheduledFor)}`;
}

/**
 * Invoices — the money side of a sale, out of the Deliveries board (Sean,
 * 2026-11-11: "too much stuff is happening around that deliveries board"). One row
 * per issued invoice (accepted, with its INV number): total, received (deposit +
 * payments, the same ledger the statement and the deal use), owing, and its Xero
 * copy with Send / Refresh. Same door as the board: deliveries.view to see,
 * deliveries.manage to act, and only invoices this person may open.
 */
export default async function InvoicesPage({ searchParams }: { searchParams?: Promise<{ show?: string }> }) {
  // The ROUTE_RULES entry, read — the edge and this page reach one verdict (deliveries.view / .manage).
  const user = await requireRoute("/invoices");
  const shown = (await searchParams)?.show;
  const filter: Filter = shown === "all" || shown === "xero" ? shown : "open";
  const [quoteIds, canManage] = await Promise.all([getAccessibleQuoteIds(user), hasPermission(user, "deliveries.manage")]);
  const tenantId = await actingTenantId();
  const xeroConnected = canManage && Boolean(await resolveIntegrationField(tenantId, "xero", "XERO_TENANT_ID"));
  const moneyFmt = await getRegionalSettings();

  const quotes = await prisma.quote.findMany({
    where: {
      tenantId,
      status: "accepted",
      supersededAt: null,
      invoiceNumber: { not: null },
      ...(quoteIds === null ? {} : { id: { in: quoteIds } }),
    },
    include: { contact: true, items: true, fees: true },
    orderBy: { invoiceNumber: "desc" },
  });
  const payments = quotes.length
    ? await prisma.quotePayment.findMany({
        where: { tenantId, quoteId: { in: quotes.map((q) => q.id) } },
        select: { quoteId: true, amountCents: true, voidedAt: true },
      })
    : [];
  const fleetsById = await loadBillToFleets(prisma, quotes.map((q) => q.fleetId));

  const rows = quotes.map((quote) => {
    const total = invoiceTotalCents(quote);
    const received = receivedCents(quote, payments.filter((p) => p.quoteId === quote.id));
    return { quote, total, received, owing: total - received, who: quoteBillTo(quote, fleetsById.get(quote.fleetId ?? "") ?? null).name || "—" };
  });
  const open = rows.filter((r) => r.owing > 0);
  const notInXero = rows.filter((r) => !r.quote.xeroInvoiceId);
  const listed = filter === "all" ? rows : filter === "xero" ? notInXero : open;

  return (
    <div className="space-y-6">
      <WorkspaceHero
        icon={Wallet}
        eyebrow="Fulfilment"
        title="Invoices"
        description="Every issued invoice: what it's for, what's been received and what's still owing — and its copy in Xero."
        actions={
          <div className="flex gap-2">
            {xeroConnected && (
              <SaveForm action={refreshAllXeroInvoices} resetOnSuccess={false} success="Refreshed from Xero">
                <SaveButton className="btn-secondary btn-sm" pendingLabel="Refreshing from Xero…">
                  <RefreshCw className="size-4" /> Refresh all from Xero
                </SaveButton>
              </SaveForm>
            )}
            <Link href="/deliveries" className="btn-secondary btn-sm"><Truck className="size-4" /> Deliveries</Link>
          </div>
        }
        stats={[
          { label: "Issued invoices", value: rows.length, detail: "Accepted, with an INV number", icon: FileText },
          { label: "Owing", value: open.length, detail: "Not fully paid yet", icon: Wallet, tone: open.length ? "warning" : "default" },
          ...(xeroConnected ? [{ label: "Not in Xero", value: notInXero.length, detail: "Send from the row", icon: RefreshCw, tone: notInXero.length ? ("primary" as const) : ("default" as const) }] : []),
        ]}
      />
      {xeroConnected && (
        <p className="text-xs text-muted-foreground">
          Refresh brings back Xero&apos;s number, status and PDF — and records the deposit once Xero shows money received.
        </p>
      )}

      <nav className="flex gap-2" aria-label="Show">
        {(Object.keys(FILTERS) as Filter[]).map((key) => (
          <Link
            key={key}
            href={key === "open" ? "/invoices" : `/invoices?show=${key}`}
            className={key === filter ? "btn-primary btn-sm" : "btn-secondary btn-sm"}
            aria-current={key === filter ? "page" : undefined}
          >
            {FILTERS[key]} · {(key === "all" ? rows : key === "xero" ? notInXero : open).length}
          </Link>
        ))}
      </nav>

      {listed.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-10 text-center text-sm text-muted-foreground">
          {filter === "open" ? "Nothing owing — every issued invoice is paid." : filter === "xero" ? "Every issued invoice is in Xero." : "No issued invoices yet."}
        </div>
      ) : (
        <ResponsiveEntityTable>
          <table className="table-base">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Customer</th>
                <th>Date</th>
                <th className="text-right">Total</th>
                <th className="text-right">Received</th>
                <th className="text-right">Owing</th>
                <th>Delivery</th>
                <th>Xero</th>
              </tr>
            </thead>
            <tbody>
              {listed.map(({ quote, total, received, owing, who }) => {
                const fmt = withCurrency(moneyFmt, quote.currency);
                return (
                  <tr key={quote.id}>
                    <td data-primary className="whitespace-nowrap">
                      <a href={`/quotes/${quote.id}/invoice`} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">
                        {formatInvoiceNumber(quote.invoiceNumber)}
                      </a>
                      <Link href={`/deals/${quote.id}`} className="ml-2 text-xs text-muted-foreground hover:underline">Q-{quote.number}</Link>
                    </td>
                    <td data-label="Customer">{quote.contact ? <Link href={`/contacts/${quote.contact.id}`} className="hover:underline">{who}</Link> : who}</td>
                    <td data-label="Date" className="whitespace-nowrap text-xs text-muted-foreground">{formatDate(statementInvoiceDate(quote))}</td>
                    <td data-label="Total" className="text-right tabular-nums">{formatZAR(total, fmt)}</td>
                    <td data-label="Received" className="text-right tabular-nums">{formatZAR(received, fmt)}</td>
                    <td data-label="Owing" className={`text-right tabular-nums ${owing > 0 ? "text-amber-300" : "text-muted-foreground"}`}>{formatZAR(Math.max(0, owing), fmt)}</td>
                    <td data-label="Delivery" className="whitespace-nowrap text-xs text-muted-foreground">{deliveryStage(quote)}</td>
                    <td data-actions className="min-w-[14rem]">
                      {xeroConnected ? (
                        <XeroInvoiceControl quote={quote} crmTotalCents={total} />
                      ) : quote.xeroInvoiceId ? (
                        <span className="text-xs text-muted-foreground">{quote.xeroInvoiceNumber ?? "In Xero"} · {xeroStatusLabel(quote.xeroStatus)}</span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ResponsiveEntityTable>
      )}
    </div>
  );
}
