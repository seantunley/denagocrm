import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import PrintActions from "@/components/PrintActions";
import QuotePrintDoc from "@/components/print/QuotePrintDoc";

export default async function QuotePrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireUser();
  const { id } = await params;
  const quote = await prisma.quote.findUnique({
    where: { id },
    include: { items: true, lead: { include: { product: true } }, contact: true, createdBy: true },
  });
  if (!quote) notFound();

  return (
    <>
      <PrintActions backHref={`/quotes/${quote.id}`} />
      <QuotePrintDoc quote={quote} />
    </>
  );
}
