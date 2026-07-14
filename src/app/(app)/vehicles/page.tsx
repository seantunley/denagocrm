import Link from "next/link";
import { Clock3, Plus } from "lucide-react";
import { prisma } from "@/lib/db";
import ModalTrigger from "@/components/Modal";
import VehicleForm from "@/components/VehicleForm";
import { createVehicle } from "@/app/actions/vehicles";
import { contactName, formatDate } from "@/lib/format";
import { computeDue, dueLabels } from "@/lib/serviceDue";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState, StatusPill } from "@/components/visual-system";
import {
  MobileDataCard,
  MobileDataField,
  MobileDataFields,
  MobileDataHeader,
  MobileDataList,
  ResponsiveDataView,
} from "@/components/responsive-patterns";

export default async function VehiclesPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const { filter } = await searchParams;
  const [vehicles, contacts, products] = await Promise.all([
    prisma.vehicle.findMany({
      orderBy: { createdAt: "desc" },
      include: { contact: true, serviceRecords: true, mileageLogs: true },
    }),
    prisma.contact.findMany({ orderBy: { firstName: "asc" }, take: 500 }),
    prisma.product.findMany({ include: { colors: true }, orderBy: { name: "asc" } }),
  ]);

  const rows = vehicles
    .map((v) => ({ vehicle: v, due: computeDue(v) }))
    .filter((r) =>
      filter === "due" ? r.due.status === "overdue" || r.due.status === "due_soon" : true
    );

  return (
    <div className="space-y-5">
      <PageHeader title="Vehicle fleet" description={`${rows.length} vehicle${rows.length === 1 ? "" : "s"}${filter === "due" ? " due for attention" : " registered across your customer base"}.`}>
          <Link
            href={filter === "due" ? "/vehicles" : "/vehicles?filter=due"}
            className={buttonVariants({ variant: filter === "due" ? "default" : "outline", size: "sm" })}
          >
            <Clock3 className="size-4" />{filter === "due" ? "Showing due" : "Service due"}
          </Link>
          <ModalTrigger label={<><Plus className="size-4" />Register vehicle</>} title="Register vehicle" buttonClass={buttonVariants({ size: "sm" })}>
            <VehicleForm
              action={createVehicle}
              contacts={contacts.map((c) => ({ id: c.id, label: contactName(c) }))}
              products={products.map((p) => ({
                id: p.id,
                name: p.name,
                colors: p.colors.map((c) => c.name),
              }))}
              submitLabel="Register vehicle"
              showInitialKm
            />
          </ModalTrigger>
      </PageHeader>

      {rows.length === 0 ? (
        <EmptyState
          icon={Clock3}
          title={filter === "due" ? "Nothing needs attention" : "No vehicles registered"}
          description={filter === "due" ? "Every registered vehicle is currently up to date." : "Register a vehicle to start tracking ownership and service history."}
        />
      ) : (
      <ResponsiveDataView
        mobile={
          <MobileDataList>
            {rows.map(({ vehicle: v, due }) => (
              <MobileDataCard key={v.id}>
                <MobileDataHeader
                  title={<Link href={`/vehicles/${v.id}`} className="text-primary hover:underline">{v.model}</Link>}
                  detail={[v.color, v.vin].filter(Boolean).join(" · ") || "No colour or VIN recorded"}
                  aside={<StatusPill tone={due.status === "overdue" ? "danger" : due.status === "due_soon" ? "warning" : "success"}>{dueLabels[due.status]}</StatusPill>}
                />
                <MobileDataFields>
                  <MobileDataField label="Owner"><Link href={`/contacts/${v.contactId}`} className="text-primary hover:underline">{contactName(v.contact)}</Link></MobileDataField>
                  <MobileDataField label="Current km">{due.currentKm != null ? `${due.currentKm.toLocaleString()} km` : "—"}</MobileDataField>
                  <MobileDataField label="Next service" wide>{[due.nextDueDate ? formatDate(due.nextDueDate) : null, due.nextDueKm != null ? `${due.nextDueKm.toLocaleString()} km` : null].filter(Boolean).join(" / ") || "Not scheduled"}</MobileDataField>
                  <MobileDataField label="Purchased">{formatDate(v.purchaseDate)}</MobileDataField>
                </MobileDataFields>
              </MobileDataCard>
            ))}
          </MobileDataList>
        }
        desktop={
      <div className="card overflow-x-auto p-0">
        <table className="table-base">
          <thead>
            <tr>
              <th>Model</th>
              <th>Owner</th>
              <th>VIN / Serial</th>
              <th>Current km</th>
              <th>Next service</th>
              <th>Status</th>
              <th>Purchased</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ vehicle: v, due }) => (
              <tr key={v.id}>
                <td>
                  <Link href={`/vehicles/${v.id}`} className="font-medium text-orange-400 hover:underline">
                    {v.model}
                  </Link>
                  {v.color && <span className="text-xs text-slate-400 ml-2">{v.color}</span>}
                </td>
                <td>
                  <Link href={`/contacts/${v.contactId}`} className="text-orange-400 hover:underline">
                    {contactName(v.contact)}
                  </Link>
                </td>
                <td className="font-mono text-xs">{v.vin ?? "—"}</td>
                <td>{due.currentKm != null ? `${due.currentKm.toLocaleString()} km` : "—"}</td>
                <td className="text-slate-400">
                  {[
                    due.nextDueDate ? formatDate(due.nextDueDate) : null,
                    due.nextDueKm != null ? `${due.nextDueKm.toLocaleString()} km` : null,
                  ]
                    .filter(Boolean)
                    .join(" / ") || "—"}
                </td>
                <td>
                  <StatusPill tone={due.status === "overdue" ? "danger" : due.status === "due_soon" ? "warning" : "success"}>{dueLabels[due.status]}</StatusPill>
                </td>
                <td className="text-slate-400">{formatDate(v.purchaseDate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
        }
      />
      )}
    </div>
  );
}
