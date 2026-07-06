import Link from "next/link";
import { prisma } from "@/lib/db";
import { contactName, formatDate } from "@/lib/format";
import { computeDue, dueColors, dueLabels } from "@/lib/serviceDue";

export default async function VehiclesPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const { filter } = await searchParams;
  const vehicles = await prisma.vehicle.findMany({
    orderBy: { createdAt: "desc" },
    include: { contact: true, serviceRecords: true, mileageLogs: true },
  });

  const rows = vehicles
    .map((v) => ({ vehicle: v, due: computeDue(v) }))
    .filter((r) =>
      filter === "due" ? r.due.status === "overdue" || r.due.status === "due_soon" : true
    );

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-2xl font-bold">Vehicles</h1>
        <div className="flex gap-2">
          <Link
            href={filter === "due" ? "/vehicles" : "/vehicles?filter=due"}
            className={filter === "due" ? "btn-primary" : "btn-secondary"}
          >
            {filter === "due" ? "Showing due only" : "Show due for service"}
          </Link>
          <Link href="/vehicles/new" className="btn-primary">
            + Register vehicle
          </Link>
        </div>
      </div>

      <div className="card p-0 overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>Model</th>
              <th>Owner</th>
              <th>VIN / Serial</th>
              <th>Current km</th>
              <th>Next service</th>
              <th>Status</th>
              <th>Purchased</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center text-slate-400 py-8">
                  {filter === "due" ? "Nothing due for service." : "No vehicles registered yet."}
                </td>
              </tr>
            )}
            {rows.map(({ vehicle: v, due }) => (
              <tr key={v.id}>
                <td>
                  <Link href={`/vehicles/${v.id}`} className="font-medium text-orange-400 hover:underline">
                    {v.model}
                  </Link>
                  {v.color && <span className="text-xs text-slate-400 ml-2">{v.color}</span>}
                </td>
                <td>
                  <Link href={`/contacts/${v.contactId}`} className="text-orange-400 hover:underline">
                    {contactName(v.contact)}
                  </Link>
                </td>
                <td className="font-mono text-xs">{v.vin ?? "—"}</td>
                <td>{due.currentKm != null ? `${due.currentKm.toLocaleString()} km` : "—"}</td>
                <td className="text-slate-400">
                  {[
                    due.nextDueDate ? formatDate(due.nextDueDate) : null,
                    due.nextDueKm != null ? `${due.nextDueKm.toLocaleString()} km` : null,
                  ]
                    .filter(Boolean)
                    .join(" / ") || "—"}
                </td>
                <td>
                  <span className={`badge ${dueColors[due.status]}`}>{dueLabels[due.status]}</span>
                </td>
                <td className="text-slate-400">{formatDate(v.purchaseDate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
