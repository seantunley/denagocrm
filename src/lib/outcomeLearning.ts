import "server-only";
import { prisma } from "./db";
import { getWorkspaceSetting, putWorkspaceSetting } from "./settings";
import { logAudit } from "./audit";
import { applyLearn } from "./assistantMemoryStore";
import { isModuleEnabled } from "./modules/enabled";
import {
  PLAYBOOK_DESCRIPTION,
  dealFacts,
  findHabits,
  playbookName,
  playbookText,
  replyTiming,
  type MessageFact,
  type Touch,
} from "./outcomeLearningRules";

/**
 * LEARNING FROM OUTCOMES, against the database (rules in outcomeLearningRules.ts). Once a week per workspace, from
 * the research cron that already runs the nightly tidy-up: read the deals closed in the last 180 days, work out what
 * the won ones did more often, and file it as a playbook PROPOSAL — unreviewed, written by nobody (createdById null),
 * so it reaches no one's DAX until the owner approves it in Settings → Assistant. No model call: database reads only.
 *
 * Its own switch, on by default (it costs a few reads a week and sends nothing to anyone). The workspace is named in
 * every query. Nothing about a customer or a message leaves this file — only counts.
 */

export const OUTCOME_LEARNING_KEY = "ASSISTANT_OUTCOME_LEARNING";
export const OUTCOME_LEARNING_LAST_KEY = "ASSISTANT_OUTCOME_LEARNING_LAST";
export const OUTCOME_LEARNING_SUMMARY_KEY = "ASSISTANT_OUTCOME_LEARNING_SUMMARY";
export const WINDOW_DAYS = 180;
const DAY = 86_400_000;
const EVERY_MS = 7 * DAY;
const REPLY_WITHIN_MS = 2 * DAY;
// ponytail: one read of up to this many closed deals and their history; batch by month if a workspace closes more.
const MAX_DEALS = 2000;
const TOUCH_CHANNELS = ["call", "email", "whatsapp", "meeting"];

export const outcomeLearningOn = (value: string | null) => value !== "off";

/** Johannesburg's hour of the day (UTC+2 all year). */
const saHour = (at: Date) => (at.getUTCHours() + 2) % 24;

/** The closed deals' facts, and every outbound message on them with whether it was answered. */
export async function closedDealFacts(tenantId: string, now = new Date()) {
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY);
  const leads = await prisma.lead.findMany({
    where: { tenantId, deletedAt: null, OR: [{ status: "won", wonAt: { gte: since } }, { status: "lost", lostAt: { gte: since } }] },
    select: { id: true, status: true, createdAt: true, wonAt: true, lostAt: true },
    orderBy: { createdAt: "desc" },
    take: MAX_DEALS,
  });
  if (!leads.length) return { deals: [], messages: [] as MessageFact[] };
  const leadIds = leads.map((l) => l.id);
  const [comms, activities, quotes] = await Promise.all([
    prisma.communication.findMany({
      where: { tenantId, leadId: { in: leadIds }, type: { in: TOUCH_CHANNELS } },
      select: { leadId: true, type: true, direction: true, occurredAt: true },
    }),
    prisma.activity.findMany({
      where: { tenantId, leadId: { in: leadIds }, status: "done", doneAt: { not: null }, type: { in: TOUCH_CHANNELS } },
      select: { leadId: true, type: true, doneAt: true },
    }),
    prisma.quote.findMany({ where: { tenantId, leadId: { in: leadIds }, deletedAt: null }, select: { id: true, leadId: true, viewedAt: true } }),
  ]);
  // A quote went out when its signing request did (the first one, if there were several).
  const sends = quotes.length
    ? await prisma.signatureRequest.findMany({
        where: { tenantId, quoteId: { in: quotes.map((q) => q.id) }, sentAt: { not: null } },
        select: { quoteId: true, sentAt: true },
      })
    : [];

  const earliest = (dates: (Date | null | undefined)[]) =>
    dates.filter((d): d is Date => Boolean(d)).reduce<Date | null>((a, d) => (!a || d < a ? d : a), null);
  const deals = leads.map((lead) => {
    const outbound = comms.filter((c) => c.leadId === lead.id && c.direction !== "inbound");
    const touches: Touch[] = [
      ...outbound.map((c) => ({ at: c.occurredAt, channel: c.type })),
      ...activities.filter((a) => a.leadId === lead.id).map((a) => ({ at: a.doneAt!, channel: a.type })),
    ];
    const ownQuotes = quotes.filter((q) => q.leadId === lead.id);
    const ownQuoteIds = new Set(ownQuotes.map((q) => q.id));
    return dealFacts({
      won: lead.status === "won",
      createdAt: lead.createdAt,
      closedAt: (lead.status === "won" ? lead.wonAt : lead.lostAt) ?? now,
      touches,
      quoteSentAt: earliest(sends.filter((s) => s.quoteId && ownQuoteIds.has(s.quoteId)).map((s) => s.sentAt)),
      quoteViewedAt: earliest(ownQuotes.map((q) => q.viewedAt)),
    });
  });

  // Messages (email / WhatsApp) staff sent, and whether the customer wrote back within two days.
  const inbound = new Map<string, number[]>();
  for (const c of comms) if (c.direction === "inbound" && c.leadId) inbound.set(c.leadId, [...(inbound.get(c.leadId) ?? []), c.occurredAt.getTime()]);
  const messages: MessageFact[] = comms
    .filter((c) => c.direction === "outbound" && (c.type === "email" || c.type === "whatsapp"))
    .map((m) => {
      const at = m.occurredAt.getTime();
      return { saHour: saHour(m.occurredAt), replied: (inbound.get(m.leadId ?? "") ?? []).some((t) => t > at && t - at <= REPLY_WITHIN_MS) };
    });
  return { deals, messages };
}

/**
 * Work it out and file the proposal. Not due (a week since the last), switched off, or nothing clear enough: no
 * playbook. `force` is the owner's "Check now". Returns what it says in Settings, or null when it didn't run.
 */
export async function runOutcomeLearning(tenantId: string, opts: { force?: boolean; now?: Date } = {}): Promise<string | null> {
  const now = opts.now ?? new Date();
  // DAX is part of the Automation module, like the tidy-up.
  if (!(await isModuleEnabled("automation"))) return null;
  if (!outcomeLearningOn(await getWorkspaceSetting(tenantId, OUTCOME_LEARNING_KEY))) return null;
  if (!opts.force) {
    const last = await getWorkspaceSetting(tenantId, OUTCOME_LEARNING_LAST_KEY);
    if (last && now.getTime() - new Date(last).getTime() < EVERY_MS) return null;
  }
  // Claim the week first: a failed run must not retry every 30 minutes.
  await putWorkspaceSetting(tenantId, OUTCOME_LEARNING_LAST_KEY, now.toISOString());

  const { deals, messages } = await closedDealFacts(tenantId, now);
  const text = playbookText(findHabits(deals), replyTiming(messages), WINDOW_DAYS);
  const won = deals.filter((d) => d.won).length;
  let summary: string;
  if (!text) {
    summary = `nothing clear enough yet (${won} won and ${deals.length - won} lost deals in the last ${WINDOW_DAYS} days)`;
  } else {
    const filed = await applyLearn(null, { playbook: [{ name: playbookName(now), description: PLAYBOOK_DESCRIPTION, content: text }] }, "outcomes");
    summary = filed
      ? `suggested a playbook from ${won} won and ${deals.length - won} lost deals — it's below, waiting for you`
      : "found habits, but the playbook couldn't be filed (this month's is already approved, or the playbook list is full)";
    if (filed) await logAudit({ action: "assistant.outcomes_learned", summary: "DAX suggested a playbook from won and lost deals", userName: "Assistant (learning from outcomes)" });
  }
  await putWorkspaceSetting(tenantId, OUTCOME_LEARNING_SUMMARY_KEY, summary);
  return summary;
}
