import { logError } from "@/lib/errorLog";
import { throttlePublic } from "@/lib/publicThrottle";
import { PUBLIC_ACTION_POLICY } from "@/lib/rateLimit";
import { SECURE_LINK_TOKEN } from "@/lib/secureLinks";
import { findDocumentRequest } from "@/lib/documentRequests";
import { REQUEST_MAX_BYTES, requestedFileName, requestFileKind } from "@/lib/documentRequestRules";
import { deleteFile, saveFile } from "@/lib/storage";
import { prisma } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { linkVendorToDeal } from "@/lib/dealVendors";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveDocumentRequestTenant } from "@/lib/tokenTenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The upload behind a supplier's document request (lib/documentRequests.ts). Public — the supplier has no account
 * — so the link is the whole authority and is checked on every POST: unknown, answered, recalled and expired links
 * take nothing. The file is judged by its own first bytes (PDF or a photo) and its size, never the name or type the
 * browser claims, and stored in the request's OWN workspace. It is filed on the request's quote, labelled with the
 * type and the supplier asked, and the request closes — ONE file, once: the close is conditional, so two uploads at
 * once file one and the other's stored bytes are removed.
 */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const back = (query: string) => Response.redirect(new URL(`/u/${token}?${query}`, req.url), 303);
  if (!SECURE_LINK_TOKEN.test(token)) return new Response("Not found", { status: 404 });
  const throttled = await throttlePublic("document-request", token, PUBLIC_ACTION_POLICY);
  if (throttled) return throttled;
  return withTokenTenantScope(
    () => resolveDocumentRequestTenant(token),
    () => upload(req, token, back),
    () => new Response("Not found", { status: 404 }),
  );
}

async function upload(req: Request, token: string, back: (query: string) => Response): Promise<Response> {
  const request = await findDocumentRequest(token);
  if (!request) return new Response("Not found", { status: 404 });
  if (request.state !== "open") return back("");

  let file: File | null = null;
  try {
    const form = await req.formData();
    const value = form.get("file");
    file = value instanceof File ? value : null;
  } catch {
    return back("error=failed");
  }
  if (!file || file.size === 0) return back("error=empty");
  if (file.size > REQUEST_MAX_BYTES) return back("error=size");
  const bytes = Buffer.from(await file.arrayBuffer());
  const kind = requestFileKind(bytes.subarray(0, 16));
  if (!kind) return back("error=type");

  const fileName = requestedFileName({ documentType: request.documentType, vendorName: request.vendorName, quoteNumber: request.quoteNumber, extension: kind.extension });
  const storedName = await saveFile(bytes, fileName, kind.mimeType, request.tenantId);
  try {
    const filed = await prisma.$transaction(async (tx) => {
      // ONE file, once: claimed only while still open — a second upload racing this one claims nothing.
      const claimed = await tx.documentRequest.updateMany({
        where: { id: request.id, tenantId: request.tenantId, fulfilledAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { fulfilledAt: new Date() },
      });
      if (claimed.count !== 1) return null;
      const doc = await tx.document.create({
        data: {
          tenantId: request.tenantId,
          fileName,
          storedName,
          mimeType: kind.mimeType,
          sizeBytes: bytes.length,
          quoteId: request.quoteId,
          tag: request.documentType,
          vendorId: request.vendorId,
          // The person who asked for it: Document needs a CRM user, and the trail says the supplier sent it.
          uploadedById: request.createdById,
        },
        select: { id: true },
      });
      await tx.documentRequest.updateMany({ where: { id: request.id, tenantId: request.tenantId }, data: { documentId: doc.id } });
      return doc;
    });
    if (!filed) {
      await deleteFile(storedName).catch(() => {});
      return back("");
    }
  } catch (error) {
    await deleteFile(storedName).catch(() => {});
    await logError("document-request", error, `request=${request.id}`, { tenantId: request.tenantId, alert: false }).catch(() => {});
    return back("error=failed");
  }

  // After the file is filed: bookkeeping that must never undo it.
  const quote = await prisma.quote.findFirst({ where: { id: request.quoteId, tenantId: request.tenantId }, select: { id: true, leadId: true, contactId: true } });
  if (quote) {
    await linkVendorToDeal({ tenantId: request.tenantId, quote, vendorId: request.vendorId, userId: request.createdById })
      .catch((error) => logError("document-request", error, `request=${request.id} deal-link`, { tenantId: request.tenantId, alert: false }));
  }
  await logAudit({
    action: "deal.document_received",
    summary: `${request.vendorName} uploaded their ${request.documentType.toLowerCase()} for Q-${request.quoteNumber} through the request link`,
    ...(quote?.leadId ? { leadId: quote.leadId } : {}),
    ...(quote?.contactId ? { contactId: quote.contactId } : {}),
    userName: request.vendorName,
    actorType: "customer",
  }).catch(() => {});
  return back("sent=1");
}
