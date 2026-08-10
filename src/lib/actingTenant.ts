import "server-only";
import { writeTenantId } from "./tenantWrite";
import { getActiveTenantId } from "./auth";
import { decideActingTenant } from "./actingTenantRule";

/**
 * The tenant that owns a row the CURRENT STAFF USER is creating.
 *
 * Use this for every user-originated write that goes through `basePrisma` or a
 * transaction the db.ts guard does not auto-stamp. See {@link decideActingTenant}
 * for why `writeTenantId() ?? DEFAULT_TENANT_ID` is not it.
 *
 * NOT for background work — cron, webhooks, queue drains — which has no session.
 * Those already carry their own scope (a channel endpoint, an explicit tenant
 * argument) and should keep using it; `getActiveTenantId()` would return null
 * there and this would fall back to the founding tenant, which is exactly the
 * bug in the other direction.
 *
 * Throws (fail closed) when enforcement is on with no usable scope, because
 * `writeTenantId()` does.
 */
export async function actingTenantId(): Promise<string> {
  return decideActingTenant({
    enforcedTenantId: writeTenantId(),
    sessionTenantId: await getActiveTenantId(),
  });
}
