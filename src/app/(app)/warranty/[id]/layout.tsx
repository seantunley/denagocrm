import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireVehicleReadAccess } from "@/lib/permissions";

export default async function WarrantyClaimLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const claim = await prisma.warrantyClaim.findUnique({
    where: { id },
    select: { vehicleId: true },
  });
  if (!claim) notFound();
  await requireVehicleReadAccess(claim.vehicleId);
  return children;
}
