import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  CircleDotDashed,
  Clock3,
  Plus,
  Search,
  UserRoundX,
  Wrench,
} from "lucide-react";
import PhotoUploadField from "@/components/PhotoUploadField";
import { prisma } from "@/lib/db";
import ModalTrigger from "@/components/Modal";
import JobCardForm from "@/components/JobCardForm";
import { contactName, formatDate, formatZAR } from "@/lib/format";
import { WorkspaceHero } from "@/components/workspace-hero";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState, StatusPill, Surface } from "@/components/visual-system";
import {
  MobileDataCard,
  MobileDataField,
  MobileDataFields,
  MobileDataHeader,
  MobileDataList,
  ResponsiveDataView,
} from "@/components/responsive-patterns";
import { cn } from "@/lib/utils";
import { stageMeta, priorityMeta, isTerminalStage, jobCardTotals } from "@/lib/workshop-constants";
import {
  getAccessibleJobCardIds,
  getAccessibleVehicleIds,
  hasPermission,
  requireAnyPermission,
} from "@/lib/permissions";
import RecordContextMenu, { type RecordContextAction } from "@/components/RecordContextMenu";
import { SaveButton, SaveForm } from "@/components/SaveForm";
import { uploadJobCardPhotos } from "@/app/actions/jobcards";

const FILTERS = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "approval", label: "Awaiting approval" },
  { value: "repair", label: "In repair" },
  { value: "ready", label: "Ready" },
  { value: "collected", label: "Collected" },
] as const;

export default async function JobCardsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  const user = await requireAnyPermission("jobcards.view_all", "jobcards.view_owned");
  const { status: requestedStatus = "all", q = "" } = await searchParams;
  const activeStatus = FILTERS.some((filter) => filter.value === requestedStatus) ? requestedStatus : "all";
  const query = q.trim().toLowerCase();
  const [jobCardIds, vehicleIds, canManage] = await Promise.all([
    getAccessibleJobCardIds(user),
    getAccessibleVehicleIds(user),
    hasPermission(user, "jobcards.manage"),
  ]);
  const [jobCards, vehicles] = await Promise.all([
    prisma.jobCard.findMany({
      where: jobCardIds === null ? {} : { id: { in: jobCardIds } },
      orderBy: [{ openedAt: "desc" }],
      include: { vehicle: true, contact: true, items: true, bay: true, technician: true },
      take: 200,
    }),
    canManage
      ? prisma.vehicle.findMany({
          where: vehicleIds === null ? {} : { id: { in: vehicleIds } },
          include: { contact: true },
          orderBy: { createdAt: "desc" },
          take: 500,
        })
      : Promise.resolve([]),
  ]);

  const active = jobCards.filter((job) => !isTerminalStage(job.status));
  const counts = {
    active: active.length,
    repair: jobCards.filter((job) => job.status === "repair").length,
    ready: jobCards.filter((job) => job.status === "ready").length,
    unassigned: active.filter((job) => !job.technicianId).length,
  };
  const wipCents = active.reduce((sum, job) => sum + jobCardTotals(job.items).totalCents, 0);

  const filteredJobs = jobCards.filter((job) => {
    if (activeStatus === "active" && isTerminalStage(job.status)) return false;
    if (activeStatus !== "all" && activeStatus !== "active" && job.status !== activeStatus) return false;
    if (!query) return true;
    const searchable = [
      String(job.number),
      job.description,
      job.vehicle.model,
      job.vehicle.vin,
      job.vehicle.regNumber,
      contactName(job.contact),
      job.technician?.name,
      job.bay?.name,
    ].filter(Boolean).join(" ").toLowerCase();
    return searchable.includes(query);
  });

  const load = new Map<string, number>();
  for (const job of active) {
    const name = job.technician?.name ?? "Unassigned";
    load.set(name, (load.get(name) ?? 0) + 1);
  }
  const loadRows = [...load.entries()].sort((a, b) => b[1] - a[1]);

  const newJobTrigger = canManage ? (
    <ModalTrigger label={<><Plus className="size-4" />New job card</>} title="Open a new job card" buttonClass={buttonVariants({ size: "sm" })}>
      <JobCardForm
        vehicles={vehicles.map((vehicle) => ({
          id: vehicle.id,
          label: `${vehicle.model}${vehicle.regNumber ? ` · ${vehicle.regNumber}` : vehicle.vin ? ` · ${vehicle.vin}` : ""} — ${contactName(vehicle.contact)}`,
        }))}
      />
    </ModalTrigger>
  ) : null;

  return (
    <div className="space-y-6">
      <WorkspaceHero
        icon={Wrench}
        eyebrow="Workshop operations"
        title="Job cards"
        description="Run every workshop job from vehicle intake through technician work, customer approval and service history."
        actions={newJobTrigger}
        stats={[
          { label: "Active jobs", value: counts.active, detail: `${counts.unassigned} unassigned`, icon: CircleDotDashed, tone: "primary" },
          { label: "In repair", value: counts.repair, detail: "On the workshop floor", icon: Wrench, tone: "warning" },
          { label: "Ready for collection", value: counts.ready, detail: "Awaiting customer", icon: CheckCircle2, tone: "success" },
          { label: "Work in progress", value: formatZAR(Math.round(wipCents)), detail: "Billed value on active jobs", icon: UserRoundX },
        ]}
      />

      {loadRows.length > 0 && (
        <div className="card">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Technician load · active jobs</p>
          <div className="flex flex-wrap gap-2">
            {loadRows.map(([name, count]) => (
              <span key={name} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-3 py-1 text-xs">
                <span className="text-muted-foreground">{name}</span>
                <span className="font-semibold tabular-nums">{count}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <Surface className="overflow-visible">
        <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
          <form className="relative w-full lg:max-w-md">
            <input type="hidden" name="status" value={activeStatus} />
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              name="q"
              defaultValue={q}
              className="input pl-9"
              placeholder="Search job, vehicle, customer, technician or bay…"
              aria-label="Search job cards"
            />
          </form>
          <div className="flex max-w-full gap-1 overflow-x-auto rounded-lg border border-border bg-muted/25 p-1">
            {FILTERS.map((filter) => {
              const params = new URLSearchParams();
              if (filter.value !== "all") params.set("status", filter.value);
              if (q.trim()) params.set("q", q.trim());
              return (
                <Link
                  key={filter.value}
                  href={`/jobcards${params.size ? `?${params.toString()}` : ""}`}
                  className={cn(
                    "shrink-0 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                    activeStatus === filter.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {filter.label}
                </Link>
              );
            })}
          </div>
        </div>

        {filteredJobs.length === 0 ? (
          <EmptyState
            icon={Wrench}
            title={jobCards.length === 0 ? "No job cards yet" : "No jobs matched this view"}
            description={jobCards.length === 0 ? "Open the first workshop job when a vehicle arrives." : "Try another status or a broader search."}
            action={jobCards.length === 0 ? newJobTrigger : <Link href="/jobcards" className={buttonVariants({ variant: "outline", size: "sm" })}>Clear filters</Link>}
            className="m-4"
          />
        ) : (
          <ResponsiveDataView
            mobile={
              <MobileDataList className="rounded-none border-0">
                {filteredJobs.map((job) => {
                  const total = jobCardTotals(job.items).totalCents;
                  const sm = stageMeta(job.status);
                  return (
                    <RecordContextMenu
                      key={job.id}
                      label={`Job #${job.number}`}
                      href={`/jobcards/${job.id}`}
                      actions={jobContextActions(job.id, job.vehicleId)}
                    >
                    <MobileDataCard>
                      <MobileDataHeader
                        title={<Link href={`/jobcards/${job.id}`} className="text-primary hover:underline">Job #{job.number}</Link>}
                        detail={`${job.vehicle.model} · ${contactName(job.contact)}`}
                        aside={<StatusPill tone={sm.tone}>{sm.label}</StatusPill>}
                      />
                      <MobileDataFields>
                        <MobileDataField label="Work requested" wide><span className="line-clamp-2 text-muted-foreground">{job.description}</span></MobileDataField>
                        <MobileDataField label="Technician">{job.technician?.name ?? "Unassigned"}</MobileDataField>
                        <MobileDataField label="Bay">{job.bay?.name ?? "—"}</MobileDataField>
                        <MobileDataField label="Estimate">{formatZAR(Math.round(total))}</MobileDataField>
                        <MobileDataField label="Priority">{priorityMeta(job.priority).label}</MobileDataField>
                      </MobileDataFields>
                      {canManage && (
                        <SaveForm action={uploadJobCardPhotos.bind(null, job.id)} className="mt-3 rounded-xl border border-primary/20 bg-primary/[0.05] p-2.5">
                          <label className="mb-2 block text-xs font-semibold text-foreground">Add condition photos</label>
                          <PhotoUploadField required className="block w-full text-xs text-muted-foreground file:mr-2 file:rounded-lg file:border-0 file:bg-muted file:px-2.5 file:py-1.5 file:text-xs file:text-foreground" />
                          <SaveButton className="btn-primary btn-sm mt-2 w-full">Take or choose photos</SaveButton>
                        </SaveForm>
                      )}
                      <Link href={`/jobcards/${job.id}`} className="inline-flex items-center gap-1 text-xs font-semibold text-primary">Open workspace <ArrowRight className="size-3.5" /></Link>
                    </MobileDataCard>
                    </RecordContextMenu>
                  );
                })}
              </MobileDataList>
            }
            desktop={
              <div className="overflow-x-auto">
                <table className="w-full min-w-[960px] text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/20 text-left text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                      <th className="px-5 py-3 font-semibold">Job</th>
                      <th className="px-4 py-3 font-semibold">Vehicle &amp; customer</th>
                      <th className="px-4 py-3 font-semibold">Technician</th>
                      <th className="px-4 py-3 font-semibold">Bay</th>
                      <th className="px-4 py-3 text-right font-semibold">Estimate</th>
                      <th className="px-4 py-3 font-semibold">Stage</th>
                      <th className="px-4 py-3 font-semibold">Opened</th>
                      <th className="px-5 py-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {filteredJobs.map((job) => {
                      const total = jobCardTotals(job.items).totalCents;
                      const sm = stageMeta(job.status);
                      const pm = priorityMeta(job.priority);
                      return (
                        <RecordContextMenu
                          key={job.id}
                          label={`Job #${job.number}`}
                          href={`/jobcards/${job.id}`}
                          actions={jobContextActions(job.id, job.vehicleId)}
                        >
                        <tr tabIndex={0} className="group transition-colors hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary">
                          <td className="px-5 py-4">
                            <Link href={`/jobcards/${job.id}`} className="font-semibold text-foreground hover:text-primary">#{job.number}</Link>
                            <p className="mt-1 max-w-xs truncate text-xs text-muted-foreground">{job.description}</p>
                          </td>
                          <td className="px-4 py-4">
                            <Link href={`/vehicles/${job.vehicleId}`} className="font-medium text-foreground hover:text-primary">{job.vehicle.model}</Link>
                            <p className="mt-1 text-xs text-muted-foreground">{contactName(job.contact)}{job.vehicle.regNumber ? ` · ${job.vehicle.regNumber}` : ""}</p>
                          </td>
                          <td className="px-4 py-4 text-muted-foreground">{job.technician?.name ?? "Unassigned"}</td>
                          <td className="px-4 py-4 text-muted-foreground">
                            {job.bay ? (
                              <span className="inline-flex items-center gap-1.5"><span className="inline-block size-2 rounded-full" style={{ backgroundColor: job.bay.color }} />{job.bay.name}</span>
                            ) : "—"}
                          </td>
                          <td className="px-4 py-4 text-right font-medium tabular-nums">{formatZAR(Math.round(total))}</td>
                          <td className="px-4 py-4">
                            <span className="inline-flex items-center gap-1.5">
                              <StatusPill tone={sm.tone}>{sm.label}</StatusPill>
                              {job.priority !== "normal" && <span className="inline-block size-2 rounded-full" title={`${pm.label} priority`} style={{ backgroundColor: pm.tone === "danger" ? "#ef4444" : pm.tone === "warning" ? "#f59e0b" : "#64748b" }} />}
                            </span>
                          </td>
                          <td className="px-4 py-4 text-muted-foreground"><span className="inline-flex items-center gap-1.5"><Clock3 className="size-3.5" />{formatDate(job.openedAt)}</span></td>
                          <td className="px-5 py-4 text-right"><Link href={`/jobcards/${job.id}`} className={buttonVariants({ variant: "ghost", size: "sm" })}>Open <ArrowRight /></Link></td>
                        </tr>
                        </RecordContextMenu>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            }
          />
        )}
      </Surface>
    </div>
  );
}

function jobContextActions(jobId: string, vehicleId: string): RecordContextAction[] {
  return [
    { label: "Open vehicle", href: `/vehicles/${vehicleId}`, icon: "car" },
    { label: "Print job card", href: `/jobcards/${jobId}/print`, icon: "print", newTab: true },
  ];
}
