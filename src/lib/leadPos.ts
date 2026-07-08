import { prisma } from "./db";

/** Position that places a new lead at the TOP of its pipeline column. */
export async function topPosition(stageId: string): Promise<number> {
  const agg = await prisma.lead.aggregate({ where: { stageId }, _min: { position: true } });
  return (agg._min.position ?? 0) - 1;
}
