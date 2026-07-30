import "server-only";
import fs from "fs";
import path from "path";
import { prisma } from "@/lib/db";
import { buildQuoteContext, buildJobCardContext } from "@/lib/docbuilder/merge";
import { parseDocument, type DocumentModel } from "@/lib/doceditor/model";
import { renderDocumentHtml, renderSigningSheets, type RenderCtx, type StampField } from "@/lib/doceditor/serialize";
import { htmlToPdf } from "@/lib/customDocs";
import { readFile } from "@/lib/storage";
import { getCompanyProfile, companyTokens } from "@/lib/companyProfile";
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
  // Inject the editable Company Profile as {{company.*}} tokens so the brand footer
  // resolves dynamically — even when a document is sent for signing with NO linked
  // record (the signer sheets and final signed PDF re-render from snapshotJson, so an
  // unbound null context would print literal placeholders). Record-specific tokens
  // still win on overlap; bound:false keeps conditionals as the placeholder layout.
  const withCompany = async (ctx: RenderCtx): Promise<RenderCtx> => {
    const company = companyTokens(await getCompanyProfile());
    if (!ctx) return { tokens: company, items: [], vars: {}, bound: false };
    return { ...ctx, tokens: { ...company, ...ctx.tokens }, bound: true };
  };
  if (quoteId) {
    const q = await prisma.quote.findUnique({
      where: { id: quoteId },
      include: { items: true, fees: { orderBy: { sortOrder: "asc" } }, lead: { include: { product: true } }, contact: true, createdBy: true },
    });
    if (q) return withCompany(buildQuoteContext(q));
  } else if (jobCardId) {
    const jc = await prisma.jobCard.findUnique({
      where: { id: jobCardId },
      include: { items: true, vehicle: true, contact: true, technician: true },
    });
    if (jc) return withCompany(buildJobCardContext(jc));
  }
  // No linked record → still resolve the global brand tokens (unbound).
  return withCompany(null);
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

async function fieldImg(ref: string | null): Promise<string | null> {
  if (!ref) return null;
  if (ref.startsWith("http") || ref.startsWith("data:")) return ref;
  try { const buf = await readFile(ref); return `data:image/png;base64,${buf.toString("base64")}`; } catch { return null; }
}

/**
 * Fields already completed by OTHER recipients, as read-only stamps — so the
 * current signer sees (e.g.) Denago's signature already on the document before
 * adding their own.
 */
export async function signedFieldStamps(requestId: string, excludeRecipientId: string): Promise<StampField[]> {
  const rows = await prisma.signatureField.findMany({ where: { requestId, filledAt: { not: null } } });
  const out: StampField[] = [];
  for (const f of rows) {
    if (f.recipientId === excludeRecipientId) continue; // the current signer fills their own
    const base = { page: f.page, x: f.x, y: f.y, width: f.width, height: f.height, kind: f.kind };
    if (f.kind === "signature" || f.kind === "initials" || f.kind === "stamp") {
      const img = await fieldImg(f.value);
      if (img) out.push({ ...base, image: img });
    } else if (f.kind === "checkbox") {
      out.push({ ...base, text: f.value === "true" ? "✓" : "" });
    } else {
      out.push({ ...base, text: f.value ?? "" });
    }
  }
  return out;
}

/** Interactive per-page sheets for the signing surface, bound to the record. */
export async function renderRequestSigningSheets(req: Pick<SignatureRequest, "snapshotJson" | "quoteId" | "jobCardId">): Promise<{ width: number; height: number; margin: number; css: string; pages: string[] }> {
  const doc = parseDocument(req.snapshotJson);
  if (!doc) return { width: 794, height: 1123, margin: 40, css: "", pages: ["<div style='padding:24px;color:#64748b'>This document is unavailable.</div>"] };
  const ctx = await bindCtx(req.quoteId, req.jobCardId);
  return renderSigningSheets(doc, ctx, logoDataUri());
}

export { logoDataUri };
