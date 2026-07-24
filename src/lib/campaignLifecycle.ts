export const CAMPAIGN_STATUSES = [
  "draft",
  "in_review",
  "changes_requested",
  "approved",
  "scheduled",
  "queued",
  "sending",
  "paused",
  "completed",
  "completed_with_errors",
  "failed",
  "cancelled",
  "archived",
] as const;

export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const CAMPAIGN_RECIPIENT_STATUSES = [
  "pending",
  "queued",
  "sending",
  "sent",
  "delivered",
  "failed_temporary",
  "failed_permanent",
  "suppressed",
  "cancelled",
] as const;

export type CampaignRecipientStatus = (typeof CAMPAIGN_RECIPIENT_STATUSES)[number];

const STATUS_SET = new Set<string>(CAMPAIGN_STATUSES);
const RECIPIENT_STATUS_SET = new Set<string>(CAMPAIGN_RECIPIENT_STATUSES);

export const CAMPAIGN_TRANSITIONS: Readonly<Record<CampaignStatus, readonly CampaignStatus[]>> = {
  draft: ["in_review", "archived"],
  in_review: ["approved", "changes_requested", "draft"],
  changes_requested: ["draft", "in_review"],
  approved: ["scheduled", "queued", "draft"],
  scheduled: ["approved", "queued", "cancelled"],
  queued: ["sending", "paused", "cancelled"],
  sending: ["paused", "completed", "completed_with_errors", "failed", "cancelled"],
  paused: ["queued", "cancelled"],
  completed: ["archived"],
  completed_with_errors: ["archived"],
  failed: ["archived"],
  cancelled: ["archived"],
  archived: [],
};

export function isCampaignStatus(value: unknown): value is CampaignStatus {
  return typeof value === "string" && STATUS_SET.has(value);
}

export function parseCampaignStatus(value: unknown): CampaignStatus {
  if (!isCampaignStatus(value)) throw new Error(`Unknown campaign status: ${String(value)}`);
  return value;
}

export function isCampaignRecipientStatus(value: unknown): value is CampaignRecipientStatus {
  return typeof value === "string" && RECIPIENT_STATUS_SET.has(value);
}

export function canTransitionCampaign(from: CampaignStatus, to: CampaignStatus): boolean {
  return CAMPAIGN_TRANSITIONS[from].includes(to);
}

export function assertCampaignTransition(fromValue: unknown, toValue: unknown): asserts toValue is CampaignStatus {
  const from = parseCampaignStatus(fromValue);
  const to = parseCampaignStatus(toValue);
  if (!canTransitionCampaign(from, to)) {
    throw new Error(`Invalid campaign transition: ${from} -> ${to}`);
  }
}

/** Launch-relevant content is editable only while it is an active working draft. */
export function isCampaignEditable(status: CampaignStatus): boolean {
  return status === "draft" || status === "changes_requested";
}

export function isCampaignLaunchable(status: CampaignStatus): boolean {
  return status === "approved";
}

export function isCampaignTerminal(status: CampaignStatus): boolean {
  return ["completed", "completed_with_errors", "failed", "cancelled", "archived"].includes(status);
}

export function campaignFinalStatus(input: {
  failedCount: number;
  suppressedCount?: number;
}): "completed" | "completed_with_errors" {
  return input.failedCount > 0 || (input.suppressedCount ?? 0) > 0
    ? "completed_with_errors"
    : "completed";
}

export function campaignStatusLabel(status: CampaignStatus): string {
  return status.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
