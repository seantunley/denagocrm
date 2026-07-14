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
import { prisma } from "@/lib/db";
import ModalTrigger from "@/components/Modal";
import JobCardForm from "@/components/JobCardForm";
import { contactName, formatDate, formatZAR } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState, MetricCard, StatusPill, Surface } from "@/components/visual-system";
import {
  KpiGrid,
  MobileDataCard,
  MobileDataField,
  MobileDataFields,
  MobileDataHeader,
  MobileDataList,
  ResponsiveDataView,
} from "@/components/responsive-patterns";
import { cn } from "@/lib/utils";
import {
  getAccessibleJobCardIds,
  getAccessibleVehicleIds,
  hasPermission,
  requireAnyPermission,
} from "@/lib/permissions";

const FILTERS = [
  { value: "all", label: "All" },
  { value: "open", label: "Waiting" },
  { value: "in_progress", label: "In progress" },
  { value: "completed", label: "Completed" },
] as const;

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
      orderBy: [{ status: "asc" }, { openedAt: "desc" }],
      include: { vehicle: true, contact: true, items: true, technician: true },
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

  const counts = {
    open: jobCards.filter((job) => job.status === "open").length,
    inProgress: jobCards.filter((job) => job.status === "in_progress").length,
    completed: jobCards.filter((job) => job.status === "completed").length,
    unassigned: jobCards.filter((job) => job.status !== "completed" && !job.technicianId).length,
  };
  const filteredJobs = jobCards.filter((job) => {
    if (activeStatus !== "all" && job.status !== activeStatus) return false;
    if (!query) return true;
    const searchable = [
      String(job.number),
      job.description,
      job.vehicle.model,
      job.vehicle.vin,
      job.vehicle.regNumber,
      contactName(job.contact),
      job.technician?.name,
    ].filter(Boolean).join(" ").toLowerCase();
    return searchable.includes(query);
  });
  const activeValue = jobCards
    .filter((job) => job.status !== "completed")
    .reduce((sum, job) => sum + job.items.reduce((itemSum, item) => itemSum + item.qty * item.unitPriceCents, 0), 0);

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
      <PageHeader
        title="Job cards"
        description="Run every workshop job from vehicle intake through technician work, customer approval and service history."
      >
        {newJobTrigger}
      </PageHeader>

      <KpiGrid>
        <MetricCard icon={CircleDotDashed} label="Waiting to start" value={counts.open} detail="Checked in and queued" />
        <MetricCard icon={Wrench} label="In progress" value={counts.inProgress} detail={formatZAR(Math.round(activeValue)) + " active value"} accent />
        <MetricCard icon={CheckCircle2} label="Completed" value={counts.completed} detail="In accessible recent cards" />
        <MetricCard icon={UserRoundX} label="Unassigned" value={counts.unassigned} detail="Active cards needing an owner" />
      </KpiGrid>

      <Surface className="overflow-visible">
        <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
          <form className="relative w-full lg:max-w-md">
            <input type="hidden" name="status" value={activeStatus} />
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              name="q"
              defaultValue={q}
              className="input pl-9"
              placeholder="Search job, vehicle, customer or technician…"
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
                  const total = job.items.reduce((sum, item) => sum + item.qty * item.unitPriceCents, 0);
                  return (
                    <MobileDataCard key={job.id}>
                      <MobileDataHeader
                        title={<Link href={`/jobcards/${job.id}`} className="text-primary hover:underline">Job #{job.number}</Link>}
                        detail={`${job.vehicle.model} · ${contactName(job.contact)}`}
                        aside={<StatusPill tone={statusTone(job.status)}>{statusLabel(job.status)}</StatusPill>}
                      />
                      <MobileDataFields>
                        <MobileDataField label="Work requested" wide><span className="line-clamp-2 text-muted-foreground">{job.description}</span></MobileDataField>
                        <MobileDataField label="Technician">{job.technician?.name ?? "Unassigned"}</MobileDataField>
                        <MobileDataField label="Estimate">{formatZAR(Math.round(total))}</MobileDataField>
                        <MobileDataField label="Opened">{formatDate(job.openedAt)}</MobileDataField>
                        <MobileDataField label="Mileage">{job.kmIn != null ? `${job.kmIn.toLocaleString()} km` : "Not captured"}</MobileDataField>
                      </MobileDataFields>
                      <Link href={`/jobcards/${job.id}`} className="inline-flex items-center gap-1 text-xs font-semibold text-primary">Open workspace <ArrowRight className="size-3.5" /></Link>
                    </MobileDataCard>
                  );
                })}
              </MobileDataList>
            }
            desktop={
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/20 text-left text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                      <th className="px-5 py-3 font-semibold">Job</th>
                      <th className="px-4 py-3 font-semibold">Vehicle & customer</th>
                      <th className="px-4 py-3 font-semibold">Technician</th>
                      <th className="px-4 py-3 text-right font-semibold">Estimate</th>
                      <th className="px-4 py-3 font-semibold">Status</th>
                      <th className="px-4 py-3 font-semibold">Opened</th>
                      <th className="px-5 py-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {filteredJobs.map((job) => {
                      const total = job.items.reduce((sum, item) => sum + item.qty * item.unitPriceCents, 0);
                      return (
                        <tr key={job.id} className="group transition-colors hover:bg-muted/20">
                          <td className="px-5 py-4">
                            <Link href={`/jobcards/${job.id}`} className="font-semibold text-foreground hover:text-primary">#{job.number}</Link>
                            <p className="mt-1 max-w-xs truncate text-xs text-muted-foreground">{job.description}</p>
                          </td>
                          <td className="px-4 py-4">
                            <Link href={`/vehicles/${job.vehicleId}`} className="font-medium text-foreground hover:text-primary">{job.vehicle.model}</Link>
                            <p className="mt-1 text-xs text-muted-foreground">{contactName(job.contact)}{job.vehicle.regNumber ? ` · ${job.vehicle.regNumber}` : ""}</p>
                          </td>
                          <td className="px-4 py-4 text-muted-foreground">{job.technician?.name ?? "Unassigned"}</td>
                          <td className="px-4 py-4 text-right font-medium tabular-nums">{formatZAR(Math.round(total))}</td>
                          <td className="px-4 py-4"><StatusPill tone={statusTone(job.status)}>{statusLabel(job.status)}</StatusPill></td>
                          <td className="px-4 py-4 text-muted-foreground"><span className="inline-flex items-center gap-1.5"><Clock3 className="size-3.5" />{formatDate(job.openedAt)}</span></td>
                          <td className="px-5 py-4 text-right"><Link href={`/jobcards/${job.id}`} className={buttonVariants({ variant: "ghost", size: "sm" })}>Open <ArrowRight /></Link></td>
                        </tr>
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
