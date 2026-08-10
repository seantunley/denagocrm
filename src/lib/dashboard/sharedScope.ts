import { DEFAULT_TENANT_ID } from "@/lib/tenant";

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
 * Dashboard.tenantId is nullable — rows predate tenancy and nothing stamped them
 * while the guard was dormant — so the founding tenant owns the untagged ones,
 * exactly as BotFlow and Journey do. A second workspace sees only its own.
 *
 * Import-free so the rule is executed by a test rather than pattern-matched.
 */
export function sharedInTenant(tenantId: string): {
  sharedAt: { not: null };
  OR?: Array<{ tenantId: string | null }>;
  tenantId?: string;
} {
  const shared = { sharedAt: { not: null } } as const;
  return tenantId === DEFAULT_TENANT_ID
    ? { ...shared, OR: [{ tenantId }, { tenantId: null }] }
    : { ...shared, tenantId };
}
