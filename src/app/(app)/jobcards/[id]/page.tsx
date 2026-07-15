import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import {
  addJobCardItem,
  deleteJobCardItem,
  setJobCardStatus,
  setJobCardTechnician,
  completeJobCard,
  deleteJobCard,
} from "@/app/actions/jobcards";
import { requireUser } from "@/lib/auth";
import DocumentsPanel from "@/components/DocumentsPanel";
import ConfirmDelete from "@/components/ConfirmDelete";
import SigningBlock from "@/components/SigningBlock";
import { listBuilderTemplates } from "@/lib/docbuilder/store";
import { generateDocEditorDocument } from "@/app/actions/doceditor";
import { activeRecordRequest } from "@/lib/signing/record";
import JobCardItemForm from "@/components/JobCardItemForm";
import { uploadJobCardPhotos } from "@/app/actions/jobcards";
import { contactName, formatDate, formatZAR } from "@/lib/format";
import { EntityDetailShell } from "@/components/entity-detail-shell";
import { StatusPill } from "@/components/visual-system";

export default async function JobCardDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [jobCard, parts, users] = await Promise.all([
    prisma.jobCard.findUnique({
      where: { id },
      include: {
        vehicle: true,
        contact: true,
        items: true,
        technician: true,
        serviceRecord: true,
        documents: { where: { deletedAt: null }, include: { uploadedBy: true }, orderBy: { createdAt: "desc" } },
      },
    }),
    prisma.part.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    prisma.user.findMany({ orderBy: { name: "asc" } }),
  ]);
  if (!jobCard) notFound();
  const currentUser = await requireUser();
  const builderDocs = (await listBuilderTemplates()).filter((t) => t.key === "jobcard" || t.key === "service-report");
  const signingState = await activeRecordRequest({ jobCardId: jobCard.id });
  const path = `/jobcards/${jobCard.id}`;

  const partsTotal = jobCard.items
    .filter((i) => i.kind === "part")
    .reduce((s, i) => s + i.qty * i.unitPriceCents, 0);
  const labourTotal = jobCard.items
    .filter((i) => i.kind === "labour")
    .reduce((s, i) => s + i.qty * i.unitPriceCents, 0);
  const grandTotal = partsTotal + labourTotal;

  return (
    <EntityDetailShell
      backHref="/jobcards"
      backLabel="Job cards"
      eyebrow={`Workshop · #${jobCard.number}`}
      title={<Link href={`/vehicles/${jobCard.vehicleId}`} className="hover:underline">{jobCard.vehicle.model}</Link>}
      status={<StatusPill tone={jobCard.status === "completed" ? "success" : jobCard.status === "in_progress" ? "warning" : "neutral"}>{jobCard.status.replace("_", " ")}</StatusPill>}
      description={<><Link href={`/contacts/${jobCard.contactId}`} className="text-primary hover:underline">{contactName(jobCard.contact)}</Link> · opened {formatDate(jobCard.openedAt)}</>}
      meta={jobCard.technician ? `Technician: ${jobCard.technician.name}` : "No technician assigned"}
      facts={[
        { label: "Odometer in", value: jobCard.kmIn != null ? `${jobCard.kmIn.toLocaleString()} km` : "Not recorded" },
        { label: "Parts", value: formatZAR(partsTotal) },
        { label: "Labour", value: formatZAR(labourTotal) },
        { label: "Total", value: formatZAR(grandTotal) },
      ]}
      actions={<>
          <Link href={`/jobcards/${jobCard.id}/print`} className="btn-secondary">
            🖨 Print
          </Link>
          {jobCard.status === "completed" && (
            <Link href={`/jobcards/${jobCard.id}/service-report`} className="btn-secondary" target="_blank">
              📋 Service report
            </Link>
          )}
          {builderDocs.length > 0 && currentUser.role === "owner" && (
            <form action={generateDocEditorDocument} className="flex items-center gap-1">
              <input type="hidden" name="jobCardId" value={jobCard.id} />
              <select
                name="templateId"
                defaultValue={builderDocs[0].id}
                className="rounded-md border border-input bg-card px-2 py-1.5 text-sm text-foreground"
                title="Builder template"
              >
                {builderDocs.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              <button className="btn-secondary" title="Generate this builder document for the job card and file it">
                📄 Generate
              </button>
            </form>
          )}
          {jobCard.status === "open" && (
            <form action={setJobCardStatus.bind(null, jobCard.id, "in_progress")}>
              <button className="btn bg-amber-500 text-white hover:bg-amber-600">
                ▶ Start work
              </button>
            </form>
          )}
          {jobCard.status === "completed" && (
            <form action={setJobCardStatus.bind(null, jobCard.id, "open")}>
              <button className="btn-secondary">Reopen</button>
            </form>
          )}
          <ConfirmDelete
            action={deleteJobCard.bind(null, jobCard.id)}
            title={`Delete job card #${jobCard.number}?`}
            description="The job card moves to the Trash and can be restored for 60 days."
          />
        </>}
    >

      <div className="card flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-semibold mb-2">Work requested</h2>
          <p className="text-sm text-slate-400 whitespace-pre-wrap">{jobCard.description}</p>
        </div>
        <form action={setJobCardTechnician.bind(null, jobCard.id)} className="shrink-0">
          <label className="label">🔧 Technician</label>
          <select name="technicianId" className="input min-w-44" defaultValue={jobCard.technicianId ?? ""}>
            <option value="">Unassigned</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
          <button className="btn-secondary btn-sm mt-2">Assign</button>
        </form>
      </div>

      <div className="card">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <div>
            <h2 className="font-semibold">📷 Check-in photos</h2>
            <p className="text-xs text-slate-400">
              Condition BEFORE work starts — scratches, dents, odometer reading. Protects both
              sides.
            </p>
          </div>
          <form
            action={uploadJobCardPhotos.bind(null, jobCard.id)}
            className="flex items-center gap-2"
          >
            <input
              type="file"
              name="files"
              multiple
              required
              accept="image/*"
              capture="environment"
              className="block text-xs text-slate-400 file:btn-secondary file:btn-sm file:mr-2 file:border-0"
            />
            <button className="btn-primary btn-sm">Upload</button>
          </form>
        </div>
        {jobCard.documents.filter((d) => d.tag === "checkin-photo").length === 0 ? (
          <p className="text-xs text-slate-500">No photos yet — snap them at check-in.</p>
        ) : (
          <div className="flex gap-2 flex-wrap">
            {jobCard.documents
              .filter((d) => d.tag === "checkin-photo")
              .map((d) => (
                <a key={d.id} href={d.storedName} target="_blank">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={d.storedName}
                    alt={d.fileName}
                    className="h-24 w-24 object-cover rounded-lg border border-slate-700 hover:border-orange-500 transition-colors"
                  />
                </a>
              ))}
          </div>
        )}
      </div>

      <SigningBlock
        kind="jobcard"
        id={jobCard.id}
        refLabel={`#${jobCard.number}`}
        signedAt={jobCard.signedAt}
        signedByName={jobCard.signedByName}
        state={signingState}
        legacyToken={jobCard.signToken}
      />

      <div className="grid lg:grid-cols-3 gap-6 items-start">
        <div className="lg:col-span-2 space-y-6">
          <div className="card">
            <h2 className="font-semibold mb-4">Parts &amp; labour</h2>
            <table className="table-base mb-4">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Description</th>
                  <th className="text-right">Qty</th>
                  <th className="text-right">Unit price</th>
                  <th className="text-right">Total</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {jobCard.items.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-center text-slate-400 py-4">
                      No items added.
                    </td>
                  </tr>
                )}
                {jobCard.items.map((i) => (
                  <tr key={i.id}>
                    <td className="capitalize">{i.kind}</td>
                    <td>{i.description}</td>
                    <td className="text-right">{i.qty}</td>
                    <td className="text-right">{formatZAR(i.unitPriceCents)}</td>
                    <td className="text-right font-medium">
                      {formatZAR(Math.round(i.qty * i.unitPriceCents))}
                    </td>
                    <td className="text-right">
                      {jobCard.status !== "completed" && (
                        <ConfirmDelete
                          action={deleteJobCardItem.bind(null, i.id, jobCard.id)}
                          title={`Remove “${i.description}”?`}
                          description="This cannot be undone. The removal is recorded in the customer history."
                          trigger="✕"
                          triggerClass="text-xs text-slate-600 hover:text-red-500 cursor-pointer"
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {jobCard.status !== "completed" && (
              <JobCardItemForm
                action={addJobCardItem.bind(null, jobCard.id)}
                parts={parts.map((p) => ({
                  id: p.id,
                  name: p.name,
                  priceCents: p.priceCents,
                  stockQty: p.stockQty,
                }))}
              />
            )}

            <div className="flex justify-end mt-4">
              <dl className="text-sm space-y-1 w-56">
                <div className="flex justify-between">
                  <dt className="text-slate-400">Parts</dt>
                  <dd className="font-medium">{formatZAR(Math.round(partsTotal))}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-400">Labour</dt>
                  <dd className="font-medium">{formatZAR(Math.round(labourTotal))}</dd>
                </div>
                <div className="flex justify-between border-t border-slate-800 pt-1">
                  <dt className="font-semibold">Total</dt>
                  <dd className="font-bold">{formatZAR(Math.round(grandTotal))}</dd>
                </div>
              </dl>
            </div>
          </div>

          {jobCard.status !== "completed" ? (
            <div className="card border-emerald-500/30">
              <h2 className="font-semibold mb-1">Complete job card</h2>
              <p className="text-xs text-slate-400 mb-4">
                Completing writes a service record on the vehicle. Next-due values default to the
                vehicle&apos;s service intervals if left blank.
              </p>
              <form action={completeJobCard.bind(null, jobCard.id)} className="space-y-3">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div>
                    <label className="label">Mileage (km)</label>
                    <input
                      type="number"
                      name="km"
                      className="input"
                      defaultValue={jobCard.kmIn ?? ""}
                    />
                  </div>
                  <div>
                    <label className="label">Next due (km)</label>
                    <input type="number" name="nextDueKm" className="input" placeholder="auto" />
                  </div>
                  <div>
                    <label className="label">Next due (date)</label>
                    <input type="date" name="nextDueDate" className="input" />
                  </div>
                  <div className="col-span-2 md:col-span-4">
                    <label className="label">Service summary</label>
                    <input
                      name="summary"
                      className="input"
                      placeholder={jobCard.description}
                    />
                  </div>
                  <div className="col-span-2 md:col-span-4">
                    <label className="label">Work done / notes</label>
                    <textarea name="details" className="input" rows={2} />
                  </div>
                </div>
                <button className="btn bg-emerald-700 text-white hover:bg-emerald-600">
                  ✓ Complete &amp; write service record
                </button>
              </form>
            </div>
          ) : (
            jobCard.serviceRecord && (
              <div className="card bg-emerald-500/10 border-emerald-500/30">
                <h2 className="font-semibold text-emerald-300 mb-1">
                  Completed {formatDate(jobCard.completedAt)}
                </h2>
                <p className="text-sm text-emerald-300">
                  Service record: {jobCard.serviceRecord.summary}
                  {jobCard.serviceRecord.nextDueDate
                    ? ` — next due ${formatDate(jobCard.serviceRecord.nextDueDate)}`
                    : ""}
                  {jobCard.serviceRecord.nextDueKm != null
                    ? ` at ${jobCard.serviceRecord.nextDueKm.toLocaleString()} km`
                    : ""}
                </p>
              </div>
            )
          )}
        </div>

        <DocumentsPanel documents={jobCard.documents} jobCardId={jobCard.id} revalidate={path} />
      </div>
    </EntityDetailShell>
  );
}
