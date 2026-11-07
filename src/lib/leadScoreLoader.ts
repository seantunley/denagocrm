import "server-only";

import { prisma } from "./db";
import { getAccessibleContactIds, getAccessibleLeadIds, type PermissionUser } from "./permissions";
import { scoreLead, type LeadScore } from "./leadScore";
import { handledToday } from "./todayAction";
import { contactActivityWhere, contactCommunicationWhere } from "./customerContact";
import { firstStageOrders, stageContactAt } from "./stageContact";

/**
 * Lead score — the IMPURE half: gathers the signals `scoreLead` reads.
 *
 * Computed on read, never stored, for the reason the Attention Centre gives
 * (src/lib/attention/load.ts): half the inputs are functions of the clock, so a
 * stored score is stale the moment it is written.
 *
 * Every read goes through the tenant-scoped `prisma`, and the candidate list
 * through `getAccessibleLeadIds` — a queue that tells a rep who to call must not
 * be able to name a deal they cannot open.
 *
 * Grouped queries over the id set (six by lead, three by the leads' customers),
 * then an in-memory join: a fixed number of round trips whether the list holds
 * one lead or five hundred.
 */

/**
 * ponytail: 500-lead ceiling, most recently updated first. A rep who can see
 * more open deals than this loses the least recently touched ones from Today
 * (the page says so). Upgrade path: pre-rank in SQL by the engagement signals
 * before applying the cap.
 */
export const TODAY_CANDIDATE_CAP = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The lead fields scoring needs. Both callers already select these. */
export type ScorableLead = {
  id: string;
  valueCents: number;
  status: string;
  createdAt: Date;
  stageEnteredAt: Date;
  stage: { name: string; isClosed: boolean; staleAfterDays: number | null; order: number; pipelineId: string };
};

const latest = (a: Date | null | undefined, b: Date | null | undefined) =>
  !a ? b ?? null : !b ? a : a > b ? a : b;

/**
 * A score, plus the two moments Today needs to decide whether the deal was already
 * handled today (lib/todayAction.ts handledToday).
 */
export type ScoredLead = LeadScore & {
  /** The customer's last message to us, on this deal or on the customer with no deal. */
  lastInboundAt: Date | null;
  /** OUR last touch: a message we sent, or a call/meeting we logged. Not a quote they opened. */
  ourLastTouchAt: Date | null;
};

/**
 * Scores a set of leads the caller has ALREADY access-checked. Does not
 * re-derive access: pass it only rows you were allowed to read.
 */
export async function scoreLeads(leads: ScorableLead[], now: Date = new Date()): Promise<Map<string, ScoredLead>> {
  const out = new Map<string, ScoredLead>();
  if (leads.length === 0) return out;
  const leadId = { in: leads.map((lead) => lead.id) };

  // A message the outbox has not confirmed sent (queued, retrying, dead, cancelled) is not a
  // touch: "handled today" must not hide a deal whose WhatsApp never left. Messages without an
  // outbox row (a logged call, an email) stand as written. Today is all that question reads,
  // so two days back is plenty.
  const unconfirmed = await prisma.botFlowOutbox.findMany({
    where: { communicationId: { not: null }, status: { not: "sent" }, createdAt: { gte: new Date(now.getTime() - 2 * 86_400_000) } },
    select: { communicationId: true },
  });
  const sentOnly = unconfirmed.length ? { id: { notIn: unconfirmed.map((row) => row.communicationId as string) } } : {};

  const [contact, inbound, done, planned, viewed, outstanding, outbound] = await Promise.all([
    // Contact means the customer (customerContact.ts): a note is something WE
    // wrote down, and a ticked-off to-do or blocked-out time isn't a touch either.
    prisma.communication.groupBy({ by: ["leadId"], where: { leadId, ...contactCommunicationWhere }, _max: { occurredAt: true } }),
    // "The customer wrote to us" — a real inbound message, never a note filed as
    // inbound (the generic communication action accepts type "note" with any
    // direction), or a newer note would award "waiting on our reply".
    prisma.communication.groupBy({ by: ["leadId"], where: { leadId, direction: "inbound", ...contactCommunicationWhere }, _max: { occurredAt: true } }),
    prisma.activity.groupBy({ by: ["leadId"], where: { leadId, ...contactActivityWhere }, _max: { doneAt: true } }),
    // The EARLIEST planned activity answers both questions at once: none means no
    // next step, and one in the past means something is overdue.
    prisma.activity.groupBy({ by: ["leadId"], where: { leadId, status: "planned" }, _min: { dueDate: true } }),
    // A signed quote's view is history, not interest.
    prisma.quote.groupBy({ by: ["leadId"], where: { leadId, deletedAt: null, signedAt: null }, _max: { viewedAt: true } }),
    // Superseded quotes have been replaced; chasing one is noise.
    prisma.quote.groupBy({
      by: ["leadId"],
      where: { leadId, deletedAt: null, status: "sent", signedAt: null, supersededAt: null },
      _count: { _all: true },
    }),
    // What WE sent — "handled today" must not count a quote the customer opened.
    prisma.communication.groupBy({ by: ["leadId"], where: { leadId, direction: "outbound", ...contactCommunicationWhere, ...sentOnly }, _max: { occurredAt: true } }),
  ]);

  // THE CUSTOMER'S OWN ROWS THAT SIT ON NO LEAD count as contact with this lead
  // too. An email sent from the customer's page, a reply in the inbox, a
  // Messenger message: each is filed on the customer with no lead. Reading only
  // `leadId` rows, a lead whose customer had been emailed that morning still
  // said "New lead — not contacted yet". The same widening the gone-quiet list
  // (leadIdle.ts) and the assistant (crmAssistant.ts) already apply. Not the
  // customer's rows on ANOTHER lead — those are another deal's contact.
  const links = await prisma.lead.findMany({ where: { id: leadId, contactId: { not: null } }, select: { id: true, contactId: true } });
  const customerOf = new Map(links.map((link) => [link.id, link.contactId as string]));
  const contactId = { in: [...new Set(customerOf.values())] };
  const [customerContact, customerInbound, customerDone, customerOutbound] = customerOf.size
    ? await Promise.all([
        prisma.communication.groupBy({ by: ["contactId"], where: { contactId, leadId: null, ...contactCommunicationWhere }, _max: { occurredAt: true } }),
        prisma.communication.groupBy({ by: ["contactId"], where: { contactId, leadId: null, direction: "inbound", ...contactCommunicationWhere }, _max: { occurredAt: true } }),
        prisma.activity.groupBy({ by: ["contactId"], where: { contactId, leadId: null, ...contactActivityWhere }, _max: { doneAt: true } }),
        prisma.communication.groupBy({ by: ["contactId"], where: { contactId, leadId: null, direction: "outbound", ...contactCommunicationWhere, ...sentOnly }, _max: { occurredAt: true } }),
      ])
    : [[], [], [], []];
  const byCustomer = <T extends { contactId: string | null }>(rows: T[], pick: (row: T) => Date | null) =>
    new Map(rows.filter((row) => row.contactId).map((row) => [row.contactId as string, pick(row)]));
  const customerComm = byCustomer(customerContact, (row) => row._max.occurredAt);
  const customerWrote = byCustomer(customerInbound, (row) => row._max.occurredAt);
  const customerActivity = byCustomer(customerDone, (row) => row._max.doneAt);
  const customerSent = byCustomer(customerOutbound, (row) => row._max.occurredAt);

  /*
   * QUOTES ARE PART OF THE CONTACT. A quote that has reached the customer —
   * emailed from the CRM, opened, or signed — is contact at that moment; and a
   * quote at all, even a draft, means the deal is being worked. Both read on the
   * lead AND on its customer with no deal (a quote made for the customer
   * directly), the same widening as the messages above. Without this a lead in
   * Quoted, whose quote went out from Outlook, scored "New lead — not contacted
   * yet" (Sean, 2026-10-15).
   */
  const [leadQuotes, customerQuotes] = await Promise.all([
    prisma.quote.findMany({ where: { leadId, deletedAt: null }, select: { leadId: true, emailedAt: true, viewedAt: true, signedAt: true } }),
    customerOf.size
      ? prisma.quote.findMany({ where: { contactId, leadId: null, deletedAt: null }, select: { contactId: true, emailedAt: true, viewedAt: true, signedAt: true } })
      : Promise.resolve([] as { contactId: string | null; emailedAt: Date | null; viewedAt: Date | null; signedAt: Date | null }[]),
  ]);
  const reached = (quote: { emailedAt: Date | null; viewedAt: Date | null; signedAt: Date | null }) => latest(latest(quote.emailedAt, quote.viewedAt), quote.signedAt);
  const quoteTouch = new Map<string, Date | null>();
  const quoted = new Set<string>();
  for (const quote of leadQuotes) {
    if (!quote.leadId) continue;
    quoted.add(quote.leadId);
    quoteTouch.set(quote.leadId, latest(quoteTouch.get(quote.leadId), reached(quote)));
  }
  const customerQuoteTouch = new Map<string, Date | null>();
  const customerQuoted = new Set<string>();
  for (const quote of customerQuotes) {
    if (!quote.contactId) continue;
    customerQuoted.add(quote.contactId);
    customerQuoteTouch.set(quote.contactId, latest(customerQuoteTouch.get(quote.contactId), reached(quote)));
  }

  const byLead = <T extends { leadId: string | null }, V>(rows: T[], pick: (row: T) => V) =>
    new Map(rows.filter((row) => row.leadId).map((row) => [row.leadId as string, pick(row)]));
  const lastComm = byLead(contact, (row) => row._max.occurredAt);
  const lastInbound = byLead(inbound, (row) => row._max.occurredAt);
  const lastDone = byLead(done, (row) => row._max.doneAt);
  const nextPlanned = byLead(planned, (row) => row._min.dueDate);
  const quoteViewed = byLead(viewed, (row) => row._max.viewedAt);
  const quoteOutstanding = new Set(outstanding.map((row) => row.leadId));
  const lastSent = byLead(outbound, (row) => row._max.occurredAt);
  // Moved past the first stage = contacted, as of that move (stageContact.ts).
  const firstOrders = await firstStageOrders(leads);

  for (const lead of leads) {
    const next = nextPlanned.get(lead.id) ?? null;
    const customer = customerOf.get(lead.id) ?? "";
    const lastInboundAt = latest(lastInbound.get(lead.id), customerWrote.get(customer));
    const ourLastTouchAt = latest(
      latest(lastSent.get(lead.id), customerSent.get(customer)),
      latest(lastDone.get(lead.id), customerActivity.get(customer)),
    );
    out.set(lead.id, {
      lastInboundAt,
      ourLastTouchAt,
      ...scoreLead(
        {
          valueCents: lead.valueCents,
          status: lead.status,
          stageName: lead.stage.name,
          stageIsClosed: lead.stage.isClosed,
          daysInStage: Math.floor((now.getTime() - lead.stageEnteredAt.getTime()) / DAY_MS),
          staleAfterDays: lead.stage.staleAfterDays,
          lastContactAt: latest(
            latest(
              latest(latest(lastComm.get(lead.id), lastDone.get(lead.id)), latest(customerComm.get(customer), customerActivity.get(customer))),
              latest(quoteTouch.get(lead.id), customerQuoteTouch.get(customer)),
            ),
            stageContactAt(lead, firstOrders),
          ),
          lastInboundAt,
          quoteViewedAt: quoteViewed.get(lead.id) ?? null,
          quoteSentNotSigned: quoteOutstanding.has(lead.id),
          hasOverdueActivity: next !== null && next < now,
          nextPlannedActivityAt: next,
          createdAt: lead.createdAt,
          hasQuote: quoted.has(lead.id) || customerQuoted.has(customer),
        },
        now,
      ),
    });
  }
  return out;
}

export type TodayLead = {
  id: string;
  /** The person — what the rep calls. */
  name: string;
  /** The opportunity, only when it says something the name does not. */
  opportunity: string | null;
  valueCents: number;
  /** The currency valueCents is in (multicurrency module); null = the base. */
  currency: string | null;
  stageName: string;
  assignedToName: string | null;
  /** The deal's customer, for the WhatsApp window lookup. */
  contactId: string | null;
  /** What Today's composer greets them by. */
  firstName: string;
  /** The deal's own address/number, else its customer's — the customer's only when the viewer may open them. */
  email: string | null;
  phone: string | null;
} & LeadScore;

/**
 * The signed-in rep's open leads, best to act on first. `mine` narrows to deals
 * assigned to them; it never widens past what `getAccessibleLeadIds` allows.
 */
export async function loadTodayLeads(
  user: PermissionUser,
  { mine }: { mine: boolean },
  now: Date = new Date(),
): Promise<{ leads: TodayLead[]; truncated: boolean }> {
  // null = unrestricted within the tenant; [] = nothing, and must stay an
  // impossible match rather than become an absent filter.
  const accessibleIds = await getAccessibleLeadIds(user);
  if (accessibleIds !== null && accessibleIds.length === 0) return { leads: [], truncated: false };

  const rows = await prisma.lead.findMany({
    where: {
      status: "open",
      deletedAt: null,
      stage: { isClosed: false },
      ...(accessibleIds === null ? {} : { id: { in: accessibleIds } }),
      ...(mine ? { assignedToId: user.id } : {}),
    },
    select: {
      id: true,
      name: true,
      title: true,
      valueCents: true,
      currency: true,
      status: true,
      createdAt: true,
      stageEnteredAt: true,
      stage: { select: { name: true, isClosed: true, staleAfterDays: true, order: true, pipelineId: true } },
      assignedTo: { select: { name: true } },
      email: true,
      phone: true,
      contactId: true,
      contact: { select: { firstName: true, email: true, phone: true, whatsapp: true } },
    },
    orderBy: { updatedAt: "desc" },
    // One extra row tells us whether the cap cut anything off.
    take: TODAY_CANDIDATE_CAP + 1,
  });
  const truncated = rows.length > TODAY_CANDIDATE_CAP;
  const candidates = rows.slice(0, TODAY_CANDIDATE_CAP);
  const [scores, accessibleContacts] = await Promise.all([scoreLeads(candidates, now), getAccessibleContactIds(user)]);
  const mayOpen = (contactId: string | null) =>
    contactId !== null && (accessibleContacts === null || accessibleContacts.includes(contactId));

  const leads: TodayLead[] = [];
  for (const row of candidates) {
    const scored = scores.get(row.id);
    if (!scored || scored.score === 0) continue;
    // Reached today and they haven't written since: done for today (todayAction.ts).
    if (handledToday(scored.ourLastTouchAt, scored.lastInboundAt, now)) continue;
    const { lastInboundAt: _inbound, ourLastTouchAt: _touch, ...score } = scored;
    const customer = mayOpen(row.contactId) ? row.contact : null;
    leads.push({
      id: row.id,
      name: row.name,
      opportunity: row.title && row.title !== row.name ? row.title : null,
      valueCents: row.valueCents,
      currency: row.currency,
      stageName: row.stage.name,
      assignedToName: row.assignedTo?.name ?? null,
      contactId: row.contactId,
      firstName: customer?.firstName?.trim() || row.name.trim().split(/\s+/)[0] || row.name,
      email: row.email || customer?.email || null,
      phone: row.phone || customer?.whatsapp || customer?.phone || null,
      ...score,
    });
  }
  // Value breaks ties: between two equally warm deals, the bigger one first.
  leads.sort((a, b) => b.score - a.score || b.valueCents - a.valueCents);
  return { leads, truncated };
}
