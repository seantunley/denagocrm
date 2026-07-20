import { differenceInCalendarDays, addDays } from "date-fns";
import { ArchiveRestore, Trash2 } from "lucide-react";
import { basePrisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { restoreFromTrash } from "@/app/actions/trash";
import { TRASH_RETENTION_DAYS, type TrashModel } from "@/lib/trash";
import { contactName, formatDateTime } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import {
  MobileDataCard,
  MobileDataField,
  MobileDataFields,
  MobileDataHeader,
  MobileDataList,
  ResponsiveDataView,
} from "@/components/responsive-patterns";
import { EmptyState, StatusPill } from "@/components/visual-system";

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
  const [automotiveOn, commerceOn] = await Promise.all([
    isModuleEnabled("automotive"),
    isModuleEnabled("commerce"),
  ]);

  const [contacts, leads, vehicles, jobCards, documents, products, libraryDocs, quotes] =
    await Promise.all([
      basePrisma.contact.findMany({ where: notNull, orderBy: { deletedAt: "desc" } }),
      basePrisma.lead.findMany({ where: notNull, orderBy: { deletedAt: "desc" } }),
      automotiveOn
        ? basePrisma.vehicle.findMany({ where: notNull, orderBy: { deletedAt: "desc" } })
        : Promise.resolve([]),
      automotiveOn
        ? basePrisma.jobCard.findMany({ where: notNull, orderBy: { deletedAt: "desc" } })
        : Promise.resolve([]),
      basePrisma.document.findMany({ where: notNull, orderBy: { deletedAt: "desc" } }),
      commerceOn
        ? basePrisma.product.findMany({ where: notNull, orderBy: { deletedAt: "desc" } })
        : Promise.resolve([]),
      basePrisma.libraryDocument.findMany({ where: notNull, orderBy: { deletedAt: "desc" } }),
      basePrisma.quote.findMany({ where: notNull, orderBy: { deletedAt: "desc" } }),
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
    ...libraryDocs.map((d) => ({
      model: "libraryDocument" as const, id: d.id, label: d.name,
      detail: "Library document", deletedAt: d.deletedAt!, deletedByName: d.deletedByName, deleteReason: d.deleteReason,
    })),
    ...quotes.map((q) => ({
      model: "quote" as const, id: q.id, label: `Quote Q-${q.number}`,
      detail: "Quote", deletedAt: q.deletedAt!, deletedByName: q.deletedByName, deleteReason: q.deleteReason,
    })),
  ].sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime());

  return (
    <div className="space-y-5">
      <PageHeader
        title="Trash"
        description={`${rows.length} deleted item${rows.length === 1 ? "" : "s"} · Items are retained for ${TRASH_RETENTION_DAYS} days before permanent removal.`}
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={Trash2}
          title="Trash is empty"
          description="Deleted contacts, leads, vehicles, documents and catalogue records will appear here during their recovery window."
        />
      ) : (
        <ResponsiveDataView
          mobile={
            <MobileDataList>
              {rows.map((row) => {
                const daysLeft = Math.max(0, differenceInCalendarDays(addDays(row.deletedAt, TRASH_RETENTION_DAYS), new Date()));
                return (
                  <MobileDataCard key={`${row.model}-${row.id}`}>
                    <MobileDataHeader
                      title={row.label}
                      detail={row.detail}
                      aside={<StatusPill tone={daysLeft <= 7 ? "danger" : "neutral"}>{daysLeft} days</StatusPill>}
                    />
                    <MobileDataFields>
                      <MobileDataField label="Deleted by">{row.deletedByName ?? "Unknown"}</MobileDataField>
                      <MobileDataField label="Deleted">{formatDateTime(row.deletedAt)}</MobileDataField>
                      <MobileDataField label="Reason" wide>{row.deleteReason ?? "No reason recorded"}</MobileDataField>
                    </MobileDataFields>
                    <form action={restoreFromTrash.bind(null, row.model, row.id)}>
                      <button className="btn-secondary w-full"><ArchiveRestore className="size-4" />Restore item</button>
                    </form>
                  </MobileDataCard>
                );
              })}
            </MobileDataList>
          }
          desktop={
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
                      <StatusPill tone={daysLeft <= 7 ? "danger" : "neutral"}>{daysLeft} days</StatusPill>
                    </td>
                    <td>
                      <form action={restoreFromTrash.bind(null, r.model, r.id)}>
                        <button className="btn-secondary btn-sm"><ArchiveRestore className="size-3.5" />Restore</button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
              </table>
            </div>
          }
        />
      )}
    </div>
  );
}
