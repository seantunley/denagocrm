import { getSetting } from "./settings";
import { prisma } from "./db";
import { builderTenantId, journeyScope } from "./flowScope";
import type { Flow } from "./flow";
import { flowErrors, publishSeverity, validateFlow, type FlowChannel, type FlowIssue } from "./flowValidation";

export async function enabledFlowChannels(): Promise<FlowChannel[]> {
  const [dmEnabled, telegramEnabled] = await Promise.all([getSetting("BOT_DM_ENABLED"), getSetting("BOT_TG_ENABLED")]);
  const channels: FlowChannel[] = ["whatsapp"];
  if (dmEnabled === "true") channels.push("messenger", "instagram");
  if (telegramEnabled === "true") channels.push("telegram");
  return channels;
}

export async function validateFlowForEnabledChannels(flow: Flow): Promise<FlowIssue[]> {
  const issues = publishSeverity(validateFlow(flow, await enabledFlowChannels()));
  const journeyNodes = Object.values(flow.nodes).filter((node) => node.type === "journey");
  const journeyIds = [...new Set(journeyNodes.map((node) => node.type === "journey" ? node.journeyId : "").filter(Boolean))];
  if (journeyIds.length) {
    const active = await prisma.journey.findMany({ where: { id: { in: journeyIds }, status: "active", ...(await journeyScope()) }, select: { id: true } });
    const activeIds = new Set(active.map((journey) => journey.id));
    for (const node of journeyNodes) if (node.type === "journey" && node.journeyId && !activeIds.has(node.journeyId)) issues.push({ severity: "error", code: "journey.unavailable", message: "The selected Journey is no longer active in this workspace.", nodeId: node.id });
  }

  const subflowNodes = Object.values(flow.nodes).filter((node) => node.type === "subflow");
  const subflowIds = [...new Set(subflowNodes.map((node) => node.type === "subflow" ? node.flowId : "").filter(Boolean))];
  if (subflowIds.length) {
    const tenantId = await builderTenantId();
    const versions = await prisma.botFlowVersion.findMany({ where: { tenantId, flowId: { in: subflowIds } }, select: { flowId: true }, distinct: ["flowId"] });
    const published = new Set(versions.map((version) => version.flowId));
    for (const node of subflowNodes) if (node.type === "subflow" && node.flowId && !published.has(node.flowId)) issues.push({ severity: "error", code: "subflow.unavailable", message: "The selected subflow has not been published in this workspace.", nodeId: node.id });
  }
  return issues;
}

export class FlowPublishValidationError extends Error {
  readonly issues: FlowIssue[];
  constructor(issues: FlowIssue[]) {
    const errors = flowErrors(issues);
    super(`Flow cannot be published: ${errors.length} validation error${errors.length === 1 ? "" : "s"}.`);
    this.name = "FlowPublishValidationError";
    this.issues = issues;
  }
}
