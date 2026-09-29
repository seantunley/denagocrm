import { getCurrentUser } from "@/lib/auth";
import { hasAnyPermission } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { parseDocument } from "@/lib/doceditor/model";
import { renderModelToPdf } from "@/lib/doceditor/generate";
import { canAccessDocumentLinks } from "@/lib/doceditor/instanceAccess";
import { renderSnapshot } from "@/lib/doceditor/customDocument";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Preview a custom document as it stands (not filed, nothing saved). Same gate
 * as opening it: document view permissions plus every linked record; a
 * forbidden document is indistinguishable from a missing one.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  if (!(await hasAnyPermission(user, "documents.view_all", "documents.view_owned", "documents.manage"))) {
    return new Response("Forbidden", { status: 403 });
  }
  const { id } = await context.params;
  const row = await prisma.docInstance.findUnique({ where: { id } });
  const doc = row && !row.deletedAt ? parseDocument(row.docModelJson) : null;
  if (!row || !doc || !(await canAccessDocumentLinks(user, row))) {
    return new Response("Not found", { status: 404 });
  }
  const pdf = await renderModelToPdf(doc, renderSnapshot(row));
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${row.title.replace(/[^a-z0-9]+/gi, "-")}.pdf"`,
    },
  });
}
