import "server-only";
import { prisma } from "./db";
import { logError } from "./errorLog";
import { logAudit } from "./audit";
import { assistantUserFor } from "./assistantUser";
import { isModuleEnabled } from "./modules/enabled";
import { canAccessContact, canAccessLead, canAccessQuote, hasAnyPermission, type PermissionUser } from "./permissions";
import { ownedWriteTenantId } from "./tenantWrite";
import { currentTenantScope } from "./tenantScope";
import { tenantOrigin } from "./tenantOrigin";
import { contactName } from "./format";
import { deliver, switchedOn } from "./proactive";
import { isQuietHour, nextMorning, proactiveText } from "./proactiveRules";
import {
  GOAL_KIND,
  blockerText,
  evaluateGoal,
  namesQuote,
  readGoalState,
  remindersOffText,
  startState,
  type GoalFacts,
  type GoalState,
} from "./assistantGoalRules";
import type { CronSliceContext } from "./tenantCron";

/*
 * DAX GOALS — the database half (the rules are assistantGoalRules.ts). Roadmap Phase 4b.
 *
 * A goal is an AssistantTask of kind "delivery_goal", the person's own, in their workspace. The assistant cron
 * checks each open one every half hour with plain queries — no model — AS the person: every pass re-checks the
 * row's workspace, that they still have the assistant and deliveries and may open the deal, and that the
 * Automotive module is on. Alerts go to that person only, through proactive DAX's own delivery (quiet hours, the
 * daily ceiling, WhatsApp); a goal never contacts the customer.
 *
 * ONE WRITER AT A TIME: each check locks the goal's row (SELECT … FOR UPDATE) and does everything — the new state,
 * the alerts, and on done / deal lost switching off the goal's own watches and DAX check-backs — in that ONE
 * transaction. A second cron pass waits on the lock, then finds the goal freshly checked (or finished) and does
 * nothing; an alert's (person, kind, record) key is unique besides, so nothing is told twice.
 *
 * NOT CLOSED BY THE 14-DAY RULE: a job sheet closes itself after 14 quiet days; a delivery goal stays live until
 * the cart is delivered, the deal is lost, or the person closes it — a delivery waiting three weeks for stock is
 * exactly what it should keep watching. Goals are kept out of the job-sheet list and the prompt (assistantTask.ts)
 * and shown in their own Ask-page section, with Off and Close.
 */

const DAY = 86_400_000;
/** A goal checked this recently is skipped: the cron beats every 30 minutes, so this is once per tick. */
const RECHECK_AFTER_MS = 20 * 60 * 1000;
const GOAL_CHECK_RESERVE_MS = 15_000;
/** ponytail: 100 open goals per workspace per tick, least recently worked on first; page through when a workspace follows more. */
const GOAL_BATCH = 100;
/** Per person — each can alert. */
export const MAX_OPEN_GOALS = 20;

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

const QUOTE_SELECT = {
  id: true, number: true, status: true, deletedAt: true, supersededAt: true,
  depositPaidAt: true, invoicedAt: true, deliveryScheduledFor: true, deliveredAt: true,
  leadId: true, contactId: true,
  lead: { select: { status: true, name: true } },
  contact: { select: { firstName: true, lastName: true } },
} as const;

/** The deal as the CRM holds it now → the goal's facts. Null when the quote is gone or was replaced by a revision. */
async function loadFacts(tenantId: string, quoteId: string) {
  const quote = await prisma.quote.findFirst({ where: { id: quoteId, tenantId }, select: QUOTE_SELECT });
  // ponytail: a revision ends the goal (the person starts one on the new quote); follow revisionOfId if that gets common.
  if (!quote || quote.deletedAt || quote.supersededAt) return null;
  const stock = await prisma.stockUnit.findMany({
    where: { tenantId, deletedAt: null, OR: [{ soldQuoteId: quote.id }, { reservations: { some: { quoteId: quote.id, status: "active" } } }] },
    select: { pdiStatus: true },
  });
  const facts: GoalFacts = {
    ref: `Q-${quote.number}`,
    depositPaid: Boolean(quote.depositPaidAt),
    invoiced: Boolean(quote.invoicedAt),
    stock,
    deliveryScheduledFor: quote.deliveryScheduledFor,
    delivered: Boolean(quote.deliveredAt),
    lost: quote.lead?.status === "lost" || quote.status === "declined" || quote.status === "cancelled",
  };
  return { quote, facts };
}

const customerOf = (q: { contact: { firstName: string; lastName: string | null } | null; lead: { name: string } | null }) =>
  (q.contact ? contactName(q.contact) : q.lead?.name) || "a customer";

export type StartGoalResult = { ok: true; id: string; title: string; next: string; existing: boolean } | { ok: false; error: string };

/**
 * The person asked DAX to keep an eye on a delivery (the Ask page). Inside their acting scope; the caller has
 * checked they may use the assistant. The quote is found as one THEY can open, in THEIR workspace.
 *
 * DEFAULT OFF PER PERSON: a goal's updates are proactive DAX's, so it needs both proactive switches on — the
 * owner's for the workspace and the person's own, which are off until switched on.
 */
export async function startDeliveryGoal(user: PermissionUser, quoteRef: string, now = new Date()): Promise<StartGoalResult> {
  const tenantId = ownedWriteTenantId();
  if (!(await isModuleEnabled("automotive"))) return { ok: false, error: "Deliveries are part of the Automotive module, which is off for this workspace." };
  if (!(await hasAnyPermission(user, "deliveries.view", "deliveries.manage"))) return { ok: false, error: "You don't have access to deliveries, so I can't follow one for you." };
  if (!(await switchedOn(tenantId, user.id))) {
    return { ok: false, error: "A goal tells you how a delivery is going the way proactive DAX does — switch proactive DAX on for yourself on this page first." };
  }
  const ref = String(quoteRef ?? "").trim().slice(0, 64);
  const number = /^Q?-?\s*(\d{1,9})$/i.exec(ref)?.[1];
  const found = ref
    ? await prisma.quote.findFirst({ where: { tenantId, deletedAt: null, ...(number ? { number: Number(number) } : { id: ref }) }, select: { id: true } })
    : null;
  if (!found || !(await canAccessQuote(user, found.id))) return { ok: false, error: "I can't find that quote among the ones you can open." };
  const loaded = await loadFacts(tenantId, found.id);
  if (!loaded) return { ok: false, error: "That quote was replaced by a newer version — follow the delivery on the new one." };
  const { quote, facts } = loaded;
  if (quote.status !== "accepted") return { ok: false, error: `${facts.ref} isn't accepted yet — a delivery goal starts once the customer has accepted it.` };
  if (facts.delivered) return { ok: false, error: `${facts.ref} is already delivered — there's nothing left to follow.` };
  if (facts.lost) return { ok: false, error: `${facts.ref}'s deal is lost — there's no delivery to follow.` };

  const state = startState(facts, now);
  const next = `Waiting on ${blockerText(state.blocker ?? "delivered", facts)}`;
  const title = `Delivery for ${customerOf(quote)} — ${facts.ref}`;
  const created = await prisma.$transaction(async (tx) => {
    // One goal per person per quote, and the cap: two clicks at once can't both pass.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`assistant-goals:${user.id}`})::bigint)`;
    const existing = await tx.assistantTask.findFirst({ where: { tenantId, userId: user.id, kind: GOAL_KIND, quoteId: quote.id, status: "open" }, select: { id: true, title: true, nextAction: true } });
    if (existing) return { ...existing, existing: true };
    if ((await tx.assistantTask.count({ where: { tenantId, userId: user.id, kind: GOAL_KIND, status: "open" } })) >= MAX_OPEN_GOALS) return null;
    const row = await tx.assistantTask.create({
      data: {
        tenantId, userId: user.id, kind: GOAL_KIND, title, status: "open",
        contactId: quote.contactId, leadId: quote.leadId, quoteId: quote.id,
        details: state as object, steps: { done: [], outstanding: [] }, nextAction: next, updatedAt: now,
      },
      select: { id: true, title: true, nextAction: true },
    });
    return { ...row, existing: false };
  });
  if (!created) return { ok: false, error: `You're already following ${MAX_OPEN_GOALS} deliveries — close one on the Ask page first.` };
  if (!created.existing) {
    // The kind only — the title names a customer.
    await logAudit({ action: "assistant.goal_started", summary: "Asked the assistant to follow a delivery", user, entityType: "AssistantTask", entityId: created.id });
  }
  return { ok: true, id: created.id, title: created.title, next: created.nextAction ?? next, existing: created.existing };
}

/** The person's goals on the Ask page: every open one (however old — they don't close themselves), and those finished in the last 30 days. */
export async function goalsForAskPage(userId: string, now = new Date()) {
  const rows = await prisma.assistantTask.findMany({
    where: { tenantId: ownedWriteTenantId(), userId, kind: GOAL_KIND, OR: [{ status: "open" }, { updatedAt: { gte: new Date(now.getTime() - 30 * DAY) } }] },
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: { id: true, title: true, status: true, quoteId: true, nextAction: true, details: true, updatedAt: true },
  });
  return rows.map(({ details, ...row }) => ({ ...row, paused: readGoalState(details, now).paused === true }));
}

/** Undelivered alerts this goal raised (held overnight, past the ceiling, or waiting for a retry) → settled, never sent. */
function dropPendingAlerts(tx: Tx, tenantId: string, userId: string, goalId: string, now: Date) {
  return tx.assistantProactiveAlert.updateMany({
    where: { tenantId, userId, kind: GOAL_KIND, recordKey: { startsWith: `${goalId}:` }, deliveredAt: null },
    data: { deliveredAt: now },
  });
}

/** Lock the person's own goal row in this workspace; null when it is not theirs, not a goal, or not there. */
async function lockGoal(tx: Tx, tenantId: string, userId: string, goalId: string) {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "AssistantTask" WHERE "id" = ${goalId} AND "tenantId" = ${tenantId} AND "userId" = ${userId} AND "kind" = ${GOAL_KIND} FOR UPDATE`;
  if (!locked.length) return null;
  return tx.assistantTask.findFirst({ where: { id: goalId, tenantId, userId, kind: GOAL_KIND }, select: { id: true, status: true, details: true, updatedAt: true } });
}

/**
 * Off / On (the Ask page): Off stops the checks and drops anything it was still about to send; On picks up again
 * at the next half hour. False when the goal is not the person's own, or no longer open.
 */
export async function setGoalPaused(userId: string, goalId: string, paused: boolean, now = new Date()): Promise<boolean> {
  const tenantId = ownedWriteTenantId();
  return prisma.$transaction(async (tx) => {
    const row = await lockGoal(tx, tenantId, userId, String(goalId));
    if (!row || row.status !== "open") return false;
    const state = readGoalState(row.details, now);
    // Back on: checked at the next pass (no checkedAt), from where it stood.
    const next: GoalState = { blocker: state.blocker, since: state.since, told: state.told, ...(paused ? { paused: true } : {}) };
    if (paused) await dropPendingAlerts(tx, tenantId, userId, row.id, now);
    await tx.assistantTask.updateMany({
      where: { id: row.id, tenantId, userId },
      data: { details: next as object, version: { increment: 1 }, ...(paused ? {} : { updatedAt: now }) },
    });
    return true;
  });
}

/** Stop following: closed, with why. Its pending alerts are dropped; the person's watches are left alone. */
async function stopGoal(tenantId: string, userId: string, goalId: string, why: string, now: Date): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const row = await lockGoal(tx, tenantId, userId, goalId);
    if (!row || row.status !== "open") return false;
    await dropPendingAlerts(tx, tenantId, userId, row.id, now);
    await tx.assistantTask.updateMany({
      where: { id: row.id, tenantId, userId },
      data: { status: "closed", closedAt: now, nextAction: why, version: { increment: 1 } },
    });
    return true;
  });
}

/** Close (the Ask page). False when it is not the person's own open goal. */
export function closeGoal(userId: string, goalId: string, now = new Date()): Promise<boolean> {
  return stopGoal(ownedWriteTenantId(), userId, String(goalId), "Closed by you", now);
}

/**
 * The goal finished (delivered, or the deal lost): its own reminders no longer matter. Inside the goal's
 * transaction, under its row lock. "Its own" = the person's active watches on this quote or its deal, and the
 * check-backs DAX set itself that name this quote. Their own scheduled questions are never touched.
 */
async function switchOffReminders(tx: Tx, tenantId: string, userId: string, quote: { id: string; number: number; leadId: string | null }) {
  const watches = await tx.assistantWatch.updateMany({
    where: { tenantId, userId, active: true, OR: [{ quoteId: quote.id }, ...(quote.leadId ? [{ leadId: quote.leadId }] : [])] },
    data: { active: false },
  });
  const dax = await tx.assistantSchedule.findMany({ where: { tenantId, userId, active: true, setBy: "dax" }, select: { id: true, question: true, reason: true } });
  const ids = dax.filter((s) => namesQuote(s.question, quote.number) || namesQuote(s.reason, quote.number)).map((s) => s.id);
  if (ids.length) await tx.assistantSchedule.updateMany({ where: { id: { in: ids }, tenantId, userId, setBy: "dax" }, data: { active: false, nextRunAt: null } });
  return { watches: watches.count, checkBacks: ids.length };
}

export type GoalRun = { checked: number; alerted: number; finished: number; stopped: number };

/**
 * The assistant cron's goal pass, in the workspace whose scope it has entered (runCronPerTenant). Plain queries.
 * Module off: nothing is checked and nothing changes — the goals wait, as they were, until it is back on.
 */
export async function runDeliveryGoals(tenantId: string, budget: Pick<CronSliceContext, "shouldStop">, now = new Date()): Promise<GoalRun> {
  const stats: GoalRun = { checked: 0, alerted: 0, finished: 0, stopped: 0 };
  const scope = currentTenantScope();
  if (!scope || scope.system || !scope.tenantId || scope.tenantId !== tenantId) return stats;
  if (!(await isModuleEnabled("automotive"))) return stats;

  const goals = await prisma.assistantTask.findMany({
    where: { tenantId, kind: GOAL_KIND, status: "open" },
    orderBy: { updatedAt: "asc" },
    take: GOAL_BATCH,
    select: { id: true, tenantId: true, userId: true, quoteId: true, details: true },
  });
  let origin: string | null = null;
  const fresh = (s: GoalState) => Boolean(s.checkedAt) && now.getTime() - Date.parse(s.checkedAt!) < RECHECK_AFTER_MS;

  for (const goal of goals) {
    if (budget.shouldStop(GOAL_CHECK_RESERVE_MS)) break;
    if (goal.tenantId !== tenantId) continue;
    const before = readGoalState(goal.details, now);
    if (before.paused || fresh(before)) continue;

    // WHO they are, now. A failure to read it changes nothing — tried again next tick.
    let user: PermissionUser | null;
    try {
      user = await assistantUserFor(goal.userId);
    } catch (error) {
      await logError("assistant-goal", "couldn't check the person for a goal", error instanceof Error ? error.name : "unknown");
      continue;
    }
    try {
      const allowed = Boolean(user && user.id === goal.userId && goal.quoteId)
        && (await hasAnyPermission(user!, "deliveries.view", "deliveries.manage"))
        && (await canAccessQuote(user!, goal.quoteId!));
      if (!allowed) {
        if (await stopGoal(tenantId, goal.userId, goal.id, "Stopped: you can no longer open this deal, so I can't follow it.", now)) stats.stopped++;
        continue;
      }
      const loaded = await loadFacts(tenantId, goal.quoteId!);
      if (!loaded) {
        if (await stopGoal(tenantId, goal.userId, goal.id, "Stopped: the quote is gone or was replaced by a newer version.", now)) stats.stopped++;
        continue;
      }
      const { quote, facts } = loaded;
      // The record each alert is about, as far as THIS person may open it — checked again when it is sent.
      const about = quote.leadId && (await canAccessLead(user!, quote.leadId))
        ? { leadId: quote.leadId, contactId: null }
        : quote.contactId && (await canAccessContact(user!, quote.contactId)) ? { leadId: null, contactId: quote.contactId } : { leadId: null, contactId: null };
      const alertsOn = await switchedOn(tenantId, goal.userId);
      origin ??= await tenantOrigin(tenantId).catch(() => "");

      const result = await prisma.$transaction(async (tx) => {
        const row = await lockGoal(tx, tenantId, goal.userId, goal.id);
        if (!row || row.status !== "open") return null;
        const state = readGoalState(row.details, now);
        // A second pass waited on the lock: the first has already checked it.
        if (state.paused || fresh(state)) return null;
        const ev = evaluateGoal(state, facts, now);
        const finished = ev.outcome !== "open";
        const off = finished ? await switchOffReminders(tx, tenantId, goal.userId, quote) : { watches: 0, checkBacks: 0 };
        // News replaces anything still waiting to be sent: a held "waiting on the deposit" is stale once it's paid.
        if (ev.alerts.length || finished) await dropPendingAlerts(tx, tenantId, goal.userId, row.id, now);
        const keys: string[] = [];
        if (alertsOn && ev.alerts.length) {
          const deliverAt = isQuietHour(now) ? nextMorning(now) : null;
          const data = ev.alerts.map((a) => {
            const line = finished ? `${a.text}${remindersOffText(off.watches, off.checkBacks)}` : a.text;
            const recordKey = `${row.id}:${a.key}`;
            keys.push(recordKey);
            return {
              tenantId, userId: goal.userId, kind: GOAL_KIND, recordKey, deliverAt, ...about,
              text: proactiveText({ kind: "delivery_goal", customer: "", url: `/deals/${quote.id}`, detail: line, recordKey }, origin ?? ""),
            };
          });
          // The unique (person, kind, record) key: a pass that somehow got here twice still makes each alert once.
          await tx.assistantProactiveAlert.createMany({ data, skipDuplicates: true });
        }
        const progressed = ev.alerts.length > 0 || finished;
        await tx.assistantTask.updateMany({
          where: { id: row.id, tenantId, userId: goal.userId, status: "open" },
          data: {
            details: { ...ev.state, checkedAt: now.toISOString() } as object,
            steps: { done: ev.done, outstanding: ev.outstanding },
            nextAction: finished ? `${ev.next}${remindersOffText(off.watches, off.checkBacks)}` : ev.next,
            version: { increment: 1 },
            // Progress is activity; a check that found nothing new is not.
            ...(progressed ? { updatedAt: now } : {}),
            ...(finished ? { status: ev.outcome === "done" ? "done" : "closed", closedAt: now } : {}),
          },
        });
        const toSend = keys.length && !isQuietHour(now)
          ? await tx.assistantProactiveAlert.findMany({ where: { tenantId, userId: goal.userId, kind: GOAL_KIND, recordKey: { in: keys }, deliveredAt: null }, select: { id: true } })
          : [];
        return { finished, outcome: ev.outcome, alerts: keys.length, toSend: toSend.map((a) => a.id), off };
      });
      if (!result) continue;
      stats.checked++;
      stats.alerted += result.alerts;
      if (result.finished) {
        stats.finished++;
        await logAudit({
          action: "assistant.goal_finished",
          summary: `A delivery the assistant was following ${result.outcome === "done" ? "was delivered" : "was lost"}; switched off ${result.off.watches} watch(es) and ${result.off.checkBacks} check-back(s)`,
          userName: "Assistant (goals)",
          entityType: "AssistantTask",
          entityId: goal.id,
        }).catch(() => {});
      }
      // Sent after the commit, by proactive DAX's own delivery: it re-checks the switches and the person's access,
      // holds it for the morning past the daily ceiling, and the sweep retries anything that didn't go.
      for (const id of result.toSend) await deliver(tenantId, id).catch((error: unknown) => logError("assistant-goal", "goal alert delivery failed", error instanceof Error ? error.name : "unknown"));
    } catch (error) {
      await logError("assistant-goal", "goal check failed", error instanceof Error ? error.name : "unknown");
    }
  }
  return stats;
}
