import { prisma } from "./db";

/**
 * A LEAD MOVED PAST ITS PIPELINE'S FIRST STAGE HAS BEEN CONTACTED (Sean, 2026-10-18). Moving it on — to Contacted
 * or anything later — is someone saying "we've been in touch", even when the call itself went into a note or was
 * never logged. A lead sitting in Contacted while every list called it "Never contacted" was the case that showed it.
 *
 * The contact is dated to when the lead entered its current stage (`stageEnteredAt`). "First" is the lowest-ordered
 * open stage of the lead's OWN pipeline — so it does not depend on a stage being called "New" or "Contacted".
 * Every reader of "has this lead been contacted / when last" takes this alongside its messages and activities
 * (leadScoreLoader, crmAssistant, crmAssistantStats, assistantWatch).
 */

export type StagedLead = { stageEnteredAt: Date; stage: { order: number; pipelineId: string } };

/** The first open stage's order, per pipeline, for these leads' pipelines. */
export async function firstStageOrders(leads: readonly StagedLead[]): Promise<Map<string, number>> {
  const pipelineIds = [...new Set(leads.map((lead) => lead.stage.pipelineId))];
  if (!pipelineIds.length) return new Map();
  const rows = await prisma.pipelineStage.groupBy({
    by: ["pipelineId"],
    where: { pipelineId: { in: pipelineIds }, isClosed: false },
    _min: { order: true },
  });
  return new Map(rows.flatMap((row) => (row._min.order == null ? [] : [[row.pipelineId, row._min.order] as const])));
}

/** When moving the lead on counts as contact: the time it entered its current stage, or null while in the first. */
export function stageContactAt(lead: StagedLead, firstOrders: ReadonlyMap<string, number>): Date | null {
  const first = firstOrders.get(lead.stage.pipelineId);
  return first !== undefined && lead.stage.order > first ? lead.stageEnteredAt : null;
}
