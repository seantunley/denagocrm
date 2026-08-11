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

/**
 * The workspace that owns a CASE — verbatim, NULL included.
 *
 * A message on a case, and the status change that accompanies it, belong to the
 * CASE. Not to the customer who posted it, and not to the staff member who
 * clicked. This distinction is not stylistic: `CustomerCaseMessage` has a
 * composite foreign key `(tenantId, caseId) → CustomerCase(tenantId, id)`, so a
 * message claiming any owner other than its case's is not insertable at all.
 *
 * That is exactly how an earlier version of this work would have broken replies
 * to existing tickets. Production is full of tenantless cases awaiting backfill;
 * stamping a reply with the viewer's tenant would have produced
 * `(tenant_denago_cpt, C1)` against a parent of `(NULL, C1)` — rejected by
 * Postgres, and the customer simply cannot reply any more.
 *
 * So NULL is returned as NULL. An unowned case keeps unowned children, and a
 * later backfill claims the whole thread together, which is the only way they
 * can stay consistent with each other.
 */
export async function tenantOfCase(caseId: string): Promise<string | null> {
  const rows = await basePrisma.$queryRaw<Array<{ tenantId: string | null }>>`
    SELECT "tenantId" FROM "CustomerCase" WHERE "id" = ${caseId} LIMIT 1`;
  return rows[0]?.tenantId ?? null;
}
