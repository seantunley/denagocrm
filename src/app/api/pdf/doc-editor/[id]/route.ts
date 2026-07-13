import { requireUser } from "@/lib/auth";
import { generateDocEditorPdf } from "@/lib/doceditor/generate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Read-only renderer → Chromium PDF for the doc-editor model (quote-bindable). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const res = await generateDocEditorPdf({ templateId: id, quoteId: url.searchParams.get("quote") });
  if (!res) return new Response("Not found or empty document", { status: 404 });
  return new Response(new Uint8Array(res.buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${res.title.replace(/[^a-z0-9]+/gi, "-")}.pdf"`,
    },
  });
}
