import { requireApiOwner, apiAuthErrorResponse } from "@/lib/auth";
import { generateDocEditorExport, type ExportFormat } from "@/lib/doceditor/generate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FORMATS: ExportFormat[] = ["html", "email", "doc"];

/** Export a doc-editor template as static HTML, email-safe HTML, or Word (.doc). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try { await requireApiOwner(); } catch (err) { const r = apiAuthErrorResponse(err); if (r) return r; throw err; }
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const fmt = url.searchParams.get("format");
  const format: ExportFormat = FORMATS.includes(fmt as ExportFormat) ? (fmt as ExportFormat) : "html";
  const res = await generateDocEditorExport({ templateId: id, quoteId: url.searchParams.get("quote"), format });
  if (!res) return new Response("Not found", { status: 404 });
  const filename = `${res.title.replace(/[^a-z0-9]+/gi, "-")}.${res.ext}`;
  return new Response(res.content, {
    headers: { "Content-Type": res.mime, "Content-Disposition": `attachment; filename="${filename}"` },
  });
}
