import { requireLeadReadAccess } from "@/lib/permissions";

export default async function LeadRecordLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireLeadReadAccess(id);
  return children;
}
