import { requireQuoteReadAccess } from "@/lib/permissions";

export default async function QuoteRecordLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireQuoteReadAccess(id);
  return children;
}
