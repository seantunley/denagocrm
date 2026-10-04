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
import { accessibleTestDriveWhere } from "./testDriveAccess";
import {
  canAccessLead,
  getAccessibleContactIds,
  getAccessibleDocumentIds,
  getAccessibleVehicleIds,
  getAccessibleLeadIds,
  getAccessibleQuoteIds,
  hasAnyPermission,
  hasPermission,
  type PermissionUser,
} from "./permissions";
import { ASSISTANT_PROFILE_KEY, parseProfile, selfKnowledge, soulText } from "./assistantSoul";
import { LEARN_INSTRUCTIONS, memoryPrompt, methodInstructions, splitLearn } from "./assistantMemory";
import { stripInvisible } from "./invisibleText";
import { safeCodexError } from "./codexErrors";
import { applyLearn, loadLearned, loadPlaybook } from "./assistantMemoryStore";
import { ACTION_INSTRUCTIONS, CHOICE_INSTRUCTIONS, splitActions, splitChoices, type ActionCard, type ProposedAction } from "./assistantActions";
import { describeSchedule, nextRun, scheduleInput } from "./assistantSchedule";
import {
  ANSWER_RULES,
  MAX_LOOKUPS,
  MAX_STEPS,
  activityArgs,
  conversationBlock,
  knowledgeArgs,
  leadArgs,
  leadBriefArgs,
  parseSteps,
  resultsBlock,
  planInstructions,
  playbookArgs,
  quoteArgs,
  recallArgs,
  scheduleArgs,
  vehicleArgs,
  deliveryArgs,
  documentArgs,
  type PriorTurn,
  type ToolStep,
} from "./crmAssistantPlan";

/**
 * "Ask the CRM" — a sales colleague that answers from the workspace's own
 * records and knowledge, on the ChatGPT account the workspace connected.
 *
 * Per question: up to MAX_STEPS research steps (ChatGPT picks read-only tools +
 * filters each time — several side by side when they're independent — validated
 * by crmAssistantPlan, and sees what came back),
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
  /** choices: quick replies, shown as buttons under the answer. */
  | { ok: true; answer: string; rows: AssistantRow[]; tools: string[]; learned: number; actions: ActionCard[]; choices: string[] }
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
      // "Expiring": still open — draft or sent, nobody has signed or declined —
      // with its validity running out in the window (or already run out today).
      ...(args.expiringWithinDays !== undefined
        ? {
            status: { in: ["draft", "sent"] },
            signedAt: null,
            declinedAt: null,
            validUntil: { gte: new Date(Date.now() - DAY), lte: new Date(Date.now() + args.expiringWithinDays * DAY) },
          }
        : {}),
    },
    orderBy: args.expiringWithinDays !== undefined ? { validUntil: "asc" } : { createdAt: "desc" },
    take: CANDIDATES,
    select: {
      id: true, number: true, status: true, createdAt: true, viewedAt: true, signedAt: true, validUntil: true,
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
      validUntil: quote.validUntil ? dateKey(quote.validUntil) : null,
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
        // A lead id, or a customer's id (from the bubble on a customer page).
        ? { OR: [{ id: needle }, { contactId: needle }] }
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
  // Test drives for this lead, through the test-drive page's own visibility rule.
  const testDrives = (await isModuleEnabled("automotive"))
    ? await prisma.testDriveBooking.findMany({
        where: { leadId: lead.id, deletedAt: null, ...(await accessibleTestDriveWhere(user)) },
        orderBy: { scheduledStart: "desc" },
        take: 5,
        select: { status: true, scheduledStart: true, salesOutcome: true, customerFeedback: true, demoVehicle: { select: { name: true } } },
      })
    : [];
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
      testDrives: testDrives.map((t) => ({
        when: dateKey(t.scheduledStart),
        status: t.status,
        vehicle: t.demoVehicle?.name ?? null,
        outcome: t.salesOutcome,
        feedback: clip(t.customerFeedback, 200),
      })),
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
      invoicedAt: true, depositPaidAt: true, deliveryScheduledFor: true, deliveredAt: true,
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
    ...(q.status === "accepted"
      ? {
          invoiced: q.invoicedAt ? dateKey(q.invoicedAt) : "no",
          deposit: q.depositPaidAt ? `paid ${dateKey(q.depositPaidAt)}` : "not paid",
          delivery: q.deliveredAt ? `delivered ${dateKey(q.deliveredAt)}` : q.deliveryScheduledFor ? `booked ${dateKey(q.deliveryScheduledFor)}` : "not booked",
        }
      : {}),
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
  // The catalogue and its prices, to the people who see them where they work —
  // on leads and in the quote builder. (/products itself is the owner's
  // management screen; reading names and prices is not managing them.)
  const seesProducts = await hasAnyPermission(user, "leads.view_all", "leads.view_owned", "quotes.view_all", "quotes.view_owned", "quotes.create");
  const [company, products, approved] = await Promise.all([
    getCompanyProfile().catch(() => null),
    seesProducts
      ? prisma.product.findMany({
          where: { active: true, deletedAt: null },
          orderBy: { name: "asc" },
          take: 60,
          select: { id: true, name: true, category: true, basePriceCents: true, description: true, showcaseTagline: true, showcaseSpecs: true },
        })
      : Promise.resolve([]),
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
/**
 * This person's earlier conversations (Hermes' session search): the turns that
 * match the most of the query's words, best first, each WITH the turns either
 * side of it that day — a decision is usually the answer to the question
 * before — so the answer step can say what was decided, not just quote a line.
 */
async function recall(user: User, raw: z.infer<typeof recallArgs>): Promise<ToolOutput> {
  const { query } = recallArgs.parse(raw);
  const words = recallWords(query);
  const since = new Date(Date.now() - HISTORY_DAYS * DAY);
  const candidates = await prisma.assistantTurn.findMany({
    where: {
      userId: user.id,
      createdAt: { gte: since },
      ...(words.length ? { OR: words.flatMap((w) => [{ question: fuzzy(w) }, { answer: fuzzy(w) }]) } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 40,
    select: { id: true, question: true, answer: true, createdAt: true },
  });
  const best = rankRecall(candidates, words).slice(0, RECALL_MATCHES);
  if (!best.length) return { truncated: false, rows: [], data: [{ note: "Nothing in this person's last 30 days of conversations matches." }] };
  // The turn before and after each match, same South African day.
  const around = await Promise.all(
    best.map((t) => {
      const day = dateKey(t.createdAt);
      const dayStart = new Date(`${day}T00:00:00+02:00`);
      return Promise.all([
        prisma.assistantTurn.findFirst({
          where: { userId: user.id, createdAt: { gte: dayStart, lt: t.createdAt } },
          orderBy: { createdAt: "desc" },
          select: { question: true, answer: true },
        }),
        prisma.assistantTurn.findFirst({
          where: { userId: user.id, createdAt: { gt: t.createdAt, lt: new Date(dayStart.getTime() + DAY) } },
          orderBy: { createdAt: "asc" },
          select: { question: true, answer: true },
        }),
      ]);
    }),
  );
  const short = (t: { question: string; answer: string } | null) => (t ? { question: clip(t.question, 200), answer: clip(t.answer, 300) } : undefined);
  return {
    truncated: candidates.length === 40,
    rows: [],
    data: best.map((t, i) => ({
      when: when(t.createdAt),
      before: short(around[i][0]),
      question: t.question,
      answer: clip(t.answer, 700),
      after: short(around[i][1]),
    })),
  };
}

const RECALL_MATCHES = 4;
const RECALL_STOP = new Set(["the", "and", "what", "did", "about", "with", "for", "was", "were", "that", "this", "have", "has", "had", "who", "when", "how", "why", "our", "you", "your", "say", "said", "tell", "told", "last", "week", "decide", "decided"]);

/** The words worth searching for: no stop words, no repeats, at most 6. */
export function recallWords(query: string): string[] {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}'-]+/u).filter((w) => w.length > 2 && !RECALL_STOP.has(w));
  return [...new Set(words)].slice(0, 6);
}

/** Most distinct words matched first; newest first among equals. */
export function rankRecall<T extends { question: string; answer: string; createdAt: Date }>(turns: T[], words: string[]): T[] {
  const hits = (t: T) => {
    const text = `${t.question}\n${t.answer}`.toLowerCase();
    return words.filter((w) => text.includes(w)).length;
  };
  return turns
    .map((t) => ({ t, n: hits(t) }))
    .filter((x) => !words.length || x.n > 0)
    .sort((a, b) => b.n - a.n || b.t.createdAt.getTime() - a.t.createdAt.getTime())
    .map((x) => x.t);
}

/** "Tue 7 Oct 10:00" in South African time. */
const when = (d: Date) =>
  d.toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const nameOfContact = (c: { firstName: string; lastName: string | null } | null | undefined) => (c ? contactName(c) : null);

/**
 * Who is busy when — meetings, blocked time and test drives (with their demo
 * vehicle) — so a suggested time never clashes. Through the calendar's own
 * visibility (getAccessibleActivityIds, accessibleTestDriveWhere). A blocked-out
 * slot shows as "busy", never its private reason.
 */
async function schedule(user: User, raw: z.infer<typeof scheduleArgs>): Promise<ToolOutput> {
  if (!(await hasAnyPermission(user, "activities.view", "activities.manage"))) return refused("the calendar");
  const args = scheduleArgs.parse(raw);
  const start = new Date(`${args.from ?? johannesburgDateKey(new Date())}T00:00:00+02:00`);
  const end = new Date(start.getTime() + (args.days ?? 3) * DAY);
  const staff = await listActingTenantStaff();
  const wanted = args.person?.toLowerCase();
  const person = wanted ? staff.find((s) => s.name.toLowerCase() === wanted) ?? staff.find((s) => s.name.toLowerCase().startsWith(wanted)) : null;
  if (args.person && !person) return { truncated: false, rows: [], data: [{ note: `No one called "${args.person}" in this workspace.` }] };

  const ids = await getAccessibleActivityIds(user);
  const activities = await prisma.activity.findMany({
    where: {
      ...(ids === null ? {} : { id: { in: ids } }),
      status: "planned",
      dueDate: { lt: end },
      AND: [
        { OR: [{ endDate: { gte: start } }, { endDate: null, dueDate: { gte: start } }] },
        person ? { OR: [{ assignedToId: person.id }, { attendees: { some: { userId: person.id } } }] } : {},
      ],
    },
    orderBy: { dueDate: "asc" },
    take: 80,
    select: {
      type: true, summary: true, dueDate: true, endDate: true, allDay: true, availabilityBlock: true,
      assignedTo: { select: { name: true } },
      attendees: { select: { user: { select: { name: true } } } },
    },
  });

  let testDrives: { reference: string; status: string; scheduledStart: Date; expectedReturnAt: Date; salespersonId: string; contactId: string; demoVehicle: { name: string } | null }[] = [];
  if (await isModuleEnabled("automotive")) {
    testDrives = await prisma.testDriveBooking.findMany({
      where: {
        deletedAt: null,
        ...(await accessibleTestDriveWhere(user)),
        status: { notIn: ["cancelled", "no_show"] },
        scheduledStart: { lt: end },
        expectedReturnAt: { gte: start },
        ...(person ? { OR: [{ salespersonId: person.id }, { accompanyingSalespersonId: person.id }] } : {}),
      },
      orderBy: { scheduledStart: "asc" },
      take: 40,
      select: { reference: true, status: true, scheduledStart: true, expectedReturnAt: true, salespersonId: true, contactId: true, demoVehicle: { select: { name: true } } },
    });
  }
  const contacts = testDrives.length
    ? new Map((await prisma.contact.findMany({ where: { id: { in: testDrives.map((t) => t.contactId) } }, select: { id: true, firstName: true, lastName: true } })).map((c) => [c.id, c]))
    : new Map();
  const staffName = new Map(staff.map((s) => [s.id, s.name]));

  return {
    truncated: activities.length === 80,
    data: [{
      window: `${johannesburgDateKey(start)} to ${johannesburgDateKey(new Date(end.getTime() - 1))}`,
      ...(person ? { person: person.name } : {}),
      busy: activities.map((a) => ({
        from: when(a.dueDate),
        until: a.endDate ? when(a.endDate) : null,
        allDay: a.allDay,
        what: a.availabilityBlock ? "busy (blocked out)" : `${a.type}: ${a.summary}`,
        people: [a.assignedTo.name, ...a.attendees.map((x) => x.user.name)],
      })),
      testDrives: testDrives.map((t) => ({
        ref: t.reference,
        status: t.status,
        from: when(t.scheduledStart),
        until: when(t.expectedReturnAt),
        vehicle: t.demoVehicle?.name ?? "no demo vehicle set",
        salesperson: staffName.get(t.salespersonId) ?? null,
        customer: nameOfContact(contacts.get(t.contactId)),
      })),
    }],
    rows: [{ label: "Calendar", detail: `${activities.length} commitments · ${testDrives.length} test drives`, href: "/calendar" }],
  };
}

/** Demo vehicles and their bookings, stock units, or customers' own vehicles. */
async function vehicles(user: User, raw: z.infer<typeof vehicleArgs>): Promise<ToolOutput> {
  const args = vehicleArgs.parse(raw);
  const take = args.limit ?? 15;
  if (args.kind === "stock") {
    if (!(await isModuleEnabled("commerce"))) return { truncated: false, rows: [], data: [{ note: "Stock isn't switched on for this workspace." }] };
    if (!(await hasAnyPermission(user, "stock.view", "stock.manage"))) return refused("stock");
    const units = await prisma.stockUnit.findMany({
      where: {
        deletedAt: null,
        ...(args.status ? { status: fuzzy(args.status) } : {}),
        ...(args.search
          ? { OR: [{ stockNumber: fuzzy(args.search) }, { serial: fuzzy(args.search) }, { label: fuzzy(args.search) }, { product: { name: fuzzy(args.search) } }] }
          : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: take + 1,
      select: {
        id: true, stockNumber: true, status: true, label: true, condition: true, color: true, location: true, salePriceCents: true,
        product: { select: { name: true } },
        reservedForLead: { select: { name: true } },
      },
    });
    const page = units.slice(0, take);
    return {
      truncated: units.length > take,
      data: page.map((u) => ({
        unit: u.stockNumber ?? u.id.slice(-6),
        product: u.product.name, status: u.status, label: u.label, condition: u.condition, colour: u.color, location: u.location,
        price: u.salePriceCents != null ? formatZAR(u.salePriceCents) : null,
        reservedFor: u.reservedForLead?.name ?? null,
      })),
      rows: page.map((u) => ({ label: `${u.product.name}${u.stockNumber ? ` · ${u.stockNumber}` : ""}`, detail: `${u.status}${u.label ? ` · ${u.label}` : ""}`, href: `/stock/${u.id}` })),
    };
  }

  if (!(await isModuleEnabled("automotive"))) return { truncated: false, rows: [], data: [{ note: "Vehicles aren't switched on for this workspace." }] };

  if (args.kind === "demo") {
    if (!(await hasAnyPermission(user, "vehicles.view_all", "vehicles.view_owned", "activities.view", "activities.manage"))) return refused("demo vehicles");
    const demos = await prisma.demoVehicle.findMany({
      where: {
        deletedAt: null,
        ...(args.status ? { status: fuzzy(args.status) } : {}),
        ...(args.search ? { OR: [{ name: fuzzy(args.search) }, { regNumber: fuzzy(args.search) }, { branch: fuzzy(args.search) }] } : {}),
      },
      orderBy: { name: "asc" },
      take: take + 1,
      select: {
        name: true, status: true, branch: true, regNumber: true, odometerKm: true, batteryLevelPct: true,
        // Availability only — times and status, no customer: enough not to double-book it.
        bookings: {
          where: { deletedAt: null, status: { notIn: ["cancelled", "no_show", "completed"] }, expectedReturnAt: { gte: new Date() }, scheduledStart: { lt: new Date(Date.now() + 14 * DAY) } },
          orderBy: { scheduledStart: "asc" },
          select: { scheduledStart: true, expectedReturnAt: true, status: true },
        },
      },
    });
    const page = demos.slice(0, take);
    return {
      truncated: demos.length > take,
      data: page.map((d) => ({
        vehicle: d.name, status: d.status, branch: d.branch, reg: d.regNumber, odometerKm: d.odometerKm, batteryPct: d.batteryLevelPct,
        bookedNext14Days: d.bookings.map((b) => ({ from: when(b.scheduledStart), until: when(b.expectedReturnAt), status: b.status })),
      })),
      rows: [{ label: "Test drives", detail: `${page.length} demo vehicle${page.length === 1 ? "" : "s"}`, href: "/test-drives" }],
    };
  }

  if (!(await hasAnyPermission(user, "vehicles.view_all", "vehicles.view_owned"))) return refused("customer vehicles");
  const ids = await getAccessibleVehicleIds(user);
  const owned = await prisma.vehicle.findMany({
    where: {
      deletedAt: null,
      ...(ids === null ? {} : { id: { in: ids } }),
      ...(args.search
        ? { OR: [{ model: fuzzy(args.search) }, { regNumber: fuzzy(args.search) }, { contact: { OR: [{ firstName: fuzzy(args.search) }, { lastName: fuzzy(args.search) }] } }] }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: take + 1,
    select: { id: true, model: true, regNumber: true, color: true, purchaseDate: true, warrantyMonths: true, contact: { select: { firstName: true, lastName: true } } },
  });
  const page = owned.slice(0, take);
  return {
    truncated: owned.length > take,
    data: page.map((v) => ({
      vehicle: v.model, reg: v.regNumber, colour: v.color, owner: nameOfContact(v.contact),
      bought: v.purchaseDate ? dateKey(v.purchaseDate) : null,
      warrantyUntil: v.purchaseDate && v.warrantyMonths ? dateKey(new Date(v.purchaseDate.getTime() + v.warrantyMonths * 30.44 * DAY)) : null,
    })),
    rows: page.map((v) => ({ label: `${v.model} — ${nameOfContact(v.contact)}`, detail: v.regNumber ?? "no reg", href: `/vehicles/${v.id}` })),
  };
}

/**
 * Signed deals on their way to the customer, in the deliveries board's own
 * stages (invoice → deposit → schedule → deliver), so DAX and the board agree.
 */
async function deliveries(user: User, raw: z.infer<typeof deliveryArgs>): Promise<ToolOutput> {
  if (!(await hasAnyPermission(user, "deliveries.view", "deliveries.manage"))) return refused("deliveries");
  // /deliveries is part of the automotive module; off → the board isn't there.
  if (!(await isModuleEnabled("automotive"))) return refused("deliveries (switched off for this workspace)");
  const args = deliveryArgs.parse(raw);
  const ids = await getAccessibleQuoteIds(user);
  const recent = args.stage === "delivered_recently";
  const quotes = await prisma.quote.findMany({
    where: {
      status: "accepted",
      supersededAt: null,
      deletedAt: null,
      ...(ids === null ? {} : { id: { in: ids } }),
      deliveredAt: recent ? { gte: new Date(Date.now() - 14 * DAY) } : null,
    },
    orderBy: { updatedAt: "asc" },
    take: CANDIDATES,
    select: {
      id: true, number: true, invoicedAt: true, depositPaidAt: true, depositPaidCents: true, deliveryScheduledFor: true, deliveredAt: true,
      taxInclusive: true, depositType: true, depositValue: true, items: true, fees: true,
      contact: { select: { firstName: true, lastName: true } },
      lead: { select: { id: true, name: true } },
    },
  });
  const today = new Date(`${johannesburgDateKey(new Date())}T00:00:00+02:00`);
  // The board's own rule (deliveries/page.tsx colOf).
  const stageOf = (q: (typeof quotes)[number]) =>
    q.deliveredAt ? "delivered"
      : !q.invoicedAt ? "to_invoice"
        : !q.depositPaidAt ? "awaiting_deposit"
          : !q.deliveryScheduledFor ? "to_schedule"
            : q.deliveryScheduledFor < today ? "overdue" : "scheduled";
  const wanted = args.stage && !recent ? args.stage : null;
  const matching = quotes
    .map((q) => ({ q, stage: stageOf(q) }))
    .filter(({ stage }) => !wanted || stage === wanted);
  const take = args.limit ?? 15;
  const page = matching.slice(0, take);
  const customer = (q: (typeof quotes)[number]) => nameOfContact(q.contact) ?? q.lead?.name ?? "no customer";
  return {
    truncated: matching.length > take || quotes.length === CANDIDATES,
    data: page.map(({ q, stage }) => ({
      quote: `Q-${q.number}`,
      leadId: q.lead?.id ?? null,
      customer: customer(q),
      stage,
      total: formatZAR(payableTotalCents(q)),
      invoiced: q.invoicedAt ? dateKey(q.invoicedAt) : "no",
      deposit: q.depositPaidAt ? `paid ${dateKey(q.depositPaidAt)}${q.depositPaidCents ? ` (${formatZAR(q.depositPaidCents)})` : ""}` : "not paid",
      deliveryDate: q.deliveryScheduledFor ? dateKey(q.deliveryScheduledFor) : null,
      delivered: q.deliveredAt ? dateKey(q.deliveredAt) : null,
    })),
    rows: page.map(({ q, stage }) => ({ label: `Q-${q.number} — ${customer(q)}`, detail: stage.replace(/_/g, " "), href: "/deliveries" })),
  };
}

/** What's on file for one customer: titles, tags and dates — never the contents. */
async function documents(user: User, raw: z.infer<typeof documentArgs>): Promise<ToolOutput> {
  if (!(await hasAnyPermission(user, "documents.view_all", "documents.view_owned"))) return refused("documents");
  const { customer } = documentArgs.parse(raw);
  const contactIds = await getAccessibleContactIds(user);
  const looksLikeId = /^c[a-z0-9]{20,}$/i.test(customer);
  const contacts = await prisma.contact.findMany({
    where: {
      deletedAt: null,
      ...(contactIds === null ? {} : { id: { in: contactIds } }),
      ...(looksLikeId
        ? { OR: [{ id: customer }, { leads: { some: { id: customer } } }] }
        : { OR: [{ firstName: fuzzy(customer) }, { lastName: fuzzy(customer) }, { company: fuzzy(customer) }, { leads: { some: { OR: [{ name: fuzzy(customer) }, { title: fuzzy(customer) }] } } }] }),
    },
    take: 3,
    select: { id: true, firstName: true, lastName: true },
  });
  if (!contacts.length) return { truncated: false, rows: [], data: [{ note: `No customer you can see matches "${customer}".` }] };
  if (contacts.length > 1) {
    return { truncated: false, rows: [], data: [{ note: "Several customers match — ask which one.", candidates: contacts.map((c) => contactName(c)) }] };
  }
  const contact = contacts[0];
  const docIds = await getAccessibleDocumentIds(user);
  const docs = await prisma.document.findMany({
    where: {
      deletedAt: null,
      replacedById: null,
      ...(docIds === null ? {} : { id: { in: docIds } }),
      OR: [{ contactId: contact.id }, { vehicle: { contactId: contact.id } }],
    },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: { fileName: true, tag: true, mimeType: true, createdAt: true },
  });
  return {
    truncated: docs.length === 30,
    data: [{ customer: contactName(contact), documents: docs.map((d) => ({ file: d.fileName, tag: d.tag, added: dateKey(d.createdAt) })) }],
    rows: [{ label: `${contactName(contact)} — documents`, detail: `${docs.length} on file`, href: `/contacts/${contact.id}` }],
  };
}

async function playbook(user: User, raw: z.infer<typeof playbookArgs>): Promise<ToolOutput> {
  const { name } = playbookArgs.parse(raw);
  const book = await loadPlaybook(name, user.id);
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
    case "playbook": return playbook(user, step.args);
    case "schedule": return schedule(user, step.args);
    case "vehicles": return vehicles(user, step.args);
    case "deliveries": return deliveries(user, step.args);
    case "documents": return documents(user, step.args);
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

/**
 * Who the assistant is talking WITH — the last layer after the business (soul,
 * workspace instructions, company, what it knows about the business): their job
 * title, their teams, whether they see everything. What they've told it or it
 * has learned about them (their profile notes) follows in the learned block.
 * Only this person's own record; teams through the tenant-scoped client.
 */
export async function personContext(user: User): Promise<string> {
  const [me, memberships, manages] = await Promise.all([
    prisma.user.findUnique({ where: { id: user.id }, select: { jobTitle: true } }),
    prisma.teamMember.findMany({ where: { userId: user.id, team: { active: true, deletedAt: null } }, select: { team: { select: { name: true } } }, take: 10 }),
    prisma.team.findMany({ where: { managerId: user.id, active: true, deletedAt: null }, select: { name: true }, take: 10 }),
  ]);
  return describePerson({
    name: user.name || "this person",
    jobTitle: me?.jobTitle ?? null,
    sees: user.role === "owner" ? "everything" : "their own",
    teams: [...new Set(memberships.map((m) => m.team.name))],
    manages: manages.map((t) => t.name),
  });
}

export function describePerson(p: { name: string; jobTitle: string | null; sees: "everything" | "their own"; teams: string[]; manages: string[] }): string {
  const role = p.jobTitle?.trim() ? `${p.name}, ${p.jobTitle.trim().slice(0, 80)}` : p.name;
  return [
    `THE PERSON YOU'RE TALKING WITH: ${role}.`,
    p.sees === "everything" ? "They can see everything in this workspace." : "They see the records their access allows — answer about those, never about anyone else's.",
    p.teams.length ? `Their team${p.teams.length === 1 ? "" : "s"}: ${p.teams.join(", ")}.` : "",
    p.manages.length ? `They manage: ${p.manages.join(", ")} — "my team" means the people in it.` : "",
    "Make your answers theirs — their deals, their team, the way they like it — without reciting this back.",
  ].filter(Boolean).join(" ");
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

/**
 * The bubble's history: only TODAY's turns (South African day), newest first —
 * enough to pick up where you left off, never a month of context.
 */
export async function assistantTurnsToday(userId: string) {
  const startOfToday = new Date(`${johannesburgDateKey(new Date())}T00:00:00+02:00`);
  return prisma.assistantTurn.findMany({
    where: { userId, createdAt: { gte: startOfToday } },
    orderBy: { createdAt: "desc" },
    take: 20,
    // `source`, so a scheduled answer is labelled as one in the thread.
    select: { question: true, answer: true, source: true },
  });
}

/**
 * Where the person is when they ask from the bubble — "this lead", "her" — as a
 * hint for the research step. Only a record id from the URL; the tools still
 * check access, so a hint about a record they can't see finds nothing.
 */
export function pageHint(path: string | null | undefined): string {
  const match = /^\/(leads|contacts)\/(c[a-z0-9]{20,})(?:[/?#]|$)/i.exec(path ?? "");
  if (!match) return "";
  return `The person is looking at ${match[1] === "leads" ? "lead" : "customer"} id ${match[2]} — "this", "him", "her", "them" mean that record (use lead_brief with that id).`;
}

/** The page's history list: this person's last turns, newest first. */
export async function assistantHistory(userId: string, take = 20) {
  return prisma.assistantTurn.findMany({
    where: { userId, createdAt: { gte: new Date(Date.now() - HISTORY_DAYS * DAY) } },
    orderBy: { createdAt: "desc" },
    take,
    select: { id: true, question: true, answer: true, source: true, createdAt: true },
  });
}

type Observation = { tool: string; args: unknown; output: ToolOutput };

/**
 * What a lookup returned, as the model reads it. CUSTOMER-AUTHORED TEXT lives in
 * here — names, web-form notes, WhatsApp and email bodies — and JSON.stringify
 * doesn't escape invisible characters, so an instruction hidden in the TAG block
 * would reach the model while staff looking at the record see nothing. Stripped
 * here, on every observation, before either step sees it.
 */
function observationText(o: Observation): string {
  // Each STRING VALUE is cleaned before it is serialised — never the finished
  // JSON. Cleaning folds fullwidth forms (NFKC), and a customer's fullwidth
  // ＂ and ＼ would otherwise become real quotes after stringify and forge
  // sibling fields ("status":"won", fake approved answers) inside the results.
  const clean = (_key: string, value: unknown) => (typeof value === "string" ? stripInvisible(value) : value);
  const body = JSON.stringify({ truncated: o.output.truncated, results: o.output.data }, clean);
  return `${o.tool} ${JSON.stringify(o.args ?? {}, clean)} →\n${body.length > OBSERVATION_CHARS ? `${body.slice(0, OBSERVATION_CHARS)}…(cut)` : body}`;
}

export { safeCodexError };

/**
 * Where a question came from. Tasks are proposed only in chat — a card needs a
 * Confirm press in the CRM, and a scheduled run or a WhatsApp message has no
 * card to press. Quick replies need someone there to tap them: not on a schedule.
 */
export type AskSource = "chat" | "schedule" | "whatsapp";
export type AskOptions = { source?: AskSource; scheduleId?: string };

export const CHANNEL_RULES: Record<AskSource, string> = {
  chat: "",
  schedule:
    "This question was SCHEDULED by the person earlier and is running on its own — they are not here to reply. Answer it fully as a short briefing; don't ask them anything and don't offer choices. You can't set up tasks here: say in words what you'd do next.",
  whatsapp:
    "The person is asking on WhatsApp from their phone. Keep it short and scannable, plain text, no links to rows. You can't set up tasks here (those need a tap on Confirm in the CRM): say in words what you'd do, and if they want a message drafted, put the draft itself in your answer so they can copy it.",
};

export async function askCrm(user: User, asked: string, page?: string | null, opts: AskOptions = {}): Promise<AssistantResult> {
  // Everything the model reads is stripped of invisible characters — the
  // question, the conversation, the workspace's names and notes, and every
  // lookup (observationText) — not only what gets stored.
  const question = stripInvisible(asked);
  const source = opts.source ?? "chat";
  const whereTheyAre = pageHint(page);
  if (!(await isCodexConnected())) {
    return { ok: false, error: "Connect ChatGPT first: Settings → Integrations → ChatGPT." };
  }
  const [context, history, learnedNow, person] = await Promise.all([
    planContext(user),
    recentTurns(user.id),
    loadLearned(user.id),
    personContext(user).catch(() => ""),
  ]);
  const conversation = stripInvisible(conversationBlock(history));
  // The business first (what it knows), then the person (who they are, what it knows about them).
  const learned = stripInvisible([memoryPrompt(learnedNow), person].filter(Boolean).join("\n\n"));
  const instructions = stripInvisible(planInstructions({ ...context, learned }));

  // Research: look, see, look closer — at most MAX_STEPS rounds, MAX_LOOKUPS in all.
  const observations: Observation[] = [];
  for (let step = 0; step < MAX_STEPS && observations.length < MAX_LOOKUPS; step++) {
    const reply = await codexRespond({
      instructions,
      prompt: [
        conversation,
        whereTheyAre,
        `Question: ${question}`,
        observations.length ? resultsBlock("Lookups so far:", observations.map(observationText).join("\n\n")) : "",
        `Rounds left: ${MAX_STEPS - step}. Lookups left: ${MAX_LOOKUPS - observations.length}.`,
      ].filter(Boolean).join("\n\n"),
      reasoningEffort: "low",
      timeoutMs: 45_000,
    });
    if ("error" in reply) {
      await logError("crm-assistant", "research step failed", safeCodexError(reply.error));
      if (!observations.length) return { ok: false, error: `ChatGPT didn't answer: ${safeCodexError(reply.error)}` };
      break;
    }
    const next = parseSteps(reply.text);
    if (!next) {
      // The reply may quote the question; log that it failed, not what it said.
      await logError("crm-assistant", "research step returned no usable tool call");
      if (!observations.length && step === 0) {
        return { ok: false, error: "I couldn't work out what to look up. Try naming what you want — leads, a customer, quotes or activities." };
      }
      break;
    }
    // Only lookups not already run (in this batch or before), within the total cap.
    const seen = new Set(observations.map((o) => `${o.tool} ${JSON.stringify(o.args)}`));
    const fresh: ToolStep[] = [];
    for (const s of next) {
      if (s.tool === "done") continue;
      const key = `${s.tool} ${JSON.stringify("args" in s ? s.args : {})}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(s);
    }
    const batch = fresh.slice(0, MAX_LOOKUPS - observations.length);
    if (!batch.length) break;
    // Independent lookups, side by side; one failing doesn't cost the others.
    const outputs = await Promise.all(
      batch.map((s) =>
        runTool(user, s).catch(async (error: unknown): Promise<ToolOutput> => {
          await logError("crm-assistant", `lookup ${s.tool} failed`, error instanceof Error ? error.name : "unknown");
          return { truncated: false, rows: [], data: [{ note: "That lookup failed — say so if it matters." }] };
        }),
      ),
    );
    batch.forEach((s, i) => observations.push({ tool: s.tool, args: "args" in s ? s.args : {}, output: outputs[i] }));
  }

  // Answer, in the workspace's own voice.
  const [profileRaw, company] = await Promise.all([
    getSetting(ASSISTANT_PROFILE_KEY),
    getCompanyProfile().catch(() => null),
  ]);
  const profile = parseProfile(profileRaw);
  const soul = stripInvisible(soulText(profile, company?.name ?? "", user.name || "a colleague"));
  const answerReply = await codexRespond({
    instructions: [
      soul,
      selfKnowledge(profile.name),
      learned,
      ANSWER_RULES,
      LEARN_INSTRUCTIONS,
      methodInstructions(observations),
      // Dated tasks ("Friday at 9", a follow-up "tomorrow") need the day it is.
      `Today is ${new Date().toLocaleDateString("en-ZA", { timeZone: "Africa/Johannesburg", weekday: "long", day: "numeric", month: "long", year: "numeric" })} (South Africa).`,
      source === "chat" ? ACTION_INSTRUCTIONS : "",
      source === "schedule" ? "" : CHOICE_INSTRUCTIONS,
      CHANNEL_RULES[source],
    ].filter(Boolean).join("\n\n"),
    prompt: [
      conversation,
      `Question: ${question}`,
      observations.length
        ? resultsBlock("What the CRM returned:", observations.map(observationText).join("\n\n"))
        : "No lookup was needed for this question.",
    ].filter(Boolean).join("\n\n"),
    reasoningEffort: "medium",
    timeoutMs: 60_000,
  });

  const rows = dedupeRows(observations.flatMap((o) => o.output.rows));
  const tools = observations.map((o) => o.tool);
  if ("error" in answerReply) {
    await logError("crm-assistant", "answer step failed", safeCodexError(answerReply.error));
    // The rows are still right; show them rather than nothing.
    return { ok: true, answer: "Here's what the CRM returned (ChatGPT couldn't write it up just now).", rows, tools, learned: 0, actions: [], choices: [] };
  }
  // The answer the person sees, and — separately — anything it decided to learn,
  // any tasks it proposes and any quick replies. All trailer lines are removed.
  const learnSplit = splitLearn(answerReply.text);
  const choiceSplit = splitChoices(learnSplit.answer);
  const { answer, actions: proposals } = splitActions(choiceSplit.answer);
  // A scheduled run learns nothing: it reads customer text daily with nobody
  // watching, so an injected "remember this" would be written with no one there.
  const learn = source === "schedule" ? null : learnSplit.learn;
  // Off-chat, a stray ACTIONS line is removed from the answer and dropped — no card to confirm it.
  const actions = source !== "chat" ? [] : await resolveActions(user, proposals).catch(async (error: unknown) => {
    await logError("crm-assistant", "task proposals failed", error instanceof Error ? error.name : "unknown");
    return [];
  });
  const choices = source === "schedule" ? [] : choiceSplit.choices;
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
        source,
        scheduleId: source === "schedule" ? opts.scheduleId ?? null : null,
      },
    })
    // Remembering is a nicety; failing to must not cost the person their answer.
    .catch((error: unknown) => logError("crm-assistant", "history write failed", error instanceof Error ? error.name : "unknown"));
  return { ok: true, answer, rows, tools, learned: learnedCount, actions, choices };
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
    if (p.type === "schedule") {
      // No lead to check: it is saved for whoever presses Confirm, and runs as
      // them with their permissions at the time. Only the timing is checked
      // here — a one-off in the past never becomes a card.
      const { type: _type, ...fields } = p;
      const parsed = scheduleInput.safeParse(fields);
      if (!parsed.success || !nextRun(parsed.data, new Date())) continue;
      cards.push({ id: `a${index}-schedule`, kind: "schedule", title: describeSchedule(parsed.data), ...parsed.data });
      continue;
    }
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
