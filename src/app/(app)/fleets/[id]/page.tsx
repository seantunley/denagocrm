import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCrm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { contactName, formatDate } from "@/lib/format";
import { computeDue, dueColors, dueLabels } from "@/lib/serviceDue";
import { computeWarranty, warrantyColors, warrantyLabels } from "@/lib/warranty";
import {
  updateFleet,
  deleteFleet,
  assignVehicleToFleet,
  removeVehicleFromFleet,
} from "@/app/actions/fleets";
import { FLEET_TYPES } from "../page";

export const dynamic = "force-dynamic";

export default async function FleetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireCrm();
  const { id } = await params;

  const fleet = await prisma.fleet.findUnique({
    where: { id },
    include: {
      vehicles: {
        include: {
          contact: true,
          serviceRecords: { orderBy: { serviceDate: "desc" }, take: 1 },
          mileageLogs: { orderBy: { recordedAt: "desc" }, take: 1 },
        },
        orderBy: { model: "asc" },
      },
    },
  });
  if (!fleet) notFound();

  const [contacts, unassigned] = await Promise.all([
    prisma.contact.findMany({ orderBy: { firstName: "asc" }, take: 500 }),
    prisma.vehicle.findMany({
      where: { fleetId: null },
      include: { contact: true },
      orderBy: { model: "asc" },
      take: 500,
    }),
  ]);
  const primary = fleet.contactId ? contacts.find((c) => c.id === fleet.contactId) : null;

  const dues = fleet.vehicles.map((v) => computeDue(v));
  const dueCount = dues.filter((d) => d.status === "overdue" || d.status === "due_soon").length;
  const inWarranty = fleet.vehicles.filter((v) => computeWarranty(v).status === "active").length;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/fleets" className="text-sm text-slate-400 hover:text-slate-200">
          ← Fleets
        </Link>
        <div className="flex flex-wrap items-center gap-3 mt-1">
          <h1 className="text-2xl font-bold">{fleet.name}</h1>
          {fleet.type && <span className="badge bg-orange-600/15 text-orange-300 capitalize">{fleet.type}</span>}
        </div>
        {primary && (
          <p className="text-sm text-slate-400 mt-1">
            Primary contact:{" "}
            <Link href={`/contacts/${primary.id}`} className="text-orange-400 hover:underline">
              {contactName(primary)}
            </Link>
          </p>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-slate-400">Carts</p>
          <p className="text-3xl font-bold mt-1">{fleet.vehicles.length}</p>
        </div>
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-slate-400">Due for service</p>
          <p className="text-3xl font-bold mt-1 text-amber-300">{dueCount}</p>
        </div>
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-slate-400">In warranty</p>
          <p className="text-3xl font-bold mt-1 text-emerald-300">{inWarranty}</p>
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          <div className="card p-0 overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Cart</th>
                  <th>Owner / contact</th>
                  <th>Service</th>
                  <th>Warranty</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {fleet.vehicles.length === 0 && (
                  <tr>
                    <td colSpan={5} className="text-center text-slate-400 py-8">
                      No carts in this fleet yet — add some on the right.
                    </td>
                  </tr>
                )}
                {fleet.vehicles.map((v) => {
                  const due = computeDue(v);
                  const w = computeWarranty(v);
                  return (
                    <tr key={v.id}>
                      <td>
                        <Link href={`/vehicles/${v.id}`} className="text-orange-400 hover:underline font-medium">
                          {v.model}
                        </Link>
                        {v.regNumber && <span className="text-slate-500 text-xs ml-1">{v.regNumber}</span>}
                      </td>
                      <td>{contactName(v.contact)}</td>
                      <td>
                        <span className={`badge ${dueColors[due.status]}`}>{dueLabels[due.status]}</span>
                      </td>
                      <td>
                        <span className={`badge ${warrantyColors[w.status]}`}>{warrantyLabels[w.status]}</span>
                      </td>
                      <td className="text-right">
                        <form action={removeVehicleFromFleet.bind(null, v.id, fleet.id)}>
                          <button className="text-xs text-red-400 hover:text-red-300">Remove</button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-4">
          <div className="card">
            <h2 className="font-semibold mb-3">Add a cart</h2>
            <form action={assignVehicleToFleet.bind(null, fleet.id)} className="flex gap-2">
              <select name="vehicleId" className="input flex-1" required defaultValue="">
                <option value="" disabled>
                  Select a cart…
                </option>
                {unassigned.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.model} — {contactName(v.contact)}
                  </option>
                ))}
              </select>
              <button className="btn-primary btn-sm">Add</button>
            </form>
          </div>

          <div className="card">
            <h2 className="font-semibold mb-3">Fleet details</h2>
            <form action={updateFleet.bind(null, fleet.id)} className="space-y-2">
              <input name="name" className="input" defaultValue={fleet.name} />
              <select name="type" className="input" defaultValue={fleet.type ?? "estate"}>
                {FLEET_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <select name="contactId" className="input" defaultValue={fleet.contactId ?? ""}>
                <option value="">Primary contact (optional)…</option>
                {contacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {contactName(c)}
                  </option>
                ))}
              </select>
              <textarea name="notes" className="input" rows={2} defaultValue={fleet.notes ?? ""} placeholder="Notes" />
              <button className="btn-secondary btn-sm">Save</button>
            </form>
          </div>

          <form action={deleteFleet}>
            <input type="hidden" name="id" value={fleet.id} />
            <button className="text-xs text-red-400 hover:text-red-300">
              Delete fleet (carts are kept)
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
