import Link from "next/link";
import { notFound } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  PackageCheck,
  ReceiptText,
  ShoppingCart,
  Truck,
} from "lucide-react";
import {
  cancelPurchaseOrder,
  confirmPurchaseOrder,
  markPurchaseOrderInTransit,
  receivePurchaseOrder,
} from "@/app/actions/stock";
import { formatZAR } from "@/lib/format";
import { getPurchaseOrderDetail, getStockLocations } from "@/lib/stockPlatform";
import { hasPermission, requireAnyPermission } from "@/lib/permissions";
import StockReceiptForm from "@/components/StockReceiptForm";
import { PageHeader } from "@/components/page-header";
import { ResponsiveEntityTable } from "@/components/responsive-patterns";
import {
  MetricCard,
  SectionHeading,
  StatusPill,
  Surface,
} from "@/components/visual-system";
import ModalTrigger from "@/components/Modal";

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

export default async function PurchaseOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireAnyPermission("stock.view", "stock.manage");
  const canManage = await hasPermission(user, "stock.manage");
  const { id } = await params;
  const [order, locations] = await Promise.all([getPurchaseOrderDetail(id), getStockLocations()]);
  if (!order) notFound();
  const remaining = Math.max(0, order.orderedQty - order.receivedQty);
  const progress = order.orderedQty > 0 ? Math.min(100, Math.round((order.receivedQty / order.orderedQty) * 100)) : 0;
  const totalValue = order.baseCostCents + order.landedOverheadCents;
  const overdue = order.expectedAt && order.expectedAt < new Date() && !["received", "cancelled"].includes(order.status);

  return (
    <div className="denago-workspace space-y-6">
      <Link href="/stock/purchase-orders" className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground">
        <ArrowLeft className="size-4" /> Back to purchase orders
      </Link>
      <PageHeader
        title={order.reference ?? "Purchase order"}
        description={`${order.supplier} · ordered ${order.orderedAt.toLocaleDateString("en-ZA")}${order.expectedAt ? ` · expected ${order.expectedAt.toLocaleDateString("en-ZA")}` : ""}`}
      >
        <StatusPill tone={TONES[order.status] ?? "neutral"}>{LABELS[order.status] ?? order.status}</StatusPill>
        {canManage && order.status === "ordered" && <form action={confirmPurchaseOrder.bind(null, id)}><button className="btn-secondary btn-sm">Confirm supplier order</button></form>}
        {canManage && ["ordered", "confirmed"].includes(order.status) && <form action={markPurchaseOrderInTransit.bind(null, id)}><button className="btn-primary btn-sm"><Truck className="size-4" /> Mark in transit</button></form>}
        {canManage && !["received", "cancelled"].includes(order.status) && (
          <ModalTrigger label="Cancel" title="Cancel purchase order" buttonClass="btn-danger btn-sm">
            <form action={cancelPurchaseOrder.bind(null, id)} className="card space-y-3">
              <p className="text-sm text-muted-foreground">Received units remain in stock. Only the outstanding supplier order is cancelled.</p>
              <textarea name="reason" required className="input min-h-24" placeholder="Cancellation reason" />
              <button className="btn-danger w-full">Cancel purchase order</button>
            </form>
          </ModalTrigger>
        )}
      </PageHeader>

      {overdue && (
        <Surface className="border-amber-400/20 bg-amber-400/5 p-4">
          <div className="flex items-start gap-3"><AlertTriangle className="mt-0.5 size-4 text-amber-300" /><div><p className="font-semibold text-amber-100">Expected arrival is overdue</p><p className="mt-1 text-xs text-amber-100/70">Review the ETA with {order.supplier} before relying on these units in the demand forecast.</p></div></div>
        </Surface>
      )}

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
        <MetricCard icon={ShoppingCart} label="Ordered units" value={order.orderedQty} detail={`${order.lineCount} line${order.lineCount === 1 ? "" : "s"}`} accent />
        <MetricCard icon={PackageCheck} label="Received" value={order.receivedQty} detail={`${progress}% complete`} />
        <MetricCard icon={Truck} label="Outstanding" value={remaining} detail="Still due from supplier" />
        <MetricCard icon={CircleDollarSign} label="Order value" value={formatZAR(totalValue)} detail="Base plus landed overhead" />
        <MetricCard icon={ReceiptText} label="Goods receipts" value={order.receipts.length} detail={order.supplierInvoiceRef ?? "No supplier invoice ref"} />
      </div>

      <Surface className="p-5">
        <SectionHeading title="Order progress" description="Each line remains open until its full ordered quantity has been physically received." />
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${progress}%` }} /></div>
        <div className="mt-5 overflow-hidden rounded-2xl border border-border">
          <ResponsiveEntityTable>
            <table className="table-base">
              <thead><tr><th>Model</th><th>Colour</th><th className="text-right">Ordered</th><th className="text-right">Received</th><th className="text-right">Open</th><th className="text-right">Unit cost</th><th className="text-right">Line value</th></tr></thead>
              <tbody>
                {order.lines.map((line) => (
                  <tr key={line.id}>
                    <td data-primary data-label="Model"><span className="font-semibold text-foreground">{line.productName}</span>{line.notes && <span className="mt-0.5 block text-xs text-muted-foreground">{line.notes}</span>}</td>
                    <td data-label="Colour" className="text-muted-foreground">{line.color ?? "Not specified"}</td>
                    <td data-label="Ordered" className="text-right tabular-nums">{line.orderedQty}</td>
                    <td data-label="Received" className="text-right tabular-nums text-emerald-300">{line.receivedQty}</td>
                    <td data-label="Open" className="text-right font-semibold tabular-nums">{Math.max(0, line.orderedQty - line.receivedQty)}</td>
                    <td data-label="Unit cost" className="text-right tabular-nums">{formatZAR(line.unitCostCents)}</td>
                    <td data-label="Line value" className="text-right font-medium tabular-nums">{formatZAR(line.unitCostCents * line.orderedQty)}</td>
                  </tr>
                ))}
                {order.lines.length === 0 && <tr><td colSpan={7} data-empty className="py-8 text-center text-muted-foreground">Legacy purchase order — units were created when the order was opened.</td></tr>}
              </tbody>
            </table>
          </ResponsiveEntityTable>
        </div>
      </Surface>

      {canManage && !["received", "cancelled"].includes(order.status) && (
        <Surface className="p-5">
          {order.lines.length > 0 ? (
            <StockReceiptForm
              action={receivePurchaseOrder.bind(null, id)}
              lines={order.lines}
              locations={locations.map((location) => ({ id: location.id, name: location.name, isDefault: location.isDefault }))}
            />
          ) : (
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div><p className="font-semibold text-foreground">Receive legacy purchase order</p><p className="mt-1 text-sm text-muted-foreground">All existing incoming placeholders on this order will move to available stock together.</p></div>
              <form action={receivePurchaseOrder.bind(null, id)}><button className="btn-primary"><PackageCheck className="size-4" /> Mark all received</button></form>
            </div>
          )}
        </Surface>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Surface className="p-5">
          <SectionHeading title="Goods receipt history" description="Every arrival batch retains its own supplier reference, overhead and quantity." action={<ReceiptText className="size-5 text-primary" />} />
          <div className="mt-4 space-y-3">
            {order.receipts.map((receipt) => (
              <div key={receipt.id} className="rounded-2xl border border-border bg-background/30 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-semibold text-foreground">{receipt.reference ?? "Goods receipt"}</p><p className="mt-1 text-xs text-muted-foreground">{receipt.receivedAt.toLocaleString("en-ZA")} · {receipt.totalQty} unit{receipt.totalQty === 1 ? "" : "s"}</p></div><StatusPill tone="success">Received</StatusPill></div>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"><span>Freight {formatZAR(receipt.freightCents)}</span><span>Duties {formatZAR(receipt.dutiesCents)}</span><span>Other {formatZAR(receipt.otherCostsCents)}</span></div>
                {receipt.notes && <p className="mt-3 text-sm text-muted-foreground">{receipt.notes}</p>}
              </div>
            ))}
            {order.receipts.length === 0 && <p className="text-sm text-muted-foreground">No physical receipt has been recorded yet.</p>}
          </div>
        </Surface>

        <aside className="space-y-4 xl:sticky xl:top-6 xl:self-start">
          <Surface className="p-5">
            <SectionHeading title="Commercial summary" />
            <dl className="mt-4 space-y-3 text-sm">
              {[
                ["Supplier", order.supplier],
                ["Currency", order.currency],
                ["Base order", formatZAR(order.baseCostCents)],
                ["Freight", formatZAR(order.freightCents)],
                ["Duties", formatZAR(order.dutiesCents)],
                ["Other costs", formatZAR(order.otherCostsCents)],
                ["Total", formatZAR(totalValue)],
              ].map(([label, value]) => <div key={label} className="flex items-center justify-between gap-3 border-b border-border pb-2 last:border-0"><dt className="text-muted-foreground">{label}</dt><dd className="font-medium text-foreground">{value}</dd></div>)}
            </dl>
          </Surface>
          {order.notes && <Surface className="p-5" inset><SectionHeading title="Order notes" /><p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{order.notes}</p></Surface>}
          {order.status === "received" && <Surface className="border-emerald-400/20 bg-emerald-400/5 p-5"><div className="flex items-start gap-3"><CheckCircle2 className="mt-0.5 size-5 text-emerald-300" /><div><p className="font-semibold text-emerald-100">Order fully received</p><p className="mt-1 text-xs leading-5 text-emerald-100/70">All physical units now have stock records, landed costs and goods-receipt ledger entries.</p></div></div></Surface>}
          {order.expectedAt && <Surface className="p-5" inset><div className="flex items-center gap-3"><Clock3 className="size-4 text-muted-foreground" /><div><p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Expected arrival</p><p className="mt-1 font-medium text-foreground">{order.expectedAt.toLocaleDateString("en-ZA")}</p></div></div></Surface>}
        </aside>
      </div>
    </div>
  );
}
