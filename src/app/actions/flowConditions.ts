"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import type { Flow, FlowConditionOperator } from "@/lib/flow";

const OPERATORS = new Set<FlowConditionOperator>([
  "equals", "not_equals", "contains", "not_contains", "exists", "not_exists", "gt", "gte", "lt", "lte",
]);

async function loadDraft(flowId: string): Promise<{ row: { id: string; definition: string }; flow: Flow } | null> {
  const row = await prisma.botFlow.findUnique({ where: { id: flowId }, select: { id: true, definition: true } });
  if (!row) return null;
  try {
    const flow = JSON.parse(row.definition) as Flow;
    if (!flow?.start || !flow?.nodes) return null;
    return { row, flow };
  } catch {
    return null;
  }
}

export async function saveChoiceCondition(
  flowId: string,
  nodeId: string,
  optionId: string,
  formData: FormData,
) {
  await requireOwner();
  const loaded = await loadDraft(flowId);
  if (!loaded) return;
  const node = loaded.flow.nodes[nodeId];
  if (!node || node.type !== "choice") return;
  const option = node.options.find((item) => item.id === optionId);
  if (!option) return;

  const enabled = formData.get("enabled") === "on";
  if (!enabled) {
    delete option.condition;
  } else {
    const variable = String(formData.get("variable") ?? "").trim().replace(/\W/g, "");
    const operator = String(formData.get("operator") ?? "equals") as FlowConditionOperator;
    const value = String(formData.get("value") ?? "").trim();
    if (!variable || !OPERATORS.has(operator)) return;
    option.condition = {
      variable,
      operator,
      ...(["exists", "not_exists"].includes(operator) ? {} : { value }),
    };
  }

  await prisma.botFlow.update({ where: { id: flowId }, data: { definition: JSON.stringify(loaded.flow) } });
  revalidatePath(`/bot-builder/${flowId}`);
  revalidatePath("/bot-builder");
}

export async function saveChoiceRouting(flowId: string, nodeId: string, formData: FormData) {
  await requireOwner();
  const loaded = await loadDraft(flowId);
  if (!loaded) return;
  const node = loaded.flow.nodes[nodeId];
  if (!node || node.type !== "choice") return;

  node.autoSelectSingle = formData.get("autoSelectSingle") === "on";
  const noMatchNext = String(formData.get("noMatchNext") ?? "").trim();
  node.noMatchNext = noMatchNext && loaded.flow.nodes[noMatchNext] ? noMatchNext : undefined;

  await prisma.botFlow.update({ where: { id: flowId }, data: { definition: JSON.stringify(loaded.flow) } });
  revalidatePath(`/bot-builder/${flowId}`);
  revalidatePath("/bot-builder");
}
