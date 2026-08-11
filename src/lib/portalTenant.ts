import "server-only";
import { basePrisma } from "./db";
import { currentTenantScope } from "./tenantScope";

/**
 * The workspace that owns a row the CUSTOMER PORTAL is writing.
 *
 * It is the CONTACT's workspace, never the ambient scope and never a default. A
 * portal request carries an OTP session for a customer, not a staff session, so
 * there is no acting workspace to resolve — the only honest source is the record
 * the customer is acting as.
 *
 * `currentTenantScope()?.tenantId ?? null` was the previous answer everywhere in
 * the portal. It is correct under enforcement and null everywhere else, because
 * no scope is entered while enforcement is dormant. Every portal case, message,
 * notification, upload, preference row and profile-change request has therefore
 * been written tenantless, and would vanish from the workspace that must answer
 * it the moment enforcement flips on.
 *
 * The enforced scope still wins when present: it has already been validated
 * against this contact, and preferring it keeps one authority rather than two.
 *
 * Null only when the contact itself is unowned — a pre-tenancy row awaiting
 * backfill. Inventing an owner there is the defect in the other direction, and
 * on rows with a composite `(tenantId, contactId)` foreign key it is not even
 * insertable: the child must match the parent, NULL included.
 *
 * Lives in its own module because BOTH `portal.ts` and `portalExpansion.ts` need
 * it. A second copy is how this codebase ended up with four implementations of
 * the acting-tenant rule.
 */
export async function portalTenantId(contactId: string): Promise<string | null> {
  const scoped = currentTenantScope()?.tenantId;
  if (scoped) return scoped;
  const rows = await basePrisma.$queryRaw<Array<{ tenantId: string | null }>>`
    SELECT "tenantId" FROM "Contact" WHERE "id" = ${contactId} LIMIT 1`;
  return rows[0]?.tenantId ?? null;
}
