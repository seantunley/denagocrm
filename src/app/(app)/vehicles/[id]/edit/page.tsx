import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { updateVehicle } from "@/app/actions/vehicles";
import { hasPermission, requireVehicleAccess } from "@/lib/permissions";
import VehicleForm from "@/components/VehicleForm";
import { contactName } from "@/lib/format";

export default async function EditVehiclePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Third instance of the same shape — no guard, sitting under
  // vehicles/[id]/layout.tsx's requireVehicleReadAccess. requireVehicleAccess is
  // what updateVehicle demands, and it enforces one thing the read guard does not:
  // the automotive module. With the pack switched off this form was still served.
  const user = await requireVehicleAccess(id, "vehicles.manage");
  const [vehicle, products, canTransfer] = await Promise.all([
    prisma.vehicle.findUnique({ where: { id }, include: { contact: true } }),
    prisma.product.findMany({ include: { colors: true }, orderBy: { name: "asc" } }),
    hasPermission(user, "vehicles.transfer"),
  ]);
  if (!vehicle) notFound();
  const owner = contactName(vehicle.contact);

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold tracking-[-0.035em]">Edit {vehicle.model}</h1>
      <VehicleForm
        action={updateVehicle.bind(null, vehicle.id)}
        // The owner isn't chosen here: a change of owner is a transfer (warranty-transfer-brief.md).
        contacts={[{ id: vehicle.contactId, label: owner }]}
        ownerLocked={{ label: owner, transferHref: canTransfer ? `/vehicles/${vehicle.id}?transfer=1` : null }}
        products={products.map((p) => ({
          id: p.id,
          name: p.name,
          colors: p.colors.map((c) => c.name),
        }))}
        defaults={{
          ...vehicle,
          purchaseDate: vehicle.purchaseDate
            ? vehicle.purchaseDate.toISOString().slice(0, 10)
            : "",
        }}
        submitLabel="Save changes"
      />
    </div>
  );
}
