import "server-only";
import { prisma } from "./db";
import { collectAttentionSignals } from "./attention/signals";
import type { AttentionSignal } from "./attention/score";
import { dealTimelineWhere } from "./customerTimeline";
import { contactActivityWhere, contactCommunicationWhere, latestContactAt } from "./customerContact";
import { isModuleEnabled } from "./modules/enabled";
import { quoteSends } from "./quoteEmailStatus";
import { isCustomerSigner } from "./signing/quoteMirror";
import { firstCustomerView, memoCustomer } from "./signing/customerView";
import { ownedWriteTenantId } from "./tenantWrite";
import { johannesburgDateKey } from "./activityDay";
import { formatZAR } from "./format";
import { stamp } from "./assistantWhy";
import { canAccessContact, getAccessibleLeadIds, getAccessibleQuoteIds, hasAnyPermission, type PermissionUser } from "./permissions";
import { STUCK_LEGEND, conversationFacts, setAsideNotes, stageFacts, stuckReasons, type StuckQuote } from "./assistantStuck";
import { getRegionalSettings } from "@/lib/settings";

/**
 * The `stuck` lookup: ONE deal, and why it isn't moving — ranked reasons, each dated and linked to the record it
 * comes from (assistantStuck.ts makes them), with the facts behind them: time in the stage against its limit, the
 * last word each way, the latest quote (sent, opened how often, signed, its deposit), the next step, and messages
 * or notes that mention finance.
 *
 * READ-ONLY, and no wider than the pages: only a deal in the person's own lead list (getAccessibleLeadIds, which
 * is the acting workspace's); its customer's own messages only when they may open that customer (as on the lead
 * page — dealTimelineWhere); a quote only when they may open it; every read on the tenant-scoped client.
 */

type Output = { rows: { label: string; detail: string; href: string }[]; data: unknown[]; truncated: boolean };

const ID = /^c[a-z0-9]{20,}$/i;
const fuzzy = (needle: string) => ({ contains: needle, mode: "insensitive" as const });
const note = (text: string): Output => ({ truncated: false, rows: [], data: [{ note: text }] });
const day = (d: Date) => johannesburgDateKey(d);
const clip = (s: string | null | undefined, n: number) => (s ? (s.length > n ? `${s.slice(0, n)}…` : s) : null);
const latest = (...dates: (Date | null | undefined)[]) =>
  dates.reduce<Date | null>((a, d) => (d && (!a || d.getTime() > a.getTime()) ? d : a), null);
/** The deal a "why is it stuck" question is about: an open one, then a parked one, then a won one. */
const STATUS_ORDER = ["open", "nurture", "won"];
const statusRank = (s: string) => (STATUS_ORDER.includes(s) ? STATUS_ORDER.indexOf(s) : STATUS_ORDER.length);

export async function stuckLookup(user: PermissionUser, needle: string): Promise<Output> {
  if (!(await hasAnyPermission(user, "leads.view_all", "leads.view_owned"))) return note("You don't have access to leads.");
  const ids = await getAccessibleLeadIds(user);
  const matches = ids !== null && ids.length === 0 ? [] : await prisma.lead.findMany({
    where: {
      deletedAt: null,
      ...(ids === null ? {} : { id: { in: ids } }),
      // A lead id, a customer's id (the bubble on a customer page), or a name.
      ...(ID.test(needle)
        ? { OR: [{ id: needle }, { contactId: needle }] }
        : { OR: [{ name: fuzzy(needle) }, { title: fuzzy(needle) }, { contact: { OR: [{ firstName: fuzzy(needle) }, { lastName: fuzzy(needle) }] } }] }),
    },
    orderBy: { updatedAt: "desc" },
    take: 5,
    select: { id: true, name: true, title: true, status: true, stage: { select: { name: true } } },
  });
  if (!matches.length) return note(`No deal you can open matches "${needle}".`);
  const [best, ...others] = [...matches].sort((a, b) => statusRank(a.status) - statusRank(b.status));
  const several = others.length
    ? {
        matched: `${matches.length} deals match "${needle}" — this is the likeliest (open, most recently worked); say which one you mean.`,
        otherMatches: others.map((m) => ({ link: `/leads/${m.id}`, customer: m.name, lead: m.title, status: m.status, stage: m.stage.name })),
      }
    : {};

  const lead = await prisma.lead.findUniqueOrThrow({
    where: { id: best.id },
    select: {
      id: true, title: true, name: true, status: true, valueCents: true, notes: true, createdAt: true,
      stageId: true, stageEnteredAt: true, contactId: true, wonAt: true, lostAt: true, lostReason: true,
      nurtureSince: true, nurtureReason: true, nurtureInterest: true, nurtureReviewAt: true, attentionDispositions: true,
      stage: { select: { name: true, staleAfterDays: true } },
      assignedTo: { select: { name: true } },
    },
  });
  const link = `/leads/${lead.id}`;
  const moneyFmt = await getRegionalSettings();
  const deal = {
    link, customer: lead.name, lead: lead.title, status: lead.status, value: formatZAR(lead.valueCents, moneyFmt),
    assignedTo: lead.assignedTo?.name ?? "unassigned", ...(lead.wonAt ? { won: day(lead.wonAt) } : {}),
  };
  const label = `${lead.name} — ${lead.title}`;
  if (lead.status === "lost") {
    return {
      truncated: false,
      rows: [{ label, detail: "Lost — closed, not stuck", href: link }],
      data: [{ deal, ...several, note: `This deal was marked lost${lead.lostAt ? ` on ${day(lead.lostAt)}` : ""}${lead.lostReason ? ` — the reason given: "${clip(lead.lostReason, 200)}"` : ""}. It is closed, not stuck.` }],
    };
  }

  const now = new Date();
  // The customer's own rows (on no deal) join the deal's only when this person may open that customer.
  const contactId = lead.contactId && (await hasAnyPermission(user, "contacts.view_all", "contacts.view_owned")) && (await canAccessContact(user, lead.contactId)) ? lead.contactId : null;
  const timeline = dealTimelineWhere({ id: lead.id, contactId });
  const quoteIds = (await hasAnyPermission(user, "quotes.view_all", "quotes.view_owned")) ? await getAccessibleQuoteIds(user) : [];
  const seesQuotes = quoteIds === null || quoteIds.length > 0;
  const mentionsFinance = { OR: [{ body: fuzzy("financ") }, { subject: fuzzy("financ") }] };

  const [signalMap, lastIn, lastOut, lastMessage, lastDone, planned, quote, financeMessages, financeActivities, deliveries] = await Promise.all([
    // The Attention Centre's own signals — for an open deal, as its list only has open ones.
    lead.status === "open"
      ? collectAttentionSignals({
          leadIds: [lead.id],
          now,
          stages: new Map([[lead.stageId, { staleAfterDays: lead.stage.staleAfterDays }]]),
          stageByLead: new Map([[lead.id, lead.stageId]]),
          stageEnteredByLead: new Map([[lead.id, lead.stageEnteredAt]]),
          contactByLead: new Map([[lead.id, contactId]]),
        })
      : Promise.resolve(new Map<string, AttentionSignal[]>()),
    prisma.communication.findFirst({ where: { AND: [timeline, contactCommunicationWhere, { direction: "inbound" }] }, orderBy: { occurredAt: "desc" }, select: { occurredAt: true, type: true } }),
    prisma.communication.findFirst({ where: { AND: [timeline, contactCommunicationWhere, { direction: "outbound" }] }, orderBy: { occurredAt: "desc" }, select: { occurredAt: true, type: true } }),
    prisma.communication.findFirst({ where: { AND: [timeline, contactCommunicationWhere] }, orderBy: { occurredAt: "desc" }, select: { occurredAt: true, type: true } }),
    prisma.activity.findFirst({ where: { AND: [timeline, contactActivityWhere] }, orderBy: { doneAt: "desc" }, select: { type: true, doneAt: true, availabilityBlock: true } }),
    prisma.activity.findMany({
      where: { AND: [timeline, { status: "planned", availabilityBlock: false }] },
      orderBy: { dueDate: "asc" },
      take: 20,
      select: { summary: true, type: true, dueDate: true, leadId: true, assignedTo: { select: { name: true } } },
    }),
    // The latest live quote on the deal: not deleted, not replaced by a revision, not withdrawn.
    seesQuotes
      ? prisma.quote.findFirst({
          where: { leadId: lead.id, deletedAt: null, supersededAt: null, status: { not: "cancelled" }, ...(quoteIds === null ? {} : { id: { in: quoteIds } }) },
          orderBy: { createdAt: "desc" },
          select: {
            id: true, number: true, status: true, createdAt: true, validUntil: true, emailedAt: true, viewedAt: true, signedAt: true,
            declinedAt: true, declineReason: true, changeRequestedAt: true, changeRequestNote: true, contactId: true, leadId: true,
            invoicedAt: true, depositPaidAt: true, depositPaidCents: true, depositType: true, depositValue: true, deliveryScheduledFor: true, deliveredAt: true,
          },
        })
      : Promise.resolve(null),
    prisma.communication.findMany({ where: { AND: [timeline, mentionsFinance] }, orderBy: { occurredAt: "desc" }, take: 2, select: { occurredAt: true, type: true, direction: true, subject: true, body: true } }),
    prisma.activity.findMany({ where: { AND: [timeline, { OR: [{ summary: fuzzy("financ") }, { note: fuzzy("financ") }] }] }, orderBy: { dueDate: "desc" }, take: 1, select: { type: true, summary: true, note: true, dueDate: true, status: true } }),
    isModuleEnabled("automotive"),
  ]);
  // A quote warning only for a quote they may open (the attention list does not ask).
  const signals = (signalMap.get(lead.id) ?? []).filter((s) => {
    if (s.kind !== "quote_expiring") return true;
    const id = s.actionHref.replace(/^\/quotes\//, "");
    return quoteIds === null || quoteIds.includes(id);
  });

  // The quote as the customer met it: sent, opened (by them, not a colleague), how often, signed.
  let quoteFacts: Record<string, unknown> | null = null;
  let stuckQuote: StuckQuote | null = null;
  if (quote) {
    const [requests, sends, financePayouts] = await Promise.all([
      prisma.signatureRequest.findMany({
        where: { quoteId: quote.id, deletedAt: null, status: { notIn: ["draft", "voided"] } },
        orderBy: { createdAt: "desc" },
        select: {
          status: true, sentAt: true,
          recipients: { select: { id: true, role: true, email: true, viewedAt: true, signedAt: true } },
          views: { select: { recipientId: true, startedAt: true, lastSeenAt: true } },
        },
      }),
      quoteSends([quote]),
      quote.status === "accepted"
        ? prisma.quotePayment.findMany({ where: { quoteId: quote.id, method: "finance", voidedAt: null }, orderBy: { receivedAt: "desc" }, select: { amountCents: true, receivedAt: true } })
        : Promise.resolve([]),
    ]);
    const isCustomer = memoCustomer((r) => isCustomerSigner(r, ownedWriteTenantId()));
    const recipients = requests.flatMap((r) => r.recipients);
    const customers = new Set<string>();
    for (const r of recipients) if (await isCustomer(r)) customers.add(r.id);
    const sittings = requests.flatMap((r) => r.views).filter((v) => customers.has(v.recipientId));
    const openedAt = quote.viewedAt ?? (await firstCustomerView(recipients, isCustomer));
    const completed = requests.find((r) => r.status === "completed");
    const signedAt = quote.signedAt ?? latest(...(completed?.recipients.map((r) => r.signedAt) ?? []));
    const sentAt = latest(quote.emailedAt, ...requests.map((r) => r.sentAt));
    const send = sends.get(quote.id);
    stuckQuote = { ...quote, sentAt, openedAt, signedAt, viaLink: requests.length > 0, emailOpen: send ? send.open ?? "untracked" : null, emailBounced: send?.bounced ?? false };
    const lastSeen = latest(...sittings.map((v) => v.lastSeenAt));
    quoteFacts = {
      quote: `Q-${quote.number}`,
      link: `/quotes/${quote.id}`,
      status: requests.length && quote.status === "draft" ? "sent for signature" : quote.status,
      created: day(quote.createdAt),
      sent: sentAt ? stamp(sentAt) : quote.status === "draft" ? "not sent (still a draft)" : "yes — no date recorded",
      ...(send ? { email: send.status } : {}),
      opened: openedAt
        ? `first ${stamp(openedAt)}; ${sittings.length ? `${sittings.length} time${sittings.length === 1 ? "" : "s"} in all, last ${stamp(lastSeen!)}` : "how often is not recorded"}`
        : requests.length
          ? "never — the customer hasn't opened the signing link"
          : `not recorded — it wasn't sent as a signing link${send ? " (`email` says what its email's open tracking saw)" : ""}`,
      signed: signedAt ? stamp(signedAt) : "no",
      validUntil: quote.validUntil ? day(quote.validUntil) : null,
      ...(quote.declinedAt ? { declined: stamp(quote.declinedAt), declineReason: clip(quote.declineReason, 200) } : {}),
      ...(quote.changeRequestedAt ? { changesRequested: stamp(quote.changeRequestedAt), changeRequest: clip(quote.changeRequestNote, 200) } : {}),
      ...(quote.status === "accepted"
        ? {
            invoiced: quote.invoicedAt ? day(quote.invoicedAt) : "no",
            deposit: quote.depositPaidAt ? `paid ${day(quote.depositPaidAt)}${quote.depositPaidCents ? ` (${formatZAR(quote.depositPaidCents, moneyFmt)})` : ""}` : "not marked paid",
            ...(quote.depositType && quote.depositValue ? { depositTerms: quote.depositType === "percent" ? `${quote.depositValue}%` : formatZAR(Math.round(quote.depositValue * 100), moneyFmt) } : {}),
            delivery: quote.deliveredAt ? `delivered ${day(quote.deliveredAt)}` : quote.deliveryScheduledFor ? `booked for ${day(quote.deliveryScheduledFor)}` : "not booked",
            ...(financePayouts.length ? { financePayouts: financePayouts.map((p) => `${formatZAR(p.amountCents, moneyFmt)} received ${day(p.receivedAt)}`) } : {}),
          }
        : {}),
    };
  }

  const lastContactAt = latestContactAt(lastMessage ? [lastMessage] : [], lastDone ? [lastDone] : []);
  const conversation = {
    lastIn: lastIn ? { at: lastIn.occurredAt, channel: lastIn.type } : null,
    lastOut: lastOut ? { at: lastOut.occurredAt, channel: lastOut.type } : null,
  };
  const reasons = stuckReasons({
    now,
    leadId: lead.id,
    status: lead.status,
    createdAt: lead.createdAt,
    parked: lead.status === "nurture" ? { since: lead.nurtureSince, reason: lead.nurtureReason, interest: lead.nurtureInterest, reviewAt: lead.nurtureReviewAt } : null,
    signals,
    setAside: setAsideNotes(lead.attentionDispositions, now),
    quote: stuckQuote,
    deliveries,
    ...conversation,
    lastContactAt,
  });
  // The name on a reason's evidence chip (assistantReply.citableLinks reads `title`): the record it links to.
  const chip = (href: string) => (href.startsWith("/quotes/") ? (quote && href === `/quotes/${quote.id}` ? `Q-${quote.number}` : "Quote") : href.startsWith("/inbox") ? "Inbox conversation" : lead.name);
  const overdue = planned.filter((a) => a.dueDate < now);
  const upcoming = planned.find((a) => a.dueDate >= now);
  const activity = (a: (typeof planned)[number]) => ({
    summary: a.summary, type: a.type, due: stamp(a.dueDate), assignedTo: a.assignedTo.name, filedOn: a.leadId ? "this deal" : "the customer", link,
  });
  // Last in the result on purpose: if a long one is cut to fit the prompt, this is what goes.
  const financeMentions = [
    ...financeMessages.map((c) => ({ when: stamp(c.occurredAt), where: `${c.direction ?? ""} ${c.type}`.trim(), text: clip([c.subject, c.body].filter(Boolean).join(" — "), 160), link })),
    ...financeActivities.map((a) => ({ when: stamp(a.dueDate), where: `${a.type} (${a.status})`, text: clip([a.summary, a.note].filter(Boolean).join(" — "), 160), link })),
    ...(lead.notes && /financ/i.test(lead.notes) ? [{ where: "the deal's notes", text: clip(lead.notes, 200), link }] : []),
  ];

  return {
    truncated: false,
    rows: [{ label, detail: reasons[0] ? `Stuck: ${reasons[0].why}` : "Nothing in the records is holding it up", href: link }],
    data: [{
      deal,
      ...several,
      legend: STUCK_LEGEND,
      reasons: reasons.map((r, i) => ({ rank: i + 1, kind: r.kind, why: r.why, ...(r.date ? { date: stamp(r.date) } : {}), link: r.link, title: chip(r.link), ...(r.setAside ? { setAside: r.setAside } : {}) })),
      stage: stageFacts(lead.stage, lead.stageEnteredAt, now),
      conversation: conversationFacts(conversation.lastIn, conversation.lastOut, lastContactAt, now),
      quote: quoteFacts ?? (seesQuotes ? "no live quote on this deal" : "not shown — you can't see quotes"),
      nextStep: {
        overdue: overdue.slice(0, 3).map(activity),
        ...(overdue.length > 3 ? { overdueInAll: overdue.length } : {}),
        next: upcoming ? activity(upcoming) : "nothing planned",
      },
      ...(financeMentions.length ? { financeMentions } : {}),
    }],
  };
}
