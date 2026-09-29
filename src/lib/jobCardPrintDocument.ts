import "server-only";
import { prisma } from "@/lib/db";
import { publishedBuilderTemplateFor } from "@/lib/docbuilder/published";
import { renderDocumentHtml } from "@/lib/doceditor/serialize";
import { bindCtx, logoDataUri } from "@/lib/signing/render";

/**
 * The printed job card from the PUBLISHED single-editor layout — the same
 * pattern as quotePrintDocument.ts. Null when no jobcard layout is published;
 * the print page then keeps its original React layout, unchanged.
 */
export async function renderJobCardPrintHtml(opts: {
  jobCardId: string;
  /** Append the check-in / check-out photos, as ?photos=1 does on the old page. */
  photos?: boolean;
  toolbarHtml?: string;
}): Promise<string | null> {
  const live = await publishedBuilderTemplateFor("jobcard");
  if (!live) return null;
  const ctx = await bindCtx(null, opts.jobCardId);

  let appendHtml: string | undefined;
  if (opts.photos) {
    const docs = await prisma.document.findMany({
      where: { jobCardId: opts.jobCardId, deletedAt: null, tag: { in: ["checkin-photo", "checkout-photo"] } },
      orderBy: { createdAt: "asc" },
      select: { id: true, tag: true, annotatedStoredName: true },
    });
    if (docs.length) {
      const figures = docs
        .map((d) => {
          const src = `/api/jobcard-photo/${encodeURIComponent(d.id)}${d.annotatedStoredName ? "?v=annotated" : ""}`;
          const caption = `${d.tag === "checkout-photo" ? "Check-out" : "Check-in"}${d.annotatedStoredName ? " · marked up" : ""}`;
          return `<figure style="margin:0;break-inside:avoid"><img src="${src}" alt="" style="width:100%;border:1px solid #cbd5e1;border-radius:8px;object-fit:contain"/><figcaption style="font-size:7.5pt;color:#64748b">${caption}</figcaption></figure>`;
        })
        .join("");
      appendHtml = `<div class="doc-page" style="display:flow-root"><div style="font-size:8pt;font-weight:700;letter-spacing:1px;color:#64748b;margin-bottom:6px">CONDITION PHOTOS</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">${figures}</div></div>`;
    }
  }

  return renderDocumentHtml(live.doc, ctx, logoDataUri(), {
    // A printed job card carries the customer's stored signature (a conditional
    // in the layout), not the e-signing placeholder boxes.
    hideOverlays: true,
    appendHtml,
    toolbarHtml: opts.toolbarHtml,
  });
}
