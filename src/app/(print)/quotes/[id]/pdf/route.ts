import { prisma } from "@/lib/db";
import { requireQuoteReadAccess } from "@/lib/permissions";
import { withActingStaffScope } from "@/lib/actingScope";
import { quotePdf } from "@/lib/quotePdf";
import { quotePdfFileName } from "@/lib/quoteEmail";
import { getCompanyProfile } from "@/lib/companyProfile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Download PDF" on a quote row: the SAME file the quote email attaches (quotePdf),
 * named as everywhere else ("Q-1029 Denago Cape Town.pdf"). Gated exactly like the
 * print page — whoever may read the quote may download it.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return withActingStaffScope(async () => {
    const { id } = await context.params;
    await requireQuoteReadAccess(id);
    const [quote, company, rendered] = await Promise.all([
      prisma.quote.findUnique({ where: { id }, select: { number: true } }),
      getCompanyProfile(),
      quotePdf(id),
    ]);
    if (!quote) return new Response("Quote not found", { status: 404 });
    if (!rendered.ok) {
      const text = rendered.reason === "no_document"
        ? "This quote has no printable layout yet. Open Document Studio and set a default quote document."
        : "The PDF could not be made just now. Please try again.";
      return new Response(text, { status: rendered.reason === "no_document" ? 404 : 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    const fileName = quotePdfFileName(quote.number, company.name);
    return new Response(new Uint8Array(rendered.pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="Q-${quote.number}.pdf"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        // A quote carries pricing and customer details — never cached by a proxy.
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
