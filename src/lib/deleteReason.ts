import { refuse } from "@/lib/actionResult";

/**
 * The reason a destructive action was confirmed with — REQUIRED on the server.
 * The confirmation dialog asks for it, but an action is a public endpoint: a
 * posted form (or a stale page) without one must be refused, not audited as
 * "No reason given".
 */
export function requiredReason(formData: FormData | undefined, what = "this"): string {
  const reason = String(formData?.get("reason") ?? "").trim();
  if (!reason) refuse(`Give a reason for ${what} — it's kept in the audit trail.`);
  return reason;
}
