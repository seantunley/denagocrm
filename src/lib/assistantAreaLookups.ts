import "server-only";
import { prisma } from "./db";
import { ownedWriteTenantId } from "./tenantWrite";
import { hasAnyPermission, getAccessibleLeadScope, type PermissionUser } from "./permissions";
import { isModuleEnabled } from "./modules/enabled";
import { listTickets } from "./helpdesk";
import { listForecastLeads, summarizeForecast } from "./pipelines";
import { npsFromScores } from "./surveyTypes";
import { contactName } from "./format";

/**
 * The areas DAX could not see (Sean, 2026-11-13: "no lookups for the help desk, marketing campaigns, forecast,
 * surveys or referrals, so DAX can't answer 'which tickets are overdue' or 'how did last week's campaign do'").
 *
 * One read-only lookup each. EACH ONE IS HELD TO ITS PAGE'S OWN RULE — the same permission and module the page
 * checks, and the page's own query where there is one (help desk: listTickets; forecast: listForecastLeads and its
 * scope filter) — so DAX never shows more than the person could open. The workspace is named in every other query.
 * Nothing here is logged.
 */

type Output = { rows: { label: string; detail: string; href: string }[]; data: unknown[]; truncated: boolean };
const DAY = 86_400_000;
const HOUR = 3_600_000;
const unavailable = (why: string): Output => ({ rows: [], data: [{ note: why }], truncated: false });
const clip = (s: string | null | undefined, max: number) => {
  const text = (s ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
/** A day range in South Africa, `to` inclusive; `days` back from today when no dates are given. */
function range(args: { from?: string; to?: string }, days: number): { from: Date; to: Date; label: string } {
  const from = args.from ? new Date(`${args.from}T00:00:00+02:00`) : new Date(Date.now() - days * DAY);
  const to = args.to ? new Date(new Date(`${args.to}T00:00:00+02:00`).getTime() + DAY) : new Date();
  return { from, to, label: args.from || args.to ? `${args.from ?? "start"} to ${args.to ?? "today"}` : `the last ${days} days` };
}

/* ── help desk ───────────────────────────────────────────────────────────── */

/** A customer waiting on us longer than this is "overdue": tickets carry no deadline of their own. */
export const TICKET_REPLY_HOURS = 24;
const CLOSED = new Set(["resolved", "closed", "cancelled"]);

export async function ticketsLookup(user: PermissionUser, args: { mine?: boolean; limit?: number }): Promise<Output> {
  if (!(await isModuleEnabled("support"))) return unavailable("The help desk is switched off in this workspace.");
  if (!(await hasAnyPermission(user, "cases.view_all", "cases.view_owned"))) return unavailable("This person can't open the help desk.");
  // The help desk page's own query: the tickets this person may see, most urgent first.
  const all = await listTickets(user, args.mine ? { assignee: "me" } : {});
  const open = all.filter((t) => !CLOSED.has(t.status));
  const now = Date.now();
  const waitingHours = (t: (typeof all)[number]) => (t.lastReplyBy === "customer" && t.lastMessageAt ? (now - t.lastMessageAt.getTime()) / HOUR : 0);
  const awaiting = open.filter((t) => t.lastReplyBy === "customer" && !(t.snoozedUntil && t.snoozedUntil.getTime() > now));
  const overdue = awaiting.filter((t) => waitingHours(t) >= TICKET_REPLY_HOURS).sort((a, b) => waitingHours(b) - waitingHours(a));
  const take = Math.min(args.limit ?? 10, 25);
  const row = (t: (typeof all)[number]) => ({
    ticket: `C-${t.number.toString()}`,
    subject: clip(t.subject, 120),
    customer: t.contactName,
    status: t.status.replaceAll("_", " "),
    priority: t.priority,
    assignedTo: t.assigneeName ?? "nobody",
    ...(t.lastReplyBy === "customer" && t.lastMessageAt ? { customerWaitingHours: Math.round(waitingHours(t)) } : {}),
    lastMessage: clip(t.lastPreview, 140),
    link: `/cases/${t.id}`,
  });
  const listed = [...overdue, ...open.filter((t) => !overdue.includes(t))].slice(0, take);
  return {
    truncated: open.length > take,
    data: [{
      ...(args.mine ? { only: "tickets assigned to this person" } : {}),
      open: open.length,
      waitingOnUs: awaiting.length,
      overdue: overdue.length,
      overdueMeans: `a customer has been waiting on our reply for ${TICKET_REPLY_HOURS} hours or more (tickets have no deadline of their own; snoozed ones are left out)`,
      urgentOrHigh: open.filter((t) => t.priority === "urgent" || t.priority === "high").length,
      unassigned: open.filter((t) => !t.assigneeId).length,
      tickets: listed.map(row),
    }],
    rows: listed.map((t) => ({ label: `C-${t.number.toString()} · ${clip(t.subject, 60)}`, detail: `${t.contactName} · ${t.status.replaceAll("_", " ")}`, href: `/cases/${t.id}` })),
  };
}

/* ── campaigns ───────────────────────────────────────────────────────────── */

export async function campaignsLookup(user: PermissionUser, args: { from?: string; to?: string; name?: string; limit?: number }): Promise<Output> {
  void user; // The campaigns page is open to every signed-in member of the workspace, with Marketing on.
  if (!(await isModuleEnabled("marketing"))) return unavailable("Marketing is switched off in this workspace.");
  const period = range(args, 30);
  const take = Math.min(args.limit ?? 10, 25);
  const campaigns = await prisma.campaign.findMany({
    where: {
      tenantId: ownedWriteTenantId(),
      archivedAt: null,
      ...(args.name ? { name: { contains: args.name.trim(), mode: "insensitive" as const } } : { sentAt: { gte: period.from, lt: period.to } }),
    },
    orderBy: [{ sentAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    take: take + 1,
    select: { id: true, name: true, channel: true, status: true, audience: true, recipientCount: true, sentCount: true, failedCount: true, openCount: true, clickCount: true, sentAt: true, scheduledFor: true },
  });
  const page = campaigns.slice(0, take);
  const rate = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}%` : null);
  if (!page.length) return { rows: [], truncated: false, data: [{ period: args.name ? `named "${args.name}"` : period.label, found: 0, note: "No campaign was sent then." }] };
  return {
    truncated: campaigns.length > take,
    data: [{
      period: args.name ? `named "${args.name}"` : period.label,
      note: "Opens and clicks are unique recipients. An email open is detected by a tracking image, so some opens are never seen; SMS has no opens.",
      campaigns: page.map((c) => ({
        name: c.name,
        channel: c.channel,
        status: c.status,
        sent: day(c.sentAt) ?? (c.scheduledFor ? `scheduled for ${day(c.scheduledFor)}` : "not sent"),
        audience: clip(c.audience, 80),
        recipients: c.recipientCount,
        delivered: c.sentCount,
        failed: c.failedCount,
        ...(c.channel === "email" ? { opened: c.openCount, openRate: rate(c.openCount, c.sentCount) } : {}),
        clicked: c.clickCount,
        clickRate: rate(c.clickCount, c.sentCount),
        link: `/campaigns/${c.id}`,
      })),
    }],
    rows: page.map((c) => ({ label: c.name, detail: `${c.channel} · ${day(c.sentAt) ?? c.status} · ${c.sentCount} sent`, href: `/campaigns/${c.id}` })),
  };
}

/* ── forecast ────────────────────────────────────────────────────────────── */

export async function forecastLookup(user: PermissionUser, args: { period?: string }): Promise<Output> {
  if (!(await hasAnyPermission(user, "forecast.view", "forecast.manage"))) return unavailable("This person can't open the forecast.");
  const period = args.period && /^\d{4}-\d{2}$/.test(args.period) ? args.period : new Date().toISOString().slice(0, 7);
  const [year, month] = period.split("-").map(Number);
  // The forecast page's own query (workspace-bounded inside it) and its own visibility rule.
  const [scope, all] = await Promise.all([
    getAccessibleLeadScope(user),
    listForecastLeads({ closeFrom: new Date(Date.UTC(year, month - 1, 1)), closeTo: new Date(Date.UTC(year, month, 1)) }),
  ]);
  const leads = scope.viewAll ? all : all.filter((l) => l.assignedToId === scope.userId || Boolean(l.teamId && scope.teamIds.includes(l.teamId)));
  const s = summarizeForecast(leads);
  const top = [...leads].sort((a, b) => b.valueCents - a.valueCents).slice(0, 10);
  const rands = (cents: number) => Math.round(cents / 100);
  return {
    truncated: leads.length > top.length,
    data: [{
      period,
      deals: s.count,
      valuesIn: "rands, the base currency (deals in another currency are counted but not added)",
      open: rands(s.openValueCents),
      weighted: rands(s.weightedValueCents),
      commit: rands(s.commitValueCents),
      bestCase: rands(s.bestCaseValueCents),
      pipeline: rands(s.pipelineValueCents),
      ...(s.otherCurrencies.length ? { otherCurrencies: s.otherCurrencies } : {}),
      note: "Deals expected to close in that month. Weighted = each deal's value × its probability. Commit = the deals marked most likely.",
      biggest: top.map((l) => ({
        deal: `${l.name} — ${l.title}`,
        value: rands(l.valueCents),
        ...(l.currency ? { currency: l.currency } : {}),
        probability: `${l.probability}%`,
        category: l.forecastCategory.replace("_", " "),
        expectedClose: day(l.expectedCloseDate),
        stage: l.stageName,
        owner: l.assignedToName ?? "unassigned",
        link: `/leads/${l.id}`,
      })),
    }],
    rows: top.map((l) => ({ label: `${l.name} — ${l.title}`, detail: `${l.forecastCategory.replace("_", " ")} · ${l.probability}% · ${day(l.expectedCloseDate) ?? "no date"}`, href: `/leads/${l.id}` })),
  };
}

/* ── surveys ─────────────────────────────────────────────────────────────── */

export async function surveysLookup(user: PermissionUser, args: { from?: string; to?: string; survey?: string }): Promise<Output> {
  if (!(await isModuleEnabled("marketing"))) return unavailable("Marketing (surveys) is switched off in this workspace.");
  if (!(await hasAnyPermission(user, "surveys.view", "surveys.manage"))) return unavailable("This person can't open surveys.");
  const period = range(args, 30);
  const tenantId = ownedWriteTenantId();
  const surveys = await prisma.survey.findMany({
    where: { tenantId, deletedAt: null, archivedAt: null, ...(args.survey ? { title: { contains: args.survey.trim(), mode: "insensitive" as const } } : {}) },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true, title: true, type: true, status: true,
      responses: {
        where: { tenantId, sentAt: { gte: period.from, lt: period.to } },
        select: { status: true, score: true, comment: true, name: true, completedAt: true },
      },
    },
  });
  const withAny = surveys.filter((s) => s.responses.length > 0);
  if (!withAny.length) return { rows: [], truncated: false, data: [{ period: period.label, found: 0, note: "No survey was sent in that period." }] };
  const low = (type: string, score: number) => (type === "nps" ? score <= 6 : score <= 2);
  return {
    truncated: false,
    data: [{
      period: period.label,
      note: "NPS runs from −100 to +100 (promoters 9–10 minus detractors 0–6). Other surveys score 1–5. Comments are the customer's own words.",
      surveys: withAny.map((s) => {
        const done = s.responses.filter((r) => r.status === "completed");
        const scores = done.map((r) => r.score).filter((n): n is number => n !== null);
        const average = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null;
        const unhappy = done
          .filter((r) => r.score !== null && low(s.type, r.score))
          .sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0))
          .slice(0, 5);
        return {
          survey: s.title,
          type: s.type,
          sent: s.responses.length,
          answered: done.length,
          responseRate: `${Math.round((done.length / s.responses.length) * 100)}%`,
          ...(s.type === "nps" ? { nps: npsFromScores(scores) } : { averageScore: average }),
          unhappy: unhappy.map((r) => ({ who: r.name ?? "a customer", score: r.score, when: day(r.completedAt), ...(r.comment ? { said: clip(r.comment, 200) } : {}) })),
          link: `/surveys/${s.id}`,
        };
      }),
    }],
    rows: withAny.map((s) => ({ label: s.title, detail: `${s.responses.filter((r) => r.status === "completed").length}/${s.responses.length} answered`, href: `/surveys/${s.id}` })),
  };
}

/* ── referrals ───────────────────────────────────────────────────────────── */

export async function referralsLookup(user: PermissionUser, args: { from?: string; to?: string; status?: "pending" | "earned" | "redeemed" }): Promise<Output> {
  void user; // The referrals page is open to every signed-in member of the workspace, with Marketing on.
  if (!(await isModuleEnabled("marketing"))) return unavailable("Marketing (referrals) is switched off in this workspace.");
  const period = range(args, 90);
  const referrals = await prisma.referral.findMany({
    where: { tenantId: ownedWriteTenantId(), createdAt: { gte: period.from, lt: period.to }, ...(args.status ? { status: args.status } : {}) },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true, status: true, createdAt: true, earnedAt: true, redeemedAt: true, redeemedNote: true, referrerId: true,
      referrer: { select: { firstName: true, lastName: true, company: true } },
      lead: { select: { id: true, name: true, title: true, status: true } },
    },
  });
  if (!referrals.length) return { rows: [], truncated: false, data: [{ period: period.label, found: 0, note: "No referrals came in then." }] };
  const by = new Map<string, { name: string; count: number; earned: number }>();
  for (const r of referrals) {
    const entry = by.get(r.referrerId) ?? { name: contactName(r.referrer) || r.referrer.company || "a customer", count: 0, earned: 0 };
    entry.count += 1;
    if (r.status !== "pending") entry.earned += 1;
    by.set(r.referrerId, entry);
  }
  const latest = referrals.slice(0, 15);
  return {
    truncated: referrals.length > latest.length,
    data: [{
      period: period.label,
      total: referrals.length,
      pending: referrals.filter((r) => r.status === "pending").length,
      earnedNotRedeemed: referrals.filter((r) => r.status === "earned").length,
      redeemed: referrals.filter((r) => r.status === "redeemed").length,
      note: "Pending: the referred person hasn't bought yet. Earned: they bought, the reward is owed. Redeemed: the reward was given.",
      topReferrers: [...by.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 5).map(([id, v]) => ({ name: v.name, referrals: v.count, converted: v.earned, link: `/contacts/${id}` })),
      latest: latest.map((r) => ({
        referrer: contactName(r.referrer) || r.referrer.company || "a customer",
        referred: r.lead ? `${r.lead.name} — ${r.lead.title} (${r.lead.status})` : "not a lead yet",
        status: r.status,
        when: day(r.createdAt),
        ...(r.redeemedNote ? { reward: clip(r.redeemedNote, 80) } : {}),
      })),
    }],
    rows: [{ label: "Referrals", detail: `${referrals.length} in ${period.label}`, href: "/referrals" }],
  };
}
