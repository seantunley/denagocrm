import "server-only";
import { prisma } from "./db";
import { auditDetailFor } from "./auditDetailQuery";
import { customerHistoryWhere, viewableDealIds } from "./customerHistory";
import { customerTimelineWhere, dealTimelineWhere } from "./customerTimeline";
import { botIdentityForConversation } from "./botConversationControl";
import { handoffContext } from "./botHandoff";
import { isModuleEnabled } from "./modules/enabled";
import { activeTenantPredicate } from "./tenantPredicate";
import { listActingTenantStaff, resolveTenantActor } from "./tenantActor";
import { WHO_LEGEND } from "./assistantWho";
import { OPENED_LEGEND } from "./emailOpenTracking";
import {
  canAccessContact,
  canAccessConversation,
  canAccessLead,
  canAccessQuote,
  getAccessibleContactIds,
  getAccessibleLeadIds,
  getAccessibleQuoteIds,
  hasAnyPermission,
  hasPermission,
  type PermissionUser,
} from "./permissions";
import {
  WHY_LEGEND,
  auditEvents,
  botFlowEvents,
  journeyEvents,
  notEnrolledEvents,
  quoteEvents,
  sendEvents,
  stamp,
  whyTimeline,
  type WhyEvent,
} from "./assistantWhy";

/**
 * The `why` lookup: one lead, customer, quote or inbox conversation's history,
 * with the cause of each event (assistantWhy.ts), so DAX can answer "why did
 * Anna get that email?" / "why is this deal Lost?" / "why did the bot hand
 * over?" from the record and say plainly when the cause isn't recorded.
 *
 * READ-ONLY, and no wider than the pages: the record must be one the person may
 * open (the same canAccess* checks, which also pin it to the acting workspace);
 * its audit trail and messages are what that record's own timeline shows them;
 * journey runs only with Marketing on AND journeys.manage (the only screen that
 * shows runs is /journeys/activity); the chatbot's state only with Automation on
 * AND inbox access to that conversation (the inbox is where it is shown).
 */

type Output = { rows: { label: string; detail: string; href: string }[]; data: unknown[]; truncated: boolean };

const ID = /^c[a-z0-9]{20,}$/i;
const QUOTE_NO = /^(?:Q-?)?(\d{1,9})$/i;
const fuzzy = (needle: string) => ({ contains: needle, mode: "insensitive" as const });
const note = (text: string): Output => ({ truncated: false, rows: [], data: [{ note: text }] });

type Target = { leadId: string | null; contactId: string | null; quoteId: string | null; conversationId: string | null; others?: string[] };

const seesLeads = (u: PermissionUser) => hasAnyPermission(u, "leads.view_all", "leads.view_owned");
const seesContacts = (u: PermissionUser) => hasAnyPermission(u, "contacts.view_all", "contacts.view_owned");
const seesQuotes = (u: PermissionUser) => hasAnyPermission(u, "quotes.view_all", "quotes.view_owned");
const seesInbox = (u: PermissionUser) => hasAnyPermission(u, "inbox.view", "inbox.reply");

/** A lead/customer the person may open — by their page guards (requireLeadReadAccess / requireContactReadAccess). */
const openableLead = async (u: PermissionUser, id: string | null | undefined) => (id && (await seesLeads(u)) && (await canAccessLead(u, id)) ? id : null);
const openableContact = async (u: PermissionUser, id: string | null | undefined) => (id && (await seesContacts(u)) && (await canAccessContact(u, id)) ? id : null);

/** What the person named → the record, checked. Null when nothing they may open matches. */
async function resolve(user: PermissionUser, needle: string): Promise<Target | null> {
  const none = { leadId: null, contactId: null, quoteId: null, conversationId: null };
  const quoteNo = QUOTE_NO.exec(needle);
  if (quoteNo || ID.test(needle)) {
    if (ID.test(needle)) {
      if (await openableLead(user, needle)) return { ...none, leadId: needle };
      if (await openableContact(user, needle)) return { ...none, contactId: needle };
    }
    if (await seesQuotes(user)) {
      const q = await prisma.quote.findFirst({
        where: quoteNo ? { number: Number(quoteNo[1]), deletedAt: null } : { id: needle, deletedAt: null },
        select: { id: true, leadId: true, contactId: true },
      });
      if (q && (await canAccessQuote(user, q.id))) {
        return { ...none, quoteId: q.id, leadId: await openableLead(user, q.leadId), contactId: await openableContact(user, q.contactId) };
      }
    }
    if (ID.test(needle) && (await seesInbox(user))) {
      const c = await prisma.conversation.findFirst({ where: { id: needle, ...activeTenantPredicate("why: conversation") }, select: { channel: true, leadId: true, contactId: true } });
      // The inbox's own rules for who may open a thread: a customer's or a deal's
      // through canAccessConversation; a post's comment thread, which has nobody
      // linked, to anyone with inbox access in the workspace (commentInbox.ts).
      // A DM thread with nobody linked is listed in no inbox, so it is refused.
      const unlinkedComments = c?.channel === "comment" && !c.leadId && !c.contactId;
      if (c && (unlinkedComments || (await canAccessConversation(user, needle)))) {
        return { ...none, conversationId: needle, leadId: await openableLead(user, c.leadId), contactId: await openableContact(user, c.contactId) };
      }
    }
    return null;
  }
  // A name: their deals first (an open one, most recently worked), then customers.
  if (await seesLeads(user)) {
    const ids = await getAccessibleLeadIds(user);
    const leads = await prisma.lead.findMany({
      where: {
        deletedAt: null,
        ...(ids === null ? {} : { id: { in: ids } }),
        OR: [{ name: fuzzy(needle) }, { title: fuzzy(needle) }, { contact: { OR: [{ firstName: fuzzy(needle) }, { lastName: fuzzy(needle) }] } }],
      },
      orderBy: { updatedAt: "desc" },
      take: 5,
      select: { id: true, name: true, title: true, status: true },
    });
    const [best, ...rest] = [...leads].sort((a, b) => Number(a.status !== "open") - Number(b.status !== "open"));
    if (best) return { ...none, leadId: best.id, others: rest.map((l) => `${l.name} — ${l.title} (${l.status}, id ${l.id})`) };
  }
  if (await seesContacts(user)) {
    const ids = await getAccessibleContactIds(user);
    const [first, ...rest] = await prisma.contact.findMany({
      where: { deletedAt: null, ...(ids === null ? {} : { id: { in: ids } }), OR: [{ firstName: fuzzy(needle) }, { lastName: fuzzy(needle) }, { company: fuzzy(needle) }] },
      orderBy: { updatedAt: "desc" },
      take: 5,
      select: { id: true, firstName: true, lastName: true },
    });
    if (first) return { ...none, contactId: first.id, others: rest.map((c) => `${[c.firstName, c.lastName].filter(Boolean).join(" ")} (customer, id ${c.id})`) };
  }
  return null;
}

export async function whyLookup(user: PermissionUser, needle: string): Promise<Output> {
  const target = await resolve(user, needle);
  // A conversation on its own is enough: an inbox thread can have no customer or
  // deal linked, and the resolver has already checked inbox access to it.
  if (!target || (!target.leadId && !target.contactId && !target.quoteId && !target.conversationId)) {
    return note(`No lead, customer, quote or conversation you can open matches "${needle}".`);
  }
  const { leadId } = target;
  const lead = leadId
    ? await prisma.lead.findUnique({
        where: { id: leadId },
        select: { title: true, name: true, status: true, stageEnteredAt: true, lostReason: true, source: true, contactId: true, stage: { select: { name: true } }, assignedTo: { select: { name: true } } },
      })
    : null;
  // A deal's customer joins in only when this person may open that customer — as on the lead page.
  const contactId = target.contactId ?? (await openableContact(user, lead?.contactId));
  const contact = contactId ? await prisma.contact.findUnique({ where: { id: contactId }, select: { firstName: true, lastName: true } }) : null;

  // The timeline the record's own page shows this person (leads/[id], contacts/[id]).
  const dealIds = !leadId && contactId
    ? viewableDealIds((await prisma.lead.findMany({ where: { contactId }, select: { id: true } })).map((l) => l.id), await getAccessibleLeadIds(user))
    : [];
  const auditWhere = leadId ? { leadId } : contactId ? customerHistoryWhere(contactId, dealIds) : null;
  const sendWhere = leadId
    ? dealTimelineWhere({ id: leadId, contactId })
    : contactId
      ? customerTimelineWhere(contactId, dealIds)
      // No customer or deal: the thread's own messages (resolve() checked inbox access to it).
      : target.conversationId ? { conversationId: target.conversationId } : null;

  const [audit, sends, stages, staff, standIn] = await Promise.all([
    auditWhere ? prisma.auditLog.findMany({ where: auditWhere, orderBy: { createdAt: "desc" }, take: 60, select: { id: true, action: true, summary: true, userId: true, userName: true, createdAt: true, leadId: true, contactId: true } }) : [],
    sendWhere
      ? prisma.communication.findMany({
          where: sendWhere,
          orderBy: { occurredAt: "desc" },
          take: 30,
          select: {
            occurredAt: true, direction: true, type: true, subject: true, body: true, user: { select: { id: true, name: true } },
            openToken: true, messageId: true, seenAt: true, openCount: true, bouncedAt: true, bounceReason: true,
          },
        })
      : [],
    prisma.pipelineStage.findMany({ select: { id: true, name: true } }),
    listActingTenantStaff().catch(() => []),
    resolveTenantActor().catch(() => null),
  ]);
  const names = new Map<string, string>([...stages.map((s) => [s.id, s.name] as const), ...staff.map((s) => [s.id, s.name] as const)]);
  const events: WhyEvent[] = [
    ...auditEvents(audit, await auditDetailFor(audit), names),
    ...sendEvents(sends, standIn?.id ?? null),
  ];
  const notes: string[] = [];

  // Quotes: the customer's actions and the automatic reminder, as the quote records them.
  if ((target.quoteId || leadId || contactId) && (await seesQuotes(user))) {
    const ids = await getAccessibleQuoteIds(user);
    const owner = target.quoteId ? { id: target.quoteId } : leadId ? { leadId } : { contactId: contactId! };
    const quotes = await prisma.quote.findMany({
      where: { ...owner, deletedAt: null, ...(ids === null ? {} : { id: { in: ids } }) },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        number: true, createdAt: true, createdBy: { select: { name: true } }, emailedAt: true, viewedAt: true, signedAt: true,
        reminderSentAt: true, declinedAt: true, declineReason: true, changeRequestedAt: true, changeRequestNote: true,
      },
    });
    events.push(...quoteEvents(quotes));
  }

  const subjects = [
    ...(leadId ? [{ leadId }] : []),
    ...(contactId ? [{ contactId }] : []),
  ];
  // Journeys — Marketing, and the people who may open the journey activity trace.
  if (subjects.length && (await isModuleEnabled("marketing"))) {
    if (await hasPermission(user, "journeys.manage")) {
      const [runs, decided] = await Promise.all([
        prisma.journeyRun.findMany({
          where: { OR: subjects },
          orderBy: { createdAt: "desc" },
          take: 10,
          select: {
            status: true, createdAt: true, completedAt: true, lastError: true, journey: { select: { name: true } },
            stepLogs: { orderBy: { startedAt: "desc" }, take: 8, select: { stepType: true, status: true, note: true, startedAt: true } },
          },
        }),
        prisma.journeyEvent.findMany({
          where: {
            OR: [...(leadId ? [{ entityType: "lead", entityId: leadId }] : []), ...(contactId ? [{ entityType: "contact", entityId: contactId }] : [])],
          },
          orderBy: { createdAt: "desc" },
          take: 10,
          select: { type: true, createdAt: true, decisions: true },
        }),
      ]);
      events.push(...journeyEvents(runs.map((r) => ({ ...r, journeyName: r.journey.name, steps: r.stepLogs }))), ...notEnrolledEvents(decided));
    } else {
      notes.push("Journey runs are shown only to people who manage journeys — messages a journey sent still name it.");
    }
  }

  // The chatbot — Automation on, and inbox access to the conversation.
  let bot: unknown[] = [];
  if ((await isModuleEnabled("automation")) && (await seesInbox(user))) {
    const conversations = target.conversationId
      ? [{ id: target.conversationId }]
      : await prisma.conversation.findMany({ where: { OR: subjects }, orderBy: { lastMessageAt: "desc" }, take: 3, select: { id: true } });
    bot = (await Promise.all(conversations.map((c) => botFacts(user, c.id, events)))).filter(Boolean);
  }

  const { events: timeline, truncated } = whyTimeline(events);
  const link = leadId ? `/leads/${leadId}` : contactId ? `/contacts/${contactId}` : target.quoteId ? `/quotes/${target.quoteId}` : `/inbox?conversation=${target.conversationId}`;
  const label = lead ? `${lead.name} — ${lead.title}` : contact ? [contact.firstName, contact.lastName].filter(Boolean).join(" ") : target.quoteId ? "Quote" : "Inbox conversation (nobody linked)";
  return {
    truncated,
    rows: [{ label, detail: "History and causes", href: link }],
    data: [{
      record: {
        link,
        ...(lead
          ? {
              lead: lead.title, customer: lead.name, status: lead.status, stage: lead.stage.name, inStageSince: stamp(lead.stageEnteredAt),
              assignedTo: lead.assignedTo?.name ?? "unassigned", source: lead.source, ...(lead.lostReason ? { lostReason: lead.lostReason } : {}),
            }
          : contact ? { customer: label } : {}),
      },
      ...(target.others?.length ? { otherMatches: target.others, matched: "Several records match — this is the likeliest; say which one you mean." } : {}),
      legend: WHY_LEGEND,
      who: WHO_LEGEND,
      opens: OPENED_LEGEND,
      events: timeline,
      ...(truncated ? { cut: "Only the newest events are listed." } : {}),
      ...(bot.length ? { chatbot: bot } : {}),
      ...(notes.length ? { notes } : {}),
    }],
  };
}

/** The bot's state on one conversation (who holds it, a handoff's reason), plus its flow events. */
async function botFacts(user: PermissionUser, conversationId: string, events: WhyEvent[]): Promise<unknown> {
  if (!(await canAccessConversation(user, conversationId))) return null;
  const [conversation, identity] = await Promise.all([
    prisma.conversation.findUnique({ where: { id: conversationId }, select: { tenantId: true, channel: true } }),
    botIdentityForConversation(conversationId),
  ]);
  // No workspace on the thread: it has no bot session in any (inboxCollaboration's rule).
  if (!conversation?.tenantId) return null;
  // The bot's session is keyed by the customer's number/handle, which lives on the
  // linked customer — a thread with none can't be matched (the inbox can't either).
  if (!identity) return { channel: conversation.channel, nowHeldBy: "not recorded — no customer is linked, so the chatbot's session can't be matched; the bot's own messages in the thread still say what it did" };
  const where = { tenantId: conversation.tenantId, channel: identity.channel };
  const [session, flow] = await Promise.all([
    prisma.botSession.findFirst({ where: { ...where, key: identity.key }, select: { status: true, ownership: true, vars: true, updatedAt: true, expiresAt: true } }),
    prisma.botFlowEvent.findMany({
      where: { ...where, conversationKey: identity.key, eventType: { in: ["flow_started", "flow_handoff", "flow_completed"] } },
      orderBy: { occurredAt: "desc" },
      take: 10,
      select: { eventType: true, occurredAt: true, flowVersionId: true },
    }),
  ]);
  const versions = await prisma.botFlowVersion.findMany({ where: { tenantId: conversation.tenantId, id: { in: [...new Set(flow.flatMap((f) => (f.flowVersionId ? [f.flowVersionId] : [])))] } }, select: { id: true, flowId: true } });
  const flows = await prisma.botFlow.findMany({ where: { tenantId: conversation.tenantId, id: { in: versions.map((v) => v.flowId) } }, select: { id: true, name: true } });
  const flowName = new Map(versions.map((v) => [v.id, flows.find((f) => f.id === v.flowId)?.name ?? null]));
  events.push(...botFlowEvents(flow.map((f) => ({ eventType: f.eventType, occurredAt: f.occurredAt, flowName: f.flowVersionId ? flowName.get(f.flowVersionId) ?? null : null }))));
  if (!session || session.expiresAt < new Date()) return { channel: conversation.channel, nowHeldBy: "the bot (no pause or handoff in force)" };
  const handoff = session.ownership === "ai_handoff" ? handoffContext(session.vars, session.updatedAt) : null;
  return {
    channel: conversation.channel,
    nowHeldBy: session.ownership === "human" ? "a person took it over" : session.ownership === "ai_handoff" ? "handed over by the bot, waiting for a person" : session.ownership,
    since: stamp(session.updatedAt),
    ...(handoff ? { handoffReason: handoff.reason ?? "not recorded", handoffSummary: handoff.summary, intent: handoff.intent } : {}),
  };
}
