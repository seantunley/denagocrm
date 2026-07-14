import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import PrintActions from "@/components/PrintActions";
import QuotePrintDoc from "@/components/print/QuotePrintDoc";
import { getDocTemplate } from "@/lib/docTemplateStore";

export default async function QuotePrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tpl?: string }>;
}) {
  await requireUser();
  const { id } = await params;
  const { tpl } = await searchParams;
  const quote = await prisma.quote.findUnique({
    where: { id },
    include: { items: true, lead: { include: { product: true } }, contact: true, createdBy: true },
  });
  if (!quote) notFound();

  return (
    <>
      <PrintActions backHref={`/quotes/${quote.id}`} backLabel="Back to quote" />
      <QuotePrintDoc quote={quote} template={await getDocTemplate("quote", tpl)} />
    </>
  );
}
