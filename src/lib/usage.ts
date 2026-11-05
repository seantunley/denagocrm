import { Prisma } from "@prisma/client";
import { basePrisma } from "./db";
import { settingsTenantId } from "./settings";
import { METER_IDS, usageMonth, type MeterId } from "./usageMeters";

/**
 * Adds to a workspace's counters for this month. One statement, INSERT … ON CONFLICT DO UPDATE, so two
 * sends at the same moment both count. `tenantId` omitted = the workspace whose settings (keys) this call
 * used. Never throws: metering must not break a send — a failure goes to the System Log instead.
 */
export async function recordUsage(counts: Partial<Record<MeterId, number>>, tenantId?: string | null): Promise<void> {
  try {
    const rows = METER_IDS.filter((id) => (counts[id] ?? 0) > 0).map((id) => [id, Math.ceil(counts[id]!)] as const);
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
