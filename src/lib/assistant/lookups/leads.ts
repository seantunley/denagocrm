import "server-only";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../db";
import { formatZAR } from "../../format";
import { formatTotals, totalsByCurrency, withCurrency } from "../../currencyRules";
import { getRegionalSettings } from "../../settings";
import { contactActivityWhere, contactCommunicationWhere, latestContactAt } from "../../customerContact";
import { firstStageOrders, stageContactAt } from "../../stageContact";
import { getAccessibleLeadIds, hasAnyPermission } from "../../permissions";
import { leadArgs } from "../../crmAssistantPlan";
import { DAY, CANDIDATES, ToolOutput, User, fuzzy, dateKey, daysAgo, refused } from "../lookupKit";
import { summary } from "../observationFit";

/** The day a deal was won or lost (its lifecycle date, set once), or null while it is open. */
export const closedOn = (lead: { status: string; wonAt: Date | null; lostAt: Date | null }) =>
  lead.status === "lost" ? lead.lostAt : lead.status === "won" ? lead.wonAt : null;

export async function findLeads(user: User, raw: z.infer<typeof leadArgs>): Promise<ToolOutput> {
  if (!(await hasAnyPermission(user, "leads.view_all", "leads.view_owned"))) return refused("leads");
  const args = leadArgs.parse(raw);
  const ids = await getAccessibleLeadIds(user);
  // Calendar days in South Africa: createdTo includes the whole of that day.
  const createdAt = {
    ...(args.createdWithinDays ? { gte: new Date(Date.now() - args.createdWithinDays * DAY) } : {}),
    ...(args.createdFrom ? { gte: new Date(`${args.createdFrom}T00:00:00+02:00`) } : {}),
    ...(args.createdTo ? { lt: new Date(new Date(`${args.createdTo}T00:00:00+02:00`).getTime() + DAY) } : {}),
  };
  // The day it was WON OR LOST (lifecycle dates, set once): lost → lostAt, won → wonAt, otherwise either.
  const closedAt = {
    ...(args.closedFrom ? { gte: new Date(`${args.closedFrom}T00:00:00+02:00`) } : {}),
    ...(args.closedTo ? { lt: new Date(new Date(`${args.closedTo}T00:00:00+02:00`).getTime() + DAY) } : {}),
  };
  const closedFilter = Object.keys(closedAt).length > 0;
  // "Closed in October" names no status: it means won OR lost — never the default "open", which has no closed date.
  const status = args.status ?? (closedFilter ? "any" : "open");
  // BY THE DAY IT CLOSED (asked, or the default for a closed-date period): only won and lost deals have that day.
  // Open or nurture deals have none — they are listed newest first instead, and the result says so (re-review of #1101).
  const closedSortAsked = (args.sort ?? (closedFilter && !args.noContactDays ? "closed" : null)) === "closed";
  const byClosed = closedSortAsked && (status === "lost" || status === "won" || status === "any");
  const closed = !closedFilter
    ? {}
    : status === "lost" ? { lostAt: closedAt }
      : status === "won" ? { wonAt: closedAt }
        : { AND: [{ OR: [{ lostAt: closedAt }, { wonAt: closedAt }] }] };
  const where = {
    ...closed,
    deletedAt: null,
    ...(ids === null ? {} : { id: { in: ids } }),
    // "Any" in closed order is the CLOSED deals — counted as well as listed, so the total and the list agree.
    ...(status === "any" ? (byClosed ? { status: { in: ["won", "lost"] } } : {}) : { status }),
    ...(args.stage ? { stage: { name: fuzzy(args.stage) } } : {}),
    ...(args.assignedTo ? { assignedTo: { name: fuzzy(args.assignedTo) } } : {}),
    ...(args.product ? { product: { name: fuzzy(args.product) } } : {}),
    ...(args.source ? { source: fuzzy(args.source) } : {}),
    ...(args.minValue ? { valueCents: { gte: Math.round(args.minValue * 100) } } : {}),
    ...(Object.keys(createdAt).length ? { createdAt } : {}),
    ...(args.search
      ? { OR: [{ name: fuzzy(args.search) }, { title: fuzzy(args.search) }, { email: fuzzy(args.search) }] }
      : {}),
  };
  // Read from the database in closed order (review of #1101): read newest-CREATED first, 500 newer deals lost early in
  // the month pushed out an older one lost on its last day. "Any" reads the lost and the won each by their own date,
  // then takes the latest of both.
  const closedOrder = (field: "lostAt" | "wonAt"): Prisma.LeadOrderByWithRelationInput[] => [{ [field]: { sort: "desc", nulls: "last" } }, { id: "asc" }];
  const read = (extra: Prisma.LeadWhereInput, orderBy: Prisma.LeadOrderByWithRelationInput[]) => prisma.lead.findMany({
      where: { AND: [where, extra] },
      orderBy,
      take: CANDIDATES,
      select: {
        id: true, title: true, name: true, status: true, valueCents: true, currency: true, source: true,
        createdAt: true, stageEnteredAt: true, contactId: true, wonAt: true, lostAt: true, lostReason: true,
        stage: { select: { name: true, order: true, pipelineId: true } },
        product: { select: { name: true } },
        assignedTo: { select: { name: true } },
        // Real contact only (customerContact.ts): not internal notes, to-dos or blocked time.
        communications: { where: contactCommunicationWhere, orderBy: { occurredAt: "desc" }, take: 1, select: { type: true, occurredAt: true } },
        activities: {
          where: contactActivityWhere,
          orderBy: { doneAt: "desc" },
          take: 1,
          select: { type: true, doneAt: true, availabilityBlock: true },
        },
      },
    });
  const readLeads = async () => {
    if (!byClosed) return read({}, [{ createdAt: "desc" }]);
    if (status === "lost") return read({}, closedOrder("lostAt"));
    if (status === "won") return read({}, closedOrder("wonAt"));
    const [lost, won] = await Promise.all([read({ status: "lost" }, closedOrder("lostAt")), read({ status: "won" }, closedOrder("wonAt"))]);
    return [...lost, ...won].sort((a, b) => (closedOn(b)?.getTime() ?? 0) - (closedOn(a)?.getTime() ?? 0)).slice(0, CANDIDATES);
  };
  const [leads, matching, reasons] = await Promise.all([
    readLeads(),
    // The real count — not capped at the CANDIDATES read above.
    prisma.lead.count({ where }),
    // "Why did we lose them": every lost reason across ALL the matches, not just the ones listed.
    status === "lost" ? prisma.lead.groupBy({ by: ["lostReason"], where, _count: { _all: true } }) : Promise.resolve([]),
  ]);

  // Last contact = the latest message either way, call or meeting. Not an
  // internal note or a completed to-do, and not the lead's own updatedAt
  // (editing a field touches it). The customer's own rows that sit on no lead
  // count too (a Messenger message matches the customer first — leadIdle.ts).
  const contactIds = [...new Set(leads.map((l) => l.contactId).filter((id): id is string => !!id))];
  const [contactComms, contactDone] = contactIds.length
    ? await Promise.all([
        prisma.communication.groupBy({ by: ["contactId"], where: { contactId: { in: contactIds }, leadId: null, ...contactCommunicationWhere }, _max: { occurredAt: true } }),
        prisma.activity.groupBy({ by: ["contactId"], where: { contactId: { in: contactIds }, leadId: null, ...contactActivityWhere }, _max: { doneAt: true } }),
      ])
    : [[], []];
  const customerTouch = new Map<string, number>();
  for (const at of [...contactComms.map((r) => [r.contactId, r._max.occurredAt] as const), ...contactDone.map((r) => [r.contactId, r._max.doneAt] as const)]) {
    if (at[0] && at[1]) customerTouch.set(at[0], Math.max(customerTouch.get(at[0]) ?? 0, at[1].getTime()));
  }
  // Moved past the first stage = contacted, as of that move (stageContact.ts).
  const firstOrders = await firstStageOrders(leads);
  const withTouch = leads.map((lead) => {
    const own = latestContactAt(lead.communications, lead.activities);
    const viaCustomer = lead.contactId ? customerTouch.get(lead.contactId) : undefined;
    const touched = Math.max(own?.getTime() ?? 0, viaCustomer ?? 0, stageContactAt(lead, firstOrders)?.getTime() ?? 0);
    return { lead, lastContact: touched ? new Date(touched) : null };
  });
  const cutoff = args.noContactDays ? Date.now() - args.noContactDays * DAY : null;
  const filtered = cutoff === null
    ? withTouch
    : withTouch.filter(({ lastContact }) => !lastContact || lastContact.getTime() < cutoff);
  const sorters: Record<string, (a: (typeof withTouch)[number], b: (typeof withTouch)[number]) => number> = {
    value: (a, b) => b.lead.valueCents - a.lead.valueCents,
    oldest_contact: (a, b) => (a.lastContact?.getTime() ?? 0) - (b.lastContact?.getTime() ?? 0),
    stage_age: (a, b) => a.lead.stageEnteredAt.getTime() - b.lead.stageEnteredAt.getTime(),
    newest: (a, b) => b.lead.createdAt.getTime() - a.lead.createdAt.getTime(),
    closed: (a, b) => (closedOn(b.lead)?.getTime() ?? 0) - (closedOn(a.lead)?.getTime() ?? 0),
  };
  const sortBy = byClosed ? "closed" : args.sort && args.sort !== "closed" ? args.sort : cutoff ? "oldest_contact" : "newest";
  const sorted = [...filtered].sort(sorters[sortBy]);
  const take = args.limit ?? 10;
  const page = sorted.slice(0, take);

  // "Gone quiet" is worked out on the newest CANDIDATES only, so past that it is a floor.
  const total = cutoff === null ? matching : leads.length === CANDIDATES ? `at least ${filtered.length}` : filtered.length;
  // The reasons describe EXACTLY the deals the total counts (review of #1101): every match from the database, or —
  // with "no contact for N days", which is worked out here — the ones left after it, counted the same way as the total.
  const reasonCounts = cutoff === null
    ? reasons.map((r) => [r.lostReason, r._count._all] as const)
    : [...Map.groupBy(filtered, ({ lead }) => lead.lostReason?.trim() || null)].map(([reason, rows]) => [reason, rows.length] as const);
  const lostReasons = [...Map.groupBy(reasonCounts, ([reason]) => reason?.trim() || "no reason recorded")]
    .map(([reason, rows]) => ({ reason, count: rows.reduce((n, [, c]) => n + c, 0) }))
    .sort((a, b) => b.count - a.count);
  const moneyFmt = await getRegionalSettings();
  return {
    truncated: sorted.length > take || leads.length === CANDIDATES,
    data: [summary({
      total,
      listed: page.length,
      ...(status === "lost" ? { lostReasons } : {}),
      ...(closedSortAsked && !byClosed ? { note: `${status} deals have no closed date — listed ${sortBy === "oldest_contact" ? "longest without contact" : "newest"} first.` } : {}),
      ...(byClosed && status === "any" ? { note: "Won and lost deals only, most recently closed first." } : {}),
    }), ...page.map(({ lead, lastContact }) => ({
      id: lead.id,
      link: `/leads/${lead.id}`,
      lead: lead.title,
      customer: lead.name,
      stage: lead.stage.name,
      status: lead.status,
      value: formatZAR(lead.valueCents, withCurrency(moneyFmt, lead.currency)),
      assignedTo: lead.assignedTo?.name ?? "unassigned",
      product: lead.product?.name ?? null,
      source: lead.source,
      // "none logged", never "never": contact is often made outside the CRM and noted (Sean, 2026-11-16).
      lastContact: lastContact ? dateKey(lastContact) : "none logged",
      daysInStage: daysAgo(lead.stageEnteredAt),
      created: dateKey(lead.createdAt),
      ...(lead.status === "won" || lead.status === "lost" ? { closed: dateKey(closedOn(lead)) } : {}),
      ...(lead.status === "lost" ? { lostReason: lead.lostReason?.trim() || "no reason recorded" } : {}),
    }))],
    rows: page.map(({ lead, lastContact }) => ({
      label: `${lead.name} — ${lead.title}`,
      detail: `${lead.stage.name} · ${formatZAR(lead.valueCents, withCurrency(moneyFmt, lead.currency))} · ${lead.assignedTo?.name ?? "unassigned"} · last contact ${lastContact ? dateKey(lastContact) : "none logged"}`,
      href: `/leads/${lead.id}`,
    })),
  };
}

export async function pipelineSummary(user: User): Promise<ToolOutput> {
  if (!(await hasAnyPermission(user, "leads.view_all", "leads.view_owned"))) return refused("leads");
  const ids = await getAccessibleLeadIds(user);
  // By stage AND currency: a stage's value is said per currency, never added across them.
  const rawGroups = await prisma.lead.groupBy({
    by: ["stageId", "currency"],
    where: { deletedAt: null, status: "open", ...(ids === null ? {} : { id: { in: ids } }) },
    _count: { _all: true },
    _sum: { valueCents: true },
  });
  const moneyFmt = await getRegionalSettings();
  const groups = [...Map.groupBy(rawGroups, (g) => g.stageId)].map(([stageId, rows]) => ({
    stageId,
    count: rows.reduce((sum, row) => sum + row._count._all, 0),
    value: formatTotals(totalsByCurrency(rows, (row) => ({ cents: row._sum.valueCents ?? 0, currency: row.currency }), moneyFmt.currency), moneyFmt),
  }));
  const stages = await prisma.pipelineStage.findMany({
    where: { id: { in: groups.map((g) => g.stageId) } },
    select: { id: true, name: true, order: true },
    orderBy: { order: "asc" },
  });
  const byStage = new Map(groups.map((g) => [g.stageId, g]));
  const data = stages.map((stage) => {
    const g = byStage.get(stage.id)!;
    return { stage: stage.name, openLeads: g.count, value: g.value };
  });
  return {
    truncated: false,
    data,
    rows: data.map((d) => ({ label: d.stage, detail: `${d.openLeads} open · ${d.value}`, href: "/leads" })),
  };
}
