import Link from "next/link";
import { Wallet, FileText, RefreshCw, Truck, CircleDollarSign } from "lucide-react";
import ModalTrigger from "@/components/Modal";
import DealPayments from "@/components/deals/DealPayments";
import { markDepositPaid } from "@/app/actions/fulfilment";
import { currencySymbol } from "@/lib/format";
import { prisma } from "@/lib/db";
import { canAccessContact, getAccessibleQuoteIds, hasAnyPermission, hasPermission, requireRoute } from "@/lib/permissions";
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
import { xeroOwnsPayments, xeroStatusLabel } from "@/lib/xeroInvoice";
import { paymentsComeFromXero } from "@/lib/xero";
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
  const paymentsFromXero = await paymentsComeFromXero(tenantId);
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
  // The full rows: the Money panel lists each payment (the deal page's DealPayments).
  const payments = quotes.length
    ? await prisma.quotePayment.findMany({ where: { tenantId, quoteId: { in: quotes.map((q) => q.id) } }, orderBy: { receivedAt: "asc" } })
    : [];
  const fleetsById = await loadBillToFleets(prisma, quotes.map((q) => q.fleetId));

  // The statement each invoice appears on — the fleet's when billed to one — only as a
  // link this person can open; exactly the deal page's rule (the statement re-checks).
  const canSeeFleets = await hasAnyPermission(user, "fleets.view", "fleets.manage");
  const contactIds = [...new Set(quotes.map((q) => q.contactId).filter((id): id is string => Boolean(id)))];
  const openableContacts = new Set(
    (await Promise.all(contactIds.map(async (id) => ((await canAccessContact(user, id)) ? id : null)))).filter(Boolean),
  );
  const { timeZone } = moneyFmt;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

  const rows = quotes.map((quote) => {
    const total = invoiceTotalCents(quote);
    const own = payments.filter((p) => p.quoteId === quote.id);
    const received = receivedCents(quote, own);
    const billTo = quoteBillTo(quote, fleetsById.get(quote.fleetId ?? "") ?? null);
    const currency = quote.currency ? `?currency=${encodeURIComponent(quote.currency)}` : "";
    const statementHref =
      billTo.isFleet && quote.fleetId
        ? canSeeFleets ? `/fleets/${quote.fleetId}/statement${currency}` : null
        : quote.contactId && openableContacts.has(quote.contactId)
          ? `/contacts/${quote.contactId}/statement${currency}`
          : null;
    return { quote, total, received, owing: total - received, who: billTo.name || "—", payments: own, statementHref };
  });
  const open = rows.filter((r) => r.owing > 0);
  // Waiting to go to Xero — not the historical ones marked "Not for Xero".
  const notInXero = rows.filter((r) => !r.quote.xeroInvoiceId && !r.quote.xeroExcludedAt);
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
          {paymentsFromXero
            ? "Invoices are made here and sent to Xero; payments are recorded in Xero. Refresh brings back Xero's number, status, PDF and every payment — the first as the deposit — so these figures and the statements match Xero."
            : "Refresh brings back Xero's number, status and PDF. Payments are recorded here in the CRM (Settings → Integrations → Xero)."}
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
                <th>Money</th>
                <th>Xero</th>
              </tr>
            </thead>
            <tbody>
              {listed.map(({ quote, total, received, owing, who, payments: own, statementHref }) => {
                const fmt = withCurrency(moneyFmt, quote.currency);
                const fromXero = Boolean(xeroOwnsPayments(quote, paymentsFromXero));
                // Xero's own figure, as last brought back — said when the CRM's differs.
                const xeroDiffers = fromXero && quote.xeroAmountPaidCents != null && quote.xeroAmountPaidCents !== received;
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
                    <td data-label="Received" className="text-right tabular-nums">
                      {formatZAR(received, fmt)}
                      {xeroDiffers && <span className="block text-[10px] text-amber-300" title="Press Refresh to bring Xero's payments back">Xero: {formatZAR(quote.xeroAmountPaidCents ?? 0, fmt)}</span>}
                    </td>
                    <td data-label="Owing" className={`text-right tabular-nums ${owing > 0 ? "text-amber-300" : "text-muted-foreground"}`}>{formatZAR(Math.max(0, owing), fmt)}</td>
                    <td data-label="Delivery" className="whitespace-nowrap text-xs text-muted-foreground">{deliveryStage(quote)}</td>
                    <td data-label="Money" className="whitespace-nowrap">
                      {/* Deposit, payments and the statement — the deal page's own Payments panel
                          (DealPayments), so the arithmetic and the forms are the same everywhere. */}
                      <ModalTrigger
                        label={<span className="inline-flex items-center gap-1"><CircleDollarSign className="size-3.5" />{canManage ? "Payments" : "View"}</span>}
                        title={`${formatInvoiceNumber(quote.invoiceNumber)} · ${who}`}
                        buttonClass="text-xs text-primary hover:underline"
                      >
                        <div className="space-y-4">
                          {canManage && !fromXero && !quote.depositPaidAt && (
                            quote.invoicedAt ? (
                              <SaveForm success="Deposit recorded" resetOnSuccess={false} action={markDepositPaid.bind(null, quote.id)} className="space-y-2 rounded-xl border border-border p-4">
                                <p className="text-sm font-medium">Record the deposit</p>
                                <input name="amount" inputMode="decimal" required placeholder={`Amount received (${currencySymbol(fmt)})`} aria-label={`Deposit amount received in ${fmt.currency}`} className="input" />
                                <input type="file" name="file" required accept=".pdf,image/*" className="block w-full text-xs text-muted-foreground file:btn-secondary file:btn-sm file:mr-2 file:border-0" />
                                <SaveButton className="btn-primary btn-sm">Deposit paid</SaveButton>
                              </SaveForm>
                            ) : (
                              <p className="rounded-xl border border-border p-4 text-xs text-muted-foreground">
                                Invoice it first — Send invoice to Xero, or Mark invoiced on the Deliveries board — then the deposit can be recorded.
                              </p>
                            )
                          )}
                          <DealPayments quote={quote} payments={own} canRecord={canManage} fromXero={fromXero} statementHref={statementHref} today={today} moneyFmt={fmt} />
                        </div>
                      </ModalTrigger>
                    </td>
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
