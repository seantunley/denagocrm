import Link from "next/link";
import { Plus } from "lucide-react";
import { prisma } from "@/lib/db";
import ModalTrigger from "@/components/Modal";
import JobCardForm from "@/components/JobCardForm";
import { contactName, formatDate, formatZAR } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";

const statusBadge: Record<string, string> = {
  open: "bg-slate-800 text-slate-400",
  in_progress: "bg-amber-500/15 text-amber-300",
  completed: "bg-emerald-500/15 text-emerald-300",
};

export default async function JobCardsPage() {
  const [jobCards, vehicles] = await Promise.all([
    prisma.jobCard.findMany({
      orderBy: [{ status: "asc" }, { openedAt: "desc" }],
      include: { vehicle: true, contact: true, items: true },
      take: 200,
    }),
    prisma.vehicle.findMany({
      include: { contact: true },
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
  ]);

  return (
    <div className="space-y-5">
      <PageHeader title="Workshop jobs" description={`${jobCards.filter((job) => job.status !== "completed").length} active · ${jobCards.length} recent job cards`}>
        <ModalTrigger label={<><Plus className="size-4" />New job card</>} title="New job card" buttonClass={buttonVariants({ size: "sm" })}>
          <JobCardForm
            vehicles={vehicles.map((v) => ({
              id: v.id,
              label: `${v.model}${v.vin ? ` (${v.vin})` : ""} — ${contactName(v.contact)}`,
            }))}
          />
        </ModalTrigger>
      </PageHeader>

      <div className="card p-0 overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>#</th>
              <th>Vehicle</th>
              <th>Customer</th>
              <th>Description</th>
              <th>Total</th>
              <th>Status</th>
              <th>Opened</th>
            </tr>
          </thead>
          <tbody>
            {jobCards.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center text-slate-400 py-8">
                  No job cards yet.
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
                  <td>{formatZAR(Math.round(total))}</td>
                  <td>
                    <span className={`badge ${statusBadge[j.status] ?? statusBadge.open}`}>
                      {j.status.replace("_", " ")}
                    </span>
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
