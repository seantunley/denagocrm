import "server-only";

export const CLOSED_REQUEST_STATUSES = [
  "completed",
  "declined",
  "voided",
  "expired",
  "rejected",
  "failed_manual_intervention",
] as const;

export const PROCESSING_REQUEST_STATUSES = ["signatures_complete", "rendering", "sealed", "distributing"] as const;

export function isRequestProcessing(status: string): boolean {
  return (PROCESSING_REQUEST_STATUSES as readonly string[]).includes(status);
}

export function isRequestClosed(status: string): boolean {
  return (CLOSED_REQUEST_STATUSES as readonly string[]).includes(status);
}
