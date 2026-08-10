import "server-only";
import { actingTenantId } from "@/lib/actingTenant";

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
 * DELEGATED, NOT RE-DERIVED. This used to spell the ladder out again —
 * `writeTenantId() ?? (await getActiveTenantId()) ?? DEFAULT_TENANT_ID` — which is
 * the same rule `actingTenantId()` applies to STAMP a dashboard on create. Two
 * copies of one rule is the shape of the bug this whole change is about: the
 * moment the write resolver and the read resolver disagree by a single rung, a
 * user creates a dashboard, publishes it, and it is invisible to their own
 * workspace — a silent failure with nothing to report. One rule, one caller-facing
 * name per side, no second answer.
 */
export async function viewerTenantId(): Promise<string> {
  return actingTenantId();
}
