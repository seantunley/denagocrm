import { prisma } from "./db";

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
