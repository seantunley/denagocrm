import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import {
  deleteVehicle,
  addMileage,
  addServiceRecord,
  deleteServiceRecord,
} from "@/app/actions/vehicles";
import DocumentsPanel from "@/components/DocumentsPanel";
import ConfirmDelete from "@/components/ConfirmDelete";
import { contactName, formatDate, formatDateTime } from "@/lib/format";
import { computeDue, dueColors, dueLabels } from "@/lib/serviceDue";

export default async function VehicleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const vehicle = await prisma.vehicle.findUnique({
    where: { id },
    include: {
      contact: true,
      product: true,
      mileageLogs: { orderBy: { recordedAt: "desc" } },
      serviceRecords: {
        orderBy: { serviceDate: "desc" },
        include: { performedBy: true, jobCard: true },
      },
      jobCards: { where: { deletedAt: null }, orderBy: { openedAt: "desc" } },
      documents: { where: { deletedAt: null }, include: { uploadedBy: true }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!vehicle) notFound();
  const due = computeDue(vehicle);
  const path = `/vehicles/${vehicle.id}`;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">
              {vehicle.model}
              {vehicle.color ? ` — ${vehicle.color}` : ""}
            </h1>
            <span className={`badge ${dueColors[due.status]}`}>{dueLabels[due.status]}</span>
          </div>
          <p className="text-sm text-slate-400 mt-0.5">
            Owner:{" "}
            <Link href={`/contacts/${vehicle.contactId}`} className="text-orange-400 hover:underline">
              {contactName(vehicle.contact)}
            </Link>
            {vehicle.vin ? ` · VIN ${vehicle.vin}` : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href={`/jobcards/new?vehicleId=${vehicle.id}`}
            className="btn-primary"
          >
            + Job card
          </Link>
          <Link href={`/vehicles/${vehicle.id}/edit`} className="btn-secondary">
            Edit
          </Link>
          <ConfirmDelete
            action={deleteVehicle.bind(null, vehicle.id)}
            title={`Delete vehicle ${vehicle.model}?`}
            description="The vehicle (with its service history and job cards) moves to the Trash and can be restored for 60 days."
          />
        </div>
      </div>

      <div className="grid md:grid-cols-4 gap-4">
        <div className="card">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Current km</p>
          <p className="text-xl font-bold mt-1">
            {due.currentKm != null ? `${due.currentKm.toLocaleString()} km` : "—"}
          </p>
        </div>
        <div className="card">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Next service due
          </p>
          <p className="text-xl font-bold mt-1">{formatDate(due.nextDueDate)}</p>
          {due.daysRemaining != null && (
            <p className="text-xs text-slate-400">
              {due.daysRemaining >= 0 ? `in ${due.daysRemaining} days` : `${-due.daysRemaining} days overdue`}
            </p>
          )}
        </div>
        <div className="card">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Due at</p>
          <p className="text-xl font-bold mt-1">
            {due.nextDueKm != null ? `${due.nextDueKm.toLocaleString()} km` : "—"}
          </p>
          {due.kmRemaining != null && (
            <p className="text-xs text-slate-400">
              {due.kmRemaining >= 0
                ? `${due.kmRemaining.toLocaleString()} km remaining`
                : `${(-due.kmRemaining).toLocaleString()} km over`}
            </p>
          )}
        </div>
        <div className="card">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Intervals</p>
          <p className="text-sm font-medium mt-1">
            {vehicle.serviceIntervalKm ? `${vehicle.serviceIntervalKm} km` : "—"} /{" "}
            {vehicle.serviceIntervalMonths ? `${vehicle.serviceIntervalMonths} months` : "—"}
          </p>
          <p className="text-xs text-slate-400 mt-1">
            Purchased {formatDate(vehicle.purchaseDate)}
            {vehicle.warrantyMonths ? ` · ${vehicle.warrantyMonths} mo warranty` : ""}
          </p>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-6 items-start">
        <div className="space-y-6">
          <div className="card">
            <h2 className="font-semibold mb-4">Service history</h2>
            <form
              action={addServiceRecord.bind(null, vehicle.id)}
              className="mb-4 space-y-3 rounded-lg bg-slate-800/40 p-4 border border-slate-800"
            >
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="label">Summary *</label>
                  <input name="summary" className="input" required placeholder="e.g. 1,000 km first service" />
                </div>
                <div>
                  <label className="label">Date</label>
                  <input type="date" name="serviceDate" className="input" />
                </div>
                <div>
                  <label className="label">Mileage (km)</label>
                  <input type="number" name="km" className="input" />
                </div>
                <div>
                  <label className="label">Next due (km)</label>
                  <input type="number" name="nextDueKm" className="input" placeholder="auto if blank" />
                </div>
                <div>
                  <label className="label">Next due (date)</label>
                  <input type="date" name="nextDueDate" className="input" />
                </div>
                <div className="col-span-2">
                  <label className="label">Details</label>
                  <textarea name="details" className="input" rows={2} />
                </div>
              </div>
              <button className="btn-primary btn-sm">Add service record</button>
            </form>

            {vehicle.serviceRecords.length === 0 ? (
              <p className="text-sm text-slate-400">No services recorded.</p>
            ) : (
              <ol className="space-y-3">
                {vehicle.serviceRecords.map((s) => (
                  <li key={s.id} className="border-l-2 border-blue-200 pl-3 group relative">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-sm font-semibold">{s.summary}</span>
                      <span className="text-xs text-slate-400">
                        {formatDate(s.serviceDate)}
                        {s.km != null ? ` · ${s.km.toLocaleString()} km` : ""}
                        {s.performedBy ? ` · ${s.performedBy.name}` : ""}
                      </span>
                    </div>
                    {s.details && (
                      <p className="text-sm text-slate-400 whitespace-pre-wrap">{s.details}</p>
                    )}
                    <p className="text-xs text-slate-400">
                      {s.nextDueDate ? `Next due ${formatDate(s.nextDueDate)}` : ""}
                      {s.nextDueKm != null ? ` at ${s.nextDueKm.toLocaleString()} km` : ""}
                      {s.jobCard ? ` · Job card #${s.jobCard.number}` : ""}
                    </p>
                    <div className="absolute right-0 top-0 opacity-0 group-hover:opacity-100">
                      <ConfirmDelete
                        action={deleteServiceRecord.bind(null, s.id, vehicle.id)}
                        title={`Delete service record “${s.summary}”?`}
                        description="This cannot be undone. The deletion is recorded in the customer history."
                        trigger="✕"
                        triggerClass="text-xs text-slate-600 hover:text-red-500 cursor-pointer"
                      />
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div className="card">
            <h2 className="font-semibold mb-3">Job cards</h2>
            {vehicle.jobCards.length === 0 ? (
              <p className="text-sm text-slate-400">No job cards.</p>
            ) : (
              <ul className="divide-y divide-slate-800">
                {vehicle.jobCards.map((j) => (
                  <li key={j.id} className="py-2 flex items-center gap-3">
                    <Link
                      href={`/jobcards/${j.id}`}
                      className="text-sm font-medium text-orange-400 hover:underline"
                    >
                      #{j.number}
                    </Link>
                    <span className="text-sm text-slate-400 flex-1 truncate">{j.description}</span>
                    <span
                      className={`badge ${
                        j.status === "completed"
                          ? "bg-emerald-500/15 text-emerald-300"
                          : j.status === "in_progress"
                          ? "bg-amber-500/15 text-amber-300"
                          : "bg-slate-800 text-slate-400"
                      }`}
                    >
                      {j.status.replace("_", " ")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="space-y-6">
          <div className="card">
            <h2 className="font-semibold mb-4">Mileage log</h2>
            <form action={addMileage.bind(null, vehicle.id)} className="flex gap-2 mb-4">
              <input
                type="number"
                name="km"
                className="input w-32"
                placeholder="km"
                required
              />
              <input name="note" className="input flex-1" placeholder="Note (optional)" />
              <button className="btn-primary btn-sm">Log</button>
            </form>
            {vehicle.mileageLogs.length === 0 ? (
              <p className="text-sm text-slate-400">No readings yet.</p>
            ) : (
              <ul className="divide-y divide-slate-800">
                {vehicle.mileageLogs.slice(0, 12).map((m) => (
                  <li key={m.id} className="py-1.5 flex items-center gap-3 text-sm">
                    <span className="font-mono font-medium w-24">{m.km.toLocaleString()} km</span>
                    <span className="text-slate-400 flex-1">{m.note ?? ""}</span>
                    <span className="text-xs text-slate-400">{formatDateTime(m.recordedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <DocumentsPanel documents={vehicle.documents} vehicleId={vehicle.id} revalidate={path} />

          {vehicle.notes && (
            <div className="card">
              <h2 className="font-semibold mb-2">Notes</h2>
              <p className="text-sm text-slate-400 whitespace-pre-wrap">{vehicle.notes}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
