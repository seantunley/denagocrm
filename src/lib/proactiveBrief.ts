import "server-only";
import { basePrisma } from "./db";
import { logError } from "./errorLog";
import { sendPushToAll } from "./push";
import { askCrm } from "./crmAssistant";
import { assistantAskAllowed, assistantUserFor } from "./assistantUser";
import { sendUpdatesToLinkedPhone } from "./assistantWhatsApp";
import { setting, switchedOn } from "./proactive";
import type { CronSliceContext } from "./tenantCron";
import {
  ASSISTANT_PROACTIVE_KEY,
  BRIEF_KIND,
  BRIEF_QUESTION,
  BRIEF_SOURCE,
  briefDueKey,
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
 * ONCE A DAY: an AssistantProactiveAlert row (kind morning_brief, the day as its key) is the claim — unique, so two
 * workers never both write it. Not written by 11:00 — skipped for the day, and the held alerts go on their own.
 */

/** Briefs written side by side per workspace per tick: enough for a team at the same hour, inside the route's budget. */
const BRIEFS_PER_TICK = 3;
/** Room a brief needs to finish: research and the answer, inside the route's limit. */
export const BRIEF_RESERVE_MS = 200_000;

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
    // The claim: one row per person per day. Already there = written (or being written) today.
    const row = await basePrisma.assistantProactiveAlert
      .create({ data: { tenantId, userId, kind: BRIEF_KIND, recordKey: dayKey, text: "", deliveredAt: now }, select: { id: true } })
      .catch((error: unknown) => {
        if ((error as { code?: string }).code === "P2002") return null;
        throw error;
      });
    if (row) claimed.push({ userId, claimId: row.id });
  }
  const results = await Promise.all(
    claimed.map(({ userId, claimId }) =>
      writeBrief(tenantId, userId, claimId, now, budget).catch(async (error: unknown) => {
        await logError("assistant-schedule", "morning brief failed", error instanceof Error ? error.name : "unknown", { tenantId });
        return false;
      }),
    ),
  );
  return { written: results.filter(Boolean).length };
}

async function writeBrief(tenantId: string, userId: string, claimId: string, now: Date, budget: Pick<CronSliceContext, "shouldStop">): Promise<boolean> {
  if (!(await switchedOn(tenantId, userId))) return false;
  const user = await assistantUserFor(userId);
  if (!user || !(await assistantAskAllowed(user.id))) return false;
  // What was held overnight for them — folded into the brief instead of arriving one by one.
  const held = await basePrisma.assistantProactiveAlert.findMany({
    where: { tenantId, userId, deliveredAt: null, deliverAt: { lte: now }, kind: { not: BRIEF_KIND } },
    orderBy: { createdAt: "asc" },
    take: 20,
    select: { id: true, text: true },
  });
  const result = await askCrm(user, briefQuestion(now, held.map((alert) => alert.text)), null, { source: "schedule" });
  if (!result.ok || !result.turnId) return false; // the held alerts stay held: the sweep sends them on their own
  // It is the morning brief, not a scheduled question: say so in the conversation.
  await basePrisma.assistantTurn.updateMany({ where: { id: result.turnId, tenantId, userId }, data: { source: BRIEF_SOURCE, question: BRIEF_QUESTION } });
  await basePrisma.assistantProactiveAlert.updateMany({ where: { id: claimId, tenantId }, data: { text: BRIEF_QUESTION, turnId: result.turnId } });
  if (held.length) {
    await basePrisma.assistantProactiveAlert.updateMany({
      where: { tenantId, userId, id: { in: held.map((alert) => alert.id) }, deliveredAt: null },
      data: { deliveredAt: new Date(), turnId: result.turnId },
    });
  }
  await sendPushToAll({ title: "DAX", body: "Your morning brief is ready.", url: "/assistant" }, "assistant", { tenantId, userId }).catch(() => {});
  await sendUpdatesToLinkedPhone(tenantId, userId, { shouldStop: budget.shouldStop }).catch(() => {});
  return true;
}
