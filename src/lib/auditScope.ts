// Deliberately NOT "server-only": a pure fragment builder — no database, no
// secrets — so the rule can be executed by a test rather than pattern-matched.
import { Prisma } from "@prisma/client";

/**
 * WHOSE AUDIT EVENTS A SIGNED-IN PERSON MAY READ: THEIR WORKSPACE'S, EXACTLY.
 *
 * The audit screen and its CSV export read "AuditEvent" through `basePrisma`,
 * which bypasses the tenant guard and row-level security on purpose — so the
 * workspace has to be written into the query by hand. It was, behind
 * `NOT tenantEnforcing() OR …`, and that made the predicate vanish whenever
 * enforcement was off: the default everywhere but production, and the rollback
 * mode. In that mode anyone holding `audit.view` or `audit.export` read every
 * workspace's trail — who did what, to which record, with a free-text summary
 * of each change.
 *
 * The switch existed so that events written before they were stamped (no
 * workspace) would not vanish from the screen. That premise has expired. Every
 * event now carries the workspace it was done in (lib/audit.ts, auditTenantIds),
 * and the ones that carry none are the ones that have no owner: platform-admin
 * actions and work done under a system scope.
 *
 * So, in BOTH modes:
 *
 *   - an event is listed and exported for the workspace in its "tenantId", and
 *     for no other;
 *   - an event with NO workspace is nobody's: no workspace is shown it or given
 *     it in an export. Production has behaved this way since enforcement went
 *     on, so nothing a workspace sees there changes (49 of 1,043 events had no
 *     workspace on 2026-10-10);
 *   - a sign-in that resolves to no workspace reads nothing — `"tenantId" = NULL`
 *     is never true. The old `IS NOT DISTINCT FROM` matched NULL to NULL and
 *     handed exactly that session the unowned events.
 */
export function ownAuditEvents(tenantId: string | null): Prisma.Sql {
  return Prisma.sql`"tenantId" = ${tenantId}`;
}
