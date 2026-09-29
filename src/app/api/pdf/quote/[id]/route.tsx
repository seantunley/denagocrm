import { renderToBuffer } from "@react-pdf/renderer";
import { prisma } from "@/lib/db";
import { requireApiOwner, apiAuthErrorResponse } from "@/lib/auth";
import QuoteDoc from "@/lib/pdf/QuoteDoc";
import { loadBillToFleet } from "@/lib/quoteBillTo";
import { withActingStaffScope } from "@/lib/actingScope";

// react-pdf renders in Node (no browser) — keep this handler on the Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Bound with {@link withActingStaffScope} for the same reason createQuoteForFleet
 * is, and this route is the proof that the reason is not specific to Server
 * Actions.
 *
 * A ROUTE HANDLER renders no layout, so nothing above it establishes the acting
 * workspace - and loadBillToFleet below reads the scope SYNCHRONOUSLY, through
 * activeTenantPredicate. Under TENANT_ENFORCEMENT=enforce a sync read with no
 * scope THROWS, and that throw is uncaught here because the catch above handles
 * only ApiAuthError, so the response is a bare 500.
 *
 * It only ever showed on FLEET quotes: loadBillToFleets returns early when the
 * quote names no fleet, so an ordinary quote never reaches the predicate at all.
 * That is why this rendered correctly for a long time and then broke for one kind
 * of document the moment enforcement was switched on.
 *
 * The wrapper never widens - an already-bound scope wins, and an unresolvable
 * session runs bare so the guards below still fail closed.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withActingStaffScope(async () => {
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
  });
}
