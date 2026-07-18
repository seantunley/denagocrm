import Link from "next/link";
import { Prisma } from "@prisma/client";
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  CalendarClock,
  CircleDollarSign,
  Clock3,
  PackageCheck,
  PackagePlus,
  Search,
  ShieldAlert,
  ShoppingCart,
  Sparkles,
  Truck,
  Warehouse,
} from "lucide-react";
import { prisma } from "@/lib/db";
import ModalTrigger from "@/components/Modal";
import StockUnitForm from "@/components/StockUnitForm";
import StockPurchaseOrderForm from "@/components/StockPurchaseOrderForm";
import { formatZAR } from "@/lib/format";
import { receivePurchaseOrder, cancelPurchaseOrder, addStockUnit } from "@/app/actions/stock";
import { StockReceiveForm } from "@/components/StockReceiveForm";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { ResponsiveEntityTable } from "@/components/responsive-patterns";
import { EmptyState, FeedbackBanner, MetricCard, SectionHeading, StatusPill, Surface } from "@/components/visual-system";
import { hasPermission, requireAnyPermission } from "@/lib/permissions";
import { listStockUnits, stockDashboard } from "@/lib/stockPlatform";
import { getStockLabels } from "@/lib/stockLabels";

const STATUS: Record<string, { label: string; tone: "neutral" | "success" | "warning" | "danger" | "info" }> = {
  incoming: { label: "Incoming", tone: "info" },
  received_pending_check: { label: "Awaiting inspection", tone: "warning" },
  available: { label: "Available", tone: "success" },
  reserved: { label: "Reserved", tone: "warning" },
  allocated: { label: "Allocated", tone: "info" },
  pdi: { label: "PDI", tone: "warning" },
  ready_for_delivery: { label: "Ready", tone: "success" },
  delivered: { label: "Delivered", tone: "neutral" },
  sold: { label: "Delivered", tone: "neutral" },
  hold: { label: "On hold", tone: "danger" },
  damaged: { label: "Damaged", tone: "danger" },
};

const FILTERS = [
  ["all", "All"], ["available", "Available"], ["incoming", "Incoming"],
  ["received_pending_check", "Inspection"], ["reserved", "Reserved"],
  ["allocated", "Allocated"], ["pdi", "PDI"],
  ["ready_for_delivery", "Ready"], ["hold", "Hold"], ["delivered", "Delivered"],
] as const;

type QueueCard = { label: string; value: number; icon: LucideIcon; href: string };

export default async function StockPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; product?: string; location?: string; age?: string }>;
}) {
  const user = await requireAnyPermission("stock.view", "stock.manage");
  const canManage = await hasPermission(user, "stock.manage");
  const params = await searchParams;
  const status = FILTERS.some(([value]) => value === params.status) ? params.status ?? "all" : "all";

  const [dashboard, products, units, openPos, locations, demand] = await Promise.all([
    stockDashboard(),
    prisma.product.findMany({ where: { active: true }, orderBy: { name: "asc" }, include: { colors: true } }),
    listStockUnits({ status, query: params.q, productId: params.product, location: params.location, age: params.age, limit: 150 }),
    prisma.purchaseOrder.findMany({
      where: { deletedAt: null, status: { in: ["ordered", "partially_received"] } },
      orderBy: [{ expectedAt: "asc" }, { orderedAt: "asc" }],
      include: {
        _count: { select: { units: { where: { deletedAt: null, status: "incoming" } } } },
        units: { where: { deletedAt: null, status: "incoming" }, take: 1, include: { product: true } },
        lines: {
          orderBy: { createdAt: "asc" },
          include: {
            product: { select: { name: true } },
            _count: { select: { units: { where: { deletedAt: null, status: "incoming" } } } },
          },
        },
      },
      take: 12,
    }),
    prisma.$queryRaw<Array<{ location: string }>>(Prisma.sql`
      SELECT DISTINCT "location" FROM "StockUnit"
      WHERE "deletedAt" IS NULL AND "location" IS NOT NULL AND "location" <> '' ORDER BY "location"
    `),
    prisma.$queryRaw<Array<{ productId: string; productName: string; openLeads: number; available: number; incoming: number; reserved: number }>>(Prisma.sql`
      SELECT p."id" AS "productId", p."name" AS "productName",
        COUNT(DISTINCT l."id") FILTER (WHERE l."status" = 'open' AND l."deletedAt" IS NULL)::int AS "openLeads",
        COUNT(DISTINCT su."id") FILTER (WHERE su."status" = 'available' AND su."deletedAt" IS NULL)::int AS "available",
        COUNT(DISTINCT su."id") FILTER (WHERE su."status" IN ('incoming', 'received_pending_check') AND su."deletedAt" IS NULL)::int AS "incoming",
        COUNT(DISTINCT su."id") FILTER (WHERE su."status" IN ('reserved', 'allocated') AND su."deletedAt" IS NULL)::int AS "reserved"
      FROM "Product" p
      LEFT JOIN "Lead" l ON l."productId" = p."id"
      LEFT JOIN "StockUnit" su ON su."productId" = p."id"
      WHERE p."active" = true
      GROUP BY p."id", p."name"
      HAVING COUNT(DISTINCT l."id") FILTER (WHERE l."status" = 'open' AND l."deletedAt" IS NULL) > 0
          OR COUNT(DISTINCT su."id") FILTER (WHERE su."deletedAt" IS NULL AND su."status" NOT IN ('delivered', 'sold')) > 0
      ORDER BY "openLeads" DESC, p."name" LIMIT 12
    `),
  ]);

  const stockLabels = await getStockLabels();
  const labelBySlug = new Map(stockLabels.map((l) => [l.slug, l]));

  const alerts = dashboard.expiringReservations + dashboard.overduePurchaseOrders + dashboard.missingSerial + dashboard.aged60;
  const queueCards: QueueCard[] = [
    { label: "Allocated", value: dashboard.allocated, icon: Boxes, href: "/stock?status=allocated" },
    { label: "In PDI", value: dashboard.pdi, icon: ShieldAlert, href: "/stock?status=pdi" },
    { label: "Ready", value: dashboard.ready, icon: PackageCheck, href: "/stock?status=ready_for_delivery" },
    { label: "On hold", value: dashboard.hold, icon: AlertTriangle, href: "/stock?status=hold" },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="Stock operations" description="Control every physical Denago unit from supplier order through reservation, PDI, delivery and warranty activation.">
        {canManage && <>
          <ModalTrigger label={<><ShoppingCart className="size-4" /> Purchase order</>} title="New purchase order" buttonClass={buttonVariants({ size: "sm" })}>
            <StockPurchaseOrderForm products={products.map((product) => ({ id: product.id, name: product.name, colors: product.colors.map((color) => color.name) }))} />
          </ModalTrigger>
          <ModalTrigger label={<><PackagePlus className="size-4" /> Add floor unit</>} title="Add a stock unit" buttonClass={buttonVariants({ variant: "outline", size: "sm" })}>
            <StockUnitForm action={addStockUnit} products={products.map((product) => ({ id: product.id, name: product.name, colors: product.colors.map((color) => color.name) }))} variant="dialog" />
          </ModalTrigger>
        </>}
      </PageHeader>

      {alerts > 0 && <FeedbackBanner tone="warning" title={`${alerts} stock item${alerts === 1 ? "" : "s"} need attention`}>
        {dashboard.expiringReservations > 0 && `${dashboard.expiringReservations} reservation${dashboard.expiringReservations === 1 ? "" : "s"} expire within 24 hours. `}
        {dashboard.overduePurchaseOrders > 0 && `${dashboard.overduePurchaseOrders} purchase order${dashboard.overduePurchaseOrders === 1 ? " is" : "s are"} overdue. `}
        {dashboard.missingSerial > 0 && `${dashboard.missingSerial} received unit${dashboard.missingSerial === 1 ? " is" : "s are"} missing a serial. `}
        {dashboard.aged60 > 0 && `${dashboard.aged60} available unit${dashboard.aged60 === 1 ? " has" : "s have"} been held for more than 60 days.`}
      </FeedbackBanner>}

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <MetricCard icon={PackageCheck} label="Available" value={dashboard.available} detail={formatZAR(dashboard.availableValueCents)} accent />
        <MetricCard icon={Truck} label="Incoming & inspection" value={dashboard.incoming} detail={formatZAR(dashboard.incomingValueCents)} />
        <MetricCard icon={CalendarClock} label="Committed" value={dashboard.reserved + dashboard.allocated} detail={`${dashboard.reserved} reserved · ${dashboard.allocated} allocated`} />
        <MetricCard icon={Clock3} label="Average stock age" value={`${dashboard.averageAgeDays}d`} detail={`${dashboard.aged60} older than 60 days`} />
      </div>

      <div className="grid gap-5 2xl:grid-cols-[minmax(0,1.55fr)_minmax(20rem,0.8fr)]">
        <Surface className="p-5">
          <SectionHeading title="Live inventory" description="Search and filter every active unit. Open a row for its complete operational history and next actions." action={<span className="text-xs tabular-nums text-muted-foreground">{units.length} shown</span>} />
          <form className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(15rem,1fr)_11rem_11rem_9rem_auto]">
            <div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><input name="q" defaultValue={params.q ?? ""} className="input pl-9" placeholder="Serial, stock no., model, colour, PO or customer" /></div>
            <select name="product" defaultValue={params.product ?? ""} className="input"><option value="">All models</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select>
            <select name="location" defaultValue={params.location ?? ""} className="input"><option value="">All locations</option>{locations.map((item) => <option key={item.location} value={item.location}>{item.location}</option>)}</select>
            <select name="age" defaultValue={params.age ?? ""} className="input"><option value="">Any age</option><option value="30">30+ days</option><option value="60">60+ days</option><option value="90">90+ days</option></select>
            <button className="btn-secondary">Filter</button>
          </form>
          <div className="mt-3 flex flex-wrap gap-2">
            {FILTERS.map(([value, label]) => {
              const query = new URLSearchParams();
              if (value !== "all") query.set("status", value);
              if (params.q) query.set("q", params.q);
              if (params.product) query.set("product", params.product);
              if (params.location) query.set("location", params.location);
              if (params.age) query.set("age", params.age);
              return <Link key={value} href={`/stock${query.size ? `?${query}` : ""}`} className={status === value ? "rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground" : "rounded-full border border-border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"}>{label}</Link>;
            })}
          </div>
          <div className="mt-4">
            {units.length === 0 ? <EmptyState icon={Boxes} title="No matching stock" description="Adjust the filters or add a physical unit to begin tracking it." /> : <ResponsiveEntityTable>
              <table className="table-base"><thead><tr><th>Unit</th><th>Status</th><th>Customer / quote</th><th>Location</th><th className="whitespace-nowrap">Age</th>{canManage && <th className="whitespace-nowrap text-right">Landed cost</th>}<th></th></tr></thead>
                <tbody>{units.map((unit) => {
                  const meta = STATUS[unit.status] ?? { label: unit.status.replaceAll("_", " "), tone: "neutral" as const };
                  return <tr key={unit.id}>
                    <td data-primary data-label="Unit"><Link href={`/stock/${unit.id}`} className="font-medium text-foreground hover:text-primary">{unit.stockNumber ?? unit.productName}</Link><p className="mt-0.5 text-xs text-muted-foreground">{unit.productName}{unit.color ? ` · ${unit.color}` : ""}{unit.serial ? ` · ${unit.serial}` : " · serial pending"}</p></td>
                    <td data-label="Status"><div className="flex flex-wrap items-center gap-1.5"><StatusPill tone={meta.tone}>{meta.label}</StatusPill>{unit.label && labelBySlug.has(unit.label) && <span className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium" style={{ backgroundColor: `${labelBySlug.get(unit.label)!.color}22`, color: labelBySlug.get(unit.label)!.color }}>{labelBySlug.get(unit.label)!.label}</span>}</div></td>
                    <td data-label="Customer / quote" className="text-sm text-muted-foreground">{unit.reservedForLeadId ? <Link href={`/leads/${unit.reservedForLeadId}`} className="text-primary hover:underline">{unit.reservedLeadName ?? "Lead"}</Link> : unit.soldQuoteId ? <Link href={`/quotes/${unit.soldQuoteId}`} className="text-primary hover:underline">Q-{unit.quoteNumber}</Link> : "—"}{unit.reservationExpiresAt && <p className="text-[11px]">Expires {unit.reservationExpiresAt.toLocaleDateString("en-ZA")}</p>}</td>
                    <td data-label="Location" className="text-sm text-muted-foreground">{unit.location ?? "—"}</td>
                    <td data-label="Age" className={`whitespace-nowrap ${unit.ageDays >= 60 ? "font-semibold text-amber-300" : "text-muted-foreground"}`}>{unit.ageDays}d</td>
                    {canManage && <td data-label="Landed cost" className="whitespace-nowrap text-right tabular-nums">{formatZAR(unit.landedCostCents || unit.costCents)}</td>}
                    <td data-actions className="text-right"><Link href={`/stock/${unit.id}`} className="btn-secondary btn-sm inline-flex items-center gap-1 whitespace-nowrap">Open <ArrowRight className="size-3.5" /></Link></td>
                  </tr>;
                })}</tbody>
              </table>
            </ResponsiveEntityTable>}
          </div>
        </Surface>

        <div className="space-y-5">
          <Surface className="p-5"><SectionHeading title="Operational queue" description="Units moving from allocation to customer handover." /><div className="mt-4 grid grid-cols-2 gap-3">
            {queueCards.map(({ label, value, icon: Icon, href }) => <Link key={label} href={href} className="rounded-2xl border border-border bg-background/30 p-4 transition-colors hover:border-primary/30"><Icon className="size-4 text-muted-foreground" /><p className="mt-3 text-2xl font-semibold tracking-tight tabular-nums">{value}</p><p className="text-xs text-muted-foreground">{label}</p></Link>)}
          </div></Surface>
          <Surface className="p-5"><SectionHeading title="Open purchase orders" description="Receive arrivals into inspection before making them available." />
            {openPos.length === 0 ? <p className="mt-4 text-sm text-muted-foreground">No supplier orders are currently outstanding.</p> : <ul className="mt-4 divide-y divide-border">{openPos.map((po) => {
              const overdue = Boolean(po.expectedAt && po.expectedAt < new Date());
              return <li key={po.id} className="py-3 first:pt-0 last:pb-0"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-medium">{po.reference || `${po.supplier} order`}</p><p className="mt-0.5 text-xs text-muted-foreground">{po._count.units} unit{po._count.units === 1 ? "" : "s"}{po.expectedAt ? ` · due ${po.expectedAt.toLocaleDateString("en-ZA")}` : ""}</p></div>{overdue && <StatusPill tone="danger">Overdue</StatusPill>}</div>
                {canManage && <div className="mt-2 flex gap-2">{po.lines.length > 0 ? <ModalTrigger label="Receive" title={`Receive — ${po.reference || `${po.supplier} order`}`} buttonClass="btn-primary btn-sm"><StockReceiveForm action={receivePurchaseOrder.bind(null, po.id)} lines={po.lines.map((line) => ({ id: line.id, name: line.product.name, color: line.color, ordered: line.orderedQty, received: line.receivedQty, outstanding: line._count.units }))} /></ModalTrigger> : <form action={receivePurchaseOrder.bind(null, po.id)}><button className="btn-primary btn-sm">Receive</button></form>}<ModalTrigger label="Cancel" title="Cancel purchase order" buttonClass="btn-secondary btn-sm"><form action={cancelPurchaseOrder.bind(null, po.id)} className="space-y-3"><p className="text-sm text-muted-foreground">Only outstanding incoming units will be removed. Previously received units remain in stock.</p><div><label className="label">Reason *</label><textarea name="reason" className="input min-h-24" required /></div><button className="btn-danger">Cancel order</button></form></ModalTrigger></div>}
              </li>;
            })}</ul>}
          </Surface>
        </div>
      </div>

      <Surface className="p-5"><SectionHeading title="Demand versus supply" description="Open CRM demand compared with physical and incoming stock by model." action={<Sparkles className="size-5 text-primary" />} />
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{demand.map((item) => {
          const freeSupply = item.available + item.incoming;
          const shortage = item.openLeads - freeSupply;
          return <div key={item.productId} className="rounded-2xl border border-border bg-background/30 p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-medium">{item.productName}</p><p className="mt-1 text-xs text-muted-foreground">{item.openLeads} open leads</p></div><StatusPill tone={shortage > 0 ? "danger" : freeSupply > item.openLeads + 2 ? "warning" : "success"}>{shortage > 0 ? `${shortage} short` : "Covered"}</StatusPill></div><div className="mt-4 grid grid-cols-3 gap-2 text-center"><div className="rounded-xl bg-muted/30 p-2"><p className="text-lg font-semibold tabular-nums">{item.available}</p><p className="text-[10px] uppercase tracking-wide text-muted-foreground">Available</p></div><div className="rounded-xl bg-muted/30 p-2"><p className="text-lg font-semibold tabular-nums">{item.incoming}</p><p className="text-[10px] uppercase tracking-wide text-muted-foreground">Incoming</p></div><div className="rounded-xl bg-muted/30 p-2"><p className="text-lg font-semibold tabular-nums">{item.reserved}</p><p className="text-[10px] uppercase tracking-wide text-muted-foreground">Committed</p></div></div></div>;
        })}</div>
      </Surface>

      {canManage && <div className="grid gap-3 sm:grid-cols-3">
        <Link href="/stock?age=60&status=available" className="rounded-2xl border border-border bg-card p-4 transition-colors hover:border-primary/30"><Clock3 className="size-5 text-amber-300" /><p className="mt-3 font-semibold">Ageing stock</p><p className="mt-1 text-xs text-muted-foreground">Prioritise older units and reduce holding cost.</p></Link>
        <Link href="/stock?status=received_pending_check" className="rounded-2xl border border-border bg-card p-4 transition-colors hover:border-primary/30"><Warehouse className="size-5 text-sky-300" /><p className="mt-3 font-semibold">Receiving queue</p><p className="mt-1 text-xs text-muted-foreground">Capture serials and inspect arrivals.</p></Link>
        <Link href="/stock?status=ready_for_delivery" className="rounded-2xl border border-border bg-card p-4 transition-colors hover:border-primary/30"><CircleDollarSign className="size-5 text-emerald-300" /><p className="mt-3 font-semibold">Ready for revenue</p><p className="mt-1 text-xs text-muted-foreground">Complete handovers and activate warranties.</p></Link>
      </div>}
    </div>
  );
}
