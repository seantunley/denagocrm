/**
 * The composite-tenant-foreign-key rule, kept PURE and dependency-free — no
 * `server-only`, no Prisma, no AsyncLocalStorage — so it can be imported straight
 * from `node:test`.
 *
 * This is NOT an acting-tenant resolver and must never become one. Resolving who
 * is ACTING is `actingTenantId()` in ./actingTenant. This module answers the
 * narrower question that several tables have no choice about: given the tenants of
 * the rows a new row POINTS AT, what may that row claim?
 */

/**
 * The tenant a row may claim given the tenants of the records it references.
 *
 * `AuditLog`, `Communication` and `Activity` carry COMPOSITE foreign keys —
 * `(tenantId, contactId) → Contact(tenantId, id)`, and the same for `leadId` and
 * `conversationId` — added by migrations 20260727140000 / 160000 and validated by
 * 180000. On those tables the row's tenant is not a free choice: it must equal the
 * tenant of everything it references, or PostgreSQL refuses the insert.
 *
 * That refusal is not hypothetical. On 2026-08-07 creating a lead for a NEW person
 * failed three times in four minutes on `AuditLog_tenantId_contactId_fkey`, because
 * the just-created contact was written with `tenantId` NULL while the acting tenant
 * resolved to a real id. The lead was already committed each time, so every
 * "failure" left a duplicate behind.
 *
 * The rule, therefore:
 *
 *   - nothing referenced resolves → `fallback` (nothing constrains the row);
 *   - every reference agrees      → that tenant;
 *   - references disagree         → NULL.
 *
 * The last case gives up attribution on this one row rather than failing the write.
 * A composite key with a NULL column is not checked at all (MATCH SIMPLE), so NULL
 * is the only value that can satisfy two parents that disagree.
 *
 * `referenced` holds one entry per reference that RESOLVED TO A ROW, and holds the
 * row's RAW `tenantId` — including NULL. Substituting an acting tenant for a NULL
 * parent here is precisely the 2026-08-07 defect, so any helper that does so must
 * not be composed into this list.
 */
export function agreedTenantId(
  referenced: ReadonlyArray<string | null>,
  fallback: string | null,
): string | null {
  if (referenced.length === 0) return fallback;
  const first = referenced[0];
  return referenced.every((value) => value === first) ? first : null;
}
