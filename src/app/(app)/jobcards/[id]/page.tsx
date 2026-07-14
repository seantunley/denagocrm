import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Camera,
  CarFront,
  Check,
  CheckCircle2,
  CircleDotDashed,
  ClipboardCheck,
  Clock3,
  FileText,
  Gauge,
  Package,
  Play,
  Printer,
  RotateCcw,
  Upload,
  UserRound,
  Wrench,
} from "lucide-react";
import { prisma } from "@/lib/db";
import {
  addJobCardItem,
  deleteJobCardItem,
  setJobCardStatus,
  setJobCardTechnician,
  completeJobCard,
  deleteJobCard,
  uploadJobCardPhotos,
} from "@/app/actions/jobcards";
import { requireUser } from "@/lib/auth";
import DocumentsPanel from "@/components/DocumentsPanel";
import ConfirmDelete from "@/components/ConfirmDelete";
import SigningBlock from "@/components/SigningBlock";
import { listBuilderTemplates } from "@/lib/docbuilder/store";
import { generateDocEditorDocument } from "@/app/actions/doceditor";
import { activeRecordRequest } from "@/lib/signing/record";
import JobCardItemForm from "@/components/JobCardItemForm";
import { contactName, formatDate, formatZAR } from "@/lib/format";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState, FeedbackBanner, MetricCard, SectionHeading, StatusPill, Surface } from "@/components/visual-system";
import { KpiGrid, ResponsiveDataView, StickyActionArea } from "@/components/responsive-patterns";
import { cn } from "@/lib/utils";

function statusTone(status: string): "neutral" | "warning" | "success" {
  if (status === "in_progress") return "warning";
  if (status === "completed") return "success";
  return "neutral";
}

function statusLabel(status: string) {
  if (status === "in_progress") return "In progress";
  if (status === "completed") return "Completed";
  return "Waiting";
}

export default async function JobCardDetailPage({ params }: { params: Promise<{ id: string }> }) {
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
  const builderDocs = (await listBuilderTemplates()).filter((template) => template.key === "jobcard" || template.key === "service-report");
  const signingState = await activeRecordRequest({ jobCardId: jobCard.id });
  const path = `/jobcards/${jobCard.id}`;
  const checkInPhotos = jobCard.documents.filter((document) => document.tag === "checkin-photo");
  const partsTotal = jobCard.items.filter((item) => item.kind === "part").reduce((sum, item) => sum + item.qty * item.unitPriceCents, 0);
  const labourTotal = jobCard.items.filter((item) => item.kind === "labour").reduce((sum, item) => sum + item.qty * item.unitPriceCents, 0);
  const grandTotal = partsTotal + labourTotal;
  const progressIndex = jobCard.status === "completed" ? 2 : jobCard.status === "in_progress" ? 1 : 0;
  const workflow = [
    { label: "Intake", detail: "Vehicle checked in", icon: CircleDotDashed },
    { label: "Workshop", detail: "Diagnosis and repair", icon: Wrench },
    { label: "Complete", detail: "Service record filed", icon: CheckCircle2 },
  ];

  return (
    <div className="space-y-6">
      <Link href="/jobcards" className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" />Back to job cards</Link>

      <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-semibold tracking-[-0.045em]">Job #{jobCard.number}</h1>
            <StatusPill tone={statusTone(jobCard.status)}>{statusLabel(jobCard.status)}</StatusPill>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
            <Link href={`/vehicles/${jobCard.vehicleId}`} className="inline-flex items-center gap-1.5 hover:text-primary"><CarFront className="size-4" />{jobCard.vehicle.model}</Link>
            <Link href={`/contacts/${jobCard.contactId}`} className="inline-flex items-center gap-1.5 hover:text-primary"><UserRound className="size-4" />{contactName(jobCard.contact)}</Link>
            <span className="inline-flex items-center gap-1.5"><CalendarDays className="size-4" />Opened {formatDate(jobCard.openedAt)}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/jobcards/${jobCard.id}/print`} className={buttonVariants({ variant: "outline", size: "sm" })}><Printer />Print</Link>
          {jobCard.status === "completed" && <Link href={`/jobcards/${jobCard.id}/service-report`} className={buttonVariants({ variant: "outline", size: "sm" })} target="_blank"><ClipboardCheck />Service report</Link>}
          {builderDocs.length > 0 && currentUser.role === "owner" && (
            <form action={generateDocEditorDocument} className="flex items-center gap-1">
              <input type="hidden" name="jobCardId" value={jobCard.id} />
              <select name="templateId" defaultValue={builderDocs[0].id} className="h-8 max-w-44 rounded-md border border-input bg-card px-2 text-xs text-foreground" title="Document template">
                {builderDocs.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
              </select>
              <button className={buttonVariants({ variant: "outline", size: "sm" })}><FileText />Generate</button>
            </form>
          )}
          {jobCard.status === "open" && <form action={setJobCardStatus.bind(null, jobCard.id, "in_progress")}><button className={buttonVariants({ size: "sm" })}><Play />Start work</button></form>}
          {jobCard.status === "completed" && <form action={setJobCardStatus.bind(null, jobCard.id, "open")}><button className={buttonVariants({ variant: "outline", size: "sm" })}><RotateCcw />Reopen</button></form>}
          <ConfirmDelete action={deleteJobCard.bind(null, jobCard.id)} title={`Delete job card #${jobCard.number}?`} description="The job card moves to Trash and can be restored for 60 days." triggerClass="btn-danger btn-sm" />
        </div>
      </div>

      <Surface className="p-4 sm:p-5">
        <div className="grid gap-3 sm:grid-cols-3">
          {workflow.map((step, index) => {
            const Icon = step.icon;
            const complete = index < progressIndex || jobCard.status === "completed";
            const current = index === progressIndex && jobCard.status !== "completed";
            return (
              <div key={step.label} className={cn("relative flex items-center gap-3 rounded-xl border px-3 py-3", complete ? "border-emerald-400/20 bg-emerald-400/[0.06]" : current ? "border-primary/25 bg-primary/[0.07]" : "border-border bg-muted/15")}>
                <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg border", complete ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-300" : current ? "border-primary/20 bg-primary/10 text-primary" : "border-border bg-muted/30 text-muted-foreground")}>
                  {complete ? <Check className="size-4" /> : <Icon className="size-4" />}
                </span>
                <div><p className="text-sm font-semibold">{step.label}</p><p className="mt-0.5 text-[11px] text-muted-foreground">{step.detail}</p></div>
                {index < workflow.length - 1 && <ArrowRight className="absolute -right-5 z-10 hidden size-4 text-muted-foreground/40 sm:block" />}
              </div>
            );
          })}
        </div>
      </Surface>

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
              {users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
            </select>
            <button className="btn-secondary btn-sm mt-2 w-full">Update assignment</button>
          </form>
        </div>
      </Surface>

      <KpiGrid>
        <MetricCard icon={Gauge} label="Arrival mileage" value={jobCard.kmIn != null ? jobCard.kmIn.toLocaleString() : "—"} detail={jobCard.kmIn != null ? "kilometres" : "Not captured"} />
        <MetricCard icon={Package} label="Parts" value={formatZAR(Math.round(partsTotal))} detail={`${jobCard.items.filter((item) => item.kind === "part").length} line items`} />
        <MetricCard icon={Clock3} label="Labour" value={formatZAR(Math.round(labourTotal))} detail={`${jobCard.items.filter((item) => item.kind === "labour").length} line items`} />
        <MetricCard icon={ClipboardCheck} label="Job total" value={formatZAR(Math.round(grandTotal))} detail="Customer-facing total" accent />
      </KpiGrid>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start">
        <div className="min-w-0 space-y-6">
          <Surface className="p-5">
            <SectionHeading title="Check-in condition" description="Photograph scratches, dents, warning lights and the odometer before workshop work begins." action={<Camera className="size-5 text-primary" />} />
            <form action={uploadJobCardPhotos.bind(null, jobCard.id)} className="mt-4 flex flex-col gap-2 rounded-xl border border-border bg-muted/20 p-3 sm:flex-row sm:items-center">
              <input type="file" name="files" multiple required accept="image/*" capture="environment" className="min-w-0 flex-1 text-xs text-muted-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-background file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-foreground" />
              <button className="btn-primary btn-sm"><Upload className="size-4" />Upload photos</button>
            </form>
            {checkInPhotos.length === 0 ? (
              <EmptyState icon={Camera} title="No check-in photos" description="Add condition evidence before work starts to protect both the customer and workshop." className="mt-4 py-8" />
            ) : (
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {checkInPhotos.map((document) => (
                  <a key={document.id} href={document.storedName} target="_blank" className="group overflow-hidden rounded-xl border border-border bg-muted/20">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={document.storedName} alt={document.fileName} className="aspect-square w-full object-cover transition-transform group-hover:scale-[1.03]" />
                  </a>
                ))}
              </div>
            )}
          </Surface>

          <Surface>
            <SectionHeading title="Parts & labour" description="Build the customer-facing workshop total and keep catalogue stock synchronized." className="border-b border-border p-5" />
            {jobCard.items.length === 0 ? (
              <EmptyState icon={Wrench} title="No charges added" description="Add a catalogue part, custom part or labour line when diagnosis begins." className="m-4 py-8" />
            ) : (
              <ResponsiveDataView
                mobile={
                  <div className="divide-y divide-border">
                    {jobCard.items.map((item) => (
                      <article key={item.id} className="space-y-3 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div><StatusPill tone={item.kind === "labour" ? "info" : "neutral"}>{item.kind}</StatusPill><p className="mt-2 font-medium">{item.description}</p></div>
                          <p className="font-semibold tabular-nums">{formatZAR(Math.round(item.qty * item.unitPriceCents))}</p>
                        </div>
                        <div className="flex items-center justify-between text-xs text-muted-foreground"><span>{item.qty} × {formatZAR(item.unitPriceCents)}</span>{jobCard.status !== "completed" && <ConfirmDelete action={deleteJobCardItem.bind(null, item.id, jobCard.id)} title={`Remove “${item.description}”?`} description="This cannot be undone. The removal is recorded in customer history." trigger="Remove" triggerClass="text-xs font-medium text-red-300 hover:text-red-200" />}</div>
                      </article>
                    ))}
                  </div>
                }
                desktop={
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[650px] text-sm">
                      <thead><tr className="border-b border-border bg-muted/20 text-left text-[10px] uppercase tracking-[0.12em] text-muted-foreground"><th className="px-5 py-3">Type</th><th className="px-4 py-3">Description</th><th className="px-4 py-3 text-right">Qty</th><th className="px-4 py-3 text-right">Unit price</th><th className="px-4 py-3 text-right">Total</th><th className="px-5 py-3" /></tr></thead>
                      <tbody className="divide-y divide-border">
                        {jobCard.items.map((item) => (
                          <tr key={item.id}><td className="px-5 py-3"><StatusPill tone={item.kind === "labour" ? "info" : "neutral"}>{item.kind}</StatusPill></td><td className="px-4 py-3 font-medium">{item.description}</td><td className="px-4 py-3 text-right tabular-nums">{item.qty}</td><td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{formatZAR(item.unitPriceCents)}</td><td className="px-4 py-3 text-right font-semibold tabular-nums">{formatZAR(Math.round(item.qty * item.unitPriceCents))}</td><td className="px-5 py-3 text-right">{jobCard.status !== "completed" && <ConfirmDelete action={deleteJobCardItem.bind(null, item.id, jobCard.id)} title={`Remove “${item.description}”?`} description="This cannot be undone. The removal is recorded in customer history." trigger="Remove" triggerClass="text-xs text-muted-foreground hover:text-red-300" />}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                }
              />
            )}
            {jobCard.status !== "completed" && <div className="border-t border-border p-4"><JobCardItemForm action={addJobCardItem.bind(null, jobCard.id)} parts={parts.map((part) => ({ id: part.id, name: part.name, priceCents: part.priceCents, stockQty: part.stockQty }))} /></div>}
            <div className="flex justify-end border-t border-border bg-muted/10 px-5 py-4">
              <dl className="w-full max-w-xs space-y-2 text-sm"><div className="flex justify-between text-muted-foreground"><dt>Parts</dt><dd>{formatZAR(Math.round(partsTotal))}</dd></div><div className="flex justify-between text-muted-foreground"><dt>Labour</dt><dd>{formatZAR(Math.round(labourTotal))}</dd></div><div className="flex justify-between border-t border-border pt-3 text-base font-semibold"><dt>Total</dt><dd className="text-primary">{formatZAR(Math.round(grandTotal))}</dd></div></dl>
            </div>
          </Surface>

          {jobCard.status !== "completed" ? (
            <Surface className="border-emerald-400/20 p-5">
              <SectionHeading title="Complete the job" description="File the service outcome against the vehicle and calculate its next service due point." action={<CheckCircle2 className="size-5 text-emerald-400" />} />
              <form action={completeJobCard.bind(null, jobCard.id)} className="mt-5 space-y-4">
                <div className="grid gap-4 sm:grid-cols-3">
                  <div><label className="label" htmlFor="complete-km">Completion mileage</label><input id="complete-km" type="number" name="km" className="input" defaultValue={jobCard.kmIn ?? ""} /></div>
                  <div><label className="label" htmlFor="next-due-km">Next due mileage</label><input id="next-due-km" type="number" name="nextDueKm" className="input" placeholder="Automatic" /></div>
                  <div><label className="label" htmlFor="next-due-date">Next due date</label><input id="next-due-date" type="date" name="nextDueDate" className="input" /></div>
                </div>
                <div><label className="label" htmlFor="service-summary">Service summary</label><input id="service-summary" name="summary" className="input" placeholder={jobCard.description} /></div>
                <div><label className="label" htmlFor="work-done">Work completed and technician notes</label><textarea id="work-done" name="details" className="input min-h-24 resize-y" /></div>
                <StickyActionArea><button className="btn bg-emerald-600 text-white hover:bg-emerald-500"><CheckCircle2 className="size-4" />Complete job & file service record</button></StickyActionArea>
              </form>
            </Surface>
          ) : jobCard.serviceRecord ? (
            <FeedbackBanner tone="success" title={`Completed ${formatDate(jobCard.completedAt)}`}>
              {jobCard.serviceRecord.summary}{jobCard.serviceRecord.nextDueDate ? ` · Next due ${formatDate(jobCard.serviceRecord.nextDueDate)}` : ""}{jobCard.serviceRecord.nextDueKm != null ? ` at ${jobCard.serviceRecord.nextDueKm.toLocaleString()} km` : ""}
            </FeedbackBanner>
          ) : null}
        </div>

        <aside className="space-y-6 xl:sticky xl:top-4">
          <div className="[&>.card]:rounded-2xl [&>.card]:border-border [&>.card]:bg-card [&>.card]:p-5 [&>.card]:shadow-sm">
            <SigningBlock kind="jobcard" id={jobCard.id} refLabel={`#${jobCard.number}`} signedAt={jobCard.signedAt} signedByName={jobCard.signedByName} state={signingState} legacyToken={jobCard.signToken} />
          </div>
          <div className="[&>.card]:rounded-2xl [&>.card]:border-border [&>.card]:bg-card [&>.card]:p-5 [&>.card]:shadow-sm">
            <DocumentsPanel documents={jobCard.documents} jobCardId={jobCard.id} revalidate={path} />
          </div>
        </aside>
      </div>
    </div>
  );
}
