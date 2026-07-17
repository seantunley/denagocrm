import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  PackageCheck,
  Plus,
  ShoppingCart,
  Truck,
} from "lucide-react";
import { getPurchaseOrders } from "@/lib/stockPlatform";
import { formatZAR } from "@/lib/format";
import { hasPermission, requireAnyPermission } from "@/lib/permissions";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { ResponsiveEntityTable } from "@/components/responsive-patterns";
import { EmptyState, MetricCard, StatusPill, Surface } from "@/components/visual-system";

const TONES: Record<string, "neutral" | "info" | "success" | "warning" | "danger"> = {
  ordered: "neutral",
  confirmed: "info",
  in_transit: "info",
  partially_received: "warning",
  received: "success",
  cancelled: "danger",
};

const LABELS: Record<string, string> = {
  ordered: "Ordered",
  confirmed: "Confirmed",
  in_transit: "In transit",
  partially_received: "Part received",
  received: "Received",
  cancelled: "Cancelled",
};

export default async function PurchaseOrdersPage() {
  const user = await requireAnyPermission("stock.view", "stock.manage");
  const canManage = await hasPermission(user, "stock.manage");
  const orders = await getPurchaseOrders();
  const active = orders.filter((order) => !["received", "cancelled"].includes(order.status));
  const overdue = active.filter((order) => order.expectedAt && order.expectedAt < new Date()).length;
  const openValue = active.reduce((sum, order) => sum + order.baseCostCents + order.landedOverheadCents, 0);
  const inTransit = active.filter((order) => order.status === "in_transit").reduce((sum, order) => sum + Math.max(0, order.orderedQty - order.receivedQty), 0);

  return (
    <div className="denago-workspace space-y-6">
      <Link href="/stock" className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground">
        <ArrowLeft className="size-4" /> Back to stock
      </Link>
      <PageHeader
        title="Purchase orders"
        description={`${active.length} active supplier order${active.length === 1 ? "" : "s"} · multi-line ordering, partial receipts and landed-cost control.`}
      >
        {canManage && (
          <Link href="/stock/purchase-orders/new" className={buttonVariants({ size: "sm" })}>
            <Plus className="size-4" /> New purchase order
          </Link>
        )}
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <MetricCard icon={ShoppingCart} label="Active orders" value={active.length} detail="Not fully received" accent />
        <MetricCard icon={Truck} label="Units in transit" value={inTransit} detail="Supplier shipment pipeline" />
        <MetricCard icon={CircleDollarSign} label="Open order value" value={formatZAR(openValue)} detail="Base plus planned overhead" />
        <MetricCard icon={AlertTriangle} label="Overdue arrivals" value={overdue} detail={overdue ? "Review ETA with supplier" : "All ETAs current"} />
      </div>

      {orders.length === 0 ? (
        <EmptyState
          icon={ShoppingCart}
          title="No purchase orders yet"
          description="Create a supplier order with multiple models and colours, then receive each delivery as it arrives."
          action={canManage ? <Link href="/stock/purchase-orders/new" className={buttonVariants({ size: "sm" })}>Create purchase order</Link> : undefined}
        />
      ) : (
        <Surface className="p-0">
          <ResponsiveEntityTable>
            <table className="table-base">
              <thead>
                <tr>
                  <th>Purchase order</th>
                  <th>Status</th>
                  <th>Progress</th>
                  <th>Expected</th>
                  <th className="text-right">Value</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => {
                  const progress = order.orderedQty > 0 ? Math.min(100, Math.round((order.receivedQty / order.orderedQty) * 100)) : 0;
                  const isOverdue = order.expectedAt && order.expectedAt < new Date() && !["received", "cancelled"].includes(order.status);
                  return (
                    <tr key={order.id}>
                      <td data-primary data-label="Purchase order">
                        <Link href={`/stock/purchase-orders/${order.id}`} className="group block">
                          <span className="font-semibold text-foreground transition-colors group-hover:text-primary">{order.reference ?? "Unreferenced purchase order"}</span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">{order.supplier} · {order.lineCount || 1} line{(order.lineCount || 1) === 1 ? "" : "s"} · ordered {order.orderedAt.toLocaleDateString("en-ZA")}</span>
                        </Link>
                      </td>
                      <td data-label="Status"><StatusPill tone={TONES[order.status] ?? "neutral"}>{LABELS[order.status] ?? order.status}</StatusPill></td>
                      <td data-label="Progress" className="min-w-40">
                        <div className="flex items-center justify-between gap-3 text-xs"><span className="font-medium text-foreground">{order.receivedQty} / {order.orderedQty}</span><span className="text-muted-foreground">{progress}%</span></div>
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${progress}%` }} /></div>
                      </td>
                      <td data-label="Expected">
                        {order.expectedAt ? (
                          <span className={isOverdue ? "inline-flex items-center gap-1.5 font-semibold text-red-300" : "inline-flex items-center gap-1.5 text-muted-foreground"}>
                            {isOverdue ? <AlertTriangle className="size-3.5" /> : <Clock3 className="size-3.5" />}{order.expectedAt.toLocaleDateString("en-ZA")}
                          </span>
                        ) : <span className="text-muted-foreground">Not set</span>}
                      </td>
                      <td data-label="Value" className="text-right font-medium tabular-nums">{formatZAR(order.baseCostCents + order.landedOverheadCents)}</td>
                      <td data-actions className="text-right"><Link href={`/stock/purchase-orders/${order.id}`} className="btn-secondary btn-sm">Open</Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ResponsiveEntityTable>
        </Surface>
      )}

      <div className="grid gap-3 md:grid-cols-3">
        <Surface className="p-4" inset><div className="flex items-start gap-3"><span className="grid size-9 place-items-center rounded-xl border border-border bg-muted/40 text-muted-foreground"><ShoppingCart className="size-4" /></span><div><p className="font-medium text-foreground">Order</p><p className="mt-1 text-xs leading-5 text-muted-foreground">Build one PO with multiple models, colours and costs.</p></div></div></Surface>
        <Surface className="p-4" inset><div className="flex items-start gap-3"><span className="grid size-9 place-items-center rounded-xl border border-sky-400/20 bg-sky-400/10 text-sky-300"><Truck className="size-4" /></span><div><p className="font-medium text-foreground">Receive</p><p className="mt-1 text-xs leading-5 text-muted-foreground">Capture partial quantities and serials without closing backorders.</p></div></div></Surface>
        <Surface className="p-4" inset><div className="flex items-start gap-3"><span className="grid size-9 place-items-center rounded-xl border border-emerald-400/20 bg-emerald-400/10 text-emerald-300"><PackageCheck className="size-4" /></span><div><p className="font-medium text-foreground">Value</p><p className="mt-1 text-xs leading-5 text-muted-foreground">Allocate actual freight and duties into every received unit’s landed cost.</p></div></div></Surface>
      </div>
    </div>
  );
}
