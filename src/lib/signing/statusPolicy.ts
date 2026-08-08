/**
 * Pure signing lifecycle policy. Keep this module free of server-only imports so
 * the complete status contract can be exercised directly in unit tests.
 */
export const CLOSED_REQUEST_STATUSES = [
  "completed",
  "declined",
  "voided",
  "expired",
  "rejected",
] as const;

export type SignatureRequestView =
  | "completed"
  | "voided"
  | "declined"
  | "rejected"
  | "expired"
  | "in-progress";

export function isRequestClosed(status: string): boolean {
  return (CLOSED_REQUEST_STATUSES as readonly string[]).includes(status);
}

export function signatureRequestView(status: string): SignatureRequestView {
  if (isRequestClosed(status)) return status as Exclude<SignatureRequestView, "in-progress">;
  return "in-progress";
}
