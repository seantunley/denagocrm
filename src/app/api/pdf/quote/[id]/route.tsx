import { renderToBuffer } from "@react-pdf/renderer";
import { prisma } from "@/lib/db";
import { requireApiOwner, apiAuthErrorResponse } from "@/lib/auth";
import QuoteDoc from "@/lib/pdf/QuoteDoc";
import { loadBillToFleet } from "@/lib/quoteBillTo";

// react-pdf renders in Node (no browser) — keep this handler on the Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try { await requireApiOwner(); } catch (err) { const r = apiAuthErrorResponse(err); if (r) return r; throw err; }
  const { id } = await ctx.params;
  const { searchParams } = new URL(req.url);
  // ?demo=N repeats the real line items N times to demonstrate multi-page flow.
  const demo = Math.max(1, Math.min(80, parseInt(searchParams.get("demo") ?? "1", 10) || 1));

  const quote = await prisma.quote.findUnique({
    where: { id },
    include: { items: true, fees: { orderBy: { sortOrder: "asc" } }, lead: { include: { product: true } }, contact: true, createdBy: true },
  });
  if (!quote) return new Response("Quote not found", { status: 404 });

  const items =
    demo > 1
      ? Array.from({ length: demo }).flatMap((_, k) =>
          quote.items.map((it) => ({ ...it, id: `${it.id}-${k}` }))
        )
      : quote.items;

  // Unsigned preview only. A signed/sealed PDF is produced solely by the real
  // signing flow after a recipient actually signs — never fabricated here.
  const fleet = await loadBillToFleet(prisma, quote.fleetId);
  const buf = Buffer.from(await renderToBuffer(<QuoteDoc quote={{ ...quote, items }} fleet={fleet} />));

  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="quote-${quote.number}.pdf"`,
    },
  });
}
