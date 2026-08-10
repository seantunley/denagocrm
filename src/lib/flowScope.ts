import "server-only";
import { DEFAULT_TENANT_ID } from "./tenant";
import { writeTenantId } from "./tenantWrite";
import { legacyFlowTenant } from "./flowTenantScope";

/**
 * The tenant whose chatbot flows the current request may see and change.
 *
 * `writeTenantId()` is null while enforcement is dormant and throws when a scope
 * should exist but does not, so this is fail-closed under enforcement and the
 * founding tenant before it.
 */
export function flowTenantId(): string {
  return writeTenantId() ?? DEFAULT_TENANT_ID;
}

/**
 * `where` fragment scoping a BotFlow query to that tenant.
 *
 * The runtime resolver has scoped its reads since #402; the BUILDER never did.
 * Every editor surface — open, save, rename, duplicate, delete, publish, restore,
 * simulate, insert a block, run the AI draft — addressed a flow by bare `id`, and
 * `findUnique({ where: { id } })` cannot be narrowed by the db.ts guard even once
 * enforcement is on, because `id` is already the unique selector. So a second
 * workspace's owner holding a flow id could read and rewrite another tenant's
 * live conversation graph, before and after the flip.
 *
 * Spread this into a `findFirst`/`updateMany`/`deleteMany` — never `findUnique`,
 * `update` or `delete`, which take a unique selector and cannot carry the tenant
 * predicate with it.
 */
export function flowScope(): ReturnType<typeof legacyFlowTenant> {
  return legacyFlowTenant(flowTenantId());
}
