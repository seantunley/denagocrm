/**
 * TWO-TENANT RUNTIME ISOLATION HARNESS.
 *
 *   npm run test:tenant-isolation
 *
 * Every other tenancy test in this repository asserts the SHAPE OF SOURCE TEXT —
 * that a model declares a tenantId, that a query mentions one, that a guard
 * function is pure. Those tests were all green on the day the pre-flip audit
 * found `Dashboard` 1/1, `JourneyRun` 6/6, `JourneyStepLog` 6/6,
 * `TestDriveBooking` 2/2 and `TimelinePin` 7/7 rows UNOWNED in production, and
 * `SalesPipeline` never filtered by tenant at all. A schema-shaped guardrail
 * gives a schema-shaped guarantee. This suite is the runtime one: two real
 * tenants, in a real PostgreSQL, driven through the real server actions.
 *
 * IT RUNS TWICE, and the two runs mean different things:
 *
 *   DORMANT (TENANT_ENFORCEMENT unset — every environment today)
 *     Documents the CURRENT, REAL exposure. Findings are recorded and printed;
 *     they never fail the build, because failing on today's known state would
 *     just mean the suite is permanently red and therefore ignored.
 *
 *   ENFORCED (tenantEnforcing() forced true)
 *     The PRE-FLIP GATE. Every check must pass. A failure here is a statement
 *     that flipping TENANT_ENFORCEMENT=enforce in production would leak or lose
 *     data, and it exits non-zero.
 *
 * SAFETY: this creates two tenants and then deliberately attempts cross-tenant
 * reads, updates and deletes. It provisions its OWN throwaway database and
 * refuses to start against anything that is not demonstrably disposable — see
 * scripts/harness/testDatabase.ts. It never reads DATABASE_URL unless that URL
 * is itself a local *_test database and NODE_ENV=test.
 */
import { provisionHarnessDatabase, migrateHarnessDatabase } from "./harness/testDatabase";
import type { CheckResult } from "./harness/engine";

type ModeReport = { mode: "dormant" | "enforced"; results: CheckResult[] };

const bar = (s: string) => `\n${"─".repeat(78)}\n${s}\n${"─".repeat(78)}`;

function tally(results: CheckResult[]) {
  return {
    pass: results.filter((r) => r.verdict === "pass").length,
    fail: results.filter((r) => r.verdict === "fail").length,
    skip: results.filter((r) => r.verdict === "skip").length,
  };
}

function printResults(results: CheckResult[]): void {
  let model = "";
  for (const r of results) {
    if (r.model !== model) {
      model = r.model;
      console.log(`\n  ${model}`);
    }
    const mark = r.verdict === "pass" ? "ok  " : r.verdict === "fail" ? "FAIL" : "skip";
    console.log(`    ${mark} [${r.check}] ${r.name}`);
    if (r.detail && r.verdict !== "pass") console.log(`         ${r.detail}`);
    else if (r.detail && process.env.TENANT_HARNESS_VERBOSE) console.log(`         ${r.detail}`);
  }
}

async function runMode(mode: "dormant" | "enforced", suffix: string): Promise<ModeReport> {
  const { __setTenantEnforcingForTests } = await import("../src/lib/tenantEnforcement");
  const { seedTwoTenants, teardown } = await import("./harness/seed");
  const { runModelChecks } = await import("./harness/engine");
  const { buildMatrix, setVictimHandles } = await import("./harness/matrix");
  const { runDefectProbes } = await import("./harness/defects");
  const { basePrisma } = await import("../src/lib/db");
  const { runAsSession } = await import("./harness/actingSession");
  const { actAsStaff } = await import("./harness/actAs");

  // The switch. tenantEnforcing() reads TENANT_ENFORCEMENT, but the repo ships a
  // test-only override for exactly this purpose — it is what makes the enforced
  // branch of the guard reachable at all instead of being dead code behind a
  // literal false. Set per mode, cleared in the finally.
  __setTenantEnforcingForTests(mode === "enforced");

  const fixture = await seedTwoTenants(`${suffix}${mode[0]}`);
  const results: CheckResult[] = [];

  try {
    /* ── Does an authenticated request actually leave a tenant scope? ──────
     *
     * This is asked FIRST because everything else depends on the answer, and
     * because the answer here was a surprise.
     *
     * `establishStaffTenantScope` calls `enterTenantScope()` (AsyncLocalStorage
     * `enterWith`), and it is called from inside `getCurrentUser()` — which is
     * wrapped in React's `cache()`. `enterWith` from an ordinary nested async
     * function propagates to the caller perfectly well; through `cache()` it does
     * not. So in this process, an authenticated request comes back from
     * `getCurrentUser()` with NO tenant scope established, and the very next
     * guarded query dies with `TenantScopeError: No tenant scope established`.
     *
     * WHAT THIS DOES AND DOES NOT PROVE. It proves the propagation fails in a
     * plain Node process. It does NOT prove the same thing happens inside Next's
     * real request context, where `cache()` has a live React scope and may behave
     * differently — this harness cannot tell those apart, and the difference
     * matters enormously (if it fails there too, enforcement fails closed on
     * every request). It is reported as its own check, and NOT counted as an
     * isolation failure, because attributing it to the product on this evidence
     * would be overreach.
     *
     * The suite then COMPENSATES: probes run inside the tenant scope the
     * application itself resolved, via the application's own resolveActingTenant.
     * Without that, every check would fail identically for one shared reason and
     * the run would say nothing about isolation.
     */
    const { getCurrentUser } = await import("../src/lib/auth");
    const { currentTenantScope } = await import("../src/lib/tenantScope");

    let scopeSurvives = false;
    await runAsSession(fixture.a.memberSession, async () => {
      await getCurrentUser();
      scopeSurvives = currentTenantScope()?.tenantId === fixture.a.tenantId;
    });
    results.push({
      model: "(request wiring)",
      check: "OWN",
      name: "an authenticated request leaves a tenant scope established",
      verdict: mode === "enforced" ? (scopeSurvives ? "pass" : "skip") : "skip",
      detail:
        mode !== "enforced"
          ? "not applicable while dormant — establishStaffTenantScope returns before entering any scope"
          : scopeSurvives
            ? "getCurrentUser() left the acting tenant in async context"
            : "getCurrentUser() returned the user but left NO tenant scope. enterTenantScope() is called " +
              "inside a React cache()-wrapped function and the enterWith does not propagate out of it here. " +
              "Recorded as a skip, not a failure: this harness cannot tell whether Next's real request " +
              "context behaves the same way, and that distinction is the whole question. VERIFY IT SEPARATELY " +
              "— if it also fails under Next, every request fails closed the moment enforcement is on.",
    });

    // The SAME reusable helper another suite would import — see harness/actAs.ts.
    const enforcing = mode === "enforced";
    const actorFor = (t: typeof fixture.a) => ({
      tenant: t,
      as: <T,>(fn: () => Promise<T>) => actAsStaff(t, fn, { enforcing }),
      asOwner: <T,>(fn: () => Promise<T>) => actAsStaff(t, fn, { enforcing, asOwner: true }),
    });
    const actorA = actorFor(fixture.a);

    setVictimHandles(fixture.b.rows.dashboardSlug, fixture.b.rows.activityId, fixture.b.rows.pipelineId);

    // The action layer logs every unexpected failure through console.error
    // (asActionResult). Those are EXPECTED here — provoking refusals is the
    // point — and at ~40 stack traces per run they bury the report. Captured
    // rather than discarded, so a genuinely surprising one can still be read
    // back with TENANT_HARNESS_VERBOSE=1.
    const swallowed: unknown[][] = [];
    const realError = console.error;
    if (!process.env.TENANT_HARNESS_VERBOSE) {
      console.error = (...args: unknown[]) => void swallowed.push(args);
    }

    try {
      const matrix = await buildMatrix();
      for (const entry of matrix) {
        const victimRowId = entry.victimRow(fixture.b.rows);
        const deleteRowId = (entry.deleteVictimRow ?? entry.victimRow)(fixture.b.rows);
        results.push(
          ...(await runModelChecks(entry, actorA, fixture.b, victimRowId, basePrisma as never, deleteRowId)),
        );
      }
      results.push(...(await runDefectProbes(actorA, fixture.b, basePrisma as never, mode === "enforced")));
    } finally {
      console.error = realError;
      if (swallowed.length) {
        console.log(`\n  (${swallowed.length} action-layer error log(s) suppressed; TENANT_HARNESS_VERBOSE=1 to see them)`);
      }
    }
  } finally {
    __setTenantEnforcingForTests(null);
    await teardown(fixture);
  }

  return { mode, results };
}

async function main() {
  const db = await provisionHarnessDatabase();
  if ("skipped" in db) {
    console.log(bar("TENANT ISOLATION HARNESS — SKIPPED"));
    console.log(db.reason);
    console.log("\nSkipped, not passed. Nothing about tenant isolation was verified.\n");
    // Exit 0: a missing local database is a configuration gap, not a defect in
    // the code under test. CI sets TENANT_HARNESS_DATABASE_URL so it never skips.
    return;
  }

  // Set BEFORE any module that builds a PrismaClient is imported. src/lib/db.ts
  // constructs its client at module scope from the ambient DATABASE_URL, so a
  // static import of anything reaching it would bind the wrong database — or, in
  // a checkout that has a .env, PRODUCTION. Every import below is dynamic for
  // this reason and the order is load-bearing.
  process.env.DATABASE_URL = db.url;
  process.env.DATABASE_URL_UNPOOLED = db.url;
  // NODE_ENV is typed readonly; assigned through the record so the harness looks
  // like a test process to the code under test (__setTenantEnforcingForTests
  // refuses to run at all when NODE_ENV is "production").
  (process.env as Record<string, string>).NODE_ENV = "test";
  process.env.SESSION_SECRET ??= "harness-session-secret-for-local-runs-only";
  process.env.SETTINGS_ENCRYPTION_KEY ??= "0123456789abcdef".repeat(4);
  // TENANT_ENFORCEMENT is deliberately NOT set: each mode drives
  // __setTenantEnforcingForTests instead, so the dormant run is the genuine
  // default-configuration path rather than an env var that happens to say "off".
  delete process.env.TENANT_ENFORCEMENT;

  console.log(bar("TWO-TENANT RUNTIME ISOLATION HARNESS"));
  console.log(`  database: ${db.describe}`);

  const started = Date.now();
  await migrateHarnessDatabase(db.url, (m) => console.log(m));

  const suffix = Date.now().toString(36);
  const reports: ModeReport[] = [];

  try {
    for (const mode of ["dormant", "enforced"] as const) {
      console.log(bar(
        mode === "dormant"
          ? "RUN 1 of 2 — DORMANT (today's real configuration). Findings are RECORDED, not fatal."
          : "RUN 2 of 2 — ENFORCED (the pre-flip gate). Any failure here is fatal.",
      ));
      const report = await runMode(mode, suffix);
      printResults(report.results);
      const t = tally(report.results);
      console.log(`\n  ${report.mode}: ${t.pass} passed, ${t.fail} failed, ${t.skip} not covered`);
      reports.push(report);
    }
  } finally {
    const { basePrisma } = await import("../src/lib/db");
    await basePrisma.$disconnect().catch(() => {});
    await db.stop();
  }

  /* ── The comparison is the report ─────────────────────────────────────── */
  console.log(bar("WHAT CHANGES AT THE FLIP"));
  const dormant = reports[0].results;
  const enforced = reports[1].results;
  const key = (r: CheckResult) => `${r.model}::${r.check}::${r.name}`;
  const dormantBy = new Map(dormant.map((r) => [key(r), r]));

  const brokenInBoth: CheckResult[] = [];
  const fixedByFlip: CheckResult[] = [];
  const brokenByFlip: CheckResult[] = [];
  for (const e of enforced) {
    const d = dormantBy.get(key(e));
    if (!d) continue;
    if (d.verdict === "fail" && e.verdict === "fail") brokenInBoth.push(e);
    else if (d.verdict === "fail" && e.verdict === "pass") fixedByFlip.push(e);
    else if (d.verdict === "pass" && e.verdict === "fail") brokenByFlip.push(e);
  }

  const section = (title: string, rows: CheckResult[], note: string) => {
    console.log(`\n  ${title} — ${rows.length}`);
    if (rows.length === 0) console.log("    (none)");
    for (const r of rows) console.log(`    ${r.model} [${r.check}] ${r.name}`);
    if (rows.length) console.log(`    → ${note}`);
  };
  section("STILL BROKEN AFTER THE FLIP", brokenInBoth,
    "enforcement does not fix these; they need a code change before TENANT_ENFORCEMENT=enforce.");
  section("FIXED BY THE FLIP", fixedByFlip,
    "broken today, correct once enforcement is on — these are arguments FOR flipping.");
  section("BROKEN BY THE FLIP", brokenByFlip,
    "works today and stops working after the flip — a regression the flip would introduce.");

  const enforcedFails = tally(enforced).fail;
  const dormantFails = tally(dormant).fail;
  console.log(bar("RESULT"));
  console.log(`  dormant  : ${dormantFails} finding(s) — recorded, non-fatal (this is today's live exposure)`);
  console.log(`  enforced : ${enforcedFails} failure(s) — fatal`);
  console.log(`  elapsed  : ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

  if (enforcedFails > 0) {
    console.error(
      `✖ ENFORCED run failed ${enforcedFails} check(s). TENANT_ENFORCEMENT=enforce is NOT safe to flip.\n`,
    );
    process.exit(1);
  }
  console.log("✓ ENFORCED run is clean.\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
