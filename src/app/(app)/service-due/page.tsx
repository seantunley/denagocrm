import Link from "next/link";
import { requireWorkshop } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { computeDue, dueColors, dueLabels } from "@/lib/serviceDue";
import { contactName, formatDate } from "@/lib/format";
import ServiceReminderButton from "@/components/ServiceReminderButton";

export const dynamic = "force-dynamic";

export default async function ServiceDuePage() {
  await requireWorkshop();

  const vehicles = await prisma.vehicle.findMany({
    include: {
      contact: true,
      serviceRecords: { orderBy: { serviceDate: "desc" }, take: 1 },
      mileageLogs: { orderBy: { recordedAt: "desc" }, take: 1 },
    },
  });

  const rows = vehicles
    .map((v) => ({ v, due: computeDue(v) }))
    .filter(({ due }) => due.status === "overdue" || due.status === "due_soon")
    .sort((a, b) => {
      // overdue first, then soonest
      if (a.due.status !== b.due.status) return a.due.status === "overdue" ? -1 : 1;
      return (a.due.daysRemaining ?? 1e9) - (b.due.daysRemaining ?? 1e9);
    });

  const overdue = rows.filter((r) => r.due.status === "overdue").length;
  const soon = rows.length - overdue;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Service due</h1>
        <p className="text-sm text-slate-400 mt-0.5">
          Carts due or overdue for a service. Book them in or send a reminder — the nightly job
          also emails customers automatically once per due cycle.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-slate-400">Overdue</p>
          <p className="text-3xl font-bold mt-1 text-red-300">{overdue}</p>
        </div>
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-slate-400">Due soon</p>
          <p className="text-3xl font-bold mt-1 text-amber-300">{soon}</p>
        </div>
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-slate-400">Total to action</p>
          <p className="text-3xl font-bold mt-1">{rows.length}</p>
        </div>
      </div>

      <div className="card p-0 overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>Cart</th>
              <th>Owner</th>
              <th>Status</th>
              <th>Due</th>
              <th className="text-right">Km left</th>
              <th>Last service</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center text-slate-400 py-8">
                  Nothing due right now — every cart is up to date. 🎉
                </td>
              </tr>
            )}
            {rows.map(({ v, due }) => {
              const last = v.serviceRecords[0];
              return (
                <tr key={v.id}>
                  <td>
                    <Link href={`/vehicles/${v.id}`} className="font-medium text-orange-400 hover:underline">
                      {v.model}
                    </Link>
                    {v.regNumber && <span className="text-slate-500 text-xs ml-1">{v.regNumber}</span>}
                  </td>
                  <td>
                    <Link href={`/contacts/${v.contactId}`} className="hover:underline">
                      {contactName(v.contact)}
                    </Link>
                  </td>
                  <td>
                    <span className={`badge ${dueColors[due.status]}`}>{dueLabels[due.status]}</span>
                  </td>
                  <td className="text-slate-300">
                    {due.nextDueDate ? formatDate(due.nextDueDate) : "—"}
                    {due.daysRemaining != null && (
                      <span className="text-xs text-slate-500 ml-1">
                        ({due.daysRemaining < 0 ? `${-due.daysRemaining}d ago` : `in ${due.daysRemaining}d`})
                      </span>
                    )}
                  </td>
                  <td className="text-right text-slate-300">
                    {due.kmRemaining != null ? due.kmRemaining.toLocaleString() : "—"}
                  </td>
                  <td className="text-slate-400">{last ? formatDate(last.serviceDate) : "never"}</td>
                  <td className="text-right whitespace-nowrap">
                    <Link href={`/jobcards/new?vehicleId=${v.id}`} className="btn-primary btn-sm mr-2">
                      Book
                    </Link>
                    <ServiceReminderButton vehicleId={v.id} />
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
