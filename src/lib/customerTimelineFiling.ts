import "server-only";
import { prisma } from "./db";
import { filedOn } from "./customerTimeline";

/**
 * Where a new timeline entry is filed (lib/customerTimeline.filedOn), with the
 * deal's customer read from the database through the workspace's own client —
 * another workspace's deal reads as missing.
 *
 * Call it AFTER the caller's own access checks on what was posted: the customer
 * it adds is the deal's own, taken from the deal's record, not from the form, so
 * it needs no check of its own — whoever may write on a deal may leave that
 * entry on its customer's history.
 */
export async function resolveFiling(posted: {
  leadId: string | null;
  contactId: string | null;
}): Promise<{ ok: true; leadId: string | null; contactId: string | null } | { ok: false; error: string }> {
  if (!posted.leadId) return filedOn(posted, undefined);
  const deal = await prisma.lead.findUnique({ where: { id: posted.leadId }, select: { contactId: true } });
  if (!deal) return { ok: false, error: "That deal is no longer there — refresh the page." };
  return filedOn(posted, deal.contactId);
}
