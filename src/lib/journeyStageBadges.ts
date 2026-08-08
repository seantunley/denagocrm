import { prisma } from "./db";
import { getActiveVersion } from "./journeyEngineShared";
import { readJourneyTriggers } from "./journeyTriggers";

/**
 * Stage id → names of the journeys that enrol on entering it.
 *
 * The pipeline board and the pipeline settings screen both badge a stage with
 * "N follow-up automations". They read AutomationRule.triggerStageId; that
 * engine is retired, so the badge now comes from the journey that actually
 * fires — otherwise both screens would silently show zero for every stage while
 * journeys ran behind them.
 *
 * Filtered in JS rather than SQL because the stage lives inside the version's
 * trigger list (Json), and only the version whose number equals
 * `Journey.activeVersion` is the one that runs — a published-but-superseded
 * version must not be counted.
 *
 * ONE journey can badge SEVERAL stages now: a version may list stage_entered
 * more than once, each with its own stageId, which is the shape "when they reach
 * Quoted or when they reach Won" takes. A journey is still named at most once
 * per stage, so a version that somehow lists the same stage twice does not
 * appear twice under it.
 */
export async function stageJourneyNames(): Promise<Map<string, string[]>> {
  const journeys = await prisma.journey.findMany({
    where: { status: "active" },
    orderBy: { name: "asc" },
    select: {
      name: true,
      activeVersion: true,
      versions: {
        where: { state: "published" },
        select: { version: true, triggers: true },
      },
    },
  });

  const byStage = new Map<string, string[]>();
  for (const journey of journeys) {
    const version = getActiveVersion(journey);
    if (!version) continue;
    for (const stageId of new Set(
      readJourneyTriggers(version.triggers)
        .filter((spec) => spec.type === "stage_entered")
        .map((spec) => spec.config.stageId)
        // No stage configured means "any stage" — that badges nothing in
        // particular, so it is left off rather than pinned to every column.
        .filter((stageId): stageId is string => typeof stageId === "string" && stageId !== ""),
    )) {
      const names = byStage.get(stageId) ?? [];
      names.push(journey.name);
      byStage.set(stageId, names);
    }
  }
  return byStage;
}
