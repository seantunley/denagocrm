"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { actingTenantId } from "@/lib/actingTenant";
import { asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { logAudit } from "@/lib/audit";
import { requireQuoteAccess } from "@/lib/permissions";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { sendEmail } from "@/lib/email";
import { tenantOrigin } from "@/lib/tenantOrigin";
import { brandForTenant, DEFAULT_BRAND } from "@/lib/tenantBrand";
import { formatDateTime } from "@/lib/format";
import { getSetting } from "@/lib/settings";
import { DOCUMENT_TYPES_KEY, parseDocumentTypes } from "@/lib/documentLabels";
import { typesForSupplier } from "@/lib/dealFile";
import { getDealFileConfig } from "@/lib/dealFileConfig";
import { createDocumentRequest } from "@/lib/documentRequests";
import { requestDays, requestEmail } from "@/lib/documentRequestRules";

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/**
 * Ask a supplier for one of its papers on a deal: a link to an upload page that files what it gets on the deal's
 * quote, labelled with the type and the supplier (review section D, 2026-11-09). Nothing goes without this click,
 * and every request is kept on the deal and in the audit trail.
 *
 * `send`: "email" mails the link to the supplier's address from the workspace; "link" only makes the link, for the
 * person to send themselves (WhatsApp) — it is returned ONCE, here, and never stored readable.
 */
export async function requestSupplierDocument(quoteId: string, formData: FormData): Promise<ActionResult & { link?: string }> {
  return asActionResult(async () => {
    const user = await requireQuoteAccess(quoteId, "documents.upload");
    if (!(await isModuleEnabled("suppliers"))) refuse("Suppliers aren't switched on for this workspace.");
    const tenantId = await actingTenantId();
    const quote = await prisma.quote.findFirst({ where: { id: quoteId, tenantId, deletedAt: null }, select: { id: true, number: true, leadId: true, contactId: true } });
    if (!quote) refuse("That quote is no longer there — refresh the page.");
    const vendor = await prisma.vendor.findFirst({
      where: { id: String(formData.get("vendorId") ?? ""), tenantId, deletedAt: null },
      select: { id: true, name: true, email: true, requiredDocuments: true },
    });
    if (!vendor) refuse("Choose a supplier from the list.");
    const documentType = String(formData.get("documentType") ?? "");
    const types = parseDocumentTypes(await getSetting(DOCUMENT_TYPES_KEY));
    // Only a paper this supplier is asked for (its own list, or the default — Settings → Quotes → Deal file checklist).
    const asked = typesForSupplier(await getDealFileConfig(), vendor.requiredDocuments);
    if (!asked.includes(documentType) || !types.includes(documentType)) refuse(`Ask ${vendor.name} for one of the papers on its list (${asked.join(", ") || "none"}).`);

    const send = formData.get("send") === "link" ? "link" : "email";
    const to = String(formData.get("to") ?? vendor.email ?? "").trim();
    if (send === "email" && !EMAIL.test(to)) refuse(`Give ${vendor.name}'s email address — or copy the link and send it yourself.`);

    const days = requestDays(formData.get("days"));
    const expiresAt = new Date(Date.now() + days * 86_400_000);
    const request = await createDocumentRequest({
      tenantId, quoteId: quote.id, vendorId: vendor.id, documentType,
      sentTo: send === "email" ? to : "link copied", createdById: user.id, expiresAt,
    });
    const link = `${(await tenantOrigin(tenantId)) || ""}/u/${request.token}`;

    if (send === "email") {
      const brand = (await brandForTenant(tenantId).catch(() => DEFAULT_BRAND)).displayName;
      const mail = requestEmail({ brand, vendorName: vendor.name, documentType, quoteNumber: quote.number, link, expiresLabel: formatDateTime(expiresAt) });
      const sent = await sendEmail({ to, subject: mail.subject, text: mail.text, senderName: user.name });
      if (!sent.ok) {
        // Not sent: the link must not be left working.
        await prisma.documentRequest.updateMany({ where: { id: request.id, tenantId }, data: { revokedAt: new Date() } });
        refuse(`The email didn't go: ${sent.error ?? "the mail server refused it"}. Nothing was sent.`);
      }
    }
    await logAudit({
      action: "deal.document_requested",
      summary: `Asked ${vendor.name} for their ${documentType.toLowerCase()} on Q-${quote.number}${send === "email" ? ` — emailed to ${to}` : " — link copied to send by hand"}`,
      ...(quote.leadId ? { leadId: quote.leadId } : {}),
      ...(quote.contactId ? { contactId: quote.contactId } : {}),
      user,
    });
    revalidatePath(`/deals/${quoteId}`);
    return send === "email"
      ? { success: `Request emailed to ${vendor.name}` }
      : { success: "Link ready — copy it and send it to the supplier", link };
  });
}

/** Withdraw a request: the link stops working at once. One that has been answered stays answered. */
export async function recallDocumentRequest(quoteId: string, requestId: string): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireQuoteAccess(quoteId, "documents.upload");
    const tenantId = await actingTenantId();
    const request = await prisma.documentRequest.findFirst({
      where: { id: requestId, tenantId, quoteId },
      select: { id: true, documentType: true, vendor: { select: { name: true } } },
    });
    if (!request) refuse("That request is no longer there — refresh the page.");
    const recalled = await prisma.documentRequest.updateMany({
      where: { id: request.id, tenantId, revokedAt: null, fulfilledAt: null },
      data: { revokedAt: new Date(), revokedById: user.id },
    });
    if (recalled.count !== 1) refuse("It was already answered or withdrawn.");
    await logAudit({ action: "deal.document_request_recalled", summary: `Withdrew the request to ${request.vendor.name} for their ${request.documentType.toLowerCase()}`, user });
    revalidatePath(`/deals/${quoteId}`);
    return { success: "Request withdrawn" };
  });
}
