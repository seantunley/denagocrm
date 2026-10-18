import "server-only";
import { basePrisma } from "./db";
import { logError } from "./errorLog";
import { sendPushToAll } from "./push";
import { askCrm } from "./crmAssistant";
import { assistantAskAllowed, assistantUserFor } from "./assistantUser";
import { sendUpdatesToLinkedPhone } from "./assistantWhatsApp";
import { dropAlerts, mayBeTold, setting, switchedOn } from "./proactive";
import type { CronSliceContext } from "./tenantCron";
import {
  ASSISTANT_PROACTIVE_KEY,
  BRIEF_KIND,
  BRIEF_LEASE_MS,
  BRIEF_QUESTION,
  BRIEF_SOURCE,
  briefDueKey,
  briefHoldsUntil,
  briefPersonKey,
  briefQuestion,
  parseBriefAt,
  proactiveOn,
} from "./proactiveRules";

/*
 * PROACTIVE DAX, part 2 — THE MORNING BRIEF (plan: docs/proactive-dax-plan-2026-10-18.md).
 *
 * Each weekday at the person's chosen time (default 07:30), for everyone whose proactive DAX is on, DAX writes
 * "your day": what is on today, what their customers did since yesterday — with the alerts held overnight folded in
 * rather than arriving one by one — and the three things that matter most. It runs exactly as a scheduled question
 * does (unattended: no questions back, nothing learned), as that person with their own access and the same hourly
 * ask limit, and lands like one: in Ask DAX (labelled as the morning brief), a phone notification, their WhatsApp.
 *
 * ONCE A DAY, RETRIED UNTIL IT IS: one AssistantProactiveAlert row per person per day (kind morning_brief, the day as
 * its key, unique). BEING WRITTEN is a lease (claimedAt); WRITTEN is deliveredAt. A brief that fails — the model down,
 * a timeout, the hourly limit — gives its lease back and the next half-hourly tick tries again; a worker that died
 * leaves a lease that runs out. Not written by 11:00 — skipped for the day, and the held alerts go on their own.
 */

/** Briefs written side by side per workspace per tick: enough for a team at the same hour, inside the route's budget. */
const BRIEFS_PER_TICK = 3;
/** Room a brief needs to finish: research and the answer, inside the route's limit. */
export const BRIEF_RESERVE_MS = 200_000;

/**
 * Take today's brief for this person: make the day's row, or take it back when nobody holds it (a failed try) or the
 * holder's lease ran out. Null when it is written already or someone is writing it now.
 */
async function claimBrief(tenantId: string, userId: string, dayKey: string, now: Date): Promise<string | null> {
  const made = await basePrisma.assistantProactiveAlert
    .create({ data: { tenantId, userId, kind: BRIEF_KIND, recordKey: dayKey, text: "", claimedAt: now }, select: { id: true } })
    .catch((error: unknown) => {
      if ((error as { code?: string }).code === "P2002") return null;
      throw error;
    });
  if (made) return made.id;
  const retaken = await basePrisma.assistantProactiveAlert.updateMany({
    where: {
      tenantId, userId, kind: BRIEF_KIND, recordKey: dayKey, deliveredAt: null,
      OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - BRIEF_LEASE_MS) } }],
    },
    data: { claimedAt: now },
  });
  if (retaken.count !== 1) return null;
  const row = await basePrisma.assistantProactiveAlert.findFirst({
    where: { tenantId, userId, kind: BRIEF_KIND, recordKey: dayKey, deliveredAt: null, claimedAt: now },
    select: { id: true },
  });
  return row?.id ?? null;
}

export async function runMorningBriefs(tenantId: string, budget: Pick<CronSliceContext, "shouldStop">): Promise<{ written: number }> {
  if (!proactiveOn(await setting(tenantId, ASSISTANT_PROACTIVE_KEY))) return { written: 0 };
  if (budget.shouldStop(BRIEF_RESERVE_MS)) return { written: 0 };
  const now = new Date();
  // Everyone who switched proactive DAX on for themselves in this workspace.
  const people = await basePrisma.appSetting.findMany({
    where: { tenantId, key: { startsWith: "ASSISTANT_PROACTIVE_FOR:" }, value: "on" },
    select: { key: true },
    take: 200,
  });
  const due: { userId: string; dayKey: string }[] = [];
  for (const { key } of people) {
    const userId = key.slice("ASSISTANT_PROACTIVE_FOR:".length);
    const at = parseBriefAt(await setting(tenantId, briefPersonKey(userId)));
    const dayKey = at ? briefDueKey(now, at) : null;
    if (dayKey) due.push({ userId, dayKey });
  }
  const claimed: { userId: string; claimId: string }[] = [];
  for (const { userId, dayKey } of due) {
    if (claimed.length >= BRIEFS_PER_TICK) break;
    const claimId = await claimBrief(tenantId, userId, dayKey, now);
    if (claimId) claimed.push({ userId, claimId });
  }
  const results = await Promise.all(
    claimed.map(async ({ userId, claimId }) => {
      const written = await writeBrief(tenantId, userId, claimId, now, budget).catch(async (error: unknown) => {
        await logError("assistant-schedule", "morning brief failed", error instanceof Error ? error.name : "unknown", { tenantId });
        return false;
      });
      // Not written: give the lease back, so the next tick tries again (until 11:00).
      if (!written) {
        await basePrisma.assistantProactiveAlert
          .updateMany({ where: { id: claimId, tenantId, deliveredAt: null, claimedAt: now }, data: { claimedAt: null } })
          .catch(() => {});
      }
      return written;
    }),
  );
  return { written: results.filter(Boolean).length };
}

async function writeBrief(tenantId: string, userId: string, claimId: string, now: Date, budget: Pick<CronSliceContext, "shouldStop">): Promise<boolean> {
  if (!(await switchedOn(tenantId, userId))) return false;
  const user = await assistantUserFor(userId);
  if (!user || !(await assistantAskAllowed(user.id))) return false;
  // What was held overnight for them — folded into the brief instead of arriving one by one. Held for 08:00 counts
  // even when the brief is written earlier (07:30 by default). Each is checked again first: an alert about a
  // customer they may no longer open is dropped, and its words never reach the brief.
  const waiting = await basePrisma.assistantProactiveAlert.findMany({
    where: { tenantId, userId, deliveredAt: null, kind: { not: BRIEF_KIND }, OR: [{ deliverAt: null }, { deliverAt: { lte: briefHoldsUntil(now) } }] },
    orderBy: { createdAt: "asc" },
    take: 20,
    select: { id: true, text: true, leadId: true, contactId: true },
  });
  const allowed = await Promise.all(waiting.map((alert) => mayBeTold(userId, alert)));
  await dropAlerts(tenantId, waiting.filter((_, i) => !allowed[i]).map((alert) => alert.id));
  const held = waiting.filter((_, i) => allowed[i]);
  const result = await askCrm(user, briefQuestion(now, held.map((alert) => alert.text)), null, { source: "schedule" });
  if (!result.ok || !result.turnId) return false; // retried next tick; past 11:00 the held alerts go on their own
  const turnId = result.turnId;
  // Done, in one step: labelled as the brief (not a scheduled question), the day marked written, and the held
  // alerts marked as delivered in it.
  // ponytail: the answer is saved by askCrm before this; if this one step fails the brief is written again next tick.
  await basePrisma.$transaction(async (tx) => {
    await tx.assistantTurn.updateMany({ where: { id: turnId, tenantId, userId }, data: { source: BRIEF_SOURCE, question: BRIEF_QUESTION } });
    await tx.assistantProactiveAlert.updateMany({ where: { id: claimId, tenantId }, data: { text: BRIEF_QUESTION, turnId, deliveredAt: new Date(), claimedAt: null } });
    if (held.length) {
      await tx.assistantProactiveAlert.updateMany({
        where: { tenantId, userId, id: { in: held.map((alert) => alert.id) }, deliveredAt: null },
        data: { deliveredAt: new Date(), turnId },
      });
    }
  });
  await sendPushToAll({ title: "DAX", body: "Your morning brief is ready.", url: "/assistant" }, "assistant", { tenantId, userId }).catch(() => {});
  await sendUpdatesToLinkedPhone(tenantId, userId, { shouldStop: budget.shouldStop }).catch(() => {});
  return true;
}
