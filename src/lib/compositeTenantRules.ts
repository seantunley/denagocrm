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
 * THREE POLICIES, DELIBERATELY SEPARATE — do not reunify them.
 *
 *   {@link agreedTenantId}           operational rows being written against parents
 *                                    that are all being resolved at once: a new
 *                                    Communication's Contact and Lead. A
 *                                    contradiction is REFUSED.
 *   {@link attachedTenantId}         a row JOINING one parent that already exists
 *                                    and whose owner is already settled: a
 *                                    Communication joining an EXISTING Conversation.
 *                                    That parent decides outright, NULL included.
 *   {@link bestEffortAgreedTenantId} AuditLog ONLY. A contradiction degrades to
 *                                    NULL so the audited operation still happens.
 *
 * The first and the third looked like one function with a flag, and that is exactly
 * how the operational path acquired audit's forgiveness. The difference is not a
 * preference: for an audit row, losing attribution is better than failing the thing
 * being audited, because the operation is the point and the log is the record of it.
 * For a Communication or an Activity the row IS the thing, and writing it unowned
 * against contradictory parents is a worse outcome than not writing it.
 *
 * The first and the second differ over exactly one input, `[A, NULL]`, and they must:
 * see {@link attachedTenantId}.
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
 * The tenant a row must claim when it ATTACHES ITSELF to a parent row that already
 * exists and already has an owner. The parent decides — verbatim, NULL included.
 *
 * The only caller today is the `Communication.create` hook in db.ts, for the
 * conversation the message joins. `Communication(tenantId, conversationId) →
 * Conversation(tenantId, id)` is a composite foreign key, so a message on an
 * existing thread has exactly one owner available to it: the thread's.
 *
 * WHY THIS IS NOT {@link agreedTenantId}, WHICH IS ALSO ABOUT COMPOSITE KEYS.
 *
 * They differ over one input, `[A, NULL]`, and that input is a production outage.
 * On 2026-08-11 every note typed onto a lead whose conversation predates the tenant
 * backfill failed on `Communication_tenantId_conversationId_fkey`: the lead is owned
 * (`A`), its conversation is not (`NULL`), and the message had been stamped from the
 * lead. `agreedTenantId` calls that pair a contradiction and refuses it — correct
 * for two parents being resolved TOGETHER for a brand-new row, where refusing means
 * the row is never written and nothing is lost. Refusing here means refusing the
 * note a person is typing, on a record that works in every other respect, for as
 * long as the backfill takes. That is the outage, not the fix for it.
 *
 * And `[A, NULL]` is not a contradiction here, because the two values are not two
 * opinions about one thing. The conversation is DOWNSTREAM of the subject: it
 * carries `Conversation(tenantId, contactId) → Contact(tenantId, id)` itself, so it
 * already agrees with the subject or is not yet claimed at all. NULL from a parent
 * is the second case — "this cluster is still awaiting backfill" — and the honest
 * answer for a child joining it is the same NULL.
 *
 * NULL IS WRITABLE HERE, AND THAT IS THE POINT. A composite key with a NULL column
 * is not checked at all (MATCH SIMPLE), so `Communication(tenantId=NULL,
 * conversationId=…, leadId=…)` satisfies BOTH keys — the unowned conversation and
 * the owned lead. The message lands unowned alongside the thread it belongs to, and
 * a later backfill claims the whole cluster together. That is the same rule
 * `conversationTenantId` follows one level up when a conversation is opened about an
 * unowned contact, and the two have to agree or the pair drifts apart.
 *
 * THE ONE CASE THAT IS STILL REFUSED: two DIFFERENT non-NULL owners — the subject in
 * one workspace, the thread in another. There is no value that row can carry. The
 * subject's violates the conversation key, the conversation's violates the contact
 * or lead key, and NULL — the value that appeases both — appeases them by switching
 * both keys OFF, writing a cross-tenant row the database is no longer allowed to
 * object to. Same conclusion as {@link agreedTenantId}, for the same reason, and it
 * is why that reasoning is not repeated at the call site.
 *
 * An absent claim (`undefined`) and an empty one (`""`) are no claim at all: the
 * writer said nothing about an owner, so there is nothing to contradict and the
 * parent simply supplies one.
 */
export function attachedTenantId(
  parentTenantId: string | null,
  claimed: string | null | undefined,
): string | null {
  const parent = parentTenantId || null;
  const child = claimed || null;
  if (child !== null && parent !== null && child !== parent) {
    throw new TenantParentConflictError([child, parent]);
  }
  // Every surviving branch: the parent's answer, whatever it is.
  return parent;
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
