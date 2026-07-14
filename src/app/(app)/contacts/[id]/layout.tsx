import { requireContactReadAccess } from "@/lib/permissions";

export default async function ContactRecordLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireContactReadAccess(id);
  return children;
}
