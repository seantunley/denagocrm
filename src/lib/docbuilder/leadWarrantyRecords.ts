import "server-only";
import { prisma } from "@/lib/db";
import { getCompanyProfile, companyTokens } from "@/lib/companyProfile";
import { readTemplateDocument } from "@/lib/doceditor/legacy";
import type { DocumentModel } from "@/lib/doceditor/model";
import { renderDocumentHtml } from "@/lib/doceditor/serialize";
import { logoDataUri } from "@/lib/signing/render";
import { publishedBuilderTemplateFor } from "./published";
import { buildLeadContext, buildWarrantyContext } from "./leadWarrantyContext";
import type { MergeContext } from "./merge";

export type BoundRecord = { ctx: MergeContext; label: string; contactId: string | null };

/**
 * Lead and warranty-claim records for the single editor. Every read goes through
 * the tenant-scoped client; access to the record is the CALLER's check
 * (requireLeadReadAccess / requireVehicleReadAccess on the print routes,
 * canAccessBuilderRecord on the builder routes), exactly as for quotes.
 */
export async function loadLeadForDoc(leadId: string): Promise<BoundRecord | null> {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { product: true, contact: true },
  });
  if (!lead) return null;
  return { ctx: buildLeadContext(lead), label: lead.name, contactId: lead.contactId };
}

export async function loadWarrantyClaimForDoc(claimId: string): Promise<BoundRecord | null> {
  const claim = await prisma.warrantyClaim.findUnique({
    where: { id: claimId },
    include: { vehicle: { include: { contact: true } } },
  });
  if (!claim) return null;
  // WarrantyClaim.jobCardId has no relation, so the parts are a separate
  // tenant-scoped read rather than an include.
  const parts = claim.jobCardId
    ? await prisma.jobCardItem.findMany({ where: { jobCardId: claim.jobCardId } })
    : [];
  const ctx = buildWarrantyContext(claim, parts);
  return { ctx, label: ctx.tokens["claim.number"], contactId: claim.vehicle.contactId };
}

/**
 * The layout a print page switches to: the default template for `key`, but only
 * once it is PUBLISHED and readable. The legacy page and its document route both
 * ask this one question, so they cannot disagree and bounce between each other.
 */
export async function printableRecordLayout(key: string): Promise<DocumentModel | null> {
  const template = await publishedBuilderTemplateFor(key);
  if (!template) return null;
  const read = readTemplateDocument(template.data, template.name);
  return read.status === "ok" ? read.doc : null;
}

/** Render a published layout bound to a lead / warranty claim, with the company brand. */
export async function renderRecordDocumentHtml(
  doc: DocumentModel,
  bound: BoundRecord,
  toolbarHtml: string,
): Promise<string> {
  const company = companyTokens(await getCompanyProfile());
  return renderDocumentHtml(
    doc,
    { ...bound.ctx, tokens: { ...company, ...bound.ctx.tokens }, bound: true },
    logoDataUri(),
    // Nothing is being signed on paper here — the dashed field boxes are an
    // e-signing affordance, as on the unsigned printed quote.
    { hideOverlays: true, toolbarHtml },
  );
}
