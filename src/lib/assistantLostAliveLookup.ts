import "server-only";
import { prisma } from "./db";
import { contactCommunicationWhere } from "./customerContact";
import { isCustomerSigner } from "./signing/quoteMirror";
import { memoCustomer } from "./signing/customerView";
import { ownedWriteTenantId } from "./tenantWrite";
import { stamp } from "./assistantWhy";
import { getAccessibleLeadIds, getAccessibleQuoteIds, type PermissionUser } from "./permissions";
import { LOST_ALIVE_DAYS, LOST_ALIVE_LEGEND, aliveDeals, softLostReason, type AliveSignal } from "./assistantLostAlive";

/**
 * The `lost_alive` lookup (assistantLostAlive.ts has the rules). Only deals the person can open
 * (getAccessibleLeadIds); `mine` narrows to theirs or nobody's, as the daily brief does. A deal's messages are its
 * own and its customer's on no deal (customerTimeline's rule); a quote "opened" is the customer's own sitting, never
 * a colleague's. READ-ONLY; every read on the tenant-scoped client; nothing here is logged.
 */

type Output = { rows: { label: string; detail: string; href: string }[]; data: unknown[]; truncated: boolean };
const DAY_MS = 86_400_000;
/** At most this many recently lost deals are read; more and the result says it was cut. */
const READ = 300;

export async function lostAliveLookup(user: PermissionUser, mine = false): Promise<Output> {
  const since = new Date(Date.now() - LOST_ALIVE_DAYS * DAY_MS);
  // Quotes are their own permission: someone who may open a deal but not its quotes learns nothing of them here.
  const [ids, quoteIds] = await Promise.all([getAccessibleLeadIds(user), getAccessibleQuoteIds(user)]);
  const lost = ids !== null && ids.length === 0 ? [] : await prisma.lead.findMany({
    where: {
      ...(ids === null ? {} : { id: { in: ids } }),
      status: "lost",
      deletedAt: null,
      lostAt: { gte: since },
      ...(mine ? { OR: [{ assignedToId: user.id }, { assignedToId: null }] } : {}),
    },
    orderBy: { lostAt: "desc" },
    take: READ,
    select: { id: true, name: true, title: true, lostAt: true, lostReason: true, contactId: true, assignedTo: { select: { name: true } } },
  });
  const soft = lost.filter((l) => l.lostAt && softLostReason(l.lostReason));
  const leadIds = soft.map((l) => l.id);
  const contactIds = [...new Set(soft.flatMap((l) => (l.contactId ? [l.contactId] : [])))];

  const quotes = leadIds.length && quoteIds?.length !== 0
    ? await prisma.quote.findMany({ where: { leadId: { in: leadIds }, deletedAt: null, ...(quoteIds === null ? {} : { id: { in: quoteIds } }) }, select: { id: true, number: true, leadId: true, viewedAt: true } })
    : [];
  const [messages, views] = leadIds.length
    ? await Promise.all([
        prisma.communication.findMany({
          where: {
            AND: [
              { OR: [{ leadId: { in: leadIds } }, { leadId: null, contactId: { in: contactIds } }] },
              contactCommunicationWhere,
              { direction: "inbound", occurredAt: { gte: since } },
            ],
          },
          orderBy: { occurredAt: "desc" },
          take: 1000,
          select: { leadId: true, contactId: true, occurredAt: true, type: true },
        }),
        quotes.length
          ? prisma.signatureView.findMany({
              where: { startedAt: { gte: since }, request: { quoteId: { in: quotes.map((q) => q.id) }, deletedAt: null } },
              select: { startedAt: true, recipient: { select: { role: true, email: true, viewedAt: true } }, request: { select: { quoteId: true } } },
            })
          : [],
      ])
    : [[], []];

  const isCustomer = memoCustomer((r) => isCustomerSigner(r, ownedWriteTenantId()));
  const signals = new Map<string, AliveSignal[]>();
  const add = (leadId: string, s: AliveSignal) => signals.set(leadId, [...(signals.get(leadId) ?? []), s]);
  for (const m of messages) {
    const on = m.leadId ? [m.leadId] : soft.filter((l) => l.contactId === m.contactId).map((l) => l.id);
    for (const leadId of on) add(leadId, { at: m.occurredAt, what: `sent a ${m.type} message` });
  }
  const quoteById = new Map(quotes.map((q) => [q.id, q]));
  for (const q of quotes) if (q.leadId && q.viewedAt) add(q.leadId, { at: q.viewedAt, what: `opened quote Q-${q.number}` });
  for (const v of views) {
    const q = quoteById.get(v.request.quoteId ?? "");
    if (q?.leadId && (await isCustomer(v.recipient))) add(q.leadId, { at: v.startedAt, what: `opened quote Q-${q.number}` });
  }

  const alive = aliveDeals(soft.map((l) => ({
    leadId: l.id, name: l.name, title: l.title, lostAt: l.lostAt!, lostReason: l.lostReason ?? "",
    salesperson: l.assignedTo?.name ?? null, signals: signals.get(l.id) ?? [],
  })));

  return {
    truncated: lost.length === READ,
    rows: alive.slice(0, 10).map((d) => ({ label: `${d.name} — ${d.title}`, detail: `lost ${stamp(d.lostAt).slice(0, 10)} (${d.lostReason}); since: ${d.signals[0].what}`, href: `/leads/${d.leadId}` })),
    data: [{
      legend: LOST_ALIVE_LEGEND,
      ...(alive.length ? {} : { nothingFound: `No deal lost in the last ${LOST_ALIVE_DAYS} days for a went-quiet or timing reason has had a message or quote view from the customer since.` }),
      deals: alive.slice(0, 15).map((d) => ({
        leadId: d.leadId,
        deal: `${d.name} — ${d.title}`,
        lostOn: stamp(d.lostAt),
        lostReason: d.lostReason,
        ...(d.salesperson ? { salesperson: d.salesperson } : {}),
        // The newest five, deduplicated by what happened: "opened Q-1030" five times is one line.
        since: [...new Map(d.signals.map((s) => [s.what, s])).values()].slice(0, 5).map((s) => `${stamp(s.at)} — ${s.what}`),
        link: `/leads/${d.leadId}`,
      })),
      ...(alive.length > 15 ? { more: alive.length - 15 } : {}),
    }],
  };
}
