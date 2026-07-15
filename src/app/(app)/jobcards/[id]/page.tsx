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
  saveConditionNotes,
  uploadCheckoutPhotos,
  addInspectionItem,
  setInspectionItem,
  deleteInspectionItem,
  uploadInspectionPhoto,
  requestAdditionalWork,
  decideApproval,
  deleteApproval,
  saveSubcontract,
  reservePart,
  releaseReservation,
  consumeReservation,
  applyServicePackage,
  setJobWarranty,
  setComeback,
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
import {
  ArrowLeft,
  CarFront,
  UserRound,
  CalendarDays,
  Printer,
  ClipboardCheck,
  FileText,
  Check,
  Gauge,
  Package,
  Clock3,
} from "lucide-react";
import { StatusPill, Surface, MetricCard } from "@/components/visual-system";
import { KpiGrid } from "@/components/responsive-patterns";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  PIPELINE_STAGES,
  PRIORITIES,
  INSPECTION_STATUSES,
  stageMeta,
  priorityMeta,
  inspectionStatusMeta,
  isTerminalStage,
  hoursBetween,
  APPROVAL_STATUS_TONE,
} from "@/lib/workshop-constants";
import { getDefaultLabourRateCents, effectiveLabourRateCents, totalLoggedHours, jobProfit } from "@/lib/workshop";

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
        items: { include: { part: true } },
        technician: true,
        serviceRecord: true,
        bay: true,
        timeEntries: { include: { technician: true }, orderBy: { startedAt: "desc" } },
        inspectionItems: { orderBy: { sortOrder: "asc" } },
        approvals: { orderBy: { createdAt: "desc" } },
        reservations: { where: { status: "active" }, include: { part: true }, orderBy: { createdAt: "desc" } },
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
  const [servicePackages, siblingJobs] = await Promise.all([
    prisma.servicePackage.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
    prisma.jobCard.findMany({
      where: { vehicleId: jobCard.vehicleId, id: { not: jobCard.id }, deletedAt: null },
      orderBy: { openedAt: "desc" },
      take: 20,
      select: { id: true, number: true, description: true },
    }),
  ]);
  const profit = jobProfit(jobCard.items, jobCard.subCostCents);

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
  const progressIndex = jobCard.status === "collected"
    ? PIPELINE_STAGES.length
    : PIPELINE_STAGES.findIndex((s) => s.value === jobCard.status);

  return (
    <div className="space-y-6">
      <Link href="/jobcards" className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" />Back to job cards</Link>

      <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-semibold tracking-[-0.045em]">Job #{jobCard.number}</h1>
            <StatusPill tone={sm.tone}>{sm.label}</StatusPill>
            {jobCard.priority !== "normal" && <StatusPill tone={pm.tone}>{pm.label} priority</StatusPill>}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
            <Link href={`/vehicles/${jobCard.vehicleId}`} className="inline-flex items-center gap-1.5 hover:text-primary"><CarFront className="size-4" />{jobCard.vehicle.model}</Link>
            <Link href={`/contacts/${jobCard.contactId}`} className="inline-flex items-center gap-1.5 hover:text-primary"><UserRound className="size-4" />{contactName(jobCard.contact)}</Link>
            <span className="inline-flex items-center gap-1.5"><CalendarDays className="size-4" />Opened {formatDate(jobCard.openedAt)}</span>
            {jobCard.bay && <span className="inline-flex items-center gap-1.5"><span className="inline-block size-2 rounded-full" style={{ backgroundColor: jobCard.bay.color }} />{jobCard.bay.name}</span>}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/jobcards/${jobCard.id}/print`} className={buttonVariants({ variant: "outline", size: "sm" })}><Printer />Print</Link>
          {jobCard.status === "collected" && <Link href={`/jobcards/${jobCard.id}/service-report`} className={buttonVariants({ variant: "outline", size: "sm" })} target="_blank"><ClipboardCheck />Service report</Link>}
          {builderDocs.length > 0 && currentUser.role === "owner" && (
            <form action={generateDocEditorDocument} className="flex items-center gap-1">
              <input type="hidden" name="jobCardId" value={jobCard.id} />
              <select name="templateId" defaultValue={builderDocs[0].id} className="h-8 max-w-44 rounded-md border border-input bg-card px-2 text-xs text-foreground" title="Document template">
                {builderDocs.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <button className={buttonVariants({ variant: "outline", size: "sm" })}><FileText />Generate</button>
            </form>
          )}
          {terminal && <form action={setJobCardStatus.bind(null, jobCard.id, "repair")}><button className={buttonVariants({ variant: "outline", size: "sm" })}>Reopen</button></form>}
          {!terminal && <form action={setJobCardStatus.bind(null, jobCard.id, "cancelled")}><button className={buttonVariants({ variant: "outline", size: "sm" })}>Cancel job</button></form>}
          <ConfirmDelete action={deleteJobCard.bind(null, jobCard.id)} title={`Delete job card #${jobCard.number}?`} description="The job card moves to Trash and can be restored for 60 days." triggerClass="btn-danger btn-sm" />
        </div>
      </div>

      {/* 8-stage workflow stepper (PR30 chrome, workshop workflow) ───────────── */}
      <Surface className="p-4 sm:p-5">
        <div className="grid gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {PIPELINE_STAGES.map((stage, index) => {
            const complete = index < progressIndex;
            const current = index === progressIndex && !terminal;
            return (
              <form key={stage.value} action={setJobCardStatus.bind(null, jobCard.id, stage.value)}>
                <button className={cn("flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left transition-colors", complete ? "border-emerald-400/20 bg-emerald-400/[0.06]" : current ? "border-primary/25 bg-primary/[0.07]" : "border-border bg-muted/15 hover:border-primary/30")}>
                  <span className={cn("grid size-6 shrink-0 place-items-center rounded-lg border text-[10px] font-semibold", complete ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-300" : current ? "border-primary/20 bg-primary/10 text-primary" : "border-border bg-muted/30 text-muted-foreground")}>{complete ? <Check className="size-3.5" /> : index + 1}</span>
                  <span className="min-w-0 truncate text-xs font-medium">{stage.label}</span>
                </button>
              </form>
            );
          })}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{terminal ? `This job is ${sm.label.toLowerCase()}. Tap a stage to reopen it.` : "Tap a stage to move the job. “Complete & write service record” below moves it to Collected."}</p>
      </Surface>

      <KpiGrid>
        <MetricCard icon={Gauge} label="Arrival mileage" value={jobCard.kmIn != null ? jobCard.kmIn.toLocaleString() : "—"} detail={jobCard.kmIn != null ? "kilometres" : "Not captured"} />
        <MetricCard icon={Package} label="Parts" value={formatZAR(Math.round(partsTotal))} detail={`${jobCard.items.filter((i) => i.kind === "part").length} line items`} />
        <MetricCard icon={Clock3} label="Labour" value={formatZAR(Math.round(labourTotal))} detail={`${actualHours} h logged`} />
        <MetricCard icon={ClipboardCheck} label="Job total" value={formatZAR(Math.round(grandTotal))} detail="Customer-facing total" accent />
      </KpiGrid>

      <Surface className="p-5">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-primary">Work requested</p>
            <p className="mt-3 whitespace-pre-wrap text-base leading-7 text-foreground">{jobCard.description}</p>
          </div>
          <form action={setJobCardTechnician.bind(null, jobCard.id)} className="rounded-xl border border-border bg-muted/20 p-3">
            <label className="label" htmlFor="job-technician">Technician</label>
            <select id="job-technician" name="technicianId" className="input" defaultValue={jobCard.technicianId ?? ""}>
              <option value="">Unassigned</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <button className="btn-secondary btn-sm mt-2 w-full">Update assignment</button>
          </form>
        </div>
      </Surface>

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

      {/* Check-out condition + notes (phase 2) ──────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card">
          <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
            <div>
              <h2 className="font-semibold">📸 Check-out photos</h2>
              <p className="text-xs text-slate-400">Condition AFTER the work — proof of hand-over state.</p>
            </div>
            <form action={uploadCheckoutPhotos.bind(null, jobCard.id)} className="flex items-center gap-2">
              <input type="file" name="files" multiple required accept="image/*" capture="environment" className="block text-xs text-slate-400 file:btn-secondary file:btn-sm file:mr-2 file:border-0" />
              <button className="btn-primary btn-sm">Upload</button>
            </form>
          </div>
          {jobCard.documents.filter((d) => d.tag === "checkout-photo").length === 0 ? (
            <p className="text-xs text-slate-500">No check-out photos yet.</p>
          ) : (
            <div className="flex gap-2 flex-wrap">
              {jobCard.documents.filter((d) => d.tag === "checkout-photo").map((d) => (
                <a key={d.id} href={d.storedName} target="_blank">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={d.storedName} alt={d.fileName} className="h-24 w-24 object-cover rounded-lg border border-slate-700 hover:border-orange-500 transition-colors" />
                </a>
              ))}
            </div>
          )}
        </div>
        <form action={saveConditionNotes.bind(null, jobCard.id)} className="card space-y-2">
          <h2 className="font-semibold">Condition notes</h2>
          <div>
            <label className="label" htmlFor="checkinNotes">At check-in</label>
            <textarea id="checkinNotes" name="checkinNotes" rows={2} className="input" defaultValue={jobCard.checkinNotes ?? ""} placeholder="Existing damage, fuel/charge level, loose items…" />
          </div>
          <div>
            <label className="label" htmlFor="checkoutNotes">At check-out</label>
            <textarea id="checkoutNotes" name="checkoutNotes" rows={2} className="input" defaultValue={jobCard.checkoutNotes ?? ""} placeholder="Final condition, what was handed back…" />
          </div>
          <button className="btn-secondary btn-sm">Save condition notes</button>
        </form>
      </div>

      {/* Inspection checklist (phase 2) ──────────────────────────────────────── */}
      <div className="card space-y-3">
        <div>
          <h2 className="font-semibold">✅ Inspection checklist</h2>
          <p className="text-xs text-slate-400">Multi-point check with a status, note and optional photo per item.</p>
        </div>
        {jobCard.inspectionItems.length > 0 && (
          <div className="divide-y divide-border">
            {jobCard.inspectionItems.map((item) => {
              const meta = inspectionStatusMeta(item.status);
              return (
                <div key={item.id} className="flex flex-wrap items-center gap-3 py-2">
                  <span className="min-w-40 flex-1 font-medium">{item.label}</span>
                  <form action={setInspectionItem.bind(null, item.id, jobCard.id)} className="flex items-center gap-2">
                    <select name="status" defaultValue={item.status} className="input h-8 py-0 text-xs w-32">
                      {INSPECTION_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                    <input name="notes" defaultValue={item.notes ?? ""} placeholder="Note" className="input h-8 py-0 text-xs w-40" />
                    <button className="btn-secondary btn-sm">Save</button>
                  </form>
                  <StatusPill tone={meta.tone}>{meta.label}</StatusPill>
                  {item.photoStoredName ? (
                    <a href={item.photoStoredName} target="_blank">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={item.photoStoredName} alt={item.label} className="h-8 w-8 rounded object-cover border border-slate-700" />
                    </a>
                  ) : (
                    <form action={uploadInspectionPhoto.bind(null, item.id, jobCard.id)} className="flex items-center gap-1">
                      <input type="file" name="file" accept="image/*" className="block w-28 text-[10px] text-slate-500 file:btn-secondary file:btn-sm file:mr-1 file:border-0" />
                      <button className="text-xs text-slate-500 hover:text-foreground">📎</button>
                    </form>
                  )}
                  <form action={deleteInspectionItem.bind(null, item.id, jobCard.id)}>
                    <button className="text-xs text-slate-600 hover:text-red-500">✕</button>
                  </form>
                </div>
              );
            })}
          </div>
        )}
        <form action={addInspectionItem.bind(null, jobCard.id)} className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-48">
            <label className="label" htmlFor="ins-label">Add check</label>
            <input id="ins-label" name="label" required className="input" placeholder="e.g. Brakes · Tyres · Lights · Battery terminals" />
          </div>
          <select name="status" defaultValue="ok" className="input w-32">
            {INSPECTION_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          <button className="btn-secondary">Add</button>
        </form>
      </div>

      {/* Additional-work approvals (phase 2) ─────────────────────────────────── */}
      <div className="card space-y-3">
        <div>
          <h2 className="font-semibold">🖐 Additional-work approvals</h2>
          <p className="text-xs text-slate-400">Extra work found mid-job. Requesting notifies the customer in their portal.</p>
        </div>
        {jobCard.approvals.length > 0 && (
          <div className="divide-y divide-border">
            {jobCard.approvals.map((a) => (
              <div key={a.id} className="flex flex-wrap items-center gap-3 py-2">
                <div className="min-w-48 flex-1">
                  <p className="font-medium">{a.description}</p>
                  <p className="text-xs text-muted-foreground">
                    {a.amountCents ? formatZAR(a.amountCents) : "No price"}
                    {a.decidedAt ? ` · ${a.decidedVia} · ${formatDate(a.decidedAt)}` : ""}
                    {a.notes ? ` · ${a.notes}` : ""}
                  </p>
                </div>
                <StatusPill tone={APPROVAL_STATUS_TONE[a.status] ?? "neutral"}>{a.status}</StatusPill>
                {a.status === "pending" && (
                  <div className="flex items-center gap-1.5">
                    <form action={decideApproval.bind(null, a.id, jobCard.id, "approved")} className="flex items-center gap-1">
                      <input type="hidden" name="decidedVia" value="phone" />
                      <button className="btn-secondary btn-sm text-emerald-400">Approve</button>
                    </form>
                    <form action={decideApproval.bind(null, a.id, jobCard.id, "declined")} className="flex items-center gap-1">
                      <input type="hidden" name="decidedVia" value="phone" />
                      <button className="btn-secondary btn-sm text-red-400">Decline</button>
                    </form>
                  </div>
                )}
                <form action={deleteApproval.bind(null, a.id, jobCard.id)}>
                  <button className="text-xs text-slate-600 hover:text-red-500">✕</button>
                </form>
              </div>
            ))}
          </div>
        )}
        {!terminal && (
          <form action={requestAdditionalWork.bind(null, jobCard.id)} className="flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-48">
              <label className="label" htmlFor="aw-desc">Additional work</label>
              <input id="aw-desc" name="description" required className="input" placeholder="e.g. Replace worn brake pads" />
            </div>
            <div className="w-32">
              <label className="label" htmlFor="aw-amount">Est. cost (R)</label>
              <input id="aw-amount" name="amount" inputMode="decimal" className="input tabular-nums" placeholder="0.00" />
            </div>
            <button className="btn-primary">Request approval</button>
          </form>
        )}
      </div>

      <SigningBlock
        kind="jobcard"
        id={jobCard.id}
        refLabel={`#${jobCard.number}`}
        signedAt={jobCard.signedAt}
        signedByName={jobCard.signedByName}
        state={signingState}
      />

      {/* Reservations · packages · subcontracting (phase 3) ─────────────────── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card space-y-3">
          <div>
            <h2 className="font-semibold">📦 Parts reservations</h2>
            <p className="text-xs text-slate-400">Earmark stock before it&apos;s fitted. Consuming adds a part line and deducts stock.</p>
          </div>
          {jobCard.reservations.length > 0 && (
            <div className="divide-y divide-border text-sm">
              {jobCard.reservations.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-3 py-1.5">
                  <span className="min-w-0 truncate">{r.qty}× {r.part.name}</span>
                  <span className="flex items-center gap-2 shrink-0">
                    <form action={consumeReservation.bind(null, r.id, jobCard.id)}>
                      <button className="btn-secondary btn-sm text-emerald-400">Consume</button>
                    </form>
                    <form action={releaseReservation.bind(null, r.id, jobCard.id)}>
                      <button className="text-xs text-slate-600 hover:text-red-500">Release</button>
                    </form>
                  </span>
                </div>
              ))}
            </div>
          )}
          {!terminal && (
            <form action={reservePart.bind(null, jobCard.id)} className="flex flex-wrap items-end gap-2">
              <div className="flex-1 min-w-40">
                <label className="label" htmlFor="res-part">Part</label>
                <select id="res-part" name="partId" required className="input">
                  <option value="">Select part…</option>
                  {parts.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.stockQty} in stock)</option>)}
                </select>
              </div>
              <div className="w-20">
                <label className="label" htmlFor="res-qty">Qty</label>
                <input id="res-qty" name="qty" type="number" min={1} defaultValue={1} className="input tabular-nums" />
              </div>
              <button className="btn-secondary">Reserve</button>
            </form>
          )}
        </div>

        <div className="space-y-4">
          {servicePackages.length > 0 && !terminal && (
            <form action={applyServicePackage.bind(null, jobCard.id)} className="card space-y-2">
              <h2 className="font-semibold">🧰 Apply service package</h2>
              <p className="text-xs text-slate-400">Drop a preset bundle of parts &amp; labour onto this job.</p>
              <div className="flex items-end gap-2">
                <select name="packageId" required className="input flex-1">
                  <option value="">Select package…</option>
                  {servicePackages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <button className="btn-secondary">Apply</button>
              </div>
            </form>
          )}
          <form action={saveSubcontract.bind(null, jobCard.id)} className="card space-y-2">
            <h2 className="font-semibold">🏭 Subcontracted work</h2>
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" name="isSubcontracted" defaultChecked={jobCard.isSubcontracted} className="h-4 w-4" />
              This job is (partly) subcontracted
            </label>
            <div className="grid grid-cols-2 gap-2">
              <input name="subcontractor" defaultValue={jobCard.subcontractor ?? ""} placeholder="Subcontractor" className="input" />
              <input name="subCost" inputMode="decimal" defaultValue={jobCard.subCostCents ? (jobCard.subCostCents / 100).toFixed(2) : ""} placeholder="Cost (R)" className="input tabular-nums" />
            </div>
            <button className="btn-secondary btn-sm">Save</button>
          </form>
        </div>
      </div>

      {/* Profitability & recovery (phase 4) ─────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Profitability</p>
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between"><dt className="text-muted-foreground">Revenue</dt><dd className="font-medium tabular-nums">{formatZAR(profit.revenueCents)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted-foreground">Parts cost</dt><dd className="tabular-nums">−{formatZAR(profit.partsCostCents)}</dd></div>
            {profit.subCostCents > 0 && <div className="flex justify-between"><dt className="text-muted-foreground">Subcontract</dt><dd className="tabular-nums">−{formatZAR(profit.subCostCents)}</dd></div>}
            <div className="flex justify-between border-t border-border pt-1"><dt className="font-semibold">Gross profit</dt><dd className={`font-bold tabular-nums ${profit.profitCents >= 0 ? "text-emerald-400" : "text-red-400"}`}>{formatZAR(profit.profitCents)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted-foreground">Margin</dt><dd className="tabular-nums">{profit.marginPct}%</dd></div>
          </dl>
        </div>
        <form action={setJobWarranty.bind(null, jobCard.id)} className="card space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Warranty recovery</p>
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" name="underWarranty" defaultChecked={jobCard.underWarranty} className="h-4 w-4" />
            Work is under warranty
          </label>
          <div>
            <label className="label" htmlFor="warrantyRecovered">Recovered (R)</label>
            <input id="warrantyRecovered" name="warrantyRecovered" inputMode="decimal" className="input tabular-nums" defaultValue={jobCard.warrantyRecoveredCents ? (jobCard.warrantyRecoveredCents / 100).toFixed(2) : ""} placeholder="Labour + parts recovered" />
          </div>
          <button className="btn-secondary btn-sm">Save</button>
        </form>
        <form action={setComeback.bind(null, jobCard.id)} className="card space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Comeback / repeat repair</p>
          <p className="text-xs text-muted-foreground">Link this job to the earlier one it&apos;s a repeat of, on the same vehicle.</p>
          <select name="comebackOfId" defaultValue={jobCard.comebackOfId ?? ""} className="input">
            <option value="">Not a comeback</option>
            {siblingJobs.map((s) => <option key={s.id} value={s.id}>#{s.number} · {s.description.slice(0, 40)}</option>)}
          </select>
          <button className="btn-secondary btn-sm">Save</button>
        </form>
      </div>

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
