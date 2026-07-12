import Link from "next/link";
import { Clock3, Plus } from "lucide-react";
import { prisma } from "@/lib/db";
import ModalTrigger from "@/components/Modal";
import VehicleForm from "@/components/VehicleForm";
import { createVehicle } from "@/app/actions/vehicles";
import { contactName, formatDate } from "@/lib/format";
import { computeDue, dueColors, dueLabels } from "@/lib/serviceDue";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";

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

      <div className="card p-0 overflow-x-auto">
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
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center text-slate-400 py-8">
                  {filter === "due" ? "Nothing due for service." : "No vehicles registered yet."}
                </td>
              </tr>
            )}
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
                  <span className={`badge ${dueColors[due.status]}`}>{dueLabels[due.status]}</span>
                </td>
                <td className="text-slate-400">{formatDate(v.purchaseDate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
