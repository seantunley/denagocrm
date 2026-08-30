"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { basePrisma, prisma } from "@/lib/db";
import { builderTenantId, flowScope } from "@/lib/flowScope";
import { withActingStaffScope } from "@/lib/actingScope";
import { parseEvaluationExpectation, parseEvaluationTurns } from "@/lib/flowEvaluationContract";
import { evaluateFlowScenario, parseEvaluationFlow } from "@/lib/flowEvaluationRunner";

type VersionDefinitionRow = { id: string; definition: string };

async function versionDefinition(tenantId: string, flowId: string, versionId: string): Promise<VersionDefinitionRow | null> {
  const rows = await basePrisma.$queryRaw<VersionDefinitionRow[]>(Prisma.sql`
    SELECT "id", "definition"
      FROM "BotFlowVersion"
     WHERE "tenantId" = ${tenantId}
       AND "flowId" = ${flowId}
       AND "id" = ${versionId}
     LIMIT 1
  `);
  return rows[0] ?? null;
}

export async function createFlowEvaluation(flowId: string, formData: FormData) {
  return withActingStaffScope(async () => {
    const owner = await requireOwner();
    const tenantId = await builderTenantId();
    const scope = await flowScope();
    const flow = await prisma.botFlow.findFirst({ where: { id: flowId, ...scope }, select: { id: true } });
    if (!flow) return { error: "Flow not found." };

    const name = String(formData.get("name") ?? "").trim().slice(0, 120);
    if (!name) return { error: "Give the evaluation a name." };
    let turns;
    let expectation;
    try {
      turns = parseEvaluationTurns(String(formData.get("turns") ?? ""));
      expectation = parseEvaluationExpectation({
        outcome: String(formData.get("outcome") ?? ""),
        replyContains: String(formData.get("replyContains") ?? ""),
        variableKey: String(formData.get("variableKey") ?? ""),
        variableValue: String(formData.get("variableValue") ?? ""),
      });
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Evaluation data is invalid." };
    }

    const requestedVersion = String(formData.get("target") ?? "draft");
    const flowVersionId = requestedVersion === "draft" ? null : requestedVersion;
    if (flowVersionId && !(await versionDefinition(tenantId, flowId, flowVersionId))) {
      return { error: "That published version does not belong to this flow." };
    }

    const count = await prisma.botFlowEvaluation.count({ where: { tenantId, flowId } });
    if (count >= 50) return { error: "This flow already has the maximum of 50 saved evaluations." };

    await prisma.botFlowEvaluation.create({
      data: { tenantId, flowId, flowVersionId, name, turns, expectation },
    });
    await logAudit({ action: "bot.evaluation_created", summary: `Flow evaluation “${name}” created`, user: owner });
    revalidatePath(`/bot-builder/${flowId}/evaluations`);
    return { success: "Evaluation saved" };
  });
}

async function runEvaluation(tenantId: string, evaluationId: string) {
  const evaluation = await prisma.botFlowEvaluation.findFirst({ where: { id: evaluationId, tenantId } });
  if (!evaluation) return { error: "Evaluation not found.", flowId: null, passed: false };
  const flow = await prisma.botFlow.findFirst({ where: { id: evaluation.flowId, tenantId }, select: { definition: true } });
  if (!flow) return { error: "Flow not found.", flowId: evaluation.flowId, passed: false };

  const version = evaluation.flowVersionId
    ? await versionDefinition(tenantId, evaluation.flowId, evaluation.flowVersionId)
    : null;
  if (evaluation.flowVersionId && !version) {
    await prisma.botFlowEvaluation.updateMany({
      where: { id: evaluation.id, tenantId },
      data: { lastStatus: "error", lastRunAt: new Date(), lastResult: { reasons: ["Published version is no longer available."] } },
    });
    return { error: "Published version is no longer available.", flowId: evaluation.flowId, passed: false };
  }

  const definition = version?.definition ?? flow.definition;
  const parsed = parseEvaluationFlow(definition);
  if (!parsed) {
    await prisma.botFlowEvaluation.updateMany({
      where: { id: evaluation.id, tenantId },
      data: { lastStatus: "error", lastRunAt: new Date(), lastResult: { reasons: ["Flow data is malformed."] } },
    });
    return { error: "Flow data is malformed.", flowId: evaluation.flowId, passed: false };
  }

  try {
    const result = await evaluateFlowScenario({ flow: parsed, turns: evaluation.turns, expectation: evaluation.expectation });
    await prisma.botFlowEvaluation.updateMany({
      where: { id: evaluation.id, tenantId },
      data: { lastStatus: result.passed ? "passed" : "failed", lastRunAt: new Date(), lastResult: result },
    });
    return { flowId: evaluation.flowId, passed: result.passed, error: result.reasons[0] };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Evaluation failed to run.";
    await prisma.botFlowEvaluation.updateMany({
      where: { id: evaluation.id, tenantId },
      data: { lastStatus: "error", lastRunAt: new Date(), lastResult: { reasons: [message] } },
    });
    return { flowId: evaluation.flowId, passed: false, error: message };
  }
}

export async function runFlowEvaluation(evaluationId: string, _formData?: FormData) {
  return withActingStaffScope(async () => {
    await requireOwner();
    const tenantId = await builderTenantId();
    const result = await runEvaluation(tenantId, evaluationId);
    if (result.flowId) revalidatePath(`/bot-builder/${result.flowId}/evaluations`);
    return { success: result.passed ? "Evaluation passed" : `Evaluation did not pass${result.error ? `: ${result.error}` : ""}` };
  });
}

export async function runAllFlowEvaluations(flowId: string, _formData?: FormData) {
  return withActingStaffScope(async () => {
    await requireOwner();
    const tenantId = await builderTenantId();
    const flow = await prisma.botFlow.findFirst({ where: { id: flowId, tenantId }, select: { id: true } });
    if (!flow) return { error: "Flow not found." };
    const evaluations = await prisma.botFlowEvaluation.findMany({ where: { tenantId, flowId }, select: { id: true }, orderBy: { createdAt: "asc" }, take: 50 });
    if (!evaluations.length) return { error: "Save an evaluation first." };
    const results = [];
    for (const evaluation of evaluations) results.push(await runEvaluation(tenantId, evaluation.id));
    revalidatePath(`/bot-builder/${flowId}/evaluations`);
    const passed = results.filter((result) => result.passed).length;
    return { success: `${passed} of ${results.length} evaluations passed` };
  });
}

export async function deleteFlowEvaluation(evaluationId: string, _formData?: FormData) {
  return withActingStaffScope(async () => {
    const owner = await requireOwner();
    const tenantId = await builderTenantId();
    const evaluation = await prisma.botFlowEvaluation.findFirst({ where: { id: evaluationId, tenantId }, select: { flowId: true, name: true } });
    if (!evaluation) return { error: "Evaluation not found." };
    await prisma.botFlowEvaluation.deleteMany({ where: { id: evaluationId, tenantId } });
    await logAudit({ action: "bot.evaluation_deleted", summary: `Flow evaluation “${evaluation.name}” deleted`, user: owner });
    revalidatePath(`/bot-builder/${evaluation.flowId}/evaluations`);
    return { success: "Evaluation deleted" };
  });
}
