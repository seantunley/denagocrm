import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { updateVehicle } from "@/app/actions/vehicles";
import VehicleForm from "@/components/VehicleForm";
import { contactName } from "@/lib/format";

export default async function EditVehiclePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [vehicle, contacts, products] = await Promise.all([
    prisma.vehicle.findUnique({ where: { id } }),
    prisma.contact.findMany({ orderBy: { firstName: "asc" }, take: 500 }),
    prisma.product.findMany({ include: { colors: true }, orderBy: { name: "asc" } }),
  ]);
  if (!vehicle) notFound();

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold tracking-[-0.035em]">Edit {vehicle.model}</h1>
      <VehicleForm
        action={updateVehicle.bind(null, vehicle.id)}
        contacts={contacts.map((c) => ({ id: c.id, label: contactName(c) }))}
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
