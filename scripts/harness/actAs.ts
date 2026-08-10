/**
 * RUN A CALLBACK AS AN AUTHENTICATED STAFF USER OF A GIVEN TENANT.
 *
 * The reusable half of the harness. Together with `seedTwoTenants()` from
 * ./seed, this is everything another suite needs to write a tenant-ownership
 * regression test:
 *
 *     const fixture = await seedTwoTenants("pr430");
 *     await actAsStaff(fixture.b, async () => {
 *       await createQuoteForContact(form);
 *     });
 *     // then read the row back and assert on its tenantId column
 *
 * WHAT IT DOES. It makes `cookies()` return that user's signed session, and
 * nothing else. The action then discovers its caller the same way it does in
 * production — `getCurrentUser()` verifies the JWT, loads the `User`, checks
 * `sessionVersion`, and calls `establishStaffTenantScope`. No tenant id is
 * passed in anywhere; every tenant decision is derived by the application's own
 * code from that one cookie. That is the property that makes an assertion on the
 * resulting row meaningful.
 *
 * THE ENFORCEMENT COMPENSATION, stated plainly because it is the one place this
 * helper does more than impersonate a browser. `establishStaffTenantScope` puts
 * the resolved tenant into AsyncLocalStorage with `enterWith`, from inside
 * `getCurrentUser()` — which React's `cache()` wraps. `enterWith` from an
 * ordinary nested async function propagates to the caller; through `cache()` it
 * does not, so in a plain Node process the scope is gone by the time the action
 * body runs and the first guarded query throws `TenantScopeError`. When
 * `enforcing` is requested, this helper therefore re-establishes the scope
 * explicitly — using the tenant the application's OWN `resolveActingTenant`
 * returns, not one supplied by the caller.
 *
 * Whether Next's real request context has the same problem is NOT something this
 * file can determine, and it matters a great deal: if it does, enforcement fails
 * closed on every request. The harness reports it as its own separate check
 * rather than folding it into an isolation result.
 *
 * DORMANT (the default, and today's every environment) needs none of this: the
 * scope machinery returns before entering anything, so the callback runs exactly
 * as a real dormant request would, with no compensation at all.
 */
import { runAsSession } from "./actingSession";
import type { TenantFixture } from "./seed";

export type ActAsOptions = {
  /** Act as the tenant's global `owner` user instead of its ordinary member. */
  asOwner?: boolean;
  /**
   * Re-establish the tenant scope after authentication. Only meaningful when
   * tenant enforcement is on; see the header for exactly what it compensates for
   * and why it is not enabled by default.
   */
  enforcing?: boolean;
};

/**
 * Run `fn` as an authenticated staff user of `tenant`.
 *
 * The default — no options — is a plain dormant staff request: one cookie, no
 * other assistance.
 */
export async function actAsStaff<T>(
  tenant: TenantFixture,
  fn: () => Promise<T>,
  options: ActAsOptions = {},
): Promise<T> {
  const session = options.asOwner ? tenant.ownerSession : tenant.memberSession;
  return runAsSession(session, async () => {
    if (!options.enforcing) return fn();
    const { resolveActingTenant } = await import("../../src/lib/tenantContext");
    const { runInTenantScope } = await import("../../src/lib/tenantScope");
    const resolved = await resolveActingTenant(
      options.asOwner ? tenant.ownerUserId : tenant.memberUserId,
    );
    // SoleTenantResult is `{tenantId} | {error}`. Falling back to the fixture's
    // own id on the error branch is deliberate: a resolution failure is a fact
    // about the seed, and letting the probes run anyway makes it show up as the
    // specific check that fails rather than as every check failing at once.
    const tenantId = "tenantId" in resolved ? resolved.tenantId : tenant.tenantId;
    return runInTenantScope({ tenantId, system: false }, fn);
  });
}

/**
 * Read a row's `tenantId` STRAIGHT OUT OF POSTGRES, bypassing every guard.
 *
 * This exists as its own export because it is the assertion the reviewer on PR
 * #430 actually asked for, and because the tempting shortcuts are all wrong. The
 * value an action returned, the payload it was called with, and the presence of
 * a `tenantId` token in the source are three different things, and the bug being
 * guarded against was a convincingly WRONG id being persisted — which every one
 * of those three would have reported as fine. The only fact that settles it is
 * the column, read back afterwards.
 *
 * Returns the id, `null` for an unowned row, or `undefined` when no such row
 * exists — three outcomes that must not be collapsed into one.
 */
export async function storedTenantId(
  table: string,
  id: string,
): Promise<string | null | undefined> {
  const { basePrisma } = await import("../../src/lib/db");
  const rows = await basePrisma.$queryRawUnsafe<Array<{ v: string | null }>>(
    `SELECT "tenantId"::text AS v FROM "${table}" WHERE "id" = $1`,
    id,
  );
  return rows.length ? rows[0].v : undefined;
}
