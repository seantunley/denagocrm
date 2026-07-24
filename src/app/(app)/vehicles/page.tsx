import Link from "next/link";
import { AlertTriangle, CarFront, Clock3, Plus, UsersRound } from "lucide-react";
import { prisma } from "@/lib/db";
import ModalTrigger from "@/components/Modal";
import VehicleForm from "@/components/VehicleForm";
import { createVehicle } from "@/app/actions/vehicles";
import { contactName, formatDate } from "@/lib/format";
import { computeDue, dueColors, dueLabels } from "@/lib/serviceDue";
import { WorkspaceHero } from "@/components/workspace-hero";
import { buttonVariants } from "@/components/ui/button";
import { ResponsiveEntityTable } from "@/components/responsive-patterns";
import {
  getAccessibleContactIds,
  getAccessibleVehicleIds,
  hasPermission,
  requireAnyPermission,
} from "@/lib/permissions";
import RecordContextMenu, { type RecordContextAction } from "@/components/RecordContextMenu";

export default async function VehiclesPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const user = await requireAnyPermission("vehicles.view_all", "vehicles.view_owned");
  const { filter } = await searchParams;
  const [vehicleIds, contactIds, canManage, canManageJobs] = await Promise.all([
    getAccessibleVehicleIds(user),
    getAccessibleContactIds(user),
    hasPermission(user, "vehicles.manage"),
    hasPermission(user, "jobcards.manage"),
  ]);
  const [vehicles, contacts, products] = await Promise.all([
    prisma.vehicle.findMany({
      where: vehicleIds === null ? {} : { id: { in: vehicleIds } },
      orderBy: { createdAt: "desc" },
      include: { contact: true, serviceRecords: true, mileageLogs: true },
    }),
    canManage
      ? prisma.contact.findMany({
          where: contactIds === null ? {} : { id: { in: contactIds } },
          orderBy: { firstName: "asc" },
          take: 500,
        })
      : Promise.resolve([]),
    canManage
      ? prisma.product.findMany({ include: { colors: true }, orderBy: { name: "asc" } })
      : Promise.resolve([]),
  ]);

  const rows = vehicles
    .map((v) => ({ vehicle: v, due: computeDue(v) }))
    .filter((r) =>
      filter === "due" ? r.due.status === "overdue" || r.due.status === "due_soon" : true
    );
  const dueRows = vehicles.map((vehicle) => computeDue(vehicle));
  const overdueCount = dueRows.filter((due) => due.status === "overdue").length;
  const dueSoonCount = dueRows.filter((due) => due.status === "due_soon").length;
  const customerCount = new Set(vehicles.map((vehicle) => vehicle.contactId)).size;

  return (
    <div className="space-y-5">
      <WorkspaceHero
        icon={CarFront}
        eyebrow="Fleet & ownership"
        title="Vehicle fleet"
        description={`${rows.length} accessible vehicle${rows.length === 1 ? "" : "s"}${filter === "due" ? " due for attention" : " registered across your customer base"}.`}
        actions={<>
        <Link
            href={filter === "due" ? "/vehicles" : "/vehicles?filter=due"}
            className={buttonVariants({ variant: filter === "due" ? "default" : "outline", size: "sm" })}
          >
            <Clock3 className="size-4" />{filter === "due" ? "Showing due" : "Service due"}
        </Link>
        {canManage && (
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
                variant="dialog"
              />
            </ModalTrigger>
        )}
        </>}
        stats={[
          { label: "Vehicles", value: vehicles.length, detail: `${customerCount} linked customers`, icon: CarFront },
          { label: "Overdue service", value: overdueCount, detail: overdueCount ? "Requires immediate action" : "No overdue services", icon: AlertTriangle, tone: overdueCount ? "danger" : "success" },
          { label: "Due soon", value: dueSoonCount, detail: "Upcoming service window", icon: Clock3, tone: dueSoonCount ? "warning" : "default" },
          { label: "Owners", value: customerCount, detail: "Accessible customer base", icon: UsersRound },
        ]}
      />

      <ResponsiveEntityTable>
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
                <td data-empty colSpan={7} className="text-center text-slate-400 py-8">
                  {filter === "due" ? "Nothing due for service." : "No accessible vehicles."}
                </td>
              </tr>
            )}
            {rows.map(({ vehicle: v, due }) => (
              <RecordContextMenu
                key={v.id}
                label={v.model}
                href={`/vehicles/${v.id}`}
                actions={vehicleContextActions(v.id, canManage, canManageJobs)}
              >
              <tr tabIndex={0} className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary">
                <td data-primary data-label="Model">
                  <Link href={`/vehicles/${v.id}`} className="font-medium text-orange-400 hover:underline">
                    {v.model}
                  </Link>
                  {v.color && <span className="text-xs text-slate-400 ml-2">{v.color}</span>}
                </td>
                <td data-label="Owner">
                  <Link href={`/contacts/${v.contactId}`} className="text-orange-400 hover:underline">
                    {contactName(v.contact)}
                  </Link>
                </td>
                <td data-label="VIN / Serial" className="font-mono text-xs">{v.vin ?? "—"}</td>
                <td data-label="Current km">{due.currentKm != null ? `${due.currentKm.toLocaleString()} km` : "—"}</td>
                <td data-label="Next service" className="text-slate-400">
                  {[
                    due.nextDueDate ? formatDate(due.nextDueDate) : null,
                    due.nextDueKm != null ? `${due.nextDueKm.toLocaleString()} km` : null,
                  ]
                    .filter(Boolean)
                    .join(" / ") || "—"}
                </td>
                <td data-label="Status">
                  <span className={`badge ${dueColors[due.status]}`}>{dueLabels[due.status]}</span>
                </td>
                <td data-label="Purchased" className="text-slate-400">{formatDate(v.purchaseDate)}</td>
              </tr>
              </RecordContextMenu>
            ))}
          </tbody>
        </table>
      </ResponsiveEntityTable>
    </div>
  );
}

function vehicleContextActions(
  vehicleId: string,
  canManage: boolean,
  canManageJobs: boolean,
): RecordContextAction[] {
  return [
    ...(canManage
      ? [{ label: "Edit vehicle", href: `/vehicles/${vehicleId}/edit`, icon: "edit" as const }]
      : []),
    ...(canManageJobs
      ? [{
          label: "Open job card",
          href: `/jobcards/new?vehicleId=${vehicleId}`,
          icon: "jobcard" as const,
        }]
      : []),
  ];
}
