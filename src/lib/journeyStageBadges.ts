import { prisma } from "./db";
import { getActiveVersion, jsonObject } from "./journeyEngineShared";

/**
 * Stage id → names of the journeys that enrol on entering it.
 *
 * The pipeline board and the pipeline settings screen both badge a stage with
 * "N follow-up automations". They read AutomationRule.triggerStageId; that
 * engine is retired, so the badge now comes from the journey that actually
 * fires — otherwise both screens would silently show zero for every stage while
 * journeys ran behind them.
 *
 * Filtered in JS rather than SQL because the stage lives inside
 * `JourneyVersion.triggerConfig` (Json), and only the version whose number
 * equals `Journey.activeVersion` is the one that runs — a published-but-
 * superseded version must not be counted.
 */
export async function stageJourneyNames(): Promise<Map<string, string[]>> {
  const journeys = await prisma.journey.findMany({
    where: { status: "active" },
    orderBy: { name: "asc" },
    select: {
      name: true,
      activeVersion: true,
      versions: {
        where: { state: "published", trigger: "stage_entered" },
        select: { version: true, triggerConfig: true },
      },
    },
  });

  const byStage = new Map<string, string[]>();
  for (const journey of journeys) {
    const version = getActiveVersion(journey);
    if (!version) continue;
    const stageId = jsonObject(version.triggerConfig).stageId;
    // No stage configured means "any stage" — that badges nothing in
    // particular, so it is left off rather than pinned to every column.
    if (typeof stageId !== "string" || !stageId) continue;
    const names = byStage.get(stageId) ?? [];
    names.push(journey.name);
    byStage.set(stageId, names);
  }
  return byStage;
}
