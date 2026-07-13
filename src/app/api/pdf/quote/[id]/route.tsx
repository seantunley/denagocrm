import { renderToBuffer } from "@react-pdf/renderer";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { contactName, formatDate } from "@/lib/format";
import QuoteDoc, { type SignedInfo } from "@/lib/pdf/QuoteDoc";
import { sealPdf } from "@/lib/pdf/seal";

// react-pdf renders in Node (no browser) — keep this handler on the Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await ctx.params;
  const { searchParams } = new URL(req.url);
  // ?demo=N repeats the real line items N times to demonstrate multi-page flow.
  const demo = Math.max(1, Math.min(80, parseInt(searchParams.get("demo") ?? "1", 10) || 1));

  const quote = await prisma.quote.findUnique({
    where: { id },
    include: { items: true, lead: { include: { product: true } }, contact: true, createdBy: true },
  });
  if (!quote) return new Response("Quote not found", { status: 404 });

  const items =
    demo > 1
      ? Array.from({ length: demo }).flatMap((_, k) =>
          quote.items.map((it) => ({ ...it, id: `${it.id}-${k}` }))
        )
      : quote.items;

  // ?sign=1 → render a signed document (signature evidence + certificate page)
  // and apply a real PKCS#7 seal.
  const doSign = searchParams.get("sign") === "1";
  let signed: SignedInfo | undefined;
  if (doSign) {
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "102.65.14.203 (demo)";
    signed = {
      name: quote.contact ? contactName(quote.contact) : quote.lead?.name ?? "Customer",
      email: quote.contact?.email ?? quote.lead?.email ?? "",
      ip,
      date: formatDate(new Date()),
    };
  }

  let buf: Buffer = Buffer.from(await renderToBuffer(<QuoteDoc quote={{ ...quote, items }} signed={signed} />));
  if (doSign) {
    buf = await sealPdf(buf, { reason: `Signed quotation Q-${quote.number}`, name: "Denago Cape Town" });
  }

  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="quote-${quote.number}${doSign ? "-signed" : ""}.pdf"`,
    },
  });
}
