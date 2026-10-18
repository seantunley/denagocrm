import "server-only";
import { basePrisma, prisma } from "./db";
import { logAudit } from "./audit";
import { formatDateTime } from "./format";
import { ownedWriteTenantId } from "./tenantWrite";
import { ASSISTANT_PROACTIVE_KEY, checkBackTiming, proactiveOn, proactivePersonKey } from "./proactiveRules";
import type { ProposedAction } from "./assistantActions";
import type { PermissionUser } from "./permissions";

/*
 * PROACTIVE DAX, part 3 — CHECKING BACK (plan: docs/proactive-dax-plan-2026-10-18.md; Sean: "Yes, it checks back").
 *
 * In a conversation DAX may set itself a check — "has Anna signed Q-1032?" on Thursday at 09:00 — with no Confirm,
 * because it only ever reports back to the same person and never contacts the customer. It is a one-off scheduled
 * question marked setBy "dax", run by the scheduled-question runner like any other, labelled as DAX checking back.
 *
 * ONLY while proactive DAX is on (the owner's switch and theirs). At most MAX_DAX_FOLLOW_UPS waiting per person —
 * their own scheduled questions keep their own ten. What the person is told comes from what was SAVED: the CRM adds
 * the line ("I'll check back …") — never the model's own claim.
 */

export const MAX_DAX_FOLLOW_UPS = 10;
export type CheckBack = Extract<ProposedAction, { type: "check_back" }>;

/** May DAX set check-backs for this person now? Both switches, in their own workspace. */
export async function checkBacksOn(userId: string): Promise<boolean> {
  const tenantId = ownedWriteTenantId();
  const read = async (key: string) =>
    (await basePrisma.appSetting.findUnique({ where: { tenantId_key: { tenantId, key } }, select: { value: true } }))?.value ?? null;
  return proactiveOn(await read(ASSISTANT_PROACTIVE_KEY)) && proactiveOn(await read(proactivePersonKey(userId)));
}

/**
 * Save the check-back(s) DAX proposed — at most one per answer — and return what to add to the answer: the line
 * saying it was set (from what was saved), or that it could not be. "" when there is nothing to say.
 */
export async function setCheckBacks(user: PermissionUser, items: readonly CheckBack[], now = new Date()): Promise<string> {
  const item = items[0];
  if (!item) return "";
  const timing = checkBackTiming(item.when, now);
  if ("refused" in timing) return `\n\n(I didn't set myself a reminder to check back: ${timing.refused}.)`;
  const tenantId = ownedWriteTenantId();
  const saved = await prisma.$transaction(async (tx) => {
    // The same per-person lock as their own schedules, so two answers at once can't both pass the count.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`assistant-schedules:${user.id}`})::bigint)`;
    if ((await tx.assistantSchedule.count({ where: { userId: user.id, active: true, setBy: "dax" } })) >= MAX_DAX_FOLLOW_UPS) return null;
    return tx.assistantSchedule.create({
      data: {
        tenantId,
        userId: user.id,
        question: item.question,
        cadence: "once",
        onDate: timing.onDate,
        timeOfDay: timing.timeOfDay,
        nextRunAt: timing.at,
        setBy: "dax",
        reason: item.reason ?? null,
      },
      select: { id: true },
    });
  });
  if (!saved) return `\n\n(I didn't set myself a reminder to check back: ${MAX_DAX_FOLLOW_UPS} are already waiting — cancel one on the Ask page.)`;
  await logAudit({
    action: "assistant.check_back_set",
    summary: `The assistant set itself a check-back for ${formatDateTime(timing.at)}`,
    user,
    entityType: "AssistantSchedule",
    entityId: saved.id,
  }).catch(() => {});
  return `\n\n🔁 I'll check back ${formatDateTime(timing.at)}: “${item.question}” — it's on your Ask page if you'd rather I didn't.`;
}
