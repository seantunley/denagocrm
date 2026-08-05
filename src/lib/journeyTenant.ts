import { DEFAULT_TENANT_ID } from "./tenant";
import { writeTenantId } from "./tenantWrite";

/**
 * The ONE tenant a journey-engine slice reads AND writes as.
 *
 * TENANT SCOPING IN THE JOURNEY ENGINE IS EXPLICIT IN EVERY QUERY, never
 * inherited from the guard.
 *
 * The engine runs on the journeys cron, once per tenant per tick
 * (`runCronPerTenant`), and every phase both READS and WRITES: the scheduling
 * sweep reads leads, contacts, vehicles and segments and emits JourneyEvent
 * rows; the event pass reads pending events and active journeys and creates
 * JourneyRun rows that go on to SEND email and WhatsApp. The db.ts tenant
 * extension deliberately does not scope anything while enforcement is off
 * (`scopeArgs` returns its args untouched unless `tenantEnforcing()`), so a
 * query relying on it alone is UNSCOPED in every environment where
 * TENANT_ENFORCEMENT is unset — which is the default and the documented
 * rollback mode. A dormant or monitor rollout would then sweep every
 * workspace's active journeys from one tenant's slice and message another
 * workspace's customers. Unlike a bad read, that is not recoverable: the send
 * has happened.
 *
 * So each query names this value itself — the SAME value the events and runs
 * are stamped with, so what a slice reads and what it writes can never
 * disagree, and a tenant can never be derived from a row the query just looked
 * up. Under enforcement the guard overwrites the predicate with the identical
 * authoritative value (`scopeWhere` and `stampCreate` spread their own tenantId
 * LAST), so this is belt-and-braces there and load-bearing everywhere else.
 *
 * Strict equality, deliberately: a NULL-tenant row is un-owned, and matching it
 * — with `IS NOT DISTINCT FROM`, an `OR tenantId IS NULL`, or by leaving the
 * predicate off — would re-open the same hole the moment enforcement were ever
 * switched back off. Legacy rows were backfilled to the founding tenant by
 * migration 20260726200000_journey_tenant_isolation, so nothing real is skipped;
 * and a sweep that under-enrols is recoverable on the next tick, while one that
 * enrols across tenants is not.
 *
 * `writeTenantId()` returns null when GLOBAL (enforcement dormant, or a trusted
 * system scope) — the founding tenant stands in, so an event or run is never
 * written tenantless during the pre-enforcement window and a legacy row stays
 * reachable — and THROWS when enforcement is on with no usable scope, rather
 * than quietly falling back to everyone's data. That is the same posture the
 * guarded client already takes for a scopeless enforced query, not a second,
 * quieter rule.
 */
export function journeyTenantId(): string {
  return writeTenantId() ?? DEFAULT_TENANT_ID;
}
