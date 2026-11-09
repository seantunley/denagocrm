import { prisma } from "./db";
import { getAccessibleQuoteIds, type PermissionUser } from "./permissions";
import { actingTenantId } from "./actingTenant";
import { isModuleEnabled } from "./modules/enabled";
import { getSetting } from "./settings";
import { DOCUMENT_TYPES_KEY, parseDocumentTypes } from "./documentLabels";
import { dealFileChecklist } from "./dealFile";
import { dealKey } from "./dealVendors";

/**
 * The deal file as the deal page shows it (Sean, 2026-11-09): every quote on the deal — its lead, revisions
 * included, or the quote alone when it has no lead — that THIS person may open; the current version of each document
 * filed on them; the signature requests; the suppliers declared on the deal; and the checklist. ONE loader for the
 * page and the ZIP download, so the pack can never list or tick differently from the screen.
 *
 * With the Suppliers module off, no supplier is shown or counted (vendor undefined) and the checklist asks for
 * supplier papers by type alone.
 */
export async function loadDealFile(quote: { id: string; leadId: string | null }, user: PermissionUser) {
  const accessibleQuoteIds = await getAccessibleQuoteIds(user);
  const dealQuotes = await prisma.quote.findMany({
    where: {
      deletedAt: null,
      ...(quote.leadId ? { leadId: quote.leadId } : { id: quote.id }),
      ...(accessibleQuoteIds ? { AND: [{ id: { in: accessibleQuoteIds } }] } : {}),
    },
    include: { items: true, fees: { orderBy: { sortOrder: "asc" } } },
    orderBy: { createdAt: "desc" },
  });
  const dealQuoteIds = dealQuotes.map((dealQuote) => dealQuote.id);
  const tenantId = await actingTenantId();
  const suppliersOn = await isModuleEnabled("suppliers");
  const [rawDocuments, signatures, documentTypes, declared] = await Promise.all([
    prisma.document.findMany({
      // The current version of each file only — an older one is kept in its history (replacedById).
      where: { quoteId: { in: dealQuoteIds }, deletedAt: null, replacedById: null },
      select: {
        id: true, fileName: true, tag: true, sizeBytes: true, createdAt: true, quoteId: true,
        storedName: true, mimeType: true, tenantId: true, vehicleId: true, jobCardId: true,
        uploadedBy: { select: { name: true } },
        vendor: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    dealSignatureRequests(dealQuoteIds),
    getSetting(DOCUMENT_TYPES_KEY).then(parseDocumentTypes),
    suppliersOn
      ? prisma.dealVendor.findMany({
          where: { tenantId, ...dealKey(quote) },
          select: { vendor: { select: { id: true, name: true, kind: true } } },
          orderBy: { createdAt: "asc" },
        })
      : [],
  ]);
  const documents = rawDocuments.map((doc) => ({ ...doc, vendor: suppliersOn ? doc.vendor : undefined }));
  const declaredVendors = declared.map((link) => link.vendor);
  const checklist = dealFileChecklist(
    dealQuotes,
    documents.map((doc) => ({ tag: doc.tag, vendorId: doc.vendor?.id ?? null, vendorName: doc.vendor?.name ?? null })),
    documentTypes,
    declaredVendors,
    suppliersOn,
  );
  return {
    tenantId, suppliersOn, dealQuotes, documents, signatures, documentTypes, declaredVendors, checklist,
    handoverPhotos: await handoverPhotosFor(tenantId, dealQuoteIds),
  };
}

/**
 * Photos taken in these quotes' delivery checklists, oldest first (Tekili Farm, 2026-11-09: 13 handover photos no
 * page showed). They live with the checklist run, not as documents, and a deal leaves the Deliveries board once
 * delivered — so EVERY list of a quote's papers shows them: the documents panel reads them here for whatever quotes
 * it lists (customer page and deal page alike), and so does the ZIP. Deliveries are automotive paperwork, as on
 * /api/files: none with that module off.
 */
export async function handoverPhotosFor(tenantId: string, quoteIds: string[]) {
  if (quoteIds.length === 0 || !(await isModuleEnabled("automotive"))) return [];
  const photos = await prisma.checklistPhoto.findMany({
    where: { tenantId, entry: { run: { tenantId, hostType: "quote.delivery", hostId: { in: quoteIds } } } },
    select: { id: true, url: true, capturedAt: true, entry: { select: { labelSnapshot: true, run: { select: { hostId: true } } } } },
    orderBy: { capturedAt: "asc" },
  });
  return photos.map((photo) => ({ id: photo.id, url: photo.url, capturedAt: photo.capturedAt, step: photo.entry.labelSnapshot, quoteId: photo.entry.run.hostId }));
}

/**
 * Reads behind the deal file and a supplier's page, here so a harness can drive the very query the page runs
 * (scripts/test-supplier-orders.ts).
 */

/**
 * Every signature request on the deal's quotes — no cap (review of #1040: a cap of 20 dropped the oldest without
 * saying so once a deal had more requests and retries than that). A deal has a handful of quotes and each a few
 * requests, so the whole list is small; the deal file's search box narrows it.
 */
export function dealSignatureRequests(quoteIds: string[]) {
  return prisma.signatureRequest.findMany({
    where: { quoteId: { in: quoteIds }, deletedAt: null },
    select: { id: true, title: true, status: true, sentAt: true, completedAt: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
}

/** A supplier's purchase orders in its workspace, newest first (the supplier's page). */
export function vendorPurchaseOrders(tenantId: string, vendorId: string) {
  return prisma.purchaseOrder.findMany({
    where: { tenantId, vendorId, deletedAt: null },
    select: { id: true, reference: true, status: true, orderedAt: true, expectedAt: true, _count: { select: { units: { where: { deletedAt: null } } } } },
    orderBy: { orderedAt: "desc" },
  });
}
