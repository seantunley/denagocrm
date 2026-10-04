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
import { getSetting } from "./settings";
import { getCompanyProfile } from "./companyProfile";
import { searchBotKnowledge } from "./botKnowledge";
import { isModuleEnabled } from "./modules/enabled";
import { ownedWriteTenantId } from "./tenantWrite";
import {
  canAccessLead,
  getAccessibleLeadIds,
  getAccessibleQuoteIds,
  hasAnyPermission,
  hasPermission,
  type PermissionUser,
} from "./permissions";
import { ASSISTANT_PROFILE_KEY, parseProfile, soulText } from "./assistantSoul";
import { LEARN_INSTRUCTIONS, memoryPrompt, splitLearn } from "./assistantMemory";
import { applyLearn, loadLearned, loadPlaybook } from "./assistantMemoryStore";
import { ACTION_INSTRUCTIONS, splitActions, type ActionCard, type ProposedAction } from "./assistantActions";
import {
  ANSWER_RULES,
  MAX_STEPS,
  activityArgs,
  conversationBlock,
  knowledgeArgs,
  leadArgs,
  leadBriefArgs,
  parseStep,
  planInstructions,
  playbookArgs,
  quoteArgs,
  recallArgs,
  type PriorTurn,
  type ToolStep,
} from "./crmAssistantPlan";

/**
 * "Ask the CRM" — a sales colleague that answers from the workspace's own
 * records and knowledge, on the ChatGPT account the workspace connected.
 *
 * Per question: up to MAX_STEPS research steps (ChatGPT picks ONE read-only tool
 * + filters each time, validated by crmAssistantPlan, and sees what came back),
 * then an ANSWER step in the workspace's own voice (assistantSoul). Every tool
 * runs on the tenant-scoped client through the same visibility rules the pages
 * use — getAccessibleLeadIds / QuoteIds / ActivityIds — so the assistant never
 * shows a person more than their own lists would.
 *
 * Each turn is kept 30 days, private to the asker (AssistantTurn; the
 * maintenance sweep deletes older rows), for follow-ups and `recall`. Nothing
 * here logs a question, a row or an answer: failures log a reason only.
 */

const DAY = 86_400_000;
/** Turns this recent are "the conversation"; older ones are only reachable via recall. */
const CONVERSATION_WINDOW_MS = 3 * 60 * 60 * 1000;
const HISTORY_DAYS = 30;
/** Candidate cap before in-memory filters (last-contact needs the full set). */
// ponytail: in-memory filter over ≤500 leads; move last-contact into SQL if a workspace outgrows it.
const CANDIDATES = 500;
/** What one tool's results may cost in a prompt. */
const OBSERVATION_CHARS = 7000;

export type AssistantRow = { label: string; detail: string; href: string };
export type AssistantResult =
  /** learned: how many memories/playbooks this answer added or changed (owner reviews them). */
  | { ok: true; answer: string; rows: AssistantRow[]; tools: string[]; learned: number; actions: ActionCard[] }
  | { ok: false; error: string };

type ToolOutput = { rows: AssistantRow[]; data: unknown[]; truncated: boolean };
type User = PermissionUser;

const fuzzy = (needle: string) => ({ contains: needle, mode: "insensitive" as const });
const dateKey = (d: Date | null | undefined) => (d ? johannesburgDateKey(d) : "never");
const daysAgo = (d: Date) => Math.floor((Date.now() - d.getTime()) / DAY);
const clip = (s: string | null | undefined, n: number) => (s ? (s.length > n ? `${s.slice(0, n)}…` : s) : null);

/* ── Tools ───────────────────────────────────────────────────────────────── */

async function findLeads(user: User, raw: z.infer<typeof leadArgs>): Promise<ToolOutput> {
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
      id: lead.id,
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

async function pipelineSummary(user: User): Promise<ToolOutput> {
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

async function findQuotes(user: User, raw: z.infer<typeof quoteArgs>): Promise<ToolOutput> {
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
      lead: { select: { id: true, name: true, title: true } },
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
      leadId: quote.lead?.id ?? null,
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

async function findActivities(user: User, raw: z.infer<typeof activityArgs>): Promise<ToolOutput> {
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
      leadId: a.leadId,
    })),
    rows: page.map((a) => ({
      label: a.summary,
      detail: `${a.type} · due ${dateKey(a.dueDate)} · ${a.assignedTo.name}`,
      href: href(a),
    })),
  };
}

/**
 * One lead in depth — what a colleague would read before saying "here's what
 * I'd do": the deal, every recent message both ways, its quotes (opened?
 * signed?), its activities and any research. Phone numbers and emails are left
 * out: nothing here needs them to reason, so they don't go to ChatGPT.
 */
async function leadBrief(user: User, raw: z.infer<typeof leadBriefArgs>): Promise<ToolOutput> {
  if (!(await hasAnyPermission(user, "leads.view_all", "leads.view_owned"))) return refused("leads");
  const { lead: needle } = leadBriefArgs.parse(raw);
  const ids = await getAccessibleLeadIds(user);
  const visible = ids === null ? {} : { id: { in: ids } };
  const looksLikeId = /^c[a-z0-9]{20,}$/i.test(needle);
  const matches = await prisma.lead.findMany({
    where: {
      deletedAt: null,
      ...visible,
      ...(looksLikeId
        ? { id: needle }
        : {
            OR: [
              { name: fuzzy(needle) },
              { title: fuzzy(needle) },
              { contact: { OR: [{ firstName: fuzzy(needle) }, { lastName: fuzzy(needle) }] } },
            ],
          }),
    },
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
    take: 5,
    select: { id: true, title: true, name: true, status: true, stage: { select: { name: true } } },
  });
  if (matches.length === 0) return { truncated: false, rows: [], data: [{ note: `No lead you can see matches "${needle}".` }] };
  if (matches.length > 1) {
    return {
      truncated: false,
      data: [{ note: "Several leads match — ask which one, or pick the obvious one.", candidates: matches.map((m) => ({ id: m.id, lead: m.title, customer: m.name, status: m.status, stage: m.stage.name })) }],
      rows: matches.map((m) => ({ label: `${m.name} — ${m.title}`, detail: `${m.stage.name} · ${m.status}`, href: `/leads/${m.id}` })),
    };
  }

  const lead = await prisma.lead.findUniqueOrThrow({
    where: { id: matches[0].id },
    select: {
      id: true, title: true, name: true, status: true, valueCents: true, quantity: true, source: true,
      notes: true, research: true, researchedAt: true, createdAt: true, stageEnteredAt: true,
      wonAt: true, lostAt: true, lostReason: true,
      stage: { select: { name: true } },
      product: { select: { name: true } },
      assignedTo: { select: { name: true } },
      communications: {
        orderBy: { occurredAt: "desc" },
        take: 15,
        select: { occurredAt: true, direction: true, type: true, subject: true, body: true },
      },
      activities: {
        orderBy: { dueDate: "desc" },
        take: 10,
        select: { type: true, summary: true, status: true, dueDate: true, doneAt: true, note: true },
      },
    },
  });
  const quotes = (await hasAnyPermission(user, "quotes.view_all", "quotes.view_owned"))
    ? await quotesForLead(user, lead.id)
    : [];

  return {
    truncated: false,
    data: [{
      id: lead.id,
      lead: lead.title,
      customer: lead.name,
      status: lead.status,
      stage: lead.stage.name,
      daysInStage: daysAgo(lead.stageEnteredAt),
      value: formatZAR(lead.valueCents),
      quantity: lead.quantity,
      product: lead.product?.name ?? null,
      source: lead.source,
      assignedTo: lead.assignedTo?.name ?? "unassigned",
      created: dateKey(lead.createdAt),
      ...(lead.wonAt ? { won: dateKey(lead.wonAt) } : {}),
      ...(lead.lostAt ? { lost: dateKey(lead.lostAt), lostReason: lead.lostReason } : {}),
      notes: clip(lead.notes, 800),
      research: lead.research ? { when: dateKey(lead.researchedAt), summary: clip(lead.research, 1500) } : null,
      messages: lead.communications.map((c) => ({
        when: dateKey(c.occurredAt),
        from: c.direction === "inbound" ? "customer" : "us",
        channel: c.type,
        text: clip([c.subject, c.body].filter(Boolean).join(" — "), 300),
      })),
      activities: lead.activities.map((a) => ({
        type: a.type,
        summary: a.summary,
        status: a.status,
        due: dateKey(a.dueDate),
        ...(a.doneAt ? { done: dateKey(a.doneAt) } : {}),
        note: clip(a.note, 200),
      })),
      quotes,
    }],
    rows: [{
      label: `${lead.name} — ${lead.title}`,
      detail: `${lead.stage.name} · ${formatZAR(lead.valueCents)} · ${lead.assignedTo?.name ?? "unassigned"}`,
      href: `/leads/${lead.id}`,
    }],
  };
}

async function quotesForLead(user: User, leadId: string) {
  const ids = await getAccessibleQuoteIds(user);
  const quotes = await prisma.quote.findMany({
    where: { leadId, deletedAt: null, supersededAt: null, ...(ids === null ? {} : { id: { in: ids } }) },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      number: true, status: true, createdAt: true, validUntil: true, viewedAt: true, signedAt: true, declinedAt: true,
      declineReason: true, changeRequestNote: true,
      taxInclusive: true, depositType: true, depositValue: true, items: true, fees: true,
    },
  });
  return quotes.map((q) => ({
    quote: `Q-${q.number}`,
    status: q.status,
    total: formatZAR(payableTotalCents(q)),
    created: dateKey(q.createdAt),
    validUntil: q.validUntil ? dateKey(q.validUntil) : null,
    viewedByCustomer: q.viewedAt ? dateKey(q.viewedAt) : "not yet",
    signed: q.signedAt ? dateKey(q.signedAt) : "no",
    ...(q.declinedAt ? { declined: dateKey(q.declinedAt), reason: clip(q.declineReason, 200) } : {}),
    ...(q.changeRequestNote ? { changeRequested: clip(q.changeRequestNote, 200) } : {}),
  }));
}

/**
 * The business's own knowledge — what makes an answer knowledgeable rather than
 * a lookup: the products and their prices, the approved answers the chatbot is
 * allowed to give (finance, warranty, policies), the company's details and,
 * for people who may see it, competitor intelligence.
 */
async function knowledge(user: User, raw: z.infer<typeof knowledgeArgs>): Promise<ToolOutput> {
  const { topic } = knowledgeArgs.parse(raw);
  const words = topic.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const [company, products, approved] = await Promise.all([
    getCompanyProfile().catch(() => null),
    prisma.product.findMany({
      where: { active: true, deletedAt: null },
      orderBy: { name: "asc" },
      take: 60,
      select: { id: true, name: true, category: true, basePriceCents: true, description: true, showcaseTagline: true, showcaseSpecs: true },
    }),
    searchBotKnowledge(topic).catch(() => []),
  ]);
  // A small catalogue is worth showing whole; a large one only where it matches.
  const relevant = products.length <= 15
    ? products
    : products.filter((p) => words.some((w) => `${p.name} ${p.category ?? ""} ${p.description ?? ""}`.toLowerCase().includes(w)));

  let competitors: unknown[] = [];
  if ((await hasPermission(user, "competitors.view")) && (await isModuleEnabled("automation"))) {
    const rows = await prisma.competitor.findMany({
      where: { deletedAt: null },
      take: 10,
      select: {
        name: true, description: true, tier: true,
        briefs: { orderBy: { createdAt: "desc" }, take: 1, select: { headline: true, body: true, createdAt: true } },
      },
    });
    const mentionsCompetitors = /compet|rival|versus|\bvs\b|compare/i.test(topic);
    competitors = rows
      .filter((c) => mentionsCompetitors || words.some((w) => c.name.toLowerCase().includes(w)))
      .map((c) => ({
        competitor: c.name,
        about: clip(c.description, 300),
        tier: c.tier,
        latestBrief: c.briefs[0] ? { when: dateKey(c.briefs[0].createdAt), headline: c.briefs[0].headline, body: clip(c.briefs[0].body, 1200) } : null,
      }));
  }

  return {
    truncated: false,
    data: [{
      company: company ? { name: company.name, tagline: company.tagline, website: company.website, address: company.address } : null,
      products: relevant.map((p) => ({
        product: p.name,
        category: p.category,
        price: formatZAR(p.basePriceCents),
        tagline: p.showcaseTagline,
        description: clip(p.description, 300),
        specs: p.showcaseSpecs ? clip(JSON.stringify(p.showcaseSpecs), 400) : null,
      })),
      approvedAnswers: approved.map((k) => ({ title: k.title, answer: clip(k.content, 800) })),
      competitors,
    }],
    rows: relevant.slice(0, 8).map((p) => ({ label: p.name, detail: formatZAR(p.basePriceCents), href: "/products" })),
  };
}

/** The asker's own earlier conversations — never anyone else's. */
async function recall(user: User, raw: z.infer<typeof recallArgs>): Promise<ToolOutput> {
  const { query } = recallArgs.parse(raw);
  const words = query.split(/\s+/).filter((w) => w.length > 2).slice(0, 6);
  const turns = await prisma.assistantTurn.findMany({
    where: {
      userId: user.id,
      createdAt: { gte: new Date(Date.now() - HISTORY_DAYS * DAY) },
      ...(words.length
        ? { OR: words.flatMap((w) => [{ question: fuzzy(w) }, { answer: fuzzy(w) }]) }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { question: true, answer: true, createdAt: true },
  });
  return {
    truncated: false,
    data: turns.map((t) => ({ when: dateKey(t.createdAt), question: t.question, answer: clip(t.answer, 600) })),
    rows: [],
  };
}

async function playbook(raw: z.infer<typeof playbookArgs>): Promise<ToolOutput> {
  const { name } = playbookArgs.parse(raw);
  const book = await loadPlaybook(name);
  if (!book) return { truncated: false, rows: [], data: [{ note: `No playbook called "${name}".` }] };
  return { truncated: false, rows: [], data: [{ playbook: book.name, description: book.description, content: book.content, reviewed: book.status === "approved" }] };
}

function refused(what: string): ToolOutput {
  return { truncated: false, rows: [], data: [{ note: `You don't have access to ${what}.` }] };
}

async function runTool(user: User, step: ToolStep): Promise<ToolOutput> {
  switch (step.tool) {
    case "find_leads": return findLeads(user, step.args);
    case "pipeline_summary": return pipelineSummary(user);
    case "find_quotes": return findQuotes(user, step.args);
    case "find_activities": return findActivities(user, step.args);
    case "lead_brief": return leadBrief(user, step.args);
    case "knowledge": return knowledge(user, step.args);
    case "recall": return recall(user, step.args);
    case "playbook": return playbook(step.args);
  }
}

/* ── The conversation ────────────────────────────────────────────────────── */

/** The workspace facts the research step needs to map names to real values. */
async function planContext(user: User) {
  const [stages, staff, types] = await Promise.all([
    prisma.pipelineStage.findMany({ select: { name: true }, orderBy: { order: "asc" } }),
    listActingTenantStaff(),
    prisma.activity.findMany({ distinct: ["type"], select: { type: true }, take: 30 }),
  ]);
  return {
    today: johannesburgDateKey(new Date()),
    userName: user.name || "the user",
    stages: [...new Set(stages.map((s) => s.name))],
    staff: staff.map((s) => s.name),
    activityTypes: types.map((t) => t.type),
  };
}

/** This person's turns in the current conversation (the last few hours), oldest first. */
async function recentTurns(userId: string): Promise<PriorTurn[]> {
  const turns = await prisma.assistantTurn.findMany({
    where: { userId, createdAt: { gte: new Date(Date.now() - CONVERSATION_WINDOW_MS) } },
    orderBy: { createdAt: "desc" },
    take: 6,
    select: { question: true, answer: true },
  });
  return turns.reverse();
}

/** The page's history list: this person's last turns, newest first. */
export async function assistantHistory(userId: string, take = 20) {
  return prisma.assistantTurn.findMany({
    where: { userId, createdAt: { gte: new Date(Date.now() - HISTORY_DAYS * DAY) } },
    orderBy: { createdAt: "desc" },
    take,
    select: { id: true, question: true, answer: true, createdAt: true },
  });
}

type Observation = { tool: string; args: unknown; output: ToolOutput };

function observationText(o: Observation): string {
  const body = JSON.stringify({ truncated: o.output.truncated, results: o.output.data });
  return `${o.tool} ${JSON.stringify(o.args ?? {})} →\n${body.length > OBSERVATION_CHARS ? `${body.slice(0, OBSERVATION_CHARS)}…(cut)` : body}`;
}

export async function askCrm(user: User, question: string): Promise<AssistantResult> {
  if (!(await isCodexConnected())) {
    return { ok: false, error: "Connect ChatGPT first: Settings → Integrations → ChatGPT." };
  }
  const [context, history, learnedNow] = await Promise.all([planContext(user), recentTurns(user.id), loadLearned(user.id)]);
  const conversation = conversationBlock(history);
  const learned = memoryPrompt(learnedNow);
  const instructions = planInstructions({ ...context, learned });

  // Research: look, see, look closer — at most MAX_STEPS lookups.
  const observations: Observation[] = [];
  for (let step = 0; step < MAX_STEPS; step++) {
    const reply = await codexRespond({
      instructions,
      prompt: [
        conversation,
        `Question: ${question}`,
        observations.length ? `Lookups so far:\n${observations.map(observationText).join("\n\n")}` : "",
        `Lookups left: ${MAX_STEPS - step}.`,
      ].filter(Boolean).join("\n\n"),
      reasoningEffort: "low",
      timeoutMs: 45_000,
    });
    if ("error" in reply) {
      await logError("crm-assistant", "research step failed", reply.error);
      if (!observations.length) return { ok: false, error: `ChatGPT didn't answer: ${reply.error}` };
      break;
    }
    const next = parseStep(reply.text);
    if (!next) {
      // The reply may quote the question; log that it failed, not what it said.
      await logError("crm-assistant", "research step returned no usable tool call");
      if (!observations.length && step === 0) {
        return { ok: false, error: "I couldn't work out what to look up. Try naming what you want — leads, a customer, quotes or activities." };
      }
      break;
    }
    if (next.tool === "done") break;
    const args = "args" in next ? next.args : {};
    if (observations.some((o) => o.tool === next.tool && JSON.stringify(o.args) === JSON.stringify(args))) break;
    observations.push({ tool: next.tool, args, output: await runTool(user, next) });
  }

  // Answer, in the workspace's own voice.
  const [profileRaw, company] = await Promise.all([
    getSetting(ASSISTANT_PROFILE_KEY),
    getCompanyProfile().catch(() => null),
  ]);
  const soul = soulText(parseProfile(profileRaw), company?.name ?? "", user.name || "a colleague");
  const answerReply = await codexRespond({
    instructions: [soul, learned, ANSWER_RULES, LEARN_INSTRUCTIONS, ACTION_INSTRUCTIONS].filter(Boolean).join("\n\n"),
    prompt: [
      conversation,
      `Question: ${question}`,
      observations.length
        ? `What the CRM returned:\n${observations.map(observationText).join("\n\n")}`
        : "No lookup was needed for this question.",
    ].filter(Boolean).join("\n\n"),
    reasoningEffort: "medium",
    timeoutMs: 60_000,
  });

  const rows = dedupeRows(observations.flatMap((o) => o.output.rows));
  const tools = observations.map((o) => o.tool);
  if ("error" in answerReply) {
    await logError("crm-assistant", "answer step failed", answerReply.error);
    // The rows are still right; show them rather than nothing.
    return { ok: true, answer: "Here's what the CRM returned (ChatGPT couldn't write it up just now).", rows, tools, learned: 0, actions: [] };
  }
  // The answer the person sees, and — separately — anything it decided to learn
  // and any tasks it proposes. Both trailer lines are removed from the answer.
  const learnSplit = splitLearn(answerReply.text);
  const { answer, actions: proposals } = splitActions(learnSplit.answer);
  const learn = learnSplit.learn;
  const actions = await resolveActions(user, proposals).catch(async (error: unknown) => {
    await logError("crm-assistant", "task proposals failed", error instanceof Error ? error.name : "unknown");
    return [];
  });
  const learnedCount = learn
    ? await applyLearn(user.id, learn).catch(async (error: unknown) => {
        await logError("crm-assistant", "learning write failed", error instanceof Error ? error.name : "unknown");
        return 0;
      })
    : 0;
  await prisma.assistantTurn
    .create({
      data: {
        tenantId: ownedWriteTenantId(),
        userId: user.id,
        question,
        answer,
        tools: observations.map((o) => ({ tool: o.tool, args: o.args })) as object,
      },
    })
    // Remembering is a nicety; failing to must not cost the person their answer.
    .catch((error: unknown) => logError("crm-assistant", "history write failed", error instanceof Error ? error.name : "unknown"));
  return { ok: true, answer, rows, tools, learned: learnedCount, actions };
}

/**
 * Proposals → cards. Each is checked against what this person may touch and its
 * names resolved to real ids (a person in this workspace, a stage in that lead's
 * pipeline); anything that doesn't resolve is dropped, not guessed. Nothing runs
 * here — the card's Confirm calls the existing action, which checks it all again.
 */
async function resolveActions(user: User, proposals: ProposedAction[]): Promise<ActionCard[]> {
  if (!proposals.length) return [];
  const staff = await listActingTenantStaff();
  const cards: ActionCard[] = [];
  for (const [index, p] of proposals.entries()) {
    if (!(await canAccessLead(user, p.leadId))) continue;
    const lead = await prisma.lead.findUnique({
      where: { id: p.leadId },
      select: { name: true, title: true, stageId: true, stage: { select: { pipelineId: true } } },
    });
    if (!lead) continue;
    const id = `a${index}-${p.leadId}`;
    const leadLabel = `${lead.name} — ${lead.title}`;
    if (p.type === "follow_up") {
      const when = p.when.includes("T") ? p.when : `${p.when}T09:00`;
      const at = new Date(`${when}:00+02:00`);
      if (Number.isNaN(at.getTime()) || at.getTime() < Date.now() - 60 * 60 * 1000) continue;
      const label = at.toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
      cards.push({ id, kind: "follow_up", leadId: p.leadId, leadLabel, title: `${p.summary ?? `Follow-up ${p.activity}`} with ${lead.name} — ${label}`, when, activity: p.activity, summary: p.summary });
    } else if (p.type === "note") {
      cards.push({ id, kind: "note", leadId: p.leadId, leadLabel, title: `Add a note to ${lead.name}'s lead`, text: p.text });
    } else if (p.type === "assign") {
      const wanted = p.to.trim().toLowerCase();
      const person = staff.find((s) => s.name.toLowerCase() === wanted) ?? staff.find((s) => s.name.toLowerCase().startsWith(wanted));
      if (!person) continue;
      cards.push({ id, kind: "assign", leadId: p.leadId, leadLabel, title: `Give ${lead.name}'s lead to ${person.name}`, userId: person.id });
    } else if (p.type === "stage") {
      // Compared in code, exactly: a pipeline has a handful of stages, and an
      // insensitive `equals` would treat `_`/`%` in the name as wildcards.
      const wantedStage = p.stage.trim().toLowerCase();
      const stage = (await prisma.pipelineStage.findMany({
        where: { pipelineId: lead.stage.pipelineId },
        select: { id: true, name: true },
      })).find((s) => s.name.toLowerCase() === wantedStage);
      if (!stage || stage.id === lead.stageId) continue;
      cards.push({ id, kind: "stage", leadId: p.leadId, leadLabel, title: `Move ${lead.name}'s lead to ${stage.name}`, stageId: stage.id });
    } else {
      cards.push({
        id, kind: "draft_message", leadId: p.leadId, leadLabel,
        title: `${p.channel === "whatsapp" ? "WhatsApp" : "Email"} to ${lead.name} (draft)`,
        channel: p.channel, subject: p.subject, body: p.body,
      });
    }
  }
  return cards;
}

function dedupeRows(rows: AssistantRow[]): AssistantRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.href}|${row.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
