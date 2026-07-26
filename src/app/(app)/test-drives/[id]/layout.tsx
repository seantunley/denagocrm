import { requireTestDriveReadAccess } from "@/lib/testDriveAccess";

export default async function TestDriveDetailLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireTestDriveReadAccess(id);
  return children;
}
