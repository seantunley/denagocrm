import { DEFAULT_TENANT_ID } from "./tenant";

/**
 * The start of a workspace's referral codes: Denago's stay DGO; any other workspace's are the first three letters
 * of its name ("Acme Golf" → ACM), or REF when the name has fewer. Codes stay unique across workspaces either way.
 */
export function referralPrefix(tenantId: string | null | undefined, tenantName: string | null | undefined): string {
  if (!tenantId || tenantId === DEFAULT_TENANT_ID) return "DGO";
  const letters = (tenantName ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  return letters.length >= 3 ? letters.slice(0, 3) : "REF";
}
