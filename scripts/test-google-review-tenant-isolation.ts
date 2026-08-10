/**
 * TWO TENANTS WATCHING THE SAME GOOGLE PLACE MUST BOTH SEE THE REVIEW.
 *
 * The schema test proves a composite unique key exists. It cannot prove the
 * runtime uses it, and for a while the runtime did not: the dedupe read was
 * `where: { externalKey, ...activeTenantPredicate(...) }`, and that predicate
 * returns `{}` while enforcement is dormant — which is the mode this ships in.
 * So the lookup was global, and whoever synced first suppressed every other
 * tenant's copy of the same review. `externalKey` is a hash of author and
 * publish time, so two tenants watching one Place produce it identically.
 *
 * The stamping had the mirror of the same defect. The tenant came from
 * `writeTenantId()`, which deliberately returns null while dormant, so every
 * review was filed under the founding tenant regardless of whose cron slice
 * fetched it — with whose Places credentials.
 *
 * Both are runtime behaviours of one function, so this drives that function
 * under two real tenant scopes and asserts what each tenant ends up owning.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes
 * every row it creates.
 */
import { basePrisma } from "../src/lib/db";
import { runInTenantScope } from "../src/lib/tenantScope";
import { recordGoogleReview } from "../src/lib/googleReviews";

const SFX = Math.random().toString(16).slice(2, 10);
let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function guardEnvironment() {
  if (process.env.NODE_ENV !== "test") throw new Error("Refusing to run outside NODE_ENV=test");
  const name = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
  if (!/_test$/.test(name)) {
    throw new Error(`Refusing to run against database "${name}" — the name must end in _test`);
  }
}

const ids = { a: `t_ra_${SFX}`, b: `t_rb_${SFX}` };
/** The same review, as two tenants watching one Place would each compute it. */
const externalKey = `key_${SFX}`;
const review = {
  externalKey,
  author: "Same Customer",
  rating: 5,
  text: "Great service.",
  publishedAt: new Date("2026-08-01T10:00:00Z"),
  raw: "{}",
};

async function seed() {
  for (const id of [ids.a, ids.b]) {
    await basePrisma.tenant.create({ data: { id, name: `Tenant ${id}`, slug: id, active: true } });
  }
}

async function cleanup() {
  await basePrisma.googleReview.deleteMany({ where: { externalKey } });
  await basePrisma.tenant.deleteMany({ where: { id: { in: [ids.a, ids.b] } } });
}

/** Exactly how the sync resolves its tenant: from the scope its slice runs in. */
const syncAs = (tenantId: string) =>
  runInTenantScope({ tenantId, system: false }, () => recordGoogleReview({ ...review, tenantId }));

async function main() {
  guardEnvironment();
  await seed();

  const first = await syncAs(ids.a);
  check("the first tenant to sync stores the review", Boolean(first));

  // THE DEFECT: with a global dedupe this returns null and tenant B never sees
  // a review left on their own Google Place.
  const second = await syncAs(ids.b);
  check(
    "the second tenant is NOT suppressed by the first tenant's copy",
    Boolean(second),
    "the dedupe matched another tenant's row",
  );
  check(
    "and they are two distinct rows",
    Boolean(first && second) && first!.id !== second!.id,
    `${first?.id} vs ${second?.id}`,
  );

  const owners = await basePrisma.googleReview.findMany({
    where: { externalKey },
    select: { tenantId: true },
    orderBy: { tenantId: "asc" },
  });
  // THE MIRROR DEFECT: stamping from writeTenantId() filed both rows under the
  // founding tenant, so tenant B's review was owned by nobody who fetched it.
  check(
    "each review is owned by the tenant whose sync fetched it",
    owners.length === 2 && owners.some((row) => row.tenantId === ids.a) && owners.some((row) => row.tenantId === ids.b),
    JSON.stringify(owners),
  );
  check(
    "and neither is filed under the founding tenant by default",
    owners.every((row) => row.tenantId === ids.a || row.tenantId === ids.b),
    JSON.stringify(owners),
  );

  // Re-running one tenant's sync is still a no-op for that tenant.
  const again = await syncAs(ids.a);
  check("a tenant's own re-sync does not duplicate its review", again === null);
  const total = await basePrisma.googleReview.count({ where: { externalKey } });
  check("leaving one row per tenant, not three", total === 2, `${total} rows`);
}

main()
  .then(async () => {
    await cleanup();
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  })
  .catch(async (error) => {
    await cleanup().catch(() => {});
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => basePrisma.$disconnect());
