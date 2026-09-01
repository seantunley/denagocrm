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
  if (ids.length) {
    // Scope the check to the workspace publishing. Unscoped, another tenant's
    // active Journey satisfied it, so a flow could be published pointing at a
    // Journey this workspace does not own — the builder/publication boundary
    // staying cross-tenant after every BotFlow query had been scoped.
    const active = await prisma.journey.findMany({ where: { id: { in: ids }, status: "active", ...(await journeyScope()) }, select: { id: true } });
    const activeIds = new Set(active.map((journey) => journey.id));
    for (const node of journeyNodes) {
      if (node.type === "journey" && node.journeyId && !activeIds.has(node.journeyId)) {
        issues.push({ severity: "error", code: "journey.unavailable", message: "The selected Journey is no longer active in this workspace.", nodeId: node.id });
      }
    }
  }

  // A subflow reference has the same failure mode as a Journey reference: the
  // runtime loads the LATEST PUBLISHED version, so a draft-only child would run
  // as "not found" for every customer. Same workspace scoping, same reason.
  const subflowNodes = Object.values(flow.nodes).filter((node) => node.type === "subflow");
  const subflowIds = [...new Set(subflowNodes.map((node) => node.type === "subflow" ? node.flowId : "").filter(Boolean))];
  if (subflowIds.length) {
    const tenantId = await builderTenantId();
    const versions = await prisma.botFlowVersion.findMany({ where: { tenantId, flowId: { in: subflowIds } }, select: { flowId: true }, distinct: ["flowId"] });
    const published = new Set(versions.map((version) => version.flowId));
    for (const node of subflowNodes) {
      if (node.type === "subflow" && node.flowId && !published.has(node.flowId)) {
        issues.push({ severity: "error", code: "subflow.unavailable", message: "The selected subflow has not been published in this workspace.", nodeId: node.id });
      }
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
