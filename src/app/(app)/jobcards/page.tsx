import Link from "next/link";
import { Plus } from "lucide-react";
import { prisma } from "@/lib/db";
import ModalTrigger from "@/components/Modal";
import JobCardForm from "@/components/JobCardForm";
import { contactName, formatDate, formatZAR } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { StatusPill } from "@/components/visual-system";
import { stageMeta, priorityMeta, isTerminalStage } from "@/lib/workshop-constants";
import {
  getAccessibleJobCardIds,
  getAccessibleVehicleIds,
  hasPermission,
  requireAnyPermission,
} from "@/lib/permissions";

export default async function JobCardsPage() {
  const user = await requireAnyPermission("jobcards.view_all", "jobcards.view_owned");
  const [jobCardIds, vehicleIds, canManage] = await Promise.all([
    getAccessibleJobCardIds(user),
    getAccessibleVehicleIds(user),
    hasPermission(user, "jobcards.manage"),
  ]);
  const [jobCards, vehicles] = await Promise.all([
    prisma.jobCard.findMany({
      where: jobCardIds === null ? {} : { id: { in: jobCardIds } },
      orderBy: [{ openedAt: "desc" }],
      include: { vehicle: true, contact: true, items: true, bay: true },
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

  return (
    <div className="space-y-5">
      <PageHeader title="Workshop jobs" description={`${jobCards.filter((job) => !isTerminalStage(job.status)).length} active · ${jobCards.length} accessible recent job cards`}>
        {canManage && (
          <ModalTrigger label={<><Plus className="size-4" />New job card</>} title="New job card" buttonClass={buttonVariants({ size: "sm" })}>
            <JobCardForm
              vehicles={vehicles.map((v) => ({
                id: v.id,
                label: `${v.model}${v.vin ? ` (${v.vin})` : ""} — ${contactName(v.contact)}`,
              }))}
            />
          </ModalTrigger>
        )}
      </PageHeader>

      <div className="card p-0 overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>#</th>
              <th>Vehicle</th>
              <th>Customer</th>
              <th>Description</th>
              <th>Bay</th>
              <th>Total</th>
              <th>Status</th>
              <th>Opened</th>
            </tr>
          </thead>
          <tbody>
            {jobCards.length === 0 && (
              <tr>
                <td colSpan={8} className="text-center text-slate-400 py-8">
                  No accessible job cards.
                </td>
              </tr>
            )}
            {jobCards.map((j) => {
              const total = j.items.reduce((s, i) => s + i.qty * i.unitPriceCents, 0);
              return (
                <tr key={j.id}>
                  <td>
                    <Link href={`/jobcards/${j.id}`} className="font-medium text-orange-400 hover:underline">
                      #{j.number}
                    </Link>
                  </td>
                  <td>
                    <Link href={`/vehicles/${j.vehicleId}`} className="text-orange-400 hover:underline">
                      {j.vehicle.model}
                    </Link>
                  </td>
                  <td>{contactName(j.contact)}</td>
                  <td className="max-w-64 truncate">{j.description}</td>
                  <td className="text-slate-400">
                    {j.bay ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="inline-block size-2 rounded-full" style={{ backgroundColor: j.bay.color }} />
                        {j.bay.name}
                      </span>
                    ) : "—"}
                  </td>
                  <td>{formatZAR(Math.round(total))}</td>
                  <td>
                    <div className="flex items-center gap-1.5">
                      <StatusPill tone={stageMeta(j.status).tone}>{stageMeta(j.status).label}</StatusPill>
                      {j.priority !== "normal" && (
                        <span className="inline-block size-2 rounded-full" style={{ backgroundColor: priorityMeta(j.priority).tone === "danger" ? "#ef4444" : priorityMeta(j.priority).tone === "warning" ? "#f59e0b" : "#64748b" }} title={`${priorityMeta(j.priority).label} priority`} />
                      )}
                    </div>
                  </td>
                  <td className="text-slate-400">{formatDate(j.openedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
