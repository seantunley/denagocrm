import { requireCaseReadAccess } from "@/lib/permissions";

export default async function CaseRecordLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireCaseReadAccess(id);
  return children;
}
