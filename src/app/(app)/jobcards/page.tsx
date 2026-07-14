import Link from "next/link";
import { Plus, Wrench } from "lucide-react";
import { prisma } from "@/lib/db";
import ModalTrigger from "@/components/Modal";
import JobCardForm from "@/components/JobCardForm";
import { contactName, formatDate, formatZAR } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState, StatusPill } from "@/components/visual-system";
import { MobileDataCard, MobileDataField, MobileDataFields, MobileDataHeader, MobileDataList, ResponsiveDataView } from "@/components/responsive-patterns";

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

      {jobCards.length === 0 ? (
        <EmptyState icon={Wrench} title="No job cards yet" description="Create the first workshop job to track labour, parts, status and customer updates." />
      ) : (
      <ResponsiveDataView
        mobile={
          <MobileDataList>
            {jobCards.map((j) => {
              const total = j.items.reduce((sum, item) => sum + item.qty * item.unitPriceCents, 0);
              return (
                <MobileDataCard key={j.id}>
                  <MobileDataHeader
                    title={<Link href={`/jobcards/${j.id}`} className="text-primary hover:underline">Job card #{j.number}</Link>}
                    detail={j.description}
                    aside={<StatusPill tone={j.status === "completed" ? "success" : j.status === "in_progress" ? "warning" : "neutral"}>{j.status.replace("_", " ")}</StatusPill>}
                  />
                  <MobileDataFields>
                    <MobileDataField label="Vehicle"><Link href={`/vehicles/${j.vehicleId}`} className="text-primary hover:underline">{j.vehicle.model}</Link></MobileDataField>
                    <MobileDataField label="Customer">{contactName(j.contact)}</MobileDataField>
                    <MobileDataField label="Total">{formatZAR(Math.round(total))}</MobileDataField>
                    <MobileDataField label="Opened">{formatDate(j.openedAt)}</MobileDataField>
                  </MobileDataFields>
                </MobileDataCard>
              );
            })}
          </MobileDataList>
        }
        desktop={
      <div className="card overflow-x-auto p-0">
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
                    <StatusPill tone={j.status === "completed" ? "success" : j.status === "in_progress" ? "warning" : "neutral"}>{j.status.replace("_", " ")}</StatusPill>
                  </td>
                  <td className="text-slate-400">{formatDate(j.openedAt)}</td>
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
