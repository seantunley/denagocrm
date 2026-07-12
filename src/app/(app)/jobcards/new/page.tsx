import { prisma } from "@/lib/db";
import JobCardForm from "@/components/JobCardForm";
import { contactName } from "@/lib/format";

export default async function NewJobCardPage({
  searchParams,
}: {
  searchParams: Promise<{ vehicleId?: string }>;
}) {
  const { vehicleId } = await searchParams;
  const vehicles = await prisma.vehicle.findMany({
    include: { contact: true },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  return (
    <div className="space-y-5 max-w-xl">
      <h1 className="text-2xl font-semibold tracking-[-0.035em]">New job card</h1>
      <JobCardForm
        vehicles={vehicles.map((v) => ({
          id: v.id,
          label: `${v.model}${v.vin ? ` (${v.vin})` : ""} — ${contactName(v.contact)}`,
        }))}
        defaultVehicleId={vehicleId}
      />
    </div>
  );
}
