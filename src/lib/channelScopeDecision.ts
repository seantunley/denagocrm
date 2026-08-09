/**
 * Inbound-channel webhook: what to do with ONE event, given the tenancy mode and
 * what the endpoint→tenant lookup came back with.
 *
 * WHY THIS EXISTS ────────────────────────────────────────────────────────────
 *
 * A WhatsApp / Messenger / Instagram POST is authenticated by ONE install-global
 * `META_APP_SECRET` HMAC. That signature proves the payload came from Meta. It
 * says NOTHING about which of OUR tenants the endpoint inside it belongs to —
 * only the endpoint id in the event does (WhatsApp phone-number id, Facebook
 * Page id, Instagram account id), looked up in `ChannelIdentity`.
 *
 * That lookup used to run ONLY under enforcement (`withChannelTenantScope`
 * opened with `if (!tenantEnforcing()) return fn()`). Enforcement is off in
 * production and stays off for a while, so a SECOND tenant whose number or Page
 * is subscribed to the same Meta app had its inbound traffic processed with no
 * tenant scope at all: its conversations, contacts, leads and bot sessions were
 * filed under the FOUNDING tenant, and replies went out from the founding
 * tenant's number. The signature check cannot catch that — every tenant on the
 * app signs with the same secret.
 *
 * THE ASYMMETRY ─────────────────────────────────────────────────────────────
 *
 * Resolving in every mode is only half the fix; the other half is NOT turning
 * dormant mode strict. An existing single-tenant install has an EMPTY
 * `ChannelIdentity` — the mapping is populated by a manual pre-enforcement step
 * (`scripts/backfill-channel-identities.ts`), deliberately not run on deploy. If
 * "unmapped" meant "reject" while enforcement is off, every WhatsApp message
 * would start failing the moment this ships. So:
 *
 *                  │ resolved                    │ unmapped
 *   ───────────────┼─────────────────────────────┼──────────────────────────────
 *   enforcing      │ run in that tenant's scope   │ SKIP the event (fail closed)
 *   dormant (off)  │ run in that tenant's scope   │ run UNSCOPED — today's path
 *
 * We always look; only the MISS is handled differently. Dormant + resolved is
 * the new cell, and it is the one that files a second tenant's traffic correctly
 * long before enforcement flips.
 *
 * A lookup that THREW is not the same as a miss, and gets the same asymmetry for
 * the same reason: dormant did no query at all before this change, so a missing
 * `ChannelIdentity` table or a database blip must not be able to turn a working
 * webhook into a 500.
 *
 * This module has NO imports on purpose, so the rule above is EXECUTED by a test
 * (tests/channelTenantScope.test.ts) rather than pattern-matched in source.
 */

/** What the `ChannelIdentity` lookup came back with, for one event. */
export type ChannelResolution =
  /** The endpoint maps to an enabled identity owned by an ACTIVE tenant. */
  | { status: "resolved"; tenantId: string }
  /**
   * No usable mapping: no row, a disabled endpoint, or a suspended/deleted
   * tenant. Also the normal state of a single-tenant install that never ran the
   * backfill — which is exactly why this cannot mean "reject" while dormant.
   */
  | { status: "unmapped" }
  /** The lookup itself threw (table absent, connection blip). NOT a miss. */
  | { status: "failed" };

/** What the caller must do with the event. */
export type ChannelScopeAction =
  /** Run the event's work INSIDE `tenantId`'s scope. */
  | { run: "scoped"; tenantId: string }
  /** Run the event's work with NO scope — byte-for-byte the pre-tenancy path. */
  | { run: "unscoped" }
  /** Do NOT run the work: hand the event to `onUnresolved` (fail closed). */
  | { run: "unresolved" }
  /** Do NOT run the work: re-throw the lookup error so the delivery is retried. */
  | { run: "rethrow" };

/**
 * The whole mode/resolution policy, in one place.
 *
 * `enforcing` is `tenantEnforcing()`; `resolution` is the outcome of
 * `resolveChannelTenant(channel, externalId)`.
 */
export function decideChannelScope(
  enforcing: boolean,
  resolution: ChannelResolution,
): ChannelScopeAction {
  // A resolved endpoint is scoped in EVERY mode. This is the fix: the tenancy
  // mode decides how a MISS is handled, never whether we bother to look.
  if (resolution.status === "resolved") {
    return { run: "scoped", tenantId: resolution.tenantId };
  }

  if (resolution.status === "failed") {
    // Enforcing: a lookup we could not COMPLETE must not be quietly downgraded
    // to "unmapped" and dropped — propagate, so the webhook 500s and Meta
    // redelivers a real tenant's message instead of us losing it.
    // Dormant: before this change there was no query here at all, so a lookup
    // failure must never be able to break a webhook that works today.
    return enforcing ? { run: "rethrow" } : { run: "unscoped" };
  }

  // Unmapped. Enforcing → fail closed (never process against the wrong tenant
  // or unscoped). Dormant → the pre-change path: run it, unscoped.
  return enforcing ? { run: "unresolved" } : { run: "unscoped" };
}
