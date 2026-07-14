import "server-only";
import fs from "fs";
import path from "path";
import { prisma } from "@/lib/db";
import { buildQuoteContext, buildJobCardContext } from "@/lib/docbuilder/merge";
import { parseDocument, type DocumentModel } from "@/lib/doceditor/model";
import { renderDocumentHtml, type RenderCtx } from "@/lib/doceditor/serialize";
import { htmlToPdf } from "@/lib/customDocs";
import type { SignatureRequest } from "@prisma/client";

let logoCache: string | null | undefined;
function logoDataUri(): string | undefined {
  if (logoCache !== undefined) return logoCache ?? undefined;
  try {
    const buf = fs.readFileSync(path.join(process.cwd(), "public", "branding", "denago-logo-email.png"));
    logoCache = `data:image/png;base64,${buf.toString("base64")}`;
  } catch { logoCache = null; }
  return logoCache ?? undefined;
}

/** Build the merge context for a request's linked record (quote / job card), if any. */
export async function bindCtx(quoteId: string | null, jobCardId: string | null): Promise<RenderCtx> {
  if (quoteId) {
    const q = await prisma.quote.findUnique({
      where: { id: quoteId },
      include: { items: true, lead: { include: { product: true } }, contact: true, createdBy: true },
    });
    if (q) return buildQuoteContext(q);
  } else if (jobCardId) {
    const jc = await prisma.jobCard.findUnique({
      where: { id: jobCardId },
      include: { items: true, vehicle: true, contact: true, technician: true },
    });
    if (jc) return buildJobCardContext(jc);
  }
  return null;
}

/** Render the frozen document of a signature request to print-ready HTML, bound to its record. */
export async function renderRequestDocHtml(req: Pick<SignatureRequest, "snapshotJson" | "quoteId" | "jobCardId">): Promise<string> {
  const doc = parseDocument(req.snapshotJson);
  if (!doc) return "<p style='padding:24px;color:#64748b'>This document is unavailable.</p>";
  const ctx = await bindCtx(req.quoteId, req.jobCardId);
  return renderDocumentHtml(doc, ctx, logoDataUri());
}

/** Render a bound document to an unsigned print-ready PDF (overlay fields hidden). */
export async function renderEnvelopePdf(doc: DocumentModel, quoteId: string | null, jobCardId: string | null): Promise<Buffer> {
  const ctx = await bindCtx(quoteId, jobCardId);
  const html = renderDocumentHtml(doc, ctx, logoDataUri(), { hideOverlays: true });
  return htmlToPdf(html);
}

export { logoDataUri };
