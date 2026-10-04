import "server-only";
import { z } from "zod";
import { prisma } from "./db";
import { logError } from "./errorLog";
import { codexRespond, isCodexConnected } from "./codex";
import { formatZAR, contactName } from "./format";
import { payableTotalCents } from "./pricing";
import { johannesburgDateKey } from "./activityDay";
import { listActingTenantStaff } from "./tenantActor";
import { getAccessibleActivityIds } from "./activityAccess";
import {
  getAccessibleLeadIds,
  getAccessibleQuoteIds,
  hasAnyPermission,
  type PermissionUser,
} from "./permissions";
import {
  ANSWER_INSTRUCTIONS,
  activityArgs,
  leadArgs,
  parsePlan,
  planInstructions,
  quoteArgs,
  type AssistantPlan,
} from "./crmAssistantPlan";

/**
 * "Ask the CRM" — plain-language questions answered from the workspace's own
 * records, on the ChatGPT account the workspace connected.
 *
 * Two ChatGPT calls per question: PLAN (pick one read-only tool + filters,
 * validated by crmAssistantPlan) and ANSWER (write it up from the rows). Between
 * them the server runs the tool through the same visibility rules the pages use
 * — getAccessibleLeadIds / QuoteIds / ActivityIds — on the tenant-scoped client,
 * so the assistant can never show a person more than their own lists would.
 *
 * Nothing here logs a question, a row or an answer: customer data stays out of
 * the error log (see the encryption-and-logs policy). Failures log a reason only.
 */

const DAY = 86_400_000;
/** Candidate cap before in-memory filters (last-contact needs the full set). */
// ponytail: in-memory filter over ≤500 leads; move last-contact into SQL if a workspace outgrows it.
const CANDIDATES = 500;

export type AssistantRow = { label: string; detail: string; href: string };
export type AssistantResult =
  | { ok: true; answer: string; rows: AssistantRow[]; tool: AssistantPlan["tool"] }
  | { ok: false; error: string };

type ToolOutput = { rows: AssistantRow[]; data: unknown[]; truncated: boolean };

const fuzzy = (needle: string) => ({ contains: needle, mode: "insensitive" as const });
const dateKey = (d: Date | null) => (d ? johannesburgDateKey(d) : "never");
const daysAgo = (d: Date) => Math.floor((Date.now() - d.getTime()) / DAY);

async function findLeads(user: PermissionUser, raw: z.infer<typeof leadArgs>): Promise<ToolOutput> {
  if (!(await hasAnyPermission(user, "leads.view_all", "leads.view_owned"))) return refused("leads");
  const args = leadArgs.parse(raw);
  const ids = await getAccessibleLeadIds(user);
  const leads = await prisma.lead.findMany({
    where: {
      deletedAt: null,
      ...(ids === null ? {} : { id: { in: ids } }),
      status: args.status ?? "open",
      ...(args.stage ? { stage: { name: fuzzy(args.stage) } } : {}),
      ...(args.assignedTo ? { assignedTo: { name: fuzzy(args.assignedTo) } } : {}),
      ...(args.product ? { product: { name: fuzzy(args.product) } } : {}),
      ...(args.source ? { source: fuzzy(args.source) } : {}),
      ...(args.minValue ? { valueCents: { gte: Math.round(args.minValue * 100) } } : {}),
      ...(args.createdWithinDays ? { createdAt: { gte: new Date(Date.now() - args.createdWithinDays * DAY) } } : {}),
      ...(args.search
        ? { OR: [{ name: fuzzy(args.search) }, { title: fuzzy(args.search) }, { email: fuzzy(args.search) }] }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: CANDIDATES,
    select: {
      id: true, title: true, name: true, status: true, valueCents: true, source: true,
      createdAt: true, stageEnteredAt: true,
      stage: { select: { name: true } },
      product: { select: { name: true } },
      assignedTo: { select: { name: true } },
      communications: { orderBy: { occurredAt: "desc" }, take: 1, select: { occurredAt: true } },
      activities: { where: { status: "done" }, orderBy: { doneAt: "desc" }, take: 1, select: { doneAt: true } },
    },
  });

  // Last contact = the latest message either way or completed activity. The
  // lead's own updatedAt is NOT contact: editing a field touches it.
  const withTouch = leads.map((lead) => {
    const touches = [lead.communications[0]?.occurredAt, lead.activities[0]?.doneAt].filter(
      (d): d is Date => Boolean(d),
    );
    const lastContact = touches.length ? new Date(Math.max(...touches.map((d) => d.getTime()))) : null;
    return { lead, lastContact };
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
  };
  const sorted = [...filtered].sort(sorters[args.sort ?? (cutoff ? "oldest_contact" : "newest")]);
  const take = args.limit ?? 10;
  const page = sorted.slice(0, take);

  return {
    truncated: sorted.length > take || leads.length === CANDIDATES,
    data: page.map(({ lead, lastContact }) => ({
      lead: lead.title,
      customer: lead.name,
      stage: lead.stage.name,
      status: lead.status,
      value: formatZAR(lead.valueCents),
      assignedTo: lead.assignedTo?.name ?? "unassigned",
      product: lead.product?.name ?? null,
      source: lead.source,
      lastContact: dateKey(lastContact),
      daysInStage: daysAgo(lead.stageEnteredAt),
    })),
    rows: page.map(({ lead, lastContact }) => ({
      label: `${lead.name} — ${lead.title}`,
      detail: `${lead.stage.name} · ${formatZAR(lead.valueCents)} · ${lead.assignedTo?.name ?? "unassigned"} · last contact ${dateKey(lastContact)}`,
      href: `/leads/${lead.id}`,
    })),
  };
}

async function pipelineSummary(user: PermissionUser): Promise<ToolOutput> {
  if (!(await hasAnyPermission(user, "leads.view_all", "leads.view_owned"))) return refused("leads");
  const ids = await getAccessibleLeadIds(user);
  const groups = await prisma.lead.groupBy({
    by: ["stageId"],
    where: { deletedAt: null, status: "open", ...(ids === null ? {} : { id: { in: ids } }) },
    _count: { _all: true },
    _sum: { valueCents: true },
  });
  const stages = await prisma.pipelineStage.findMany({
    where: { id: { in: groups.map((g) => g.stageId) } },
    select: { id: true, name: true, order: true },
    orderBy: { order: "asc" },
  });
  const byStage = new Map(groups.map((g) => [g.stageId, g]));
  const data = stages.map((stage) => {
    const g = byStage.get(stage.id)!;
    return { stage: stage.name, openLeads: g._count._all, value: formatZAR(g._sum.valueCents ?? 0) };
  });
  return {
    truncated: false,
    data,
    rows: data.map((d) => ({ label: d.stage, detail: `${d.openLeads} open · ${d.value}`, href: "/leads" })),
  };
}

async function findQuotes(user: PermissionUser, raw: z.infer<typeof quoteArgs>): Promise<ToolOutput> {
  if (!(await hasAnyPermission(user, "quotes.view_all", "quotes.view_owned"))) return refused("quotes");
  const args = quoteArgs.parse(raw);
  const ids = await getAccessibleQuoteIds(user);
  const quotes = await prisma.quote.findMany({
    where: {
      deletedAt: null,
      supersededAt: null,
      ...(ids === null ? {} : { id: { in: ids } }),
      ...(args.awaitingSignature
        ? { status: "sent", signedAt: null, declinedAt: null }
        : args.status ? { status: args.status } : {}),
      ...(args.viewed === true ? { viewedAt: { not: null } } : args.viewed === false ? { viewedAt: null } : {}),
      ...(args.olderThanDays ? { createdAt: { lt: new Date(Date.now() - args.olderThanDays * DAY) } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: CANDIDATES,
    select: {
      id: true, number: true, status: true, createdAt: true, viewedAt: true, signedAt: true,
      taxInclusive: true, depositType: true, depositValue: true, items: true, fees: true,
      lead: { select: { name: true, title: true } },
      contact: { select: { firstName: true, lastName: true } },
    },
  });
  // Totals through payableTotalCents — the figure on the document, fees included.
  const priced = quotes
    .map((quote) => ({ quote, total: payableTotalCents(quote) }))
    .filter(({ total }) => !args.minValue || total >= args.minValue * 100);
  const take = args.limit ?? 10;
  const page = priced.slice(0, take);
  const customer = (q: (typeof quotes)[number]) =>
    q.contact ? contactName(q.contact) : q.lead?.name ?? "no customer";
  return {
    truncated: priced.length > take || quotes.length === CANDIDATES,
    data: page.map(({ quote, total }) => ({
      quote: `Q-${quote.number}`,
      customer: customer(quote),
      status: quote.status,
      total: formatZAR(total),
      created: dateKey(quote.createdAt),
      viewedByCustomer: quote.viewedAt ? dateKey(quote.viewedAt) : "not yet",
      signed: quote.signedAt ? dateKey(quote.signedAt) : "no",
    })),
    rows: page.map(({ quote, total }) => ({
      label: `Q-${quote.number} — ${customer(quote)}`,
      detail: `${quote.status} · ${formatZAR(total)} · viewed ${quote.viewedAt ? dateKey(quote.viewedAt) : "not yet"}`,
      href: `/quotes/${quote.id}`,
    })),
  };
}

async function findActivities(user: PermissionUser, raw: z.infer<typeof activityArgs>): Promise<ToolOutput> {
  if (!(await hasAnyPermission(user, "activities.view", "activities.manage"))) return refused("activities");
  const args = activityArgs.parse(raw);
  const ids = await getAccessibleActivityIds(user);
  // Day edges in Johannesburg (UTC+2, no DST) — the timezone every date here shows in.
  const today = johannesburgDateKey(new Date());
  const startOfToday = new Date(`${today}T00:00:00+02:00`);
  const range = {
    overdue: { lt: startOfToday },
    today: { gte: startOfToday, lt: new Date(startOfToday.getTime() + DAY) },
    this_week: { gte: startOfToday, lt: new Date(startOfToday.getTime() + 7 * DAY) },
    upcoming: { gte: new Date() },
  }[args.when];
  const take = args.limit ?? 15;
  const activities = await prisma.activity.findMany({
    where: {
      ...(ids === null ? {} : { id: { in: ids } }),
      status: "planned",
      availabilityBlock: false,
      dueDate: range,
      ...(args.type ? { type: fuzzy(args.type) } : {}),
      ...(args.assignedTo ? { assignedTo: { name: fuzzy(args.assignedTo) } } : {}),
    },
    orderBy: { dueDate: args.when === "overdue" ? "desc" : "asc" },
    take: take + 1,
    select: {
      id: true, type: true, summary: true, dueDate: true, leadId: true, contactId: true,
      assignedTo: { select: { name: true } },
      lead: { select: { name: true } },
    },
  });
  const page = activities.slice(0, take);
  const href = (a: (typeof activities)[number]) =>
    a.leadId ? `/leads/${a.leadId}` : a.contactId ? `/contacts/${a.contactId}` : "/activities";
  return {
    truncated: activities.length > take,
    data: page.map((a) => ({
      type: a.type,
      summary: a.summary,
      due: dateKey(a.dueDate),
      assignedTo: a.assignedTo.name,
      customer: a.lead?.name ?? null,
    })),
    rows: page.map((a) => ({
      label: a.summary,
      detail: `${a.type} · due ${dateKey(a.dueDate)} · ${a.assignedTo.name}`,
      href: href(a),
    })),
  };
}

function refused(what: string): ToolOutput {
  return { truncated: false, rows: [], data: [{ note: `You don't have access to ${what}.` }] };
}

async function runTool(user: PermissionUser, plan: Exclude<AssistantPlan, { tool: "none" }>): Promise<ToolOutput> {
  switch (plan.tool) {
    case "find_leads": return findLeads(user, plan.args);
    case "pipeline_summary": return pipelineSummary(user);
    case "find_quotes": return findQuotes(user, plan.args);
    case "find_activities": return findActivities(user, plan.args);
  }
}

/** The workspace facts the plan step needs to map names to real values. */
async function planContext(user: PermissionUser & { name?: string | null }) {
  const [stages, staff, types] = await Promise.all([
    prisma.pipelineStage.findMany({ select: { name: true }, orderBy: { order: "asc" } }),
    listActingTenantStaff(),
    prisma.activity.findMany({ distinct: ["type"], select: { type: true }, take: 30 }),
  ]);
  return {
    today: johannesburgDateKey(new Date()),
    userName: user.name ?? "the user",
    stages: [...new Set(stages.map((s) => s.name))],
    staff: staff.map((s) => s.name),
    activityTypes: types.map((t) => t.type),
  };
}

export async function askCrm(user: PermissionUser & { name?: string | null }, question: string): Promise<AssistantResult> {
  if (!(await isCodexConnected())) {
    return { ok: false, error: "Connect ChatGPT first: Settings → Integrations → ChatGPT." };
  }
  const planReply = await codexRespond({
    instructions: planInstructions(await planContext(user)),
    prompt: question,
    reasoningEffort: "low",
    timeoutMs: 45_000,
  });
  if ("error" in planReply) {
    await logError("crm-assistant", "plan step failed", planReply.error);
    return { ok: false, error: `ChatGPT didn't answer: ${planReply.error}` };
  }
  const plan = parsePlan(planReply.text);
  if (!plan) {
    // The reply may quote the question; log that it failed, not what it said.
    await logError("crm-assistant", "plan step returned no usable tool call");
    return { ok: false, error: "I couldn't turn that into a search. Try naming what you want — leads, quotes or activities." };
  }
  if (plan.tool === "none") return { ok: true, answer: plan.reply, rows: [], tool: "none" };

  const output = await runTool(user, plan);
  const answerReply = await codexRespond({
    instructions: ANSWER_INSTRUCTIONS,
    prompt: `Question: ${question}\n\nRows (truncated: ${output.truncated}):\n${JSON.stringify(output.data)}`,
    reasoningEffort: "low",
    verbosity: "low",
    timeoutMs: 45_000,
  });
  if ("error" in answerReply) {
    await logError("crm-assistant", "answer step failed", answerReply.error);
    // The rows are still right; show them rather than nothing.
    return { ok: true, answer: "Here's what the CRM returned (ChatGPT couldn't write a summary just now).", rows: output.rows, tool: plan.tool };
  }
  return { ok: true, answer: answerReply.text.trim(), rows: output.rows, tool: plan.tool };
}
