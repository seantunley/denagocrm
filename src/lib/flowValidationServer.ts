import { getSetting } from "./settings";
import { prisma } from "./db";
import type { Flow } from "./flow";
import { flowErrors, publishSeverity, validateFlow, type FlowChannel, type FlowIssue } from "./flowValidation";

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

  // Publication is the migration boundary for the action-outcome contract; see
  // publishSeverity. Editing stays permissive, a new publication does not.
  const graded = publishSeverity(issues);
  issues.length = 0;
  issues.push(...graded);
  const journeyNodes = Object.values(flow.nodes).filter((node) => node.type === "journey");
  const ids = [...new Set(journeyNodes.map((node) => node.type === "journey" ? node.journeyId : "").filter(Boolean))];
  if (!ids.length) return issues;
  const active = await prisma.journey.findMany({ where: { id: { in: ids }, status: "active" }, select: { id: true } });
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
