import { differenceInCalendarDays, addDays } from "date-fns";
import { basePrisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { restoreFromTrash } from "@/app/actions/trash";
import { TRASH_RETENTION_DAYS, type TrashModel } from "@/lib/trash";
import { contactName, formatDateTime } from "@/lib/format";

type Row = {
  model: TrashModel;
  id: string;
  label: string;
  detail: string;
  deletedAt: Date;
  deletedByName: string | null;
  deleteReason: string | null;
};

export default async function TrashPage() {
  await requireUser();
  const notNull = { deletedAt: { not: null } } as const;

  const [contacts, leads, vehicles, jobCards, documents, products] = await Promise.all([
    basePrisma.contact.findMany({ where: notNull, orderBy: { deletedAt: "desc" } }),
    basePrisma.lead.findMany({ where: notNull, orderBy: { deletedAt: "desc" } }),
    basePrisma.vehicle.findMany({ where: notNull, orderBy: { deletedAt: "desc" } }),
    basePrisma.jobCard.findMany({ where: notNull, orderBy: { deletedAt: "desc" } }),
    basePrisma.document.findMany({ where: notNull, orderBy: { deletedAt: "desc" } }),
    basePrisma.product.findMany({ where: notNull, orderBy: { deletedAt: "desc" } }),
  ]);

  const rows: Row[] = [
    ...contacts.map((c) => ({
      model: "contact" as const, id: c.id, label: contactName(c),
      detail: "Contact", deletedAt: c.deletedAt!, deletedByName: c.deletedByName, deleteReason: c.deleteReason,
    })),
    ...leads.map((l) => ({
      model: "lead" as const, id: l.id, label: l.title,
      detail: `Lead — ${l.name}`, deletedAt: l.deletedAt!, deletedByName: l.deletedByName, deleteReason: l.deleteReason,
    })),
    ...vehicles.map((v) => ({
      model: "vehicle" as const, id: v.id, label: v.model,
      detail: `Vehicle${v.vin ? ` — ${v.vin}` : ""}`, deletedAt: v.deletedAt!, deletedByName: v.deletedByName, deleteReason: v.deleteReason,
    })),
    ...jobCards.map((j) => ({
      model: "jobCard" as const, id: j.id, label: `Job card #${j.number}`,
      detail: j.description.slice(0, 60), deletedAt: j.deletedAt!, deletedByName: j.deletedByName, deleteReason: j.deleteReason,
    })),
    ...documents.map((d) => ({
      model: "document" as const, id: d.id, label: d.fileName,
      detail: "Document", deletedAt: d.deletedAt!, deletedByName: d.deletedByName, deleteReason: d.deleteReason,
    })),
    ...products.map((p) => ({
      model: "product" as const, id: p.id, label: p.name,
      detail: "Product", deletedAt: p.deletedAt!, deletedByName: p.deletedByName, deleteReason: p.deleteReason,
    })),
  ].sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime());

  return (
    <div className="space-y-5 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold">🗑 Trash</h1>
        <p className="text-sm text-slate-400 mt-1">
          Deleted items are kept for {TRASH_RETENTION_DAYS} days, then removed permanently.
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="card text-center py-10">
          <p className="text-slate-400">The trash is empty.</p>
        </div>
      ) : (
        <div className="card p-0 overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr>
                <th>Item</th>
                <th>Deleted by</th>
                <th>Reason</th>
                <th>Deleted</th>
                <th>Purges in</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const purgeDate = addDays(r.deletedAt, TRASH_RETENTION_DAYS);
                const daysLeft = Math.max(0, differenceInCalendarDays(purgeDate, new Date()));
                return (
                  <tr key={`${r.model}-${r.id}`}>
                    <td>
                      <p className="font-medium">{r.label}</p>
                      <p className="text-xs text-slate-400">{r.detail}</p>
                    </td>
                    <td>{r.deletedByName ?? "—"}</td>
                    <td className="max-w-56">
                      <span className="text-slate-400 text-xs">{r.deleteReason ?? "—"}</span>
                    </td>
                    <td className="text-slate-400 text-xs">{formatDateTime(r.deletedAt)}</td>
                    <td>
                      <span
                        className={`badge ${
                          daysLeft <= 7 ? "bg-red-500/15 text-red-300" : "bg-slate-800 text-slate-300"
                        }`}
                      >
                        {daysLeft} days
                      </span>
                    </td>
                    <td>
                      <form action={restoreFromTrash.bind(null, r.model, r.id)}>
                        <button className="btn-secondary btn-sm">↩ Restore</button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
