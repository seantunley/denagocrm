import { getSetting } from "./settings";
import type { Flow } from "./flow";
import { flowErrors, validateFlow, type FlowChannel, type FlowIssue } from "./flowValidation";

/** Channels on which the shared published journey can actually run right now. */
export async function enabledFlowChannels(): Promise<FlowChannel[]> {
  const [dmEnabled, telegramEnabled] = await Promise.all([
    getSetting("BOT_DM_ENABLED"),
    getSetting("BOT_TG_ENABLED"),
  ]);
  const channels: FlowChannel[] = ["whatsapp"];
  if (dmEnabled === "true") channels.push("messenger", "instagram");
  if (telegramEnabled === "true") channels.push("telegram");
  return channels;
}

export async function validateFlowForEnabledChannels(flow: Flow): Promise<FlowIssue[]> {
  return validateFlow(flow, await enabledFlowChannels());
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
