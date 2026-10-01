import { differenceInCalendarDays, addDays } from "date-fns";
import { ArchiveRestore, Trash2 } from "lucide-react";
import { basePrisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { restoreFromTrash } from "@/app/actions/trash";
import { TRASH_RETENTION_DAYS, actingTrashPredicate, type RestorableModel } from "@/lib/trash";
import { SaveForm, SaveButton } from "@/components/SaveForm";
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
  model: RestorableModel;
  id: string;
  label: string;
  detail: string;
  deletedAt: Date;
  deletedByName: string | null;
  deleteReason: string | null;
  /** Not swept by the nightly purge — stays until restored. */
  kept?: boolean;
};

function PurgeIn({ row }: { row: Row }) {
  if (row.kept) return <StatusPill tone="neutral">Kept</StatusPill>;
  const daysLeft = Math.max(0, differenceInCalendarDays(addDays(row.deletedAt, TRASH_RETENTION_DAYS), new Date()));
  return <StatusPill tone={daysLeft <= 7 ? "danger" : "neutral"}>{daysLeft} days</StatusPill>;
}

export default async function TrashPage() {
  // Owner-only. This previously called requireUser(), which is weaker than the
  // policy the app states for this route: ROUTE_GATES lists /trash as "admin",
  // so any authenticated non-owner reaching this page without the proxy in the
  // request path saw everything below. That matters more here than elsewhere —
  // the page reads every soft-deleted contact, lead, vehicle, job card,
  // document, product, library document and quote through basePrisma, which
  // sets app.bypass_rls and is not soft-delete filtered. The proxy stays as the
  // pre-filter (nicer redirect); requireOwner() is the actual boundary.
  await requireOwner();
  // …and owner of WHICH tenant. requireOwner() answers "is this person an
  // owner", never "whose data may they see", so on its own it let an owner of
  // one tenant read every other tenant's deleted contacts, leads, quotes,
  // documents and vehicles — names, addresses, phone numbers, prices. The
  // deletion path was tenant-scoped first (see lib/trash.ts); this is the read
  // side of the same hole, and the more serious half: restoring was already
  // blocked, but the PII was still on screen.
  // NO SCOPE and a scope carrying null are different facts: no scope means
  // enforcement is off (the documented default) and the request was never told
  // which tenant it belongs to, so there is nothing to filter on. `?? null`
  // would filter on the legacy untenanted value and show an empty Trash page
  // to every migrated tenant.
  // ACTING scope, not activeTenantPredicate: this page runs behind
  // requireOwner() alone, no per-record ownership gate, so activeTenantPredicate
  // answering `{}` while dormant (today's mode everywhere) meant every owner
  // saw every OTHER tenant's trash. See lib/trash.ts's actingTrashPredicate.
  const notNull = {
    deletedAt: { not: null },
    ...(await actingTrashPredicate("Trash page")),
  } as const;
  // Named again at each newer query so the tenant is visible in the call itself.
  const { tenantId } = notNull;
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

  // Records deleted with only `deletedAt` (no reason / deleted-by, never purged) —
  // see RESTORE_ONLY_MODELS. Who deleted them and why is in the audit log.
  const [fleets, parts, stockUnits, surveys, competitors, signWorkflows, docTemplates, builderTemplates, studioTemplates, docInstances, blocks] =
    await Promise.all([
      basePrisma.fleet.findMany({ where: { ...notNull, tenantId }, select: { id: true, name: true, deletedAt: true } }),
      basePrisma.part.findMany({ where: { ...notNull, tenantId }, select: { id: true, name: true, sku: true, deletedAt: true } }),
      // Not the incoming units a cancelled purchase order took with it — they
      // would come back as stock arriving on an order that no longer exists.
      basePrisma.stockUnit.findMany({
        where: { ...notNull, tenantId, NOT: { purchaseOrder: { is: { status: "cancelled" } } } },
        select: { id: true, stockNumber: true, deletedAt: true, product: { select: { name: true } } },
      }),
      basePrisma.survey.findMany({ where: { ...notNull, tenantId }, select: { id: true, title: true, deletedAt: true } }),
      basePrisma.competitor.findMany({ where: { ...notNull, tenantId }, select: { id: true, name: true, deletedAt: true } }),
      basePrisma.signWorkflow.findMany({ where: { ...notNull, tenantId }, select: { id: true, name: true, deletedAt: true } }),
      basePrisma.docTemplateRecord.findMany({ where: { ...notNull, tenantId }, select: { id: true, name: true, deletedAt: true } }),
      basePrisma.docBuilderTemplate.findMany({ where: { ...notNull, tenantId }, select: { id: true, name: true, deletedAt: true } }),
      basePrisma.customDocTemplate.findMany({ where: { ...notNull, tenantId }, select: { id: true, name: true, deletedAt: true } }),
      basePrisma.docInstance.findMany({ where: { ...notNull, tenantId }, select: { id: true, title: true, deletedAt: true } }),
      basePrisma.reusableBlock.findMany({ where: { ...notNull, tenantId }, select: { id: true, name: true, deletedAt: true } }),
    ]);
  const keptRow = (model: RestorableModel, id: string, label: string, detail: string, deletedAt: Date | null): Row => ({
    model, id, label, detail, deletedAt: deletedAt!, deletedByName: null, deleteReason: null, kept: true,
  });

  const rows: Row[] = [
    ...fleets.map((f) => keptRow("fleet", f.id, f.name, "Fleet — its members were unlinked when it was deleted", f.deletedAt)),
    ...parts.map((p) => keptRow("part", p.id, p.name, `Part${p.sku ? ` — ${p.sku}` : ""}`, p.deletedAt)),
    ...stockUnits.map((s) => keptRow("stockUnit", s.id, s.stockNumber ?? s.product.name, `Stock unit — ${s.product.name}`, s.deletedAt)),
    ...surveys.map((s) => keptRow("survey", s.id, s.title, "Survey — comes back switched off", s.deletedAt)),
    ...competitors.map((c) => keptRow("competitor", c.id, c.name, "Competitor", c.deletedAt)),
    ...signWorkflows.map((w) => keptRow("signWorkflow", w.id, w.name, "Signing workflow", w.deletedAt)),
    ...docTemplates.map((t) => keptRow("docTemplateRecord", t.id, t.name, "Document template", t.deletedAt)),
    ...builderTemplates.map((t) => keptRow("docBuilderTemplate", t.id, t.name, "Document builder template", t.deletedAt)),
    ...studioTemplates.map((t) => keptRow("customDocTemplate", t.id, t.name, "Studio template", t.deletedAt)),
    ...docInstances.map((d) => keptRow("docInstance", d.id, d.title, "Studio document", d.deletedAt)),
    ...blocks.map((b) => keptRow("reusableBlock", b.id, b.name, "Reusable block", b.deletedAt)),
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
                return (
                  <MobileDataCard key={`${row.model}-${row.id}`}>
                    <MobileDataHeader
                      title={row.label}
                      detail={row.detail}
                      aside={<PurgeIn row={row} />}
                    />
                    <MobileDataFields>
                      <MobileDataField label="Deleted by">{row.deletedByName ?? "Unknown"}</MobileDataField>
                      <MobileDataField label="Deleted">{formatDateTime(row.deletedAt)}</MobileDataField>
                      <MobileDataField label="Reason" wide>{row.deleteReason ?? "No reason recorded"}</MobileDataField>
                    </MobileDataFields>
                    <SaveForm action={restoreFromTrash.bind(null, row.model, row.id)}>
                      <SaveButton className="btn-secondary w-full" pendingLabel="Restoring…"><ArchiveRestore className="size-4" />Restore item</SaveButton>
                    </SaveForm>
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
                      <PurgeIn row={r} />
                    </td>
                    <td>
                      <SaveForm action={restoreFromTrash.bind(null, r.model, r.id)}>
                        <SaveButton className="btn-secondary btn-sm" pendingLabel="Restoring…"><ArchiveRestore className="size-3.5" />Restore</SaveButton>
                      </SaveForm>
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
