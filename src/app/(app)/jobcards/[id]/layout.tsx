import { requireJobCardReadAccess } from "@/lib/permissions";

export default async function JobCardRecordLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireJobCardReadAccess(id);
  return children;
}
