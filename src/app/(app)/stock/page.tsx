import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  CalendarClock,
  Download,
  MapPin,
  Package,
  PackageCheck,
  Search,
  Settings2,
  ShoppingCart,
  Sparkles,
  TrendingUp,
  Warehouse,
} from "lucide-react";
import { prisma } from "@/lib/db";
import { formatZAR } from "@/lib/format";
import { getStockDashboard, getStockLocations } from "@/lib/stockPlatform";
import {
  STOCK_STATUS_LABELS,
  STOCK_STATUS_TONES,
  isStockStatus,
  reservationUrgency,
  stockAgeBand,
  stockAgeDays,
} from "@/lib/stockWorkflow";
import { getStockStatuses } from "@/lib/stockStatuses";
import { hasPermission, requireAnyPermission } from "@/lib/permissions";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { ResponsiveEntityTable } from "@/components/responsive-patterns";
import {
  EmptyState,
  FeedbackBanner,
  MetricCard,
  SectionHeading,
  StatusPill,
  Surface,
} from "@/components/visual-system";

export const metadata = { title: "Stock operations — DenagoCRM" };

function count(dashboard: Awaited<ReturnType<typeof getStockDashboard>>, status: string) {
  return dashboard.counts[status] ?? 0;
}

function alertTotal(dashboard: Awaited<ReturnType<typeof getStockDashboard>>) {
  return Object.values(dashboard.alerts).reduce((sum, value) => sum + value, 0);
}

export default async function StockPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    status?: string;
    product?: string;
    location?: string;
    age?: string;
    page?: string;
  }>;
}) {
  const user = await requireAnyPermission("stock.view", "stock.manage");
  const canManage = await hasPermission(user, "stock.manage");
  const params = await searchParams;
  const [products, locations, statuses, dashboard] = await Promise.all([
    prisma.product.findMany({
      where: { active: true, deletedAt: null },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    getStockLocations(),
    getStockStatuses(),
    getStockDashboard({
      query: params.q,
      status: params.status,
      productId: params.product,
      locationId: params.location,
      age: params.age,
      page: Number(params.page) || 1,
      pageSize: 30,
    }),
  ]);
  const statusBySlug = new Map(statuses.map((status) => [status.slug, status]));
  const currentStatus = params.status && statusBySlug.has(params.status) ? params.status : "all";
  const totalPages = Math.max(1, Math.ceil(dashboard.total / dashboard.pageSize));
  const pageQuery = new URLSearchParams();
  if (params.q) pageQuery.set("q", params.q);
  if (currentStatus !== "all") pageQuery.set("status", currentStatus);
  if (params.product) pageQuery.set("product", params.product);
  if (params.location) pageQuery.set("location", params.location);
  if (params.age) pageQuery.set("age", params.age);
  const baseQuery = pageQuery.toString();
  const pageHref = (page: number) => `/stock?${baseQuery ? `${baseQuery}&` : ""}page=${page}`;

  return (
    <div className="denago-workspace space-y-6">
      <PageHeader
        title="Stock operations"
        description={`${count(dashboard, "available")} available · ${count(dashboard, "incoming")} incoming · ${count(dashboard, "reserved")} reserved · controlled from supplier order to customer delivery.`}
      >
        <Link href="/api/stock/export" className={buttonVariants({ variant: "ghost", size: "sm" })}><Download className="size-4" /> Export</Link>
        <Link href="/stock/purchase-orders" className={buttonVariants({ variant: "outline", size: "sm" })}><ShoppingCart className="size-4" /> Purchase orders</Link>
        {canManage && <Link href="/stock/settings" className={buttonVariants({ variant: "outline", size: "sm" })}><Settings2 className="size-4" /> Settings</Link>}
        {canManage && <Link href="/stock/new" className={buttonVariants({ size: "sm" })}><Package className="size-4" /> Add unit</Link>}
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-6">
        <MetricCard icon={PackageCheck} label="Available" value={count(dashboard, "available")} detail="Immediately reservable" accent />
        <MetricCard icon={ShoppingCart} label="Incoming" value={count(dashboard, "incoming")} detail="Supplier pipeline" />
        <MetricCard icon={ClipboardCheck} label="Ready" value={count(dashboard, "ready")} detail="PDI complete" />
        <MetricCard icon={Warehouse} label="Active stock value" value={formatZAR(dashboard.values.activeCents)} detail="Landed cost basis" />
        <MetricCard icon={CalendarClock} label="Expiring reservations" value={dashboard.alerts.expiringReservations} detail="Within 72 hours" />
        <MetricCard icon={AlertTriangle} label="Operational alerts" value={alertTotal(dashboard)} detail="Needs attention" />
      </div>

      {alertTotal(dashboard) > 0 && (
        <div className="grid gap-3 lg:grid-cols-3">
          {dashboard.alerts.overduePurchaseOrders > 0 && <FeedbackBanner tone="warning" title={`${dashboard.alerts.overduePurchaseOrders} overdue purchase order${dashboard.alerts.overduePurchaseOrders === 1 ? "" : "s"}`}>Expected dates have passed without full receipt.</FeedbackBanner>}
          {dashboard.alerts.agedAvailable > 0 && <FeedbackBanner tone="warning" title={`${dashboard.alerts.agedAvailable} aged available unit${dashboard.alerts.agedAvailable === 1 ? "" : "s"}`}>Available for more than 60 days and should be prioritised in sales matching.</FeedbackBanner>}
          {(dashboard.alerts.missingSerials > 0 || dashboard.alerts.pdiWaiting > 0) && <FeedbackBanner tone="info" title="Operational data to complete">{dashboard.alerts.missingSerials} serial{dashboard.alerts.missingSerials === 1 ? "" : "s"} missing · {dashboard.alerts.pdiWaiting} unit{dashboard.alerts.pdiWaiting === 1 ? "" : "s"} awaiting PDI.</FeedbackBanner>}
        </div>
      )}

      <Surface className="p-5">
        <SectionHeading title="Demand versus supply" description="Open CRM demand compared with available, incoming and committed units." action={<TrendingUp className="size-5 text-primary" />} />
        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {dashboard.demand.map((row) => (
            <div key={row.productId} className="rounded-2xl border border-border bg-background/30 p-4">
              <div className="flex items-start justify-between gap-3">
                <div><p className="font-semibold text-foreground">{row.productName}</p><p className="mt-1 text-xs text-muted-foreground">{row.openDemand} open lead{row.openDemand === 1 ? "" : "s"}</p></div>
                <StatusPill tone={row.recommendation > 0 ? "warning" : "success"}>{row.recommendation > 0 ? `Order ${row.recommendation}` : "Covered"}</StatusPill>
              </div>
              <div className="mt-4 grid grid-cols-4 gap-2 text-center">
                {[["Available", row.available], ["Incoming", row.incoming], ["Committed", row.reserved + row.allocated], ["Ready", row.ready]].map(([label, value]) => <div key={String(label)} className="rounded-xl border border-border bg-card/70 px-2 py-2"><p className="text-lg font-semibold tabular-nums">{value}</p><p className="text-[9px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">{label}</p></div>)}
              </div>
            </div>
          ))}
        </div>
      </Surface>

      <Surface className="p-4">
        <form method="get" className="grid gap-3 lg:grid-cols-[minmax(15rem,1fr)_repeat(4,minmax(9rem,auto))_auto]">
          <div className="relative"><Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><input name="q" className="input pl-10" defaultValue={params.q ?? ""} placeholder="Search stock no., serial, model, colour or lead…" /></div>
          <select name="status" className="input" defaultValue={currentStatus}><option value="all">All statuses</option>{statuses.map((status) => <option key={status.slug} value={status.slug}>{status.label}</option>)}</select>
          <select name="product" className="input" defaultValue={params.product ?? ""}><option value="">All models</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select>
          <select name="location" className="input" defaultValue={params.location ?? ""}><option value="">All locations</option>{locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</select>
          <select name="age" className="input" defaultValue={params.age ?? ""}><option value="">Any age</option><option value="30">30+ days</option><option value="60">60+ days</option><option value="90">90+ days</option></select>
          <button className="btn-primary">Apply</button>
        </form>
        <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">Showing {dashboard.units.length} of {dashboard.total} matching units.</p>
      </Surface>

      {dashboard.units.length === 0 ? (
        <EmptyState icon={Boxes} title="No stock matches these filters" description="Clear the filters, receive a purchase order or add a floor unit." action={canManage ? <Link href="/stock/new" className={buttonVariants({ size: "sm" })}>Add stock unit</Link> : undefined} />
      ) : (
        <Surface className="p-0">
          <ResponsiveEntityTable>
            <table className="table-base">
              <thead><tr><th>Unit</th><th>Status</th><th>Location</th><th>Age</th><th>Reserved / sold for</th>{canManage && <th className="text-right">Landed value</th>}<th></th></tr></thead>
              <tbody>
                {dashboard.units.map((unit) => {
                  const age = stockAgeDays(unit.arrivedAt ?? unit.createdAt);
                  const ageBand = stockAgeBand(age);
                  const urgency = reservationUrgency(unit.reservationExpiresAt);
                  const option = statusBySlug.get(unit.status);
                  const systemStatus = isStockStatus(unit.status) ? unit.status : null;
                  return (
                    <tr key={unit.id}>
                      <td data-primary data-label="Unit"><Link href={`/stock/${unit.id}`} className="group block"><span className="font-semibold transition-colors group-hover:text-primary">{unit.productName}</span><span className="mt-0.5 block text-xs text-muted-foreground">{unit.stockNumber ?? "No stock number"}{unit.color ? ` · ${unit.color}` : ""}</span><span className="mt-0.5 block font-mono text-[11px] text-muted-foreground/70">{unit.serial ?? "Serial pending"}</span></Link></td>
                      <td data-label="Status">{systemStatus ? <StatusPill tone={STOCK_STATUS_TONES[systemStatus]}>{STOCK_STATUS_LABELS[systemStatus]}</StatusPill> : <span className="rounded-full border px-2.5 py-1 text-xs font-semibold" style={{ borderColor: `${option?.color ?? "#64748b"}55`, backgroundColor: `${option?.color ?? "#64748b"}18`, color: option?.color ?? "#94a3b8" }}>{option?.label ?? unit.status.replaceAll("-", " ")}</span>}{unit.pdiStatus === "completed" && unit.status !== "delivered" && <p className="mt-1 text-[10px] font-medium text-emerald-400">PDI complete</p>}</td>
                      <td data-label="Location" className="text-muted-foreground"><span className="inline-flex items-center gap-1.5"><MapPin className="size-3.5" />{unit.locationName ?? "Unassigned"}</span></td>
                      <td data-label="Age"><span className={ageBand === "critical" ? "font-semibold text-red-300" : ageBand === "aged" ? "font-semibold text-amber-300" : "text-muted-foreground"}>{age == null ? "—" : `${age}d`}</span></td>
                      <td data-label="Reserved / sold for" className="text-muted-foreground">{unit.reservedForLeadId ? <div><Link href={`/leads/${unit.reservedForLeadId}`} className="font-medium text-primary hover:underline">{unit.reservedLeadName ?? "Lead"}</Link>{unit.reservationExpiresAt && <p className={urgency === "expired" || urgency === "today" ? "text-[10px] text-red-300" : urgency === "soon" ? "text-[10px] text-amber-300" : "text-[10px] text-muted-foreground"}>Expires {unit.reservationExpiresAt.toLocaleDateString("en-ZA")}</p>}</div> : unit.soldQuoteId ? <Link href={`/quotes/${unit.soldQuoteId}`} className="font-medium text-primary hover:underline">Q-{unit.soldQuoteNumber ?? "—"}{unit.soldContactName ? ` · ${unit.soldContactName}` : ""}</Link> : "—"}</td>
                      {canManage && <td data-label="Landed value" className="text-right font-medium tabular-nums">{formatZAR(unit.landedCostCents || unit.costCents)}{unit.salePriceCents > 0 && <p className="text-[10px] text-emerald-400">Margin {formatZAR(unit.salePriceCents - (unit.landedCostCents || unit.costCents))}</p>}</td>}
                      <td data-actions className="text-right"><Link href={`/stock/${unit.id}`} className="btn-secondary btn-sm">Manage <ArrowRight className="size-3.5" /></Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ResponsiveEntityTable>
        </Surface>
      )}

      {totalPages > 1 && <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card px-4 py-3"><p className="text-xs text-muted-foreground">Page {dashboard.page} of {totalPages}</p><div className="flex gap-2">{dashboard.page > 1 && <Link href={pageHref(dashboard.page - 1)} className="btn-secondary btn-sm">Previous</Link>}{dashboard.page < totalPages && <Link href={pageHref(dashboard.page + 1)} className="btn-secondary btn-sm">Next</Link>}</div></div>}

      <Surface className="relative overflow-hidden p-5"><div className="pointer-events-none absolute -right-12 -top-12 size-40 rounded-full bg-primary/10 blur-3xl" /><div className="relative flex flex-col gap-4 md:flex-row md:items-center md:justify-between"><div><div className="flex items-center gap-2 text-primary"><Sparkles className="size-4" /><span className="text-[10px] font-semibold uppercase tracking-[0.16em]">Inventory intelligence</span></div><h2 className="mt-2 text-lg font-semibold tracking-tight">Use ageing and CRM demand to sell the right physical unit first.</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">Recommendations consider open leads, incoming stock, commitments and safety stock.</p></div><div className="flex shrink-0 gap-2"><Link href="/stock/purchase-orders" className="btn-secondary"><ShoppingCart className="size-4" /> Purchasing</Link><Link href="/api/stock/export" className="btn-primary"><Download className="size-4" /> Export ledger</Link></div></div></Surface>
    </div>
  );
}
