import Link from "next/link";
import { prisma } from "@/lib/db";
import { computeDue, dueColors, dueLabels } from "@/lib/serviceDue";
import { contactName, formatDate } from "@/lib/format";
import ServiceReminderButton from "@/components/ServiceReminderButton";
import { PageHeader } from "@/components/page-header";
import {
  getAccessibleVehicleIds,
  hasPermission,
  requireAnyPermission,
} from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function ServiceDuePage() {
  const user = await requireAnyPermission("vehicles.view_all", "vehicles.view_owned");
  const [vehicleIds, canManage] = await Promise.all([
    getAccessibleVehicleIds(user),
    hasPermission(user, "vehicles.manage"),
  ]);
  const vehicles = await prisma.vehicle.findMany({
    where: vehicleIds === null ? {} : { id: { in: vehicleIds } },
    include: {
      contact: true,
      serviceRecords: { orderBy: { serviceDate: "desc" }, take: 1 },
      mileageLogs: { orderBy: { recordedAt: "desc" }, take: 1 },
    },
  });

  const rows = vehicles
    .map((vehicle) => ({ vehicle, due: computeDue(vehicle) }))
    .filter(({ due }) => due.status === "overdue" || due.status === "due_soon")
    .sort((a, b) => {
      if (a.due.status !== b.due.status) return a.due.status === "overdue" ? -1 : 1;
      return (a.due.daysRemaining ?? 1e9) - (b.due.daysRemaining ?? 1e9);
    });
  const overdue = rows.filter((row) => row.due.status === "overdue").length;
  const soon = rows.length - overdue;

  return (
    <div className="space-y-6">
      <PageHeader title="Service due" description={`${overdue} accessible overdue · ${soon} due soon${canManage ? " · Book workshop time or send a customer reminder." : ""}`} />
      <div className="grid grid-cols-3 gap-3">
        <div className="card"><p className="text-xs uppercase tracking-wide text-slate-400">Overdue</p><p className="text-3xl font-bold mt-1 text-red-300">{overdue}</p></div>
        <div className="card"><p className="text-xs uppercase tracking-wide text-slate-400">Due soon</p><p className="text-3xl font-bold mt-1 text-amber-300">{soon}</p></div>
        <div className="card"><p className="text-xs uppercase tracking-wide text-slate-400">Total to action</p><p className="text-3xl font-bold mt-1">{rows.length}</p></div>
      </div>

      <div className="card p-0 overflow-x-auto">
        <table className="table-base">
          <thead><tr><th>Cart</th><th>Owner</th><th>Status</th><th>Due</th><th className="text-right">Km left</th><th>Last service</th><th /></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={7} className="text-center text-slate-400 py-8">Nothing accessible is due right now.</td></tr>}
            {rows.map(({ vehicle, due }) => {
              const last = vehicle.serviceRecords[0];
              return (
                <tr key={vehicle.id}>
                  <td><Link href={`/vehicles/${vehicle.id}`} className="font-medium text-orange-400 hover:underline">{vehicle.model}</Link>{vehicle.regNumber && <span className="text-slate-500 text-xs ml-1">{vehicle.regNumber}</span>}</td>
                  <td><Link href={`/contacts/${vehicle.contactId}`} className="hover:underline">{contactName(vehicle.contact)}</Link></td>
                  <td><span className={`badge ${dueColors[due.status]}`}>{dueLabels[due.status]}</span></td>
                  <td className="text-slate-300">{due.nextDueDate ? formatDate(due.nextDueDate) : "—"}{due.daysRemaining != null && <span className="text-xs text-slate-500 ml-1">({due.daysRemaining < 0 ? `${-due.daysRemaining}d ago` : `in ${due.daysRemaining}d`})</span>}</td>
                  <td className="text-right text-slate-300">{due.kmRemaining != null ? due.kmRemaining.toLocaleString() : "—"}</td>
                  <td className="text-slate-400">{last ? formatDate(last.serviceDate) : "never"}</td>
                  <td className="text-right whitespace-nowrap">
                    {canManage && <><Link href={`/jobcards/new?vehicleId=${vehicle.id}`} className="btn-primary btn-sm mr-2">Book</Link><ServiceReminderButton vehicleId={vehicle.id} /></>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
