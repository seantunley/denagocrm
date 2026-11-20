import { Prisma } from "@prisma/client";
import { basePrisma } from "./db";
import { settingsTenantId } from "./settings";
import { CHATGPT_JOB_PREFIX, METER_IDS, chatGptJobMeter, usageMonth, type MeterId } from "./usageMeters";

/**
 * Adds to a workspace's counters for this month. One statement, INSERT … ON CONFLICT DO UPDATE, so two
 * sends at the same moment both count. `tenantId` omitted = the workspace whose settings (keys) this call
 * used. Never throws: metering must not break a send — a failure goes to the System Log instead.
 */
export async function recordUsage(counts: Partial<Record<MeterId, number>>, tenantId?: string | null): Promise<void> {
  await addCounts(METER_IDS.filter((id) => (counts[id] ?? 0) > 0).map((id) => [id, Math.ceil(counts[id]!)] as const), tenantId);
}

/**
 * One ChatGPT (subscription) call: its tokens and the call on the two ChatGPT meters, and its tokens on the job's own
 * row, so the Plan page can say what is using the allowance. Never billable; never throws.
 */
export async function recordChatGptUsage(job: string, tokens: number, tenantId?: string | null): Promise<void> {
  const n = Math.max(0, Math.ceil(tokens));
  await addCounts([["chatgpt_calls", 1], ...(n > 0 ? ([["chatgpt_tokens", n], [chatGptJobMeter(job), n]] as const) : [])], tenantId);
}

/** This month's ChatGPT tokens by job, most first. */
export async function chatGptUsageByJob(tenantId: string, month: string): Promise<{ job: string; tokens: number }[]> {
  const rows = await basePrisma.usageCounter.findMany({ where: { tenantId, month, meter: { startsWith: CHATGPT_JOB_PREFIX } } });
  return rows.map((row) => ({ job: row.meter.slice(CHATGPT_JOB_PREFIX.length), tokens: Number(row.count) })).sort((a, b) => b.tokens - a.tokens);
}

async function addCounts(rows: ReadonlyArray<readonly [string, number]>, tenantId?: string | null): Promise<void> {
  try {
    if (!rows.length) return;
    const owner = tenantId ?? (await settingsTenantId());
    const month = usageMonth();
    await basePrisma.$executeRaw`
      INSERT INTO "UsageCounter" ("tenantId", "month", "meter", "count")
      VALUES ${Prisma.join(rows.map(([meter, n]) => Prisma.sql`(${owner}, ${month}, ${meter}, ${BigInt(n)})`))}
      ON CONFLICT ("tenantId", "month", "meter") DO UPDATE SET "count" = "UsageCounter"."count" + EXCLUDED."count"`;
  } catch (error) {
    // Loaded only when needed, as elevenlabs/sms do: errorLog is server-only and this file is imported by modules tests load.
    const { logError } = await import("./errorLog");
    await logError("usage-meter", error).catch(() => {});
  }
}

/** One workspace's counters for one month, as plain numbers (missing meters are 0). */
export async function usageFor(tenantId: string, month: string): Promise<Record<MeterId, number>> {
  const rows = await basePrisma.usageCounter.findMany({ where: { tenantId, month } });
  const out = Object.fromEntries(METER_IDS.map((id) => [id, 0])) as Record<MeterId, number>;
  for (const row of rows) if ((METER_IDS as string[]).includes(row.meter)) out[row.meter as MeterId] = Number(row.count);
  return out;
}
