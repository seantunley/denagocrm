/**
 * PR #430 — WHAT TENANT DOES POSTGRES ACTUALLY RECEIVE?
 *
 *   npm run test:tenant-stamp
 *
 * THE OBJECTION THIS ANSWERS. `tests/unguardedTenantWrites.test.ts` is a source
 * scanner. It proves the token `tenantId` appears in an unguarded create's
 * payload — and the bug it is guarding against was a CONVINCINGLY WRONG tenant
 * id being persisted, which that scanner reports as fine. `tenantId:
 * totallyWrongTenant` passes it. So does `tenantId: await actingTenantId()`.
 * The two are indistinguishable to it, and the whole defect lives in the gap.
 *
 * This suite closes the gap the only way it can be closed: it creates the rows
 * through the REAL server actions, as a REAL authenticated staff user of tenant
 * B, against a REAL PostgreSQL with the REAL migrations applied — and then
 * SELECTs each row back out and reads its `tenantId` COLUMN.
 *
 * Three facts are deliberately NOT used as evidence anywhere below:
 *   - what the action returned,
 *   - what the action was called with,
 *   - what the source text says.
 * Each of the three would have been green on the day the bug shipped. The row is
 * located by DIFFING the table's ids before and after the call — so not even the
 * created id comes from the action — and the ownership fact is a `SELECT
 * "tenantId" FROM "<table>" WHERE id = …` through the bypass client.
 *
 * THE DEFECT, precisely. The stamp used to be `writeTenantId() ?? DEFAULT_TENANT_ID`.
 * `writeTenantId()` returns null while enforcement is DORMANT — which is every
 * environment today — so the fallback fired on every user-originated write and
 * stamped the FOUNDING tenant. A person acting in workspace B filed rows owned
 * by workspace A. This suite therefore runs DORMANT, because dormant is where
 * the bug lives; running it enforced would mask exactly the branch under test.
 *
 * SAFETY. This repository's `.env` points at PRODUCTION. Nothing here may reach
 * it. The database is provisioned by scripts/harness/testDatabase.ts, which
 * fails closed on any URL that is not demonstrably disposable, and this file
 * additionally asks the live connection `SELECT current_database()` and refuses
 * to seed unless the server it actually reached names itself as scratch. A
 * string check on a URL and a round trip to the server are different claims;
 * both are made.
 *
 * SHARED FIXTURES. seedTwoTenants(), actAsStaff() and storedTenantId() come from
 * the two-tenant harness (scripts/harness/, branch test/two-tenant-harness) so
 * there is one set of tenant fixtures in this repository rather than two.
 */
import {
  provisionHarnessDatabase,
  migrateHarnessDatabase,
  disposabilityProblem,
} from "./harness/testDatabase";

/* ────────────────────────────────────────────────────────────────────────────
 * Reporting
 * ──────────────────────────────────────────────────────────────────────────── */

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  if (detail) console.log(`       ${detail}`);
}

const bar = (s: string) => `\n${"─".repeat(78)}\n${s}\n${"─".repeat(78)}`;

/* ────────────────────────────────────────────────────────────────────────────
 * Main
 * ──────────────────────────────────────────────────────────────────────────── */

async function main(): Promise<number> {
  console.log(bar("PR #430 — persisted tenant ownership, read back from PostgreSQL"));

  /* 1. A DISPOSABLE DATABASE, OR NOTHING AT ALL. ---------------------------- */
  const provisioned = await provisionHarnessDatabase();
  if ("skipped" in provisioned) {
    console.log(bar("SKIPPED — no scratch database, so NOTHING was proven"));
    console.log(provisioned.reason);
    console.log(
      "\n  This is a skip, not a pass. It asserts nothing about tenant ownership.\n",
    );
    return 0;
  }

  // Re-assert independently of the provisioner, while the ambient DATABASE_URL
  // is still the one from .env — this is the comparison that catches "the
  // harness variable was pointed at the app's own database", and it stops being
  // meaningful the moment the override below happens.
  const problem = disposabilityProblem(provisioned.url);
  if (problem) throw new Error(`Refusing to run: ${problem}`);

  console.log(`\n  database: ${provisioned.describe}`);

  /* 2. POINT THE APPLICATION AT IT — BEFORE ANY APPLICATION CODE LOADS. -----
   *
   * `basePrisma` is constructed from DATABASE_URL at IMPORT time, so this
   * assignment has to happen before src/lib/db is first reached. That is why
   * every application import in this file is dynamic and lives below this line,
   * and why the only static import is the provisioner (which pulls in
   * @prisma/client and node builtins, and no application module).
   */
  process.env.DATABASE_URL = provisioned.url;
  process.env.DATABASE_URL_UNPOOLED = provisioned.url;
  // The app's signer falls back to a dev constant when this is unset; setting it
  // explicitly keeps the harness's tokens verifiable by the app's own jwtVerify
  // regardless of what the ambient environment happens to carry.
  process.env.SESSION_SECRET ||= "harness-session-secret-not-a-real-one";
  // Dormant is the default and is what this suite tests, but an inherited
  // TENANT_ENFORCEMENT would silently move the code under test onto the other
  // branch of the guard and the run would prove something else entirely.
  delete process.env.TENANT_ENFORCEMENT;

  try {
    await migrateHarnessDatabase(provisioned.url, (m) => console.log(m));

    const failures = await run();
    return failures;
  } finally {
    await provisioned.stop();
  }
}

async function run(): Promise<number> {
  const { basePrisma } = await import("../src/lib/db");
  const { tenantEnforcing } = await import("../src/lib/tenantEnforcement");
  const { DEFAULT_TENANT_ID } = await import("../src/lib/tenant");
  const { seedTwoTenants, teardown } = await import("./harness/seed");
  const { actAsStaff, storedTenantId } = await import("./harness/actAs");
  const { HarnessRedirect } = await import("./harness/stubs/next-navigation");

  /* 3. PROVE THE CONNECTION LANDED WHERE WE THINK IT DID. -------------------
   *
   * Everything above reasons about a STRING. This asks the server. A scratch
   * URL that was quietly overridden downstream — by a pooler, a PGDATABASE, a
   * connection string rewritten in db.ts — would sail past every check so far
   * and be caught only here, before a single row is written.
   */
  const [live] = await basePrisma.$queryRawUnsafe<
    Array<{ db: string; host: string | null }>
  >(`SELECT current_database() AS db, inet_server_addr()::text AS host`);
  if (!/(_test|_harness|_scratch)$/.test(live.db)) {
    throw new Error(
      `Refusing to write: connected database is "${live.db}", which is not a scratch database.`,
    );
  }
  record(
    "connected to a scratch database, not production",
    true,
    `current_database() = "${live.db}", server ${live.host ?? "local socket"}`,
  );

  if (tenantEnforcing()) {
    throw new Error("Expected DORMANT enforcement — the defect only reproduces there.");
  }
  record(
    "enforcement is dormant (the mode the defect lives in)",
    true,
    "tenantEnforcing() === false, so writeTenantId() returns null and the old fallback would fire",
  );

  const suffix = `pr430${Date.now().toString(36).slice(-6)}`;
  const fixture = await seedTwoTenants(suffix);
  const A = fixture.a.tenantId;
  const B = fixture.b.tenantId;

  console.log(
    `\n  acting tenant  B = ${B}\n  other tenant   A = ${A}\n  founding tenant  = ${DEFAULT_TENANT_ID}  (what the defect stamps)\n`,
  );

  /** Ids present in `table` right now. The before/after diff is how a created
   *  row is located without trusting anything the action said. */
  async function idsIn(table: string): Promise<Set<string>> {
    const rows = await basePrisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id" FROM "${table}"`,
    );
    return new Set(rows.map((r) => r.id));
  }

  /**
   * Run `fn`, then return the single row id that appeared in `table` — or a
   * reason why no row can be attributed.
   *
   * The action is allowed to THROW here rather than aborting the suite, and that
   * is not defensive padding: a wrongly-stamped write does not always reach the
   * table. Some of these models carry a COMPOSITE foreign key on
   * `(tenantId, <parent>Id)`, so stamping a tenant that does not own the parent
   * is rejected by PostgreSQL outright (P2003). "The row was refused" and "the
   * row landed under the wrong owner" are both failures of the same property —
   * the acting tenant's row is not there — and each check has to be able to say
   * which of the two happened without stopping the other two checks from running.
   */
  type Created = { id: string } | { failed: string };

  async function createdRowId(table: string, fn: () => Promise<void>): Promise<Created> {
    const before = await idsIn(table);
    try {
      await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = (error as { code?: string })?.code;
      const constraint = (error as { meta?: { constraint?: string } })?.meta?.constraint;
      const after = await idsIn(table);
      const leaked = [...after].filter((id) => !before.has(id));
      if (leaked.length === 1) return { id: leaked[0] };
      return {
        failed:
          code === "P2003"
            ? `the write was REJECTED by PostgreSQL (${code}, constraint ${constraint}) — ` +
              `the stamped tenant does not own the parent row, so no ${table} was persisted at all`
            : `the action threw and no ${table} row was persisted: ${message.split("\n")[0]}`,
      };
    }
    const after = await idsIn(table);
    const fresh = [...after].filter((id) => !before.has(id));
    if (fresh.length !== 1) {
      return {
        failed: `expected exactly one new ${table} row, saw ${fresh.length} — cannot attribute ownership`,
      };
    }
    return { id: fresh[0] };
  }

  /**
   * A redirect is how these two actions finish — and ALSO how this codebase says
   * NO: requirePermission redirects to "/", requireContactAccess to "/contacts",
   * requireVehicleAccess to "/vehicles". The two are the same exception type, so
   * a blanket catch would turn "access refused, nothing was written" into a
   * silent skip. Only the SUCCESS destination is accepted; anything else is
   * re-thrown carrying the location it tried to go to.
   */
  async function expectRedirectTo(
    prefix: string,
    fn: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await fn();
    } catch (error) {
      if (error instanceof HarnessRedirect) {
        if (error.location.startsWith(prefix)) return;
        throw new Error(
          `action refused: redirected to "${error.location}" instead of "${prefix}…" — ` +
            `the access guard said no, so nothing was written`,
        );
      }
      throw error;
    }
    throw new Error(`expected a redirect to "${prefix}…" — the action returned instead`);
  }

  /** THE ASSERTION. The row's `tenantId` column, straight out of PostgreSQL. */
  async function assertOwnedByB(label: string, table: string, created: Created): Promise<void> {
    if ("failed" in created) {
      record(label, false, `expected B=${B}, but ${created.failed}`);
      record(`${label} — does not belong to tenant A`, false, `no ${table} row exists to own`);
      return;
    }
    const id = created.id;
    const stored = await storedTenantId(table, id);
    const shown =
      stored === undefined ? "<no such row>" : stored === null ? "NULL (unowned)" : stored;
    const isFounding = stored === DEFAULT_TENANT_ID;
    const ok = stored === B;
    record(
      label,
      ok,
      ok
        ? `SELECT "tenantId" FROM "${table}" WHERE id='${id}' → ${shown} (= acting tenant B)`
        : `SELECT "tenantId" FROM "${table}" WHERE id='${id}' → expected B=${B}, ` +
          `received ${shown}${isFounding ? "  ← the FOUNDING tenant: the row was filed in the wrong workspace" : ""}`,
    );
    // Stated separately so a failure says which boundary was crossed, not just
    // that a string differed.
    record(
      `${label} — does not belong to tenant A`,
      stored !== A,
      stored === A ? `row is owned by A (${A})` : `A = ${A}`,
    );
  }

  try {
    /* ── 1. Quote ─────────────────────────────────────────────────────────
     * createQuoteForContact authorises against a contact and then writes
     * through basePrisma.$transaction — the guard-bypassing shape the whole
     * PR is about. */
    console.log("\n  Quote — createQuoteForContact");
    const { createQuoteForContact } = await import("../src/app/actions/quotes");
    const quote = await createdRowId("Quote", async () => {
      await actAsStaff(fixture.b, async () => {
        const form = new FormData();
        form.set("contactId", fixture.b.rows.contactId);
        await expectRedirectTo("/quotes?edit=", () => createQuoteForContact(form));
      });
    });
    await assertOwnedByB("Quote created in B is owned by B", "Quote", quote);

    /* ── 2. JobCard ───────────────────────────────────────────────────────── */
    console.log("\n  JobCard — createJobCard");
    const { createJobCard } = await import("../src/app/actions/jobcards");
    const jobCard = await createdRowId("JobCard", async () => {
      await actAsStaff(fixture.b, async () => {
        const form = new FormData();
        form.set("vehicleId", fixture.b.rows.vehicleId);
        form.set("description", "harness check-in");
        await expectRedirectTo("/jobcards/", () => createJobCard(form));
      });
    });
    await assertOwnedByB("JobCard created in B is owned by B", "JobCard", jobCard);

    /* ── 3. ConsentRecord ─────────────────────────────────────────────────
     * The consent write PR #430 fixed is the POPIA erasure record in
     * anonymizeContact — the one that runs inside basePrisma.$transaction.
     * (recordConsent writes through the GUARDED client, which is a different
     * path and deliberately untouched by this PR.) It is owner-gated, hence
     * asOwner. */
    console.log("\n  ConsentRecord — anonymizeContact (POPIA erasure record)");
    const { anonymizeContact } = await import("../src/app/actions/privacy");
    const consent = await createdRowId("ConsentRecord", async () => {
      await actAsStaff(
        fixture.b,
        async () => {
          const result = await anonymizeContact(fixture.b.rows.contactId);
          const err = (result as { error?: string } | undefined)?.error;
          if (err) throw new Error(`anonymizeContact refused: ${err}`);
        },
        { asOwner: true },
      );
    });
    await assertOwnedByB(
      "ConsentRecord created in B is owned by B",
      "ConsentRecord",
      consent,
    );
  } finally {
    await teardown(fixture);
    await basePrisma.$disconnect();
  }

  const failed = checks.filter((c) => !c.ok).length;
  console.log(
    bar(
      failed === 0
        ? `PASS — ${checks.length} checks. Every row PostgreSQL received is owned by the acting tenant.`
        : `FAIL — ${failed} of ${checks.length} checks. Rows were persisted under the wrong tenant.`,
    ),
  );
  return failed;
}

main()
  .then((failed) => process.exit(failed === 0 ? 0 : 1))
  .catch((error) => {
    console.error("\n", error);
    process.exit(1);
  });
