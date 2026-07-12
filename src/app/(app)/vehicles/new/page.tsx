import { prisma } from "@/lib/db";
import { createVehicle } from "@/app/actions/vehicles";
import VehicleForm from "@/components/VehicleForm";
import { contactName } from "@/lib/format";

export default async function NewVehiclePage({
  searchParams,
}: {
  searchParams: Promise<{ contactId?: string; productId?: string; color?: string }>;
}) {
  const { contactId, productId, color } = await searchParams;
  const [contacts, products] = await Promise.all([
    prisma.contact.findMany({ orderBy: { firstName: "asc" }, take: 500 }),
    prisma.product.findMany({ include: { colors: true }, orderBy: { name: "asc" } }),
  ]);
  const preselected = products.find((p) => p.id === productId);

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold tracking-[-0.035em]">Register vehicle</h1>
      <VehicleForm
        action={createVehicle}
        contacts={contacts.map((c) => ({ id: c.id, label: contactName(c) }))}
        products={products.map((p) => ({
          id: p.id,
          name: p.name,
          colors: p.colors.map((c) => c.name),
        }))}
        defaults={{
          contactId: contactId ?? "",
          productId: productId ?? "",
          model: preselected?.name ?? "",
          color: color ?? "",
        }}
        submitLabel="Register vehicle"
        showInitialKm
      />
    </div>
  );
}
