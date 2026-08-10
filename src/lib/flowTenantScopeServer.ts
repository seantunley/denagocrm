import "server-only";
import { DEFAULT_TENANT_ID } from "./tenant";
import { writeTenantId } from "./tenantWrite";
import { nullableTenantWhere, type NullableTenantWhere } from "./flowTenantScope";

/**
 * Request-bound bindings of {@link ./flowTenantScope} for the chatbot
 * ADMINISTRATION surface — the flow builder, its version/blocks/simulator tools,
 * the analytics workspace and the chatbot settings page.
 *
 * Every one of those already calls `requireOwner()`, so this is not an
 * authentication gap. It is that "an owner" says nothing about WHICH workspace,
 * and the guarded `prisma` client only adds the tenant predicate when
 * `tenantEnforcing()` is true — which it is not in production. Until it is, an
 * administration query that does not name the tenant itself runs globally, so a
 * second workspace's owner could list, open, edit, publish, roll back or delete
 * another workspace's flows.
 *
 * Same resolution as `outboxTenantId()` / the chatbot runtime's `flowTenantId()`:
 * the scoped tenant under enforcement, the founding tenant while dormant, and a
 * throw (never a silent global fallback) when a scope was expected and missing.
 */

/** The workspace whose flows this request administers. */
export function builderTenantId(): string {
  return writeTenantId() ?? DEFAULT_TENANT_ID;
}

/**
 * `where` fragment selecting only the rows this workspace owns, for models whose
 * `tenantId` is still nullable (BotFlow, Journey, LibraryDocument). Spread it
 * alongside the rest of a filter: `where: { id, ...builderOwnedWhere() }`.
 *
 * Models with a NOT NULL `tenantId` — BotFlowVersion, BotFlowPublication,
 * BotFlowOutbox, BotFlowEvent, AppSetting — take a strict
 * `tenantId: builderTenantId()` instead; there are no legacy rows to rescue and
 * a strict predicate is the stronger one.
 */
export function builderOwnedWhere(): NullableTenantWhere {
  return nullableTenantWhere(builderTenantId());
}
