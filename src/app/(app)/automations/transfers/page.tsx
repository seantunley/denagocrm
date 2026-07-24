import { CheckCircle2, Clock3, MoveRight, PackageCheck, Truck } from "lucide-react";
import { updateStockTransferRequest } from "@/app/actions/automationPlatform";
import { PageHeader } from "@/components/page-header";
import { EmptyState, MetricCard, Surface } from "@/components/visual-system";
import { getActiveTenantId } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { hasPermission, requireAnyPermission } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function AutomationTransfersPage() {
  const user = await requireAnyPermission("stock.view", "stock.manage");
  const canManage = await hasPermission(user, "stock.manage");
  const tenantId = await getActiveTenantId();
  const rows = await prisma.stockTransferRequest.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
    take: 300,
  });
  const ids = [...new Set(rows.map((row) => row.stockUnitId))];
  const units = await prisma.stockUnit.findMany({
    where: { id: { in: ids } },
    select: { id: true, stockNumber: true, serial: true, product: { select: { name: true } } },
  });
  const unitMap = new Map(units.map((unit) => [unit.id, unit]));
  const requested = rows.filter((row) => row.status === "requested").length;
  const approved = rows.filter((row) => row.status === "approved").length;
  const inTransit = rows.filter((row) => row.status === "in_transit").length;
  const received = rows.filter((row) => row.status === "received").length;

  return (
    <div className="space-y-6">
      <PageHeader title="Automation stock transfers" description="Operational transfer requests created by Journeys. No purchase values, inventory valuation or accounting are stored here." />
      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <MetricCard icon={Clock3} label="Requested" value={requested} detail="Awaiting stock approval" accent={requested > 0} />
        <MetricCard icon={CheckCircle2} label="Approved" value={approved} detail="Ready to dispatch" />
        <MetricCard icon={Truck} label="In transit" value={inTransit} detail="Awaiting receipt" />
        <MetricCard icon={PackageCheck} label="Received" value={received} detail="Most recent 300 requests" />
      </section>

      {rows.length === 0 ? (
        <EmptyState icon={MoveRight} title="No transfer requests" description="A Create stock transfer Journey step will create a governed request here." />
      ) : (
        <Surface className="overflow-x-auto p-0">
          <table className="table-base">
            <thead><tr><th>Vehicle / stock unit</th><th>From</th><th>To</th><th>Status</th><th>Requested</th><th>Controls</th></tr></thead>
            <tbody>
              {rows.map((row) => {
                const unit = unitMap.get(row.stockUnitId);
                return (
                  <tr key={row.id}>
                    <td><p className="font-medium">{unit?.product?.name ?? "Stock unit"}</p><p className="text-xs text-muted-foreground">{unit?.stockNumber ?? unit?.serial ?? row.stockUnitId}</p>{row.notes && <p className="mt-1 max-w-md text-xs text-muted-foreground">{row.notes}</p>}</td>
                    <td>{row.fromBranch ?? "Unassigned"}</td>
                    <td>{row.toBranch}</td>
                    <td><span className={`badge ${row.status === "received" ? "bg-emerald-500/15 text-emerald-300" : row.status === "cancelled" ? "bg-red-500/15 text-red-300" : row.status === "in_transit" ? "bg-blue-500/15 text-blue-300" : "bg-amber-500/15 text-amber-300"}`}>{row.status.replaceAll("_", " ")}</span></td>
                    <td>{formatDateTime(row.createdAt)}</td>
                    <td className="min-w-56">
                      {canManage && row.status === "requested" && <div className="flex gap-2"><form action={updateStockTransferRequest.bind(null, row.id, "approved")}><button className="btn-primary btn-sm">Approve</button></form><form action={updateStockTransferRequest.bind(null, row.id, "cancelled")}><button className="btn-danger btn-sm">Cancel</button></form></div>}
                      {canManage && row.status === "approved" && <div className="flex gap-2"><form action={updateStockTransferRequest.bind(null, row.id, "in_transit")}><button className="btn-primary btn-sm">Dispatch</button></form><form action={updateStockTransferRequest.bind(null, row.id, "cancelled")}><button className="btn-danger btn-sm">Cancel</button></form></div>}
                      {canManage && row.status === "in_transit" && <div className="flex gap-2"><form action={updateStockTransferRequest.bind(null, row.id, "received")}><button className="btn-primary btn-sm">Receive</button></form><form action={updateStockTransferRequest.bind(null, row.id, "cancelled")}><button className="btn-danger btn-sm">Cancel</button></form></div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Surface>
      )}
    </div>
  );
}
