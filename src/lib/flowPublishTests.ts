import "server-only";
import { prisma } from "./db";
import type { Flow } from "./flow";
import type { FlowIssue } from "./flowValidation";
import { evaluateFlowScenario } from "./flowEvaluationRunner";

/**
 * PUBLISH-TIME TESTS (Node-RED review 2026-11-02, Sean's item 6). Every saved test on the Evaluations page runs against
 * the exact draft being published — whichever version it was first written against, because a saved test is a promise
 * about how the flow behaves, and that is what a new version could break. A failing test is a publish ERROR naming
 * it; nothing is sent or written (the runner stubs every effect).
 *
 * ALL of them, never a sample (PR #977 review): a gate that skips the 25th test lets the 25th failure through. A flow
 * holds at most 50 (flowEvaluations.ts) of at most 12 turns each, run in memory, so the whole suite fits one request.
 */
export async function publishTestIssues(tenantId: string, flowId: string, flow: Flow, channel: string): Promise<FlowIssue[]> {
  const cases = await prisma.botFlowEvaluation.findMany({
    where: { tenantId, flowId },
    orderBy: { createdAt: "asc" },
    select: { name: true, turns: true, expectation: true },
  });
  const issues: FlowIssue[] = [];
  for (const saved of cases) {
    try {
      const result = await evaluateFlowScenario({ flow, channel, turns: saved.turns, expectation: saved.expectation });
      if (!result.passed) issues.push({ severity: "error", code: "test.failed", message: `Saved test “${saved.name}” fails on this draft: ${result.reasons[0] ?? "it did not pass"}` });
    } catch (error) {
      issues.push({ severity: "error", code: "test.failed", message: `Saved test “${saved.name}” fails on this draft: ${error instanceof Error ? error.message.slice(0, 200) : "it could not run"}` });
    }
  }
  return issues;
}
