import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { contactCommunicationWhere } from "./customerContact";
import { getAccessibleContactIds, getAccessibleLeadIds, hasPermission, type PermissionUser } from "./permissions";
import { CONFIRM_EVENTS, confirmedKind, forwardMoves, readProposed, summarizeOutcomes, type Confirmation } from "./assistantOutcomeRules";

const DAY_MS = 86_400_000;

/** What the viewer may open; null = everything (their role sees every deal, or every customer). */
async function visibleTo(viewer: PermissionUser) {
  const [allDeals, allCustomers] = await Promise.all([hasPermission(viewer, "leads.view_all"), hasPermission(viewer, "contacts.view_all")]);
  const [leads, contacts] = await Promise.all([allDeals ? null : getAccessibleLeadIds(viewer), allCustomers ? null : getAccessibleContactIds(viewer)]);
  return { leads: leads && new Set(leads), contacts: contacts && new Set(contacts) };
}

/**
 * Settings → Assistant, "How DAX's suggestions worked out": over the last `days`, the cards DAX offered in this
 * workspace, how many were confirmed, and what happened after (assistantOutcomeRules). Numbers only — nobody's
 * customer is named. Bounded: the period's own rows, and outcomes only on the deals and customers confirmed on.
 *
 * Every query names the workspace — on the scoped client as well, because enforcement is a switch. And only what
 * the viewer may open is counted: an owner whose role sees just their own deals gets numbers about those alone.
 *
 * Null: nothing recorded in the period yet.
 */
export async function assistantOutcomes(
  tenantId: string,
  viewer: PermissionUser,
  staffIds: ReadonlySet<string>,
  { days = 30, now = new Date() }: { days?: number; now?: Date } = {},
) {
  // What DAX offered is recorded from the release that added AssistantTurn.proposed: both sides are counted from the
  // first answer in the period that recorded it, so a Confirm from before is never set against no suggestion.
  const first = await prisma.assistantTurn.findFirst({
    where: { tenantId, createdAt: { gte: new Date(now.getTime() - days * DAY_MS), lte: now }, proposed: { not: Prisma.DbNull } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  if (!first) return null;
  const period = { gte: first.createdAt, lte: now };
  const [turns, events, accepted, stages, visible] = await Promise.all([
    prisma.assistantTurn.findMany({ where: { tenantId, createdAt: period, proposed: { not: Prisma.DbNull } }, select: { userId: true, proposed: true } }),
    prisma.auditEvent.findMany({
      where: { tenantId, eventType: { in: CONFIRM_EVENTS }, createdAt: period },
      select: { actorUserId: true, eventType: true, entityType: true, entityId: true, summary: true, metadata: true, createdAt: true },
    }),
    prisma.auditEvent.findMany({ where: { tenantId, eventType: "quote.accepted", createdAt: period }, select: { entityType: true, entityId: true, createdAt: true } }),
    prisma.pipelineStage.findMany({ where: { tenantId }, select: { id: true, order: true } }),
    visibleTo(viewer),
  ]);

  // An audit event names one record: the deal when there is one, else the customer.
  const on = (e: { entityType: string | null; entityId: string | null }) => ({
    leadId: e.entityType === "Lead" ? e.entityId : null,
    contactId: e.entityType === "Contact" ? e.entityId : null,
  });
  // A deal's customer, so their message counts for a card on their deal.
  const leadIds = [...new Set([...events, ...accepted].flatMap((e) => on(e).leadId ?? []))];
  const leads = leadIds.length ? await prisma.lead.findMany({ where: { tenantId, id: { in: leadIds } }, select: { id: true, contactId: true, wonAt: true } }) : [];
  const customerOf = new Map(leads.map((lead) => [lead.id, lead.contactId]));
  const withCustomer = (r: { leadId: string | null; contactId: string | null }) => ({
    leadId: r.leadId,
    contactId: r.contactId ?? (r.leadId ? customerOf.get(r.leadId) ?? null : null),
  });
  const confirmations: Confirmation[] = events.map((e) => ({ ...withCustomer(on(e)), at: e.createdAt, userId: e.actorUserId, kind: confirmedKind(e) }));
  const dealIds = [...new Set(confirmations.flatMap((c) => c.leadId ?? []))];
  const customerIds = [...new Set(confirmations.flatMap((c) => c.contactId ?? []))];
  const onThem = [{ leadId: { in: dealIds } }, { contactId: { in: customerIds } }];
  const [replies, signed, moves] = await Promise.all([
    prisma.communication.findMany({
      where: { tenantId, direction: "inbound", ...contactCommunicationWhere, occurredAt: period, OR: onThem },
      select: { leadId: true, contactId: true, occurredAt: true },
    }),
    prisma.quote.findMany({ where: { tenantId, signedAt: period, OR: onThem }, select: { leadId: true, contactId: true, signedAt: true } }),
    prisma.auditEvent.findMany({
      where: { tenantId, eventType: "lead.stage_changed", entityType: "Lead", entityId: { in: dealIds }, createdAt: period },
      select: { entityId: true, beforeJson: true, afterJson: true, createdAt: true },
    }),
  ]);

  return {
    since: first.createdAt,
    ...summarizeOutcomes({
      now,
      proposals: turns.flatMap((turn) => readProposed(turn.proposed).map((card) => ({ ...card, userId: turn.userId }))),
      confirmations,
      happened: {
        reply: replies.map((m) => ({ at: m.occurredAt, leadId: m.leadId, contactId: m.contactId })),
        quote: [
          ...signed.flatMap((q) => (q.signedAt ? [{ at: q.signedAt, leadId: q.leadId, contactId: q.contactId }] : [])),
          ...accepted.map((e) => ({ at: e.createdAt, ...withCustomer(on(e)) })),
        ],
        progress: [
          ...forwardMoves(moves, new Map(stages.map((stage) => [stage.id, stage.order]))),
          ...leads.flatMap((lead) => (lead.wonAt ? [{ at: lead.wonAt, leadId: lead.id, contactId: null }] : [])),
        ],
      },
      visible,
      staffIds,
    }),
  };
}
