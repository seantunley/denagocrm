import "server-only";
import { basePrisma } from "./db";
import { actingTenantId } from "./actingTenant";
import { agreedTenantId } from "./compositeTenantRules";

/**
 * WHO OWNS A ROW THAT HANGS OFF A CUSTOMER RECORD.
 *
 * Not a fourth acting-tenant resolver — it does not resolve one at all. `Who is
 * acting?` is {@link actingTenantId}, imported. This module answers the question
 * that comes AFTER it for tables whose tenant is not a free choice: `Communication`
 * and `Activity` (and `AuditLog`, via lib/audit.ts) carry COMPOSITE foreign keys to
 * `Contact`, `Lead` and `Conversation`, so the row must claim the tenant of what it
 * points at or PostgreSQL refuses the insert outright.
 *
 * The 2026-08-10 production audit found `Communication` 19 of 72 unowned (17 of them
 * written since the July backfill) and `Activity` 14 of 61 (11 since). Every one of
 * those writers took its tenant from `writeTenantId()`, which returns null while
 * enforcement is dormant, or from nothing at all. Swapping them to the acting tenant
 * alone would not have fixed it — it would have reproduced the 2026-08-07 outage,
 * where an audit row claiming the acting tenant against a freshly-created,
 * still-unstamped contact was refused three times in four minutes and left two
 * duplicate leads behind. So the parent decides, and the acting tenant is only the
 * answer when there is no parent to ask.
 *
 * NOTE for the actingTenant.ts reconciliation: this deliberately does NOT compose
 * `inheritedTenantId()`. The agreement rule needs each parent's RAW `tenantId`,
 * NULL included — a helper that substitutes an acting tenant for a null parent
 * would put back exactly the value the composite key rejects.
 */

/**
 * Read through `basePrisma` deliberately: this runs BEFORE the row's tenant is
 * known, so the guarded client would have nothing to scope by (and under
 * enforcement would fail closed on the very lookup that decides the scope). Same
 * narrow pre-scope boundary `resolvePortalTenant` and `resolveChannelTenant` use —
 * one indexed row, one column.
 */
const PARENT_READERS = {
  contactId: (id: string) => basePrisma.contact.findUnique({ where: { id }, select: { tenantId: true } }),
  leadId: (id: string) => basePrisma.lead.findUnique({ where: { id }, select: { tenantId: true } }),
  conversationId: (id: string) =>
    basePrisma.conversation.findUnique({ where: { id }, select: { tenantId: true } }),
  communicationId: (id: string) =>
    basePrisma.communication.findUnique({ where: { id }, select: { tenantId: true } }),
  activityId: (id: string) => basePrisma.activity.findUnique({ where: { id }, select: { tenantId: true } }),
} as const;

export type CustomerRecordRefs = Partial<
  Record<keyof typeof PARENT_READERS, string | null | undefined>
>;

/**
 * The tenant a new row may claim, derived from the records it points at, falling
 * back to the acting tenant when it points at nothing.
 *
 * An id that resolves to no row is skipped: it constrains nothing here, and the
 * insert will fail on its own single-column foreign key, which is the correct place
 * for that failure to surface.
 */
export async function customerRecordTenantId(refs: CustomerRecordRefs): Promise<string | null> {
  const wanted = (Object.keys(PARENT_READERS) as Array<keyof typeof PARENT_READERS>)
    .map((key) => ({ key, id: refs[key] }))
    .filter((ref): ref is { key: keyof typeof PARENT_READERS; id: string } => Boolean(ref.id));

  // Only pay for the acting-tenant resolution when there is no parent to ask — the
  // common case has one, and the parent decides.
  if (wanted.length === 0) return actingTenantId();

  const rows = await Promise.all(wanted.map((ref) => PARENT_READERS[ref.key](ref.id)));
  const referenced = rows
    .filter((row): row is { tenantId: string | null } => row != null)
    .map((row) => row.tenantId);

  if (referenced.length === 0) return actingTenantId();
  return agreedTenantId(referenced, null);
}
