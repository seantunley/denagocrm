import "server-only";
import { prisma } from "./db";
import { requireUser } from "./auth";
import { hasAnyPermission } from "./permissions";
import { recoverableActiveTenantPredicate } from "./tenantPredicate";
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
 * nothing while enforcement is off (its documented rollback mode), so a picker
 * leaning on the guard would list every workspace's fleet NAMES. The async
 * predicate preserves the ordinary ambient-scope rule and, when an enforced
 * Server Action/API request lost only its ALS carrier, re-derives the same
 * validated staff workspace before building the explicit predicate. A genuinely
 * unresolved or sessionless request still fails closed.
 *
 * One helper, one query: every caller gets both gates instead of each page
 * hand-rolling a `fleet.findMany` that may or may not remember either.
 */
export async function fleetPicker(): Promise<FleetPicker> {
  const user = await requireUser();
  if (!(await hasAnyPermission(user, "fleets.view", "fleets.manage"))) return NO_FLEET_PICKER;
  const tenant = await recoverableActiveTenantPredicate("fleet picker");
  const fleets = await prisma.fleet.findMany({
    where: { ...tenant },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
    take: 500,
  });
  return { canLink: true, fleets };
}
