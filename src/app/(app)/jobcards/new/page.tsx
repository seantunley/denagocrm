import { prisma } from "@/lib/db";
import JobCardForm from "@/components/JobCardForm";
import { contactName } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { Surface } from "@/components/visual-system";
import { getAccessibleContactIds, getAccessibleVehicleIds, requirePermission } from "@/lib/permissions";

export default async function NewJobCardPage({
  searchParams,
}: {
  searchParams: Promise<{ vehicleId?: string }>;
}) {
  const user = await requirePermission("jobcards.manage");
  const { vehicleId } = await searchParams;
  const [vehicleIds, contactIds] = await Promise.all([getAccessibleVehicleIds(user), getAccessibleContactIds(user)]);
  const [vehicles, contacts] = await Promise.all([
    prisma.vehicle.findMany({
      where: vehicleIds === null ? {} : { id: { in: vehicleIds } },
      include: { contact: true },
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
    // For a job with no vehicle.
    prisma.contact.findMany({ where: contactIds === null ? {} : { id: { in: contactIds } }, orderBy: { firstName: "asc" }, take: 500 }),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title="New job card" description="Check in a vehicle, or open a job for a customer, and give the workshop a clear, traceable scope of work." />
      <Surface className="p-5 sm:p-6">
        <JobCardForm
          vehicles={vehicles.map((vehicle) => ({
            id: vehicle.id,
            label: `${vehicle.model}${vehicle.regNumber ? ` · ${vehicle.regNumber}` : vehicle.vin ? ` · ${vehicle.vin}` : ""} — ${contactName(vehicle.contact)}`,
          }))}
          defaultVehicleId={vehicleId}
          contacts={contacts.map((contact) => ({ id: contact.id, label: contactName(contact) }))}
        />
      </Surface>
    </div>
  );
}
