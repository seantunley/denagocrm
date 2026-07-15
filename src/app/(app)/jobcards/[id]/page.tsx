import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import {
  addJobCardItem,
  deleteJobCardItem,
  setJobCardStatus,
  setJobCardTechnician,
  setJobCardBay,
  setJobCardPriority,
  setJobCardEstimate,
  startTimeEntry,
  stopTimeEntry,
  deleteTimeEntry,
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
import { contactName, formatDate, formatDateTime, formatZAR } from "@/lib/format";
import { StatusPill } from "@/components/visual-system";
import {
  PIPELINE_STAGES,
  PRIORITIES,
  stageMeta,
  priorityMeta,
  isTerminalStage,
  hoursBetween,
} from "@/lib/workshop-constants";
import { getDefaultLabourRateCents, effectiveLabourRateCents, totalLoggedHours } from "@/lib/workshop";

export default async function JobCardDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [jobCard, parts, users, bays, defaultRateCents] = await Promise.all([
    prisma.jobCard.findUnique({
      where: { id },
      include: {
        vehicle: true,
        contact: true,
        items: true,
        technician: true,
        serviceRecord: true,
        bay: true,
        timeEntries: { include: { technician: true }, orderBy: { startedAt: "desc" } },
        documents: { where: { deletedAt: null }, include: { uploadedBy: true }, orderBy: { createdAt: "desc" } },
      },
    }),
    prisma.part.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    prisma.user.findMany({ orderBy: { name: "asc" } }),
    prisma.workshopBay.findMany({ where: { active: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    getDefaultLabourRateCents(),
  ]);
  if (!jobCard) notFound();
  const currentUser = await requireUser();

  const now = new Date();
  const terminal = isTerminalStage(jobCard.status);
  const sm = stageMeta(jobCard.status);
  const actualHours = totalLoggedHours(jobCard.timeEntries, now);
  const rateCents = effectiveLabourRateCents(jobCard.labourRateCents, defaultRateCents);
  const timeLabourCents = Math.round(actualHours * rateCents);
  const myRunning = jobCard.timeEntries.find((e) => e.endedAt === null && e.technicianId === currentUser.id) ?? null;
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
  const pm = priorityMeta(jobCard.priority);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-semibold tracking-[-0.035em]">Job card #{jobCard.number}</h1>
            <StatusPill tone={sm.tone}>{sm.label}</StatusPill>
            {jobCard.priority !== "normal" && <StatusPill tone={pm.tone}>{pm.label} priority</StatusPill>}
            {jobCard.bay && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <span className="inline-block size-2 rounded-full" style={{ backgroundColor: jobCard.bay.color }} />
                {jobCard.bay.name}
              </span>
            )}
          </div>
          <p className="text-sm text-slate-400 mt-0.5">
            <Link href={`/vehicles/${jobCard.vehicleId}`} className="text-orange-400 hover:underline">
              {jobCard.vehicle.model}
            </Link>
            {" · "}
            <Link href={`/contacts/${jobCard.contactId}`} className="text-orange-400 hover:underline">
              {contactName(jobCard.contact)}
            </Link>
            {" · opened "}
            {formatDate(jobCard.openedAt)}
            {jobCard.kmIn != null ? ` at ${jobCard.kmIn.toLocaleString()} km` : ""}
            {jobCard.technician ? ` · 🔧 ${jobCard.technician.name}` : ""}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Link href={`/jobcards/${jobCard.id}/print`} className="btn-secondary">
            🖨 Print
          </Link>
          {jobCard.status === "collected" && (
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
          {terminal && (
            <form action={setJobCardStatus.bind(null, jobCard.id, "repair")}>
              <button className="btn-secondary">Reopen</button>
            </form>
          )}
          {!terminal && (
            <form action={setJobCardStatus.bind(null, jobCard.id, "cancelled")}>
              <button className="btn-secondary">Cancel job</button>
            </form>
          )}
          <ConfirmDelete
            action={deleteJobCard.bind(null, jobCard.id)}
            title={`Delete job card #${jobCard.number}?`}
            description="The job card moves to the Trash and can be restored for 60 days."
          />
        </div>
      </div>

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

      {/* Workshop stage ─────────────────────────────────────────────────────── */}
      <div className="card">
        <h2 className="font-semibold mb-3">Workshop stage</h2>
        <div className="flex flex-wrap gap-2">
          {PIPELINE_STAGES.map((stage) => {
            const active = jobCard.status === stage.value;
            return (
              <form key={stage.value} action={setJobCardStatus.bind(null, jobCard.id, stage.value)}>
                <button
                  disabled={active}
                  className={
                    active
                      ? "rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground"
                      : "rounded-full border border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                  }
                >
                  {stage.label}
                </button>
              </form>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {terminal
            ? `This job is ${sm.label.toLowerCase()}. Pick a stage above to reopen it.`
            : "Use “Complete & write service record” below to move to Collected."}
        </p>
      </div>

      {/* Bay · priority · estimate ──────────────────────────────────────────── */}
      <div className="grid gap-4 md:grid-cols-3">
        <form action={setJobCardBay.bind(null, jobCard.id)} className="card space-y-2">
          <label className="label" htmlFor="bayId">Workshop bay</label>
          <select id="bayId" name="bayId" className="input" defaultValue={jobCard.bayId ?? ""}>
            <option value="">Unassigned</option>
            {bays.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <button className="btn-secondary btn-sm">Set bay</button>
        </form>
        <form action={setJobCardPriority.bind(null, jobCard.id)} className="card space-y-2">
          <label className="label" htmlFor="priority">Priority</label>
          <select id="priority" name="priority" className="input" defaultValue={jobCard.priority}>
            {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
          <button className="btn-secondary btn-sm">Set priority</button>
        </form>
        <form action={setJobCardEstimate.bind(null, jobCard.id)} className="card space-y-2">
          <label className="label">Labour estimate</label>
          <div className="grid grid-cols-2 gap-2">
            <input name="estimatedHours" inputMode="decimal" className="input tabular-nums" placeholder="Hours" defaultValue={jobCard.estimatedHours ?? ""} />
            <input name="labourRate" inputMode="decimal" className="input tabular-nums" placeholder={`R${(defaultRateCents / 100).toFixed(0)}/h`} defaultValue={jobCard.labourRateCents != null ? (jobCard.labourRateCents / 100).toFixed(2) : ""} />
          </div>
          <button className="btn-secondary btn-sm">Save estimate</button>
        </form>
      </div>

      {/* Technician time clock ──────────────────────────────────────────────── */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="font-semibold">⏱ Technician time</h2>
            <p className="text-xs text-muted-foreground">
              Estimated {jobCard.estimatedHours != null ? `${jobCard.estimatedHours} h` : "—"} · Logged{" "}
              <span className="tabular-nums text-foreground">{actualHours} h</span> · Labour value{" "}
              <span className="text-foreground">{formatZAR(timeLabourCents)}</span> @ R{(rateCents / 100).toFixed(0)}/h
              {jobCard.estimatedHours != null && actualHours > jobCard.estimatedHours && (
                <span className="ml-1 text-amber-400">· over estimate</span>
              )}
            </p>
          </div>
          {!terminal &&
            (myRunning ? (
              <form action={stopTimeEntry.bind(null, jobCard.id)}>
                <button className="btn bg-red-600 text-white hover:bg-red-700">■ Stop my clock</button>
              </form>
            ) : (
              <form action={startTimeEntry.bind(null, jobCard.id)}>
                <button className="btn bg-emerald-700 text-white hover:bg-emerald-600">▶ Start my clock</button>
              </form>
            ))}
        </div>
        {jobCard.timeEntries.length === 0 ? (
          <p className="text-xs text-muted-foreground">No time logged yet.</p>
        ) : (
          <div className="divide-y divide-border text-sm">
            {jobCard.timeEntries.map((e) => (
              <div key={e.id} className="flex items-center justify-between gap-3 py-1.5">
                <span className="min-w-0 truncate text-muted-foreground">
                  {e.technician?.name ?? "—"} · {formatDateTime(e.startedAt)}{e.note ? ` · ${e.note}` : ""}
                </span>
                <span className="flex items-center gap-2 shrink-0">
                  {e.endedAt ? (
                    <span className="tabular-nums font-medium text-foreground">{hoursBetween(e.startedAt, e.endedAt)} h</span>
                  ) : (
                    <span className="text-emerald-400">running…</span>
                  )}
                  <form action={deleteTimeEntry.bind(null, e.id, jobCard.id)}>
                    <button className="text-xs text-slate-600 hover:text-red-500">✕</button>
                  </form>
                </span>
              </div>
            ))}
          </div>
        )}
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
                      {!terminal && (
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

            {!terminal && (
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

          {!terminal ? (
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
    </div>
  );
}
