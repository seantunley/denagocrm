import { getSetting } from "./settings";
import { prisma } from "./db";
import { builderOwnedWhere } from "./flowTenantScopeServer";
import type { Flow } from "./flow";
import { flowErrors, validateFlow, type FlowChannel, type FlowIssue } from "./flowValidation";

export async function enabledFlowChannels(): Promise<FlowChannel[]> {
  const [dmEnabled, telegramEnabled] = await Promise.all([getSetting("BOT_DM_ENABLED"), getSetting("BOT_TG_ENABLED")]);
  const channels: FlowChannel[] = ["whatsapp"];
  if (dmEnabled === "true") channels.push("messenger", "instagram");
  if (telegramEnabled === "true") channels.push("telegram");
  return channels;
}

/**
 * Publication validates both pure graph/channel rules and external references.
 * A saved draft may outlive a Journey that was disabled or deleted; live traffic
 * must not discover that only after reaching the node.
 */
export async function validateFlowForEnabledChannels(flow: Flow): Promise<FlowIssue[]> {
  const issues = validateFlow(flow, await enabledFlowChannels());
  const journeyNodes = Object.values(flow.nodes).filter((node) => node.type === "journey");
  const ids = [...new Set(journeyNodes.map((node) => node.type === "journey" ? node.journeyId : "").filter(Boolean))];
  if (!ids.length) return issues;
  // "…no longer active in this workspace" has to mean THIS workspace. Unscoped,
  // a journey node pointing at another tenant's Journey id validated clean and
  // publication then shipped a graph whose enrolment effect writes across the
  // tenant boundary at runtime. Journey.tenantId is nullable, so the founding
  // tenant keeps its legacy NULL journeys.
  const active = await prisma.journey.findMany({
    where: { id: { in: ids }, status: "active", ...builderOwnedWhere() },
    select: { id: true },
  });
  const activeIds = new Set(active.map((journey) => journey.id));
  for (const node of journeyNodes) {
    if (node.type === "journey" && node.journeyId && !activeIds.has(node.journeyId)) {
      issues.push({ severity: "error", code: "journey.unavailable", message: "The selected Journey is no longer active in this workspace.", nodeId: node.id });
    }
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
