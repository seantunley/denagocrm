import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import QuotePrintDoc from "@/components/print/QuotePrintDoc";

export const metadata = { robots: { index: false } };

/**
 * Token-authenticated printable document — identical to the internal print
 * page. Used by the signed-PDF renderer and reachable by the customer.
 */
export default async function TokenPrintPage({
  params,
}: {
  params: Promise<{ kind: string; token: string }>;
}) {
  const { kind, token } = await params;
  if (kind !== "quote" || !/^[a-f0-9]{48,64}$/.test(token)) notFound();

  const quote = await prisma.quote.findFirst({
    where: { signToken: token },
    include: { items: true, lead: { include: { product: true } }, contact: true, createdBy: true },
  });
  if (!quote) notFound();

  return <QuotePrintDoc quote={quote} />;
}
