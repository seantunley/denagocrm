/**
 * LIVE NUMBERS ON EACH STEP (Node-RED's node status; Sean, 2026-11-02). Per step, over the last N days (the flow
 * builder page reads botFlowAnalytics): how many conversations reached it, and how many answered it.
 */
export type StepNumbers = Record<string, { reached: number; interacted: number }>;

const ASKS_FOR_INPUT = new Set(["choice", "capture", "captureFile", "slots"]);

/** "142 reached · 31 answered · 12 dropped off" — the last two only for a step that waits for the customer. */
export function stepNumbersLine(type: string, stats: { reached: number; interacted: number } | undefined): string | null {
  if (!stats || stats.reached <= 0) return null;
  if (!ASKS_FOR_INPUT.has(type)) return `${stats.reached} reached`;
  return `${stats.reached} reached · ${stats.interacted} answered · ${Math.max(stats.reached - stats.interacted, 0)} dropped off`;
}
