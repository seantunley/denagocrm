import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { basePrisma } from "./db";
import { logAudit } from "./audit";
import { logError } from "./errorLog";
import { READY_MADE_JOURNEYS, readyMadeMarkerKey, type ReadyMadeJourney } from "./automationRegister";

/**
 * Every workspace gets the ready-made journeys that replaced the built-in senders
 * (automationRegister.ts → READY_MADE_JOURNEYS): published, listed and editable on
 * Journeys like any other, and OFF (paused) — unless the owner had already
 * switched the old built-in on, in which case it starts ON so nothing that was
 * being sent silently stops.
 *
 * Created once per workspace, ever. The AppSetting marker (unique per tenant +
 * key) records which journey it got, so a ready-made journey the owner deletes or
 * archives is never re-created, and the per-tenant advisory lock means two pages
 * loading at once (or a page and the cron) can't create two.
 *
 * basePrisma, with the tenant named on every row: this runs from the cron and
 * from page loads alike, and the lock and the writes must share one connection.
 */
function seedLockKey(tenantId: string): bigint {
  const digest = crypto.createHash("sha256").update(`ready-made-journeys:${tenantId}`).digest("hex");
  return BigInt(`0x${digest.slice(0, 15)}`);
}

/** Was the old built-in explicitly switched on? Unset, "false" or unreadable → no. */
async function priorApproval(
  tx: Prisma.TransactionClient,
  tenantId: string,
  def: ReadyMadeJourney,
): Promise<boolean> {
  const value = async (key: string) =>
    (await tx.appSetting.findUnique({ where: { tenantId_key: { tenantId, key } }, select: { value: true } }))?.value ?? null;
  if ((await value(def.priorSwitch)) !== "true") return false;
  // The old service job sent nothing without a picked template, so "on" without
  // one was never an approval of anything actually going out.
  if (def.priorSwitch === "SERVICE_REMINDER_ENABLED") {
    const templateId = await value("SERVICE_REMINDER_TEMPLATE_ID");
    if (!templateId) return false;
    return Boolean(await tx.emailTemplate.findFirst({ where: { id: templateId, tenantId }, select: { id: true } }));
  }
  return true;
}

export async function ensureReadyMadeJourneys(tenantId: string): Promise<void> {
  const keys = READY_MADE_JOURNEYS.map((def) => readyMadeMarkerKey(def.key));
  const recorded = await basePrisma.appSetting.count({ where: { tenantId, key: { in: keys } } });
  if (recorded === keys.length) return;

  const created = await basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${seedLockKey(tenantId)}::bigint)`;
    const made: Array<{ name: string; on: boolean }> = [];
    for (const def of READY_MADE_JOURNEYS) {
      const markerKey = readyMadeMarkerKey(def.key);
      const marker = await tx.appSetting.findUnique({ where: { tenantId_key: { tenantId, key: markerKey } } });
      if (marker) continue;
      const on = await priorApproval(tx, tenantId, def);
      const journey = await tx.journey.create({
        data: {
          tenantId,
          name: def.name,
          description: def.description,
          category: "automation",
          status: on ? "active" : "paused",
          // Two vehicles or two signers for one customer are two messages; the
          // module's own once-only claim is what stops a double, not the run mode.
          runMode: "parallel",
          activeVersion: 1,
        },
      });
      await tx.journeyVersion.create({
        data: {
          tenantId,
          journeyId: journey.id,
          version: 1,
          state: "published",
          publishedAt: new Date(),
          triggers: def.triggers as Prisma.InputJsonValue,
          // Expand-phase dual write, as every version writer does (actions/journeys.ts).
          trigger: def.triggers[0].type,
          triggerConfig: def.triggers[0].config as Prisma.InputJsonValue,
          entryConditions: Prisma.JsonNull,
          definition: {
            startStepId: def.steps[0].id,
            steps: def.steps.map((step, index) => ({ ...step, nextStepId: def.steps[index + 1]?.id ?? null })),
          } as Prisma.InputJsonValue,
        },
      });
      await tx.appSetting.create({ data: { tenantId, key: markerKey, value: journey.id } });
      made.push({ name: def.name, on });
    }
    return made;
  });

  for (const { name, on } of created) {
    await logAudit({
      action: "journey.ready_made_created",
      summary: `Ready-made journey “${name}” added, ${on ? "ON — the built-in it replaces was switched on" : "OFF until switched on in Journeys"}`,
      userName: "System",
    });
  }
}

/** The same, never throwing: a page must still render if seeding can't run. */
export async function ensureReadyMadeJourneysQuietly(tenantId: string): Promise<void> {
  await ensureReadyMadeJourneys(tenantId).catch((error) => logError("ready-made-journeys", error));
}

export type ReadyMadeJourneyState = {
  def: ReadyMadeJourney;
  journeyId: string | null;
  /** active | paused | draft | archived — or null when it was deleted or never made. */
  status: string | null;
};

/** Each ready-made journey, and whether it is on, for this workspace. */
export async function readyMadeJourneyStates(tenantId: string): Promise<ReadyMadeJourneyState[]> {
  const markers = await basePrisma.appSetting.findMany({
    where: { tenantId, key: { in: READY_MADE_JOURNEYS.map((def) => readyMadeMarkerKey(def.key)) } },
    select: { key: true, value: true },
  });
  const idOf = new Map(markers.map((m) => [m.key, m.value]));
  const journeys = await basePrisma.journey.findMany({
    where: { tenantId, id: { in: markers.map((m) => m.value) } },
    select: { id: true, status: true },
  });
  const statusOf = new Map(journeys.map((j) => [j.id, j.status]));
  return READY_MADE_JOURNEYS.map((def) => {
    const journeyId = idOf.get(readyMadeMarkerKey(def.key)) ?? null;
    return { def, journeyId, status: journeyId ? statusOf.get(journeyId) ?? null : null };
  });
}

/** Journey ids that are ready-made, for the "Ready-made" label on Journeys. */
export async function readyMadeJourneyIds(tenantId: string): Promise<Set<string>> {
  const markers = await basePrisma.appSetting.findMany({
    where: { tenantId, key: { in: READY_MADE_JOURNEYS.map((def) => readyMadeMarkerKey(def.key)) } },
    select: { value: true },
  });
  return new Set(markers.map((m) => m.value));
}
