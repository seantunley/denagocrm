import { requireVehicleReadAccess } from "@/lib/permissions";

export default async function VehicleRecordLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireVehicleReadAccess(id);
  return children;
}
