/**
 * The composite-tenant-foreign-key rule, kept PURE and dependency-free — no
 * `server-only`, no Prisma, no AsyncLocalStorage — so it can be imported straight
 * from `node:test`.
 *
 * This is NOT an acting-tenant resolver and must never become one. Resolving who
 * is ACTING is `actingTenantId()` in ./actingTenant. This module answers the
 * narrower question that several tables have no choice about: given the tenants of
 * the rows a new row POINTS AT, what may that row claim?
 *
 * TWO POLICIES, DELIBERATELY SEPARATE — do not reunify them.
 *
 *   {@link agreedTenantId}           operational rows: Communication, Activity.
 *                                    A contradiction is REFUSED.
 *   {@link bestEffortAgreedTenantId} AuditLog ONLY. A contradiction degrades to
 *                                    NULL so the audited operation still happens.
 *
 * They looked like one function with a flag, and that is exactly how the operational
 * path acquired audit's forgiveness. The difference is not a preference: for an
 * audit row, losing attribution is better than failing the thing being audited,
 * because the operation is the point and the log is the record of it. For a
 * Communication or an Activity the row IS the thing, and writing it unowned against
 * contradictory parents is a worse outcome than not writing it.
 */

/**
 * The records a new row points at do not agree on an owner.
 *
 * Named, and carrying the values, so a caller can tell a genuine contradiction
 * apart from a lookup miss (which is silence, not an error) and so the message
 * that reaches a log says which tenants were in conflict.
 */
export class TenantParentConflictError extends Error {
  /** The raw parent tenants, in the order they were supplied. */
  readonly referenced: ReadonlyArray<string | null>;

  constructor(referenced: ReadonlyArray<string | null>) {
    const shown = referenced.map((value) => (value === null ? "NULL" : value)).join(", ");
    super(
      `The records this row points at belong to different workspaces (${shown}), so it has no owner it can claim.`,
    );
    this.name = "TenantParentConflictError";
    this.referenced = [...referenced];
  }
}

/** True when every entry is the same value — including "every entry is NULL". */
function allAgree(referenced: ReadonlyArray<string | null>): boolean {
  return referenced.every((value) => value === referenced[0]);
}

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
 * The rule:
 *
 *   - nothing referenced resolves  → `fallback` (nothing constrains the row);
 *   - every reference agrees       → that tenant, NULL included;
 *   - references disagree          → THROW {@link TenantParentConflictError}.
 *
 * WHY DISAGREEMENT IS REFUSED AND NOT NULLED. This returned NULL until 2026-08-11,
 * reasoning that a composite key with a NULL column is not checked at all (MATCH
 * SIMPLE), so NULL is the only value that can satisfy two parents that disagree.
 * The premise is true and the conclusion is backwards. Given `contactId → A` and
 * `leadId → B`, returning NULL writes `tenantId=NULL, contactId=A's, leadId=B's` —
 * and because the tenant column is NULL, MATCH SIMPLE stops checking BOTH composite
 * keys. The one mechanism that would have objected to a row spanning two workspaces
 * is switched off by the very value chosen to appease it. A detected contradiction
 * became an unowned cross-tenant row that the database could no longer refuse.
 *
 * `addCommunication()` takes `contactId` and `leadId`, authorises them
 * INDEPENDENTLY, then hands both here; Activity creation has the same multi-parent
 * shape. Authorisation stops most hostile pairings today, but the composite key is
 * the last line of defence and it is the only one that does not depend on every
 * caller having got its checks right.
 *
 * NOTE THE TWO CASES THAT ARE NOT CONTRADICTIONS AND STILL WORK:
 *
 *   [NULL]        a single parent that predates the backfill. Genuinely unowned,
 *   [NULL, NULL]  nothing to contradict, and NULL is the honest answer — this is
 *                 the transition case, and it is not refused.
 *
 * WHAT REFUSAL COSTS. `[A, NULL]` — one backfilled parent, one not — now throws
 * where it used to write a NULL row. That is a real behaviour change during the
 * rollout window and it will surface as a failed operation rather than a silent
 * one. It is the intended trade: NULL there does not merely lose attribution on
 * the new row, it disables the composite check against the OWNED parent too, and
 * `A` would violate the key against the unowned one. There is no safe value, so
 * the write does not happen.
 */
export function agreedTenantId(
  referenced: ReadonlyArray<string | null>,
  fallback: string | null,
): string | null {
  if (referenced.length === 0) return fallback;
  if (allAgree(referenced)) return referenced[0];
  throw new TenantParentConflictError(referenced);
}

/**
 * AUDIT ONLY. The same rule, except that a contradiction degrades to NULL instead
 * of refusing.
 *
 * An audit row exists to record that something happened. If the records it points
 * at disagree, refusing it would fail the operation being audited — trading a
 * complete log for a broken feature, and doing it at the exact moment the data is
 * already strange enough to be worth logging. So audit keeps the older, forgiving
 * behaviour, ON PURPOSE and in one clearly-named place.
 *
 * The cost is the same as it ever was, and is accepted HERE and nowhere else: the
 * resulting row has a NULL tenant, so its composite keys go unchecked. For a log
 * entry that is a loss of attribution. For a Communication or an Activity it would
 * be a cross-tenant row the database was prevented from objecting to — which is
 * why {@link agreedTenantId} refuses instead, and why these are two functions.
 */
export function bestEffortAgreedTenantId(
  referenced: ReadonlyArray<string | null>,
  fallback: string | null,
): string | null {
  if (referenced.length === 0) return fallback;
  return allAgree(referenced) ? referenced[0] : null;
}
