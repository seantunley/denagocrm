import "server-only";
import { prisma } from "./db";
import { requireUser } from "./auth";
import { hasAnyPermission } from "./permissions";
import { activeTenantPredicate } from "./tenantPredicate";
import { NO_FLEET_PICKER, type FleetPicker } from "./fleetTypes";

/**
 * The fleets the CURRENT user may pick from — the contact form's "Fleet"
 * dropdown, and anywhere else a fleet has to be chosen.
 *
 * TWO gates, both of which have to be here rather than at the call sites.
 *
 * PERMISSION. `/fleets` is guarded `anyOf: ["fleets.view", "fleets.manage"]`
 * (routeAccess.ts), so a user without either may not see the fleets page — and a
 * dropdown listing every fleet account by name on the contact form is that same
 * page's data through a different door. The names of an operator's customer
 * accounts are exactly the sort of thing the permission exists to withhold. When
 * the answer is no, no query runs at all.
 *
 * TENANT. The tenant is named explicitly in the query. The db.ts guard scopes
 * nothing while enforcement is off (its documented default, and the state
 * production runs in), so a picker leaning on the guard would list every
 * workspace's fleet NAMES — a cross-tenant read of customer accounts, in a
 * dropdown, before anyone has saved anything. `activeTenantPredicate` gives the
 * active tenant under enforcement, throws when enforcement is on but this request
 * has no scope, and yields no filter only in the dormant single-tenant mode where
 * there is nothing yet to filter by.
 *
 * One helper, one query: every caller gets both gates instead of each page
 * hand-rolling a `fleet.findMany` that may or may not remember either.
 */
export async function fleetPicker(): Promise<FleetPicker> {
  const user = await requireUser();
  if (!(await hasAnyPermission(user, "fleets.view", "fleets.manage"))) return NO_FLEET_PICKER;
  const fleets = await prisma.fleet.findMany({
    where: { ...activeTenantPredicate("fleet picker") },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
    take: 500,
  });
  return { canLink: true, fleets };
}
