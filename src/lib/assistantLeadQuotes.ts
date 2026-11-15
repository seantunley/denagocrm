import "server-only";
import { prisma } from "./db";
import { canAccessQuote, hasPermission, type PermissionUser } from "./permissions";
import { logAudit } from "./audit";
import { LEAD_QUOTES_MAX, unlinkedOpenQuotesWhere, type LeadQuotesOutcome } from "./assistantActions";

let failNext = false;
/** Tests only: the next link throws AFTER the lead is open, as a dropped database connection would. */
export function __failNextQuoteLinkForTests(): void {
  failNext = true;
}

/**
 * The customer's open quotes a create_lead card promised, put on the lead it opened (Sean, 2026-11-15: Q-1043 was
 * built for Grant's Auto Spares, then his lead opened without it). Every promised quote comes back sorted:
 *  - moved: put on the lead now;
 *  - already: on it from an earlier Confirm of the same card — so confirming again is safe, and finishes the job;
 *  - skipped, with WHY: it changed since the card (declined, deleted, another deal, another customer, another
 *    currency, a revision) or this person may no longer edit or open it. The reply names each one (review of #1125).
 * A THROW is not "changed": the database didn't answer, nothing was moved (one transaction, count-checked), and the
 * caller says Confirm again.
 */
export async function putQuotesOnNewLead(user: PermissionUser, leadId: string, promised: unknown): Promise<LeadQuotesOutcome> {
  const asked = (Array.isArray(promised) ? promised : [])
    .filter((q): q is { id: string; number: number } => typeof q?.id === "string" && Number.isInteger(q?.number))
    .slice(0, LEAD_QUOTES_MAX);
  const out: LeadQuotesOutcome = { moved: [], already: [], skipped: [] };
  if (!asked.length) return out;
  const lead = await prisma.lead.findFirst({ where: { id: leadId, deletedAt: null }, select: { tenantId: true, contactId: true, currency: true } });
  if (!lead?.tenantId || !lead.contactId) {
    out.skipped = asked.map((q) => ({ number: q.number, why: "the lead isn't open any more" }));
    return out;
  }
  const canEdit = await hasPermission(user, "quotes.edit");
  const rows = await prisma.quote.findMany({
    where: { id: { in: asked.map((q) => q.id) }, tenantId: lead.tenantId },
    select: { id: true, number: true, status: true, leadId: true, contactId: true, currency: true, supersededAt: true, deletedAt: true },
  });
  const eligible: { id: string; number: number }[] = [];
  for (const q of asked) {
    const row = rows.find((r) => r.id === q.id);
    if (!row || row.deletedAt) { out.skipped.push({ number: q.number, why: "it was deleted" }); continue; }
    if (row.leadId === leadId) { out.already.push(row.number); continue; }
    const why = !canEdit ? "your role can't edit quotes"
      : !(await canAccessQuote(user, row.id)) ? "you can't open it any more"
      : row.leadId ? "it's on another deal now"
      : row.supersededAt ? "a revision replaced it"
      : row.status !== "draft" && row.status !== "sent" ? `it's ${row.status} now`
      : row.contactId !== lead.contactId ? "it's another customer's now"
      : (row.currency ?? null) !== (lead.currency ?? null) ? "it's in another currency"
      : null;
    if (why) out.skipped.push({ number: row.number, why });
    else eligible.push({ id: row.id, number: row.number });
  }
  if (!eligible.length) return out;
  if (failNext) {
    failNext = false;
    throw new Error("test: the quote link failed");
  }
  const where = { ...unlinkedOpenQuotesWhere(lead.contactId), id: { in: eligible.map((q) => q.id) }, tenantId: lead.tenantId, currency: lead.currency };
  await prisma.$transaction(async (tx) => {
    const done = await tx.quote.updateMany({ where, data: { leadId } });
    // One changed between the read above and here: nothing moves, and Confirm again sorts each one afresh.
    if (done.count !== eligible.length) throw new Error("quotes changed while being put on the lead");
  });
  out.moved = eligible.map((q) => q.number);
  await logAudit({
    action: "quote.lead_linked", summary: `Put ${out.moved.map((n) => `Q-${n}`).join(", ")} on the new lead`,
    user, leadId, contactId: lead.contactId, metadata: { quoteNumbers: out.moved, via: "assistant" },
  });
  return out;
}
