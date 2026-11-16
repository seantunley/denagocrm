import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { ciExactIds } from "./ciExact";
import { resolveTenantActor } from "./tenantActor";
import { sendPushToAll } from "./push";
import { matchFinanceEmail } from "./dealFinanceRules";
import { storedFinanceEmailBody } from "./financeEmailRules";
import { canAccessLead } from "./permissions";

export type InboundEmail = { subject: string; body: string; when: Date; messageId: string | null; dedupeKey: string };

/**
 * An email FROM a finance house (Sean, 2026-11-16: "keep the records up to date"): filed on the one financed deal it
 * names, so their answer is on the deal's timeline without anyone copying it across. Called by imapSync before the
 * ordinary customer routing.
 *
 * Returns null when the sender isn't a finance house — the caller carries on as before. Otherwise whether it was
 * filed: an email that names no single deal (or two) is left in the mailbox, never guessed onto one.
 *
 * Filed as a NOTE: it is not the customer writing, so it must not read as "waiting on our reply" or as contact with
 * the customer (customerContact.ts). Its attachments stay in the mailbox — applicant documents are never stored
 * (Sean: "not storing that information"); the approval letter is filed on the deal by a person. Nothing is changed or
 * sent: the status is moved by staff.
 */
export async function fileFinanceHouseEmail(fromEmail: string, email: InboundEmail): Promise<boolean | null> {
  // The supplier whose address this IS (exact, case-folded), and only a live finance house.
  const ids = await ciExactIds("vendorEmail", fromEmail);
  if (ids.length === 0) return null;
  const houses = await prisma.vendor.findMany({ where: { id: { in: ids }, deletedAt: null, kind: "finance" }, select: { id: true, name: true } });
  if (houses.length === 0) return null;

  const seen = await prisma.communication.findFirst({ where: { dedupeKey: email.dedupeKey }, select: { id: true } });
  if (seen) return false; // filed on a previous run

  const deals = await prisma.dealFinance.findMany({
    where: { vendorId: { in: houses.map((house) => house.id) }, status: { notIn: ["paid_out", "withdrawn"] } },
    select: { id: true, tenantId: true, leadId: true, reference: true, vendorId: true },
  });
  if (deals.length === 0) return false;
  const leads = await prisma.lead.findMany({ where: { id: { in: deals.map((deal) => deal.leadId) }, deletedAt: null }, select: { id: true, name: true, contactId: true, assignedToId: true } });
  const leadOf = new Map(leads.map((lead) => [lead.id, lead]));
  const candidates = deals.flatMap((deal) => {
    const lead = leadOf.get(deal.leadId);
    return lead ? [{ ...deal, customer: lead.name, contactId: lead.contactId, ownerId: lead.assignedToId }] : [];
  });
  const deal = matchFinanceEmail(`${email.subject}\n${email.body}`, candidates);
  if (!deal) return false; // no single deal named — left in the mailbox

  const actor = await resolveTenantActor();
  if (!actor) return false;
  const house = houses.find((h) => h.id === deal.vendorId)!;
  try {
    await prisma.communication.create({
      data: {
        type: "note",
        direction: null,
        subject: `Email from ${house.name}: ${email.subject}`.slice(0, 300),
        // The answer, not the applicant: shortened and masked (financeEmailRules.ts). The full email stays in the mailbox.
        body: storedFinanceEmailBody(email.body),
        occurredAt: email.when,
        messageId: email.messageId,
        dedupeKey: email.dedupeKey,
        leadId: deal.leadId,
        contactId: deal.contactId,
        userId: actor.id,
        tenantId: deal.tenantId,
      },
    });
  } catch (error) {
    // A concurrent run filed it first.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
    throw error;
  }
  // ONLY THE DEAL'S OWN SALESPERSON, and only if they may open it (review of #1138): a customer's finance never reaches
  // the lock screen of someone who can't see the deal. No salesperson: nobody is notified — it is on the deal.
  const owner = deal.ownerId ? await prisma.user.findUnique({ where: { id: deal.ownerId }, select: { id: true, name: true, email: true, role: true } }) : null;
  if (owner && (await canAccessLead(owner, deal.leadId).catch(() => false))) {
    await sendPushToAll(
      { title: `🏦 Email from ${house.name}`, body: `About ${deal.customer}'s finance — update its status`.slice(0, 100), url: `/leads/${deal.leadId}?tab=finance` },
      "email_in",
      { userId: owner.id },
    ).catch(() => {});
  }
  return true;
}
