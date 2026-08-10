/**
 * Who owns a workshop booking.
 *
 * Workshop bookings are `Activity` rows with `category: "workshop"`, and every
 * decision about them happens on the UNGUARDED path: `src/lib/bookingSlots.ts` and
 * `src/app/api/bookings/route.ts` both run inside `basePrisma.$transaction` for the
 * advisory lock, and `basePrisma` bypasses the db.ts tenant extension by design —
 * permanently, not just while enforcement is dormant. So four separate decisions
 * have to name the tenant by hand and they have to AGREE:
 *
 *   1. the tenant stamped on the new Activity,
 *   2. the capacity count that decides SLOT_TAKEN,
 *   3. the advisory-lock namespace the count is taken under,
 *   4. the availability read the customer is shown, and any later
 *      cancel / reschedule predicate.
 *
 * Disagreement between (2) and (4) shows a customer a free slot the booker then
 * refuses. Disagreement between (2) and (3) lets two bookers pass the same count
 * and overfill the slot. Getting (1) wrong files one workshop's bookings under
 * another workshop's name for ever.
 *
 * This module holds that one rule, and nothing else. It is dependency-free apart
 * from the founding-tenant constant (itself a pure, `server-only`-free module), so
 * the rule can be EXECUTED by a unit test rather than pattern-matched in source.
 */
import { DEFAULT_TENANT_ID } from "./tenant";

/** A stored booking, reduced to the column that decides ownership. */
export type BookingRow = { tenantId: string | null };

/** The ownership rule as a Prisma `where` fragment — see {@link bookingOwnedBy}. */
export type BookingTenantWhere =
  | { tenantId: string }
  | { OR: [{ tenantId: string }, { tenantId: null }] };

/**
 * The tenant a booking read or write belongs to.
 *
 * `writeTenantId()` returns null whenever the current scope is GLOBAL — dormant
 * enforcement or a trusted `system` caller — which is every request in production
 * today, and it THROWS when the scope has been lost. Resolving that null to the
 * founding tenant is the platform's existing rule for un-owned rows, not a new
 * one: `withTenantWrite()` and `statisticsTenantId()` both resolve exactly the
 * same way, and every tenant-isolation migration backfilled NULL to it.
 *
 * Before this, the booking path kept the null and wrote `...(tenantId ? { tenantId }
 * : {})`, i.e. nothing — so every chatbot and website booking landed tenantless.
 */
export function bookingTenantId(
  scoped: string | null,
  founding: string = DEFAULT_TENANT_ID,
): string {
  return scoped ?? founding;
}

/**
 * Does a stored booking belong to `tenantId`?
 *
 * STRICT EQUALITY for every tenant, with exactly one documented exception — the
 * FOUNDING tenant also owns `tenantId IS NULL` rows. That is the rule already
 * written down in `src/lib/statistics.ts` (`tenantSql` / `tenantWhere`); this
 * mirrors it rather than inventing a second, disagreeing one.
 *
 * WHY THE NULL ARM SURVIVES THE BACKFILL. Migration
 * 20260810100000_workshop_booking_tenant_backfill clears every NULL row that exists
 * when it runs, but it cannot keep them cleared: while enforcement is dormant the
 * db.ts guard stamps nothing, and `portal.ts`, `fulfilment.ts` and `flowActions.ts`
 * all create `category: "workshop"` activities through the guarded client. Dropping
 * the NULL arm from the CAPACITY COUNT would stop counting those real bookings and
 * DOUBLE-BOOK the workshop — a worse outcome than the mis-attribution being fixed
 * here. Dropping it from the cancel/reschedule predicate would make an existing
 * tenantless booking uncancellable. So the arm stays, and it matches nothing in
 * steady state.
 *
 * The half that actually protects a second workshop is the other one:
 * NO OTHER TENANT EVER MATCHES A NULL ROW.
 */
export function bookingOwnedBy(
  row: BookingRow,
  tenantId: string,
  founding: string = DEFAULT_TENANT_ID,
): boolean {
  if (row.tenantId === null) return tenantId === founding;
  return row.tenantId === tenantId;
}

/**
 * The same rule as a Prisma `where` fragment, for the capacity count, the
 * availability read and any cancel/reschedule predicate.
 *
 * Written as an OR of two index-friendly terms rather than
 * `COALESCE("tenantId", …) = $1`, which is not sargable and would defeat
 * `Activity_tenantId_idx` — the same reasoning as `statistics.tenantSql`.
 */
export function bookingTenantWhere(
  tenantId: string,
  founding: string = DEFAULT_TENANT_ID,
): BookingTenantWhere {
  return tenantId === founding ? { OR: [{ tenantId }, { tenantId: null }] } : { tenantId };
}

/**
 * The advisory lock a booker must hold to count and fill one slot instant.
 *
 * Two tenants booking the same instant are booking two different slots, so they
 * must not contend — and, more importantly, two bookers in the SAME tenant must,
 * or both pass the count check and overfill the slot (READ COMMITTED lets both
 * readers see the same count).
 *
 * The founding tenant deliberately keeps the pre-tenancy scalar key. Every booking
 * ever taken has locked on `pg_advisory_xact_lock(<instant>)`, and during a rolling
 * deploy old and new instances run side by side: if the key changed, one instance
 * would hold `<instant>` while the other held `hashtext('slot:tenant_denago_cpt:<instant>')`,
 * they would not exclude each other, and the deploy window itself would double-book
 * the workshop. A tenant that has no history has nothing to stay compatible with,
 * so it gets its own namespace immediately.
 */
export type SlotLock = { kind: "legacy"; instant: number } | { kind: "tenant"; key: string };

export function slotLock(
  tenantId: string,
  instant: number,
  founding: string = DEFAULT_TENANT_ID,
): SlotLock {
  return tenantId === founding
    ? { kind: "legacy", instant }
    : { kind: "tenant", key: `slot:${tenantId}:${instant}` };
}

/**
 * Should a booking adopt its still-un-owned (`tenantId IS NULL`) parent rows into
 * `tenantId` before writing a STAMPED activity against them?
 *
 * Only while the scope is GLOBAL — i.e. only when {@link bookingTenantId} had to
 * fall back to the founding tenant. The composite tenant foreign keys are MATCH
 * SIMPLE, so a tenantless Activity linked to a tenantless Contact is legal, while a
 * STAMPED Activity linked to that same tenantless Contact is REFUSED. Stamping
 * without this repair would turn "the booking is filed under the wrong tenant" into
 * "the booking 500s", for every contact created since the backfill.
 *
 * Under enforcement (`scoped` is a real tenant) it must NOT run: the guard stamps
 * parents itself there, and a link that does not resolve is a genuine cross-tenant
 * reference that has to fail rather than be quietly repaired.
 */
export function adoptsUnownedParents(scoped: string | null): boolean {
  return scoped === null;
}
