import "server-only";
import { prisma } from "./db";
import { contactCommunicationWhere } from "./customerContact";
import { contactName } from "./format";
import { isCustomerSigner } from "./signing/quoteMirror";
import { memoCustomer } from "./signing/customerView";
import { ownedWriteTenantId } from "./tenantWrite";
import { johannesburgDateKey } from "./activityDay";
import { auditCause, stamp } from "./assistantWhy";
import { getAccessibleContactIds, getAccessibleLeadIds, getAccessibleQuoteIds, hasAnyPermission, type PermissionUser } from "./permissions";
import { CATCH_UP_LEGEND, catchUpSince, messagesByCustomer, newestFirst, quoteNews, taskList, type CatchUpItem } from "./assistantCatchUp";

/**
 * The `catch_up` lookup: what changed on the person's own deals since their previous question to DAX
 * (assistantCatchUp.ts has the rules), read from the records.
 *
 * "MINE" IS THE DAILY BRIEF'S: deals assigned to them plus the unassigned ones nobody else will pick up, and the
 * customers they own — and only ever what their own lists hold (getAccessibleLeadIds / ContactIds / QuoteIds, the
 * acting workspace's). A deal's messages are its own and its customer's on no deal (customerTimeline's rule).
 * READ-ONLY; every read on the tenant-scoped client; nothing here is logged.
 */

type Output = { rows: { label: string; detail: string; href: string }[]; data: unknown[]; truncated: boolean };

/** What someone ELSE did to a deal that matters to its owner — its stage, its outcome, parking it, its delivery date. */
const DEAL_MOVES = [
  "lead.stage_changed", "lead.won", "lead.lost", "lead.reopened", "lead.assigned", "lead.nurtured", "lead.reactivated",
  "fulfilment.delivery_scheduled", "fulfilment.delivery_rescheduled",
];
const DAY_MS = 86_400_000;
const clip = (s: string | null | undefined, n: number) => (s ? (s.length > n ? `${s.slice(0, n)}…` : s) : null);
/** At most this many inbound messages are read (newest first); more and the result says it was cut. */
const MESSAGES = 200;

export async function catchUpLookup(user: PermissionUser, sinceDay?: string): Promise<Output> {
  const now = new Date();
  // Their own previous question — in the CRM chat or on WhatsApp. Never a scheduled run, an alert or a briefing:
  // those are DAX talking, not them asking.
  const last = await prisma.assistantTurn.findFirst({
    where: { userId: user.id, source: { in: ["chat", "whatsapp"] }, createdAt: { lt: now } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const { since, basis } = catchUpSince(now, last?.createdAt ?? null, sinceDay);
  const window = { gt: since, lte: now };

  const [leadIds, contactIds, quoteIds, seesActivities] = await Promise.all([
    getAccessibleLeadIds(user),
    getAccessibleContactIds(user),
    getAccessibleQuoteIds(user),
    hasAnyPermission(user, "activities.view", "activities.manage"),
  ]);
  const myLeads = leadIds !== null && leadIds.length === 0 ? [] : await prisma.lead.findMany({
    where: { deletedAt: null, ...(leadIds === null ? {} : { id: { in: leadIds } }), OR: [{ assignedToId: user.id }, { assignedToId: null }] },
    select: { id: true, name: true, title: true, contactId: true, assignedToId: true, createdById: true, createdAt: true, source: true, createdBy: { select: { name: true } } },
  });
  const leadById = new Map(myLeads.map((l) => [l.id, l]));
  const mineLeadIds = [...leadById.keys()];
  const openable = contactIds === null ? null : new Set(contactIds);
  const owned = openable !== null && openable.size === 0 ? [] : await prisma.contact.findMany({
    where: { deletedAt: null, ownerId: user.id, ...(contactIds === null ? {} : { id: { in: contactIds } }) },
    select: { id: true },
  });
  // Their customers: the ones they own, and their deals' — only those they may open.
  const mineContactIds = [...new Set([...owned.map((c) => c.id), ...myLeads.flatMap((l) => (l.contactId && (openable === null || openable.has(l.contactId)) ? [l.contactId] : []))])];
  const filedOnMine = { OR: [{ leadId: { in: mineLeadIds } }, { leadId: null, contactId: { in: mineContactIds } }] };

  const [inbound, outbound, views, moves] = await Promise.all([
    prisma.communication.findMany({
      where: { AND: [filedOnMine, contactCommunicationWhere, { direction: "inbound", occurredAt: window }] },
      orderBy: { occurredAt: "desc" },
      take: MESSAGES,
      select: { occurredAt: true, type: true, subject: true, body: true, leadId: true, contactId: true, contact: { select: { firstName: true, lastName: true, company: true, isCompany: true } } },
    }),
    prisma.communication.findMany({
      where: { AND: [filedOnMine, contactCommunicationWhere, { direction: "outbound", occurredAt: window }] },
      orderBy: { occurredAt: "desc" },
      take: MESSAGES * 5,
      select: { occurredAt: true, leadId: true, contactId: true, subject: true },
    }),
    // Sittings with a quote's signing page in the window — whose, and whether a revisit, is settled below.
    prisma.signatureView.findMany({
      where: { startedAt: window, request: { quoteId: { not: null }, deletedAt: null } },
      select: { recipientId: true, startedAt: true, recipient: { select: { role: true, email: true, viewedAt: true } }, request: { select: { quoteId: true } } },
    }),
    prisma.auditLog.findMany({
      // Someone else — a person, or the CRM itself (userId null). What they did themselves is not news to them.
      where: { leadId: { in: mineLeadIds }, createdAt: window, action: { in: DEAL_MOVES }, OR: [{ userId: null }, { userId: { not: user.id } }] },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { leadId: true, action: true, summary: true, userId: true, userName: true, createdAt: true },
    }),
  ]);

  const quotes = quoteIds !== null && quoteIds.length === 0 ? [] : await prisma.quote.findMany({
    where: {
      deletedAt: null,
      supersededAt: null,
      ...(quoteIds === null ? {} : { id: { in: quoteIds } }),
      // Inside AND: a top-level `id` would replace the access filter above.
      AND: [
        { OR: [{ leadId: { in: mineLeadIds } }, { leadId: null, contactId: { in: mineContactIds } }] },
        { OR: [{ viewedAt: window }, { signedAt: window }, { declinedAt: window }, { changeRequestedAt: window }, { id: { in: [...new Set(views.map((v) => v.request.quoteId!))] } }] },
      ],
    },
    select: {
      id: true, number: true, leadId: true, viewedAt: true, signedAt: true, declinedAt: true, declineReason: true, changeRequestedAt: true, changeRequestNote: true,
      lead: { select: { name: true } }, contact: { select: { firstName: true, lastName: true, company: true, isCompany: true } },
    },
  });
  // "Opened again": the CUSTOMER (never a colleague countersigning) back at it after their first sitting ever.
  const quoteIdsShown = new Set(quotes.map((q) => q.id));
  const theirViews = views.filter((v) => quoteIdsShown.has(v.request.quoteId!));
  const firsts = theirViews.length
    ? await prisma.signatureView.groupBy({ by: ["recipientId"], where: { recipientId: { in: [...new Set(theirViews.map((v) => v.recipientId))] } }, _min: { startedAt: true } })
    : [];
  const firstAt = new Map(firsts.map((f) => [f.recipientId, f._min.startedAt?.getTime() ?? 0]));
  const isCustomer = memoCustomer((r) => isCustomerSigner(r, ownedWriteTenantId()));
  const revisits = new Map<string, Date[]>();
  for (const v of theirViews) {
    if (v.startedAt.getTime() <= (firstAt.get(v.recipientId) ?? 0) || !(await isCustomer(v.recipient))) continue;
    revisits.set(v.request.quoteId!, [...(revisits.get(v.request.quoteId!) ?? []), v.startedAt]);
  }

  const startOfToday = new Date(`${johannesburgDateKey(now)}T00:00:00+02:00`);
  const theirTasks = { status: "planned", availabilityBlock: false, OR: [{ assignedToId: user.id }, { attendees: { some: { userId: user.id } } }] };
  const [overdueCount, todayCount, tasks] = seesActivities
    ? await Promise.all([
        prisma.activity.count({ where: { ...theirTasks, dueDate: { lt: startOfToday } } }),
        prisma.activity.count({ where: { ...theirTasks, dueDate: { gte: startOfToday, lt: new Date(startOfToday.getTime() + DAY_MS) } } }),
        prisma.activity.findMany({
          where: { ...theirTasks, dueDate: { lt: new Date(startOfToday.getTime() + DAY_MS) } },
          orderBy: { dueDate: "asc" },
          take: 5,
          select: { summary: true, type: true, dueDate: true, leadId: true, contactId: true, lead: { select: { name: true } }, contact: { select: { firstName: true, lastName: true, company: true, isCompany: true } } },
        }),
      ])
    : [0, 0, []];

  const leadName = (id: string | null) => (id ? leadById.get(id)?.name ?? null : null);
  // New since then, and not made by them: theirs, or nobody's yet.
  const newLeads = myLeads.filter((l) => l.createdAt.getTime() > since.getTime() && l.createdAt.getTime() <= now.getTime() && l.createdById !== user.id);
  const isNew = new Set(newLeads.map((l) => l.id));
  const items: CatchUpItem[] = [
    ...messagesByCustomer(
      inbound.map((m) => ({
        at: m.occurredAt,
        channel: m.type,
        text: clip([m.subject, m.body].filter(Boolean).join(" — "), 140),
        customerKey: m.contactId ?? `lead:${m.leadId}`,
        customer: (m.contact ? contactName(m.contact) : leadName(m.leadId)) || "A customer",
        link: m.leadId ? `/leads/${m.leadId}` : `/contacts/${m.contactId}`,
        leadId: m.leadId,
        contactId: m.contactId,
      })),
      outbound.map((o) => ({ at: o.occurredAt, leadId: o.leadId, contactId: o.contactId, bot: (o.subject ?? "").startsWith("🤖") })),
    ),
    ...quotes.flatMap((q) => quoteNews({ ...q, customer: (q.contact ? contactName(q.contact) : q.lead?.name) || "A customer", revisits: revisits.get(q.id) ?? [] }, since)),
    ...moves.flatMap((row): CatchUpItem[] => {
      const lead = row.leadId ? leadById.get(row.leadId) : undefined;
      // An assignment is news only when the deal is now theirs — and a new lead already says so itself, below.
      if (!lead || (row.action === "lead.assigned" && (lead.assignedToId !== user.id || isNew.has(lead.id)))) return [];
      return [{ at: row.createdAt, type: "deal", what: clip(row.summary, 160) ?? row.action, by: auditCause(row), customer: lead.name, link: `/leads/${lead.id}` }];
    }),
    ...newLeads.map((l): CatchUpItem => ({
      at: l.createdAt,
      type: "new_lead",
      what: `${l.assignedToId ? "New lead for you" : "New lead, not assigned to anyone yet"}: ${l.name} — ${l.title}`,
      customer: l.name,
      source: l.source,
      by: l.createdBy?.name ?? "added automatically",
      link: `/leads/${l.id}`,
    })),
  ];
  const { items: listed, cut } = newestFirst(items);

  return {
    truncated: cut > 0 || inbound.length === MESSAGES,
    rows: listed.slice(0, 10).map((i) => ({ label: i.what, detail: i.when, href: i.link })),
    data: [{
      since: stamp(since),
      sinceBasis: basis,
      mine: "deals assigned to them or to nobody, and customers they own — only those they can open",
      legend: CATCH_UP_LEGEND,
      ...(cut ? { cut: `only the newest ${listed.length} of ${listed.length + cut} are listed` } : {}),
      ...(listed.length ? {} : { nothingNew: `Nothing has changed on their deals since ${stamp(since)}.` }),
      // Before the items: if a long catch-up is cut to fit the prompt, only its oldest items go.
      tasks: seesActivities
        ? {
            overdue: overdueCount,
            dueToday: todayCount,
            list: taskList(tasks.map((t) => ({
              summary: t.summary,
              type: t.type,
              dueDate: t.dueDate,
              customer: t.contact ? contactName(t.contact) : t.lead?.name ?? null,
              link: t.leadId ? `/leads/${t.leadId}` : t.contactId ? `/contacts/${t.contactId}` : "/activities",
            })), now),
          }
        : "not shown — they can't see activities",
      items: listed,
    }],
  };
}
