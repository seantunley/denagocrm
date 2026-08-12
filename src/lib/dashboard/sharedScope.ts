// `flowTenantWhere` is #463's rename of `legacyFlowTenant`: the old name became
// a lie once the rule stopped being a legacy allowance. Same function, and the
// reasoning below is unchanged.
import { flowTenantWhere } from "@/lib/flowTenantScope";

/**
 * `where` fragment for a dashboard PUBLISHED to a given workspace.
 *
 * "Shared" has to mean *shared inside this tenant*. Both published-dashboard
 * reads leaned on the scoped `prisma` client for that boundary, and db.ts is
 * explicit that there is none:
 *
 *     if (!tenantEnforcing()) return args;   // always, today
 *
 * So a bare `sharedAt: { not: null }` matched EVERY tenant's published
 * dashboards. Tenant A publishes "Sales"; tenant B lists it, opens it by slug,
 * and reads its title, layout, card configuration and any markdown inside it.
 *
 * WHOSE ROWS COUNT is not this module's rule to invent. `Dashboard.tenantId` is
 * nullable — rows predate tenancy and nothing stamped them while the guard was
 * dormant — so the founding tenant owns the untagged ones and a second workspace
 * sees only its own. That is `flowTenantWhere`, which has been on main since
 * #452 and is what BotFlow, Journey and statistics.ts already apply. This file
 * carried its own copy of it, which is one more place for the rule to drift: get
 * the legacy clause wrong here and every dashboard an existing install has
 * silently disappears from the switcher, exactly as Publish silently died for
 * flows.
 *
 * So the only thing added here is `sharedAt`, which is the one part that IS about
 * dashboards.
 *
 * (The name says "flow" for where it was first needed, not for what it decides —
 * see its doc comment. A rename belongs in the change that renames every caller,
 * not in this one.)
 */
export function sharedInTenant(tenantId: string): {
  sharedAt: { not: null };
  OR?: Array<{ tenantId: string | null }>;
  tenantId?: string;
} {
  return { sharedAt: { not: null }, ...flowTenantWhere(tenantId) };
}
