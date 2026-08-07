/**
 * The two pure decisions the stranded-completion sweep is built on.
 *
 * Deliberately NOT `server-only` and importing no database client: both are
 * answers a reviewer has to be able to check without a database, and both were
 * got wrong in a way that only shows up under conditions a source read cannot
 * reproduce (a second tenant; a quote signed by another path).
 */
import { DEFAULT_TENANT_ID } from "@/lib/tenant";

/** One tenant condition: an exact owner, or a set of acceptable owners. */
export type TenantClause = { tenantId: string | null } | { OR: { tenantId: string | null }[] };

/**
 * A Prisma `where` fragment confining a query to one tenant's rows.
 *
 * Expressed as `AND` rather than as a bare `tenantId` key so that spreading it
 * into a query can never collide with that query's own `OR` — the lease claim
 * needs a top-level `OR`, and a fragment that quietly overwrote it would drop
 * the tenant boundary or the lease condition depending on spread order. `AND` is
 * also the honest shape: this is a condition added to whatever the caller asked
 * for, never a replacement for it.
 */
export type SweepTenantWhere = { AND: TenantClause[] };

/**
 * The tenant fragment for a row whose owner is already known EXACTLY — the
 * completion path, which has just loaded the request and can read its
 * `tenantId`, including when that is null. Same shape as {@link sweepTenantWhere}
 * so one type threads through both paths.
 */
export function exactTenantWhere(tenantId: string | null): SweepTenantWhere {
  return { AND: [{ tenantId }] };
}

/**
 * The tenant predicate for one sweep, as an EXPLICIT `where` fragment.
 *
 * ── WHY EXPLICIT ───────────────────────────────────────────────────────────
 *
 * The db.ts guard rewrites args only when `tenantEnforcing()` is true, and it is
 * false in every environment today — so ambient scope confines NOTHING in
 * production. The sweep reads requests, recipients, quotes, leads and job cards,
 * then EMAILS A SIGNED CONTRACT, using SMTP credentials that `sendEmail`
 * resolves from the ambient tenant. An unscoped sweep running with the founding
 * tenant's scope bound (which is what dormant cron mode binds) could therefore
 * select another tenant's stranded request and post their contract out over the
 * founding tenant's mail identity. That is not a leak of metadata; it is the
 * document itself, to the wrong recipients, from the wrong sender.
 *
 * So every query carries this fragment, and `recoverStrandedCompletions` takes
 * the tenant id as an argument rather than inferring it.
 *
 * ── WHY NULL IS THE FOUNDING TENANT'S, AND ONLY ITS ────────────────────────
 *
 * `tenantId` is still nullable and unstamped on the write path: the guard's
 * `stampCreate` runs only under enforcement, so a signature request created
 * TODAY lands with `tenantId` NULL. A plain `{ tenantId: DEFAULT_TENANT_ID }`
 * would therefore match none of the current data and silently switch the whole
 * recovery off — the failure mode being fixed, reintroduced by the fix.
 *
 * Treating NULL as the founding tenant's is not an invention; it is the rule the
 * data was migrated under. `20260722147000_tenant_documents_isolation` backfills
 * every signing table with exactly
 *
 *     UPDATE "SignatureRequest" SET "tenantId" = 'tenant_denago_cpt'
 *      WHERE "tenantId" IS NULL
 *
 * and `withTenantWrite` stamps DEFAULT_TENANT_ID for the same reason. A NULL row
 * is an un-stamped founding-tenant row.
 *
 * For ANY OTHER tenant a NULL row is categorically not theirs, so they get the
 * strict equality — which is what keeps the leak closed. And once enforcement is
 * on, RLS answers `"tenantId" = current_setting('app.current_tenant')`, so NULL
 * rows disappear for everyone including the founding tenant; this predicate is
 * then a narrowing of an already-closed set, never a widening of it.
 */
export function sweepTenantWhere(tenantId: string): SweepTenantWhere {
  if (!tenantId || typeof tenantId !== "string") {
    throw new Error("A recovery sweep needs a concrete tenant id — it sends mail on that tenant's behalf");
  }
  if (tenantId === DEFAULT_TENANT_ID) {
    // Legacy un-stamped rows ARE this tenant's; see above.
    return { AND: [{ OR: [{ tenantId: DEFAULT_TENANT_ID }, { tenantId: null }] }] };
  }
  return { AND: [{ tenantId }] };
}

/**
 * Did THIS signature request's completion transaction sign the source record?
 *
 * ── THE QUESTION THAT HAS TO BE ASKED ──────────────────────────────────────
 *
 * `sourceSigned` gates the won-effects: the `quote_signed` journey event, the
 * lead-won emission, referral crediting, the audit line and the staff push. In
 * the original transaction it means one precise thing — that a CONDITIONAL
 * update (`... WHERE signedAt IS NULL`) matched one row, i.e. *this* transaction
 * changed the source from unsigned to signed.
 *
 * Recovery cannot re-run that update, and asking the obvious substitute — "does
 * the source have a signedAt?" — is a DIFFERENT question. A request that
 * completed after some other path had already signed the quote (the legacy
 * /sign endpoint, a second request, a person marking it signed) answers yes to
 * the substitute and no to the real one. Recovering it as though it had done the
 * signing re-fires every won-effect for a sale that was already booked.
 *
 * ── THE EVIDENCE ───────────────────────────────────────────────────────────
 *
 * `signedPdfHash` is the SHA-256 of the sealed PDF, written onto the source by
 * the SAME conditional update that means "we signed it", and unique to this
 * request — every sealed PDF embeds this request's own certificate page, signer
 * names, timestamps and IPs, so no two requests produce the same bytes. So the
 * source carrying OUR hash is immutable proof that our update is the one that
 * landed, and a source signed by anyone else carries their hash or none.
 *
 * Returns false whenever either side is missing, which is the conservative
 * direction: the customer still gets their signed contract, and a won-effect
 * that fired once is not fired a second time.
 */
export function sourceSignedByThisRequest(
  requestPdfHash: string | null | undefined,
  sourcePdfHash: string | null | undefined,
): boolean {
  if (!requestPdfHash || !sourcePdfHash) return false;
  return requestPdfHash === sourcePdfHash;
}
