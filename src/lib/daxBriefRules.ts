import type { AttentionSignal } from "./attention/score";
import { agoPhrase, calendarDaysAgo } from "./leadScore";
import { johannesburgDateKey } from "./activityDay";
import { redactForLog } from "./redactLog";

/**
 * The DAX daily brief — the PURE half. No database and no `server-only`, so the
 * tests drive it directly; `daxBrief.ts` is the loader that feeds it.
 *
 * ── DETERMINISTIC, NOT AN LLM ────────────────────────────────────────────────────
 *
 * "Six things need your attention" has to be TRUE every time it is shown. A
 * model asked to summarise the CRM can miscount, drop the customer who has been
 * waiting longest, or invent urgency; a rule cannot. So the brief is plain CRM
 * logic over facts the existing lists already compute (the Attention Centre, the
 * Today queue, the deliveries board's stage rule), and DAX is handed the result
 * to reason ABOUT rather than asked to produce it.
 *
 * ── THE ORDER IS SEAN'S ──────────────────────────────────────────────────────
 *
 * 1 customers waiting for a reply, 2 today's meetings and test drives, 3 overdue
 * commitments, 4 hot opportunities, 5 quotes needing attention, 6 operational
 * problems, 7 stale deals worth recovering. It is a fixed list rather than a
 * score because it is a policy somebody stated, and a weighted sum would let
 * three stale deals outrank one waiting customer — the exact mistake it exists
 * to prevent.
 *
 * Within a group the named example is the highest-value lead when values differ
 * (so the R180k stalled deal is named, not a small one). Waiting customers are
 * the exception: the longest wait is named, because that is the policy.
 */

export type BriefTone = "red" | "orange" | "green" | "info";

export type BriefItem = {
  key: string;
  tone: BriefTone;
  emoji: string;
  title: string;
  detail?: string;
  href: string;
  count?: number;
  valueCents?: number;
};

/** One salesperson in the team view. */
export type TeamRow = {
  userId: string;
  name: string;
  /** Leads with an overdue follow-up. */
  overdue: number;
  /** Leads where a customer is waiting on a reply. */
  waiting: number;
  /** Value of leads past their stage's age limit. */
  stalledValueCents: number;
  /** Value of every open lead they own that the viewer can see. */
  pipelineValueCents: number;
};

export type DaxBrief = {
  /** With the greeting — for DAX and anywhere the page has not already said hello. */
  headline: string;
  /** Without it — for the home card, which sits under a greeting of its own. */
  summary: string;
  items: BriefItem[];
  attentionValueCents: number;
  team?: TeamRow[];
};

/** The Attention Centre's lead, narrowed to what the brief reads. `AttentionLead` fits it. */
export type BriefLead = {
  id: string;
  name: string;
  valueCents: number;
  ownerId: string | null;
  ownerName: string | null;
  signals: Pick<AttentionSignal, "kind" | "detail" | "since" | "actionHref">[];
};

/** A Today-queue lead, narrowed. `TodayLead` fits it. */
export type HotLead = { id: string; name: string; valueCents: number; reasons: string[] };

export type ViewedQuote = { id: string; number: number; leadId: string | null; leadName: string; viewedAt: Date };

export type DeliveryQuote = {
  id: string;
  number: number;
  customer: string;
  invoicedAt: Date | null;
  depositPaidAt: Date | null;
  deliveryScheduledFor: Date | null;
  deliveredAt: Date | null;
};

export type BriefInput = {
  now: Date;
  userId: string;
  userName: string;
  /** Every attention lead the viewer can see; the brief narrows to theirs. */
  leads: BriefLead[];
  /** The viewer's own Today queue, best first. */
  hot: HotLead[];
  /** Today's planned activities that are theirs (never test-drive activities — see below). */
  activities: { type: string; dueDate: Date }[];
  testDrives: { scheduledStart: Date; vehicle: string | null }[];
  viewedQuotes: ViewedQuote[];
  /** Accepted, undelivered quotes. Empty when deliveries are off or not theirs to see. */
  deliveries: DeliveryQuote[];
  team?: TeamRow[];
};

/** Enough to read at a glance; the rest is one click away on /today. */
export const MAX_BRIEF_ITEMS = 7;
export const MAX_TEAM_ROWS = 8;

const SA_TZ = "Africa/Johannesburg";

export function greetingFor(now: Date): string {
  const hour = Number(now.toLocaleString("en-ZA", { hour: "2-digit", hour12: false, timeZone: SA_TZ }));
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

/** "14:00", South African time. */
function clock(at: Date): string {
  return at.toLocaleTimeString("en-ZA", { timeZone: SA_TZ, hour: "2-digit", minute: "2-digit", hour12: false });
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The deliveries board's own column rule (deliveries/page.tsx `colOf`, copied
 * by crmAssistant's `deliveries()` too), so the brief and the board agree on
 * what "overdue" means.
 */
export function deliveryStage(q: DeliveryQuote, todayStart: Date): string {
  if (q.deliveredAt) return "delivered";
  if (!q.invoicedAt) return "to_invoice";
  if (!q.depositPaidAt) return "awaiting_deposit";
  if (!q.deliveryScheduledFor) return "to_schedule";
  return q.deliveryScheduledFor < todayStart ? "overdue" : "scheduled";
}

/**
 * "Looks close" = the customer is engaging NOW: opened the quote recently, or
 * replied and we answered. Matched on the Today queue's own reason sentences
 * (leadScore.ts) so there is one definition of warm; the test pins the match to
 * `scoreLead`'s real output so a reworded reason fails loudly rather than
 * quietly emptying this group.
 */
export function hotReason(reasons: string[]): string | null {
  return reasons.find((r) => r.startsWith("Opened the quote") || r.startsWith("Replied ")) ?? null;
}

type Row = { leadId: string | null; name: string; detail: string; href: string; valueCents: number };

/**
 * One line per group: the count, and the top example named.
 *
 * The named example is the highest-value row when any row has a value; otherwise
 * the first row (the one the caller sorted to the front — longest wait for
 * waiting customers, soonest expiry, etc.). Group order itself is never changed.
 */
function group(
  key: string,
  tone: BriefTone,
  emoji: string,
  rows: Row[],
  title: (n: number) => string,
  listHref: string,
): BriefItem | null {
  if (rows.length === 0) return null;
  const hasValue = rows.some((r) => r.valueCents > 0);
  const top = hasValue
    ? rows.reduce((best, row) => (row.valueCents > best.valueCents ? row : best), rows[0])
    : rows[0];
  return {
    key,
    tone,
    emoji,
    title: title(rows.length),
    detail: `${top.name} — ${top.detail}`,
    // One thing → straight to it. Several → the list that holds them all.
    href: rows.length === 1 ? top.href : listHref,
    count: rows.length,
    valueCents: rows.reduce((sum, row) => sum + row.valueCents, 0),
  };
}

/** Every lead carrying `kind`, with that signal's own sentence and link. */
function signalRows(leads: BriefLead[], kind: AttentionSignal["kind"]): (Row & { since: string })[] {
  const rows: (Row & { since: string })[] = [];
  for (const lead of leads) {
    const signal = lead.signals.find((s) => s.kind === kind);
    if (!signal) continue;
    rows.push({
      leadId: lead.id,
      name: lead.name,
      detail: signal.detail,
      href: signal.actionHref,
      valueCents: lead.valueCents,
      since: signal.since ?? "",
    });
  }
  return rows;
}

/** Oldest first: the customer who has waited longest is the one to name. */
const oldestFirst = (a: { since: string }, b: { since: string }) => a.since.localeCompare(b.since);

export function buildBrief(input: BriefInput): DaxBrief {
  const { now, userId } = input;
  // "Mine": theirs, plus the unassigned ones nobody else will pick up.
  const mine = input.leads.filter((lead) => lead.ownerId === userId || lead.ownerId === null);

  const waiting = signalRows(mine, "unanswered_inbound").sort(oldestFirst);
  const overdue = signalRows(mine, "overdue_task").sort(oldestFirst);
  // ISO `since` is `validUntil` here, so oldest-first is soonest-to-expire first.
  const expiring = signalRows(mine, "quote_expiring").sort(oldestFirst);
  const stale = signalRows(mine, "stage_age").sort((a, b) => b.valueCents - a.valueCents);

  // A customer already waiting on a reply is item 1; naming them again as
  // "looks close" would count one person twice.
  const waitingIds = new Set(waiting.map((row) => row.leadId));
  const hot: Row[] = [];
  for (const lead of input.hot) {
    const reason = hotReason(lead.reasons);
    if (!reason || waitingIds.has(lead.id)) continue;
    hot.push({ leadId: lead.id, name: lead.name, detail: reason, href: `/leads/${lead.id}`, valueCents: lead.valueCents });
  }
  // Highest value first so the named example in a "looks close" group is the bigger deal.
  hot.sort((a, b) => b.valueCents - a.valueCents);

  // Already said by "looks close" or "expiring" — once is enough.
  const said = new Set([...hot, ...expiring].map((row) => row.leadId));
  const viewed: Row[] = input.viewedQuotes
    .filter((q) => !q.leadId || !said.has(q.leadId))
    .map((q) => ({
      leadId: q.leadId,
      name: q.leadName,
      detail: `opened Q-${q.number} ${agoPhrase(calendarDaysAgo(q.viewedAt, now))}, not signed`,
      href: `/quotes/${q.id}`,
      valueCents: 0,
    }));

  const todayStart = new Date(`${johannesburgDateKey(now)}T00:00:00+02:00`);
  const deliveryRows = (stage: string): Row[] =>
    input.deliveries
      .filter((q) => deliveryStage(q, todayStart) === stage)
      .map((q) => ({ leadId: null, name: `Q-${q.number}`, detail: q.customer, href: "/deliveries", valueCents: 0 }));

  const groups = [
    group("waiting", "red", "🔴", waiting, (n) => plural(n, "customer waiting for a reply", "customers waiting for a reply"), "/inbox"),
    agendaItem(input, now),
    group("overdue", "orange", "🟠", overdue, (n) => plural(n, "overdue follow-up", "overdue follow-ups"), "/leads/attention"),
    group("hot", "green", "🔥", hot, (n) => (n === 1 ? "1 deal looks close" : `${n} deals look close`), "/today"),
    group("quote_expiring", "orange", "🟠", expiring, (n) => plural(n, "quote expiring", "quotes expiring"), "/leads/attention"),
    group("quote_viewed", "info", "👀", viewed, (n) => plural(n, "quote opened but not signed", "quotes opened but not signed"), "/quotes"),
    group("delivery_overdue", "orange", "🚚", deliveryRows("overdue"), (n) => plural(n, "delivery overdue", "deliveries overdue"), "/deliveries"),
    group("awaiting_deposit", "info", "💰", deliveryRows("awaiting_deposit"), (n) => plural(n, "delivery awaiting deposit", "deliveries awaiting deposit"), "/deliveries"),
    group("stale", "info", "💤", stale, (n) => plural(n, "stale deal worth recovering", "stale deals worth recovering"), "/leads/attention"),
  ].filter((item): item is BriefItem => item !== null);

  // Counted BEFORE the cap, so the number stays honest when the list is cut.
  // Only red and orange count: a meeting or a warm deal is good news, not a problem.
  const urgent = groups
    .filter((item) => item.tone === "red" || item.tone === "orange")
    .reduce((sum, item) => sum + (item.count ?? 1), 0);
  const summary =
    urgent > 0
      ? `${plural(urgent, "thing needs", "things need")} your attention.`
      : groups.length > 0
        ? "Nothing urgent right now."
        : "Nothing urgent, a clean slate.";
  const firstName = input.userName.split(/\s+/)[0];

  // Each lead once, however many groups it appears in.
  const attentionLeads = new Map<string, number>();
  for (const row of [...waiting, ...overdue, ...expiring, ...stale]) {
    if (row.leadId) attentionLeads.set(row.leadId, row.valueCents);
  }

  return {
    headline: `${greetingFor(now)} ${firstName} — ${summary[0].toLowerCase()}${summary.slice(1)}`,
    summary,
    items: groups.slice(0, MAX_BRIEF_ITEMS),
    attentionValueCents: [...attentionLeads.values()].reduce((sum, v) => sum + v, 0),
    ...(input.team ? { team: input.team } : {}),
  };
}

/**
 * "Today: 2 meetings, 1 test drive (14:00 Rover XL)". What is still AHEAD today:
 * a 09:00 meeting read at 15:00 is either done or overdue, and overdue has its
 * own line. Test drives come from bookings (vehicle name and all), which is why
 * the loader leaves out their calendar activities — counting both would double
 * every drive.
 */
function agendaItem(input: BriefInput, now: Date): BriefItem | null {
  const ahead = input.activities.filter((a) => a.dueDate >= now);
  const drives = input.testDrives.filter((t) => t.scheduledStart >= now);
  const meetings = ahead.filter((a) => a.type === "meeting").length;
  const other = ahead.length - meetings;
  const parts: string[] = [];
  if (meetings) parts.push(plural(meetings, "meeting", "meetings"));
  if (drives.length) {
    const next = drives[0];
    parts.push(`${plural(drives.length, "test drive", "test drives")} (${clock(next.scheduledStart)}${next.vehicle ? ` ${next.vehicle}` : ""})`);
  }
  if (other) parts.push(plural(other, "other task", "other tasks"));
  if (parts.length === 0) return null;
  return {
    key: "today",
    tone: "info",
    emoji: "📅",
    title: `Today: ${parts.join(", ")}`,
    href: "/calendar",
    count: ahead.length + drives.length,
  };
}

/**
 * The manager's view: per salesperson, what is slipping. Built from the same
 * permission-scoped attention list and pipeline totals, so it can never count a
 * deal the viewer could not open. `members` null = everyone (an owner).
 */
export function buildTeamRows(input: {
  leads: BriefLead[];
  pipeline: { ownerId: string; valueCents: number }[];
  names: Map<string, string>;
  members: Set<string> | null;
}): TeamRow[] {
  const rows = new Map<string, TeamRow>();
  const row = (userId: string, fallbackName: string | null): TeamRow => {
    let found = rows.get(userId);
    if (!found) {
      found = {
        userId,
        name: input.names.get(userId) ?? fallbackName ?? "Unnamed",
        overdue: 0,
        waiting: 0,
        stalledValueCents: 0,
        pipelineValueCents: 0,
      };
      rows.set(userId, found);
    }
    return found;
  };
  const inTeam = (id: string | null): id is string => id !== null && (input.members === null || input.members.has(id));

  for (const lead of input.leads) {
    if (!inTeam(lead.ownerId)) continue;
    const r = row(lead.ownerId, lead.ownerName);
    if (lead.signals.some((s) => s.kind === "overdue_task")) r.overdue += 1;
    if (lead.signals.some((s) => s.kind === "unanswered_inbound")) r.waiting += 1;
    if (lead.signals.some((s) => s.kind === "stage_age")) r.stalledValueCents += lead.valueCents;
  }
  for (const p of input.pipeline) {
    if (inTeam(p.ownerId)) row(p.ownerId, null).pipelineValueCents += p.valueCents;
  }

  // Most needing attention first — in the brief's own order: waiting customers,
  // then missed commitments, then money going stale.
  return [...rows.values()]
    .filter((r) => r.overdue || r.waiting || r.stalledValueCents || r.pipelineValueCents)
    .sort(
      (a, b) =>
        b.waiting - a.waiting ||
        b.overdue - a.overdue ||
        b.stalledValueCents - a.stalledValueCents ||
        b.pipelineValueCents - a.pipelineValueCents,
    )
    .slice(0, MAX_TEAM_ROWS);
}

/**
 * The brief as DAX's lookup sees it. Names stay (they are how a person asks
 * about a deal), but a lead created from an inbound WhatsApp is often NAMED by
 * its phone number, so every string goes through the log redactor on the way
 * to the model.
 */
export function briefForAssistant(brief: DaxBrief) {
  const clean = redactForLog;
  return {
    headline: clean(brief.headline),
    attentionValueCents: brief.attentionValueCents,
    items: brief.items.map((item) => ({
      title: clean(item.title),
      ...(item.detail ? { detail: clean(item.detail) } : {}),
      // `link`, the name every lookup uses, so DAX can cite the item (assistantReply).
      link: item.href,
      ...(item.count ? { count: item.count } : {}),
      ...(item.valueCents ? { valueCents: item.valueCents } : {}),
    })),
    ...(brief.team
      ? {
          team: brief.team.map((r) => ({
            name: clean(r.name),
            waiting: r.waiting,
            overdue: r.overdue,
            stalledValueCents: r.stalledValueCents,
            pipelineValueCents: r.pipelineValueCents,
          })),
        }
      : {}),
  };
}
