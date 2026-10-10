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

/**
 * The last day a link works, for showing to a person.
 *
 * A quote's link expires at the END of its valid-until day — midnight, which is
 * the first instant of the NEXT day. Formatting that instant as a date printed
 * "expires 24 Oct" beside a quote valid until the 23rd. The moment just before
 * it is the day the link is actually still good.
 */
export function lastValidDay(expiresAt: Date | string): Date {
  return new Date(new Date(expiresAt).getTime() - 1);
}

export function signatureRequestView(status: string): SignatureRequestView {
  if (isRequestClosed(status)) return status as Exclude<SignatureRequestView, "in-progress">;
  return "in-progress";
}
