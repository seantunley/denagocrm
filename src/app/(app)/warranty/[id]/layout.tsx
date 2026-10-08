import { notFound } from "next/navigation";
import { requireWarrantyClaimReadAccess } from "@/lib/warrantyAccess";

export default async function WarrantyClaimLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // The claim's read rule (warranty grant AND vehicle). The page checks it again
  // itself: a layout does not re-run on client navigation.
  if (!(await requireWarrantyClaimReadAccess(id))) notFound();
  return children;
}
