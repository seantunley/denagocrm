import "server-only";
import { DEFAULT_TENANT_ID } from "@/lib/tenant";
import { writeTenantId } from "@/lib/tenantWrite";
import { getActiveTenantId } from "@/lib/auth";

/**
 * The workspace a dashboard viewer is acting in.
 *
 * "Shared" has to mean *shared inside this tenant*. The queries that read
 * published dashboards were relying on the scoped `prisma` client to supply that
 * boundary, and db.ts is explicit that it does not:
 *
 *     if (!tenantEnforcing()) return args;   // always, today
 *
 * So while enforcement is dormant a bare `sharedAt: { not: null }` matches EVERY
 * tenant's published dashboards. Tenant A publishes "Sales"; tenant B lists it,
 * opens it, and reads its title, layout, card configuration and any markdown in
 * it. The predicate has to name the tenant itself rather than assume something
 * upstream added one.
 *
 * Same rule as everywhere else in this codebase: an enforced scope wins, then
 * the session's validated active workspace, then the founding tenant — which is
 * what a session minted before the `tid` claim resolves to, and is byte-for-byte
 * today's single-tenant behaviour.
 */
export async function viewerTenantId(): Promise<string> {
  return writeTenantId() ?? (await getActiveTenantId()) ?? DEFAULT_TENANT_ID;
}
