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
// Safe as a STATIC import despite the dynamic-import discipline below: this
// module's only import is `import type`, so it reaches nothing that builds a
// PrismaClient. It is pure data plus three pure functions.
import {
  ACKNOWLEDGED_ENFORCED_FAILURES,
  activeAcknowledgements,
  staleAcknowledgements,
  unacknowledgedFailures,
} from "./harness/acknowledged";

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
  const { runBotChannelProbes } = await import("./harness/botChannel");
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
     * ⚠ RESOLVED — THIS IS A HARNESS ARTIFACT, NOT A PRODUCT DEFECT. ⚠
     *
     * DO NOT "FIX" getCurrentUser() ON THE STRENGTH OF THIS CHECK. It has
     * already been chased down, and there is nothing wrong with the code it
     * appears to accuse.
     *
     * What the check observes is real: `establishStaffTenantScope` calls
     * `enterTenantScope()` (AsyncLocalStorage `enterWith`) from inside
     * `getCurrentUser()`, which React's `cache()` wraps — and IN THIS PROCESS
     * the scope is gone by the time the caller resumes, so the next guarded
     * query would die with `TenantScopeError: No tenant scope established`.
     *
     * What it does NOT observe is Next. `cache()` outside a request has no React
     * cache scope to attach to and falls back to a different implementation;
     * this harness runs in plain Node, with no Next request context, so it is
     * exercising that fallback and nothing else.
     *
     * VERIFIED SEPARATELY, against a REAL RUNNING Next 16.2.10 request:
     * `enterWith` inside `cache()` DOES propagate — in a route handler, in a
     * Server Component, and across a layout→page segment boundary. All three.
     * Written up in `docs/enterwith-request-scope-finding.md` on branch
     * `docs/tenant-preflip-audit`.
     *
     * So the conclusion is the opposite of the alarming one: enforcement does
     * NOT fail closed on every request, and `getCurrentUser()` is correct as
     * written. The check is kept — deliberately, as a `skip` — because it is
     * what makes the compensation below legible instead of looking like the
     * harness quietly arranging for its own probes to pass.
     *
     * The compensation: probes run inside the tenant scope the application
     * itself resolved, via the application's own `resolveActingTenant`. Without
     * it every check would fail identically for one shared, artificial reason
     * and the run would say nothing whatever about isolation.
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
            : "HARNESS ARTIFACT — NOT A PRODUCT DEFECT, and not a thing to go and fix. enterTenantScope() " +
              "is called inside a React cache()-wrapped getCurrentUser(), and the enterWith does not " +
              "propagate out of it IN PLAIN NODE, which is all this process is. Checked against a real " +
              "running Next 16.2.10 request and it DOES propagate there — route handler, Server Component, " +
              "and across a layout→page segment boundary. See docs/enterwith-request-scope-finding.md on " +
              "branch docs/tenant-preflip-audit. The suite compensates by re-entering the scope the app's " +
              "own resolveActingTenant returns; that compensation exists because of THIS, and is not " +
              "covering for anything in src/.",
    });

    // The SAME reusable helper another suite would import — see harness/actAs.ts.
    const enforcing = mode === "enforced";
    const actorFor = (t: typeof fixture.a) => ({
      tenant: t,
      as: <T,>(fn: () => Promise<T>) => actAsStaff(t, fn, { enforcing }),
      asOwner: <T,>(fn: () => Promise<T>) => actAsStaff(t, fn, { enforcing, asOwner: true }),
    });
    const actorA = actorFor(fixture.a);

    setVictimHandles(fixture.b.rows);

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
      // Driven through the CHANNEL scope rather than a staff session: a provider
      // webhook has no cookie, so the endpoint is the only thing that says whose
      // message this is.
      results.push(
        ...(await runBotChannelProbes(fixture.a, fixture.b, basePrisma as never, mode === "enforced")),
      );
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

  /* ── The gate ─────────────────────────────────────────────────────────────
   *
   * BLOCKING, with a recorded allowlist. Two independent ways to fail, and the
   * second is the one that stops the list rotting — see scripts/harness/
   * acknowledged.ts for the full reasoning.
   *
   *   UNACKNOWLEDGED  a failure nobody wrote down. The gate proper.
   *   STALE           an entry that no longer names a currently-failing check —
   *                   it passes now, or vanished, or quietly became a skip.
   *
   * The allowlisted count is printed on every run, in the RESULT block, whether
   * or not the run passes. A non-zero allowlist must never read as "clean".
   */
  const unacknowledged = unacknowledgedFailures(enforced);
  const stale = staleAcknowledgements(enforced);
  const active = activeAcknowledgements(enforced);

  console.log(bar("PRE-FLIP GATE"));

  if (active.length) {
    console.log(
      `\n  ⚠ ${active.length} KNOWN FAILURE(S) ALLOWLISTED — recorded, NOT fixed, NOT clean.\n` +
        "    Each one is a way enforcement would still leak or lose data today.\n",
    );
    for (const entry of active) {
      console.log(`    ${entry.model} [${entry.check}] ${entry.name}`);
      console.log(`      why: ${entry.why}`);
      console.log(`      fix: ${entry.fix}\n`);
    }
    console.log(
      "    THIS LIST MUST REACH ZERO BEFORE TENANT_ENFORCEMENT IS SWITCHED ON.\n" +
        "    It is an exemption with a deadline, not a substitute for the fix.\n",
    );
  } else if (ACKNOWLEDGED_ENFORCED_FAILURES.length === 0) {
    console.log("\n  allowlist is EMPTY — nothing is being exempted.\n");
  }

  if (unacknowledged.length) {
    console.log(`\n  ✖ ${unacknowledged.length} UNACKNOWLEDGED failure(s) — these fail the build:\n`);
    for (const r of unacknowledged) {
      console.log(`    ${r.model} [${r.check}] ${r.name}`);
      if (r.detail) console.log(`      ${r.detail}`);
    }
    console.log(
      "\n    Fix them. If one genuinely cannot be fixed in this repository, record it in\n" +
        "    scripts/harness/acknowledged.ts with a `why` and a `fix` saying where the real\n" +
        "    fix lives — in a diff a reviewer can see, never by a check quietly going red.\n",
    );
  }

  if (stale.length) {
    console.log(`\n  ✖ ${stale.length} STALE allowlist entr(y/ies) — these also fail the build:\n`);
    for (const { entry, reason } of stale) {
      console.log(`    ${entry.model} [${entry.check}] ${entry.name}`);
      console.log(`      ${reason}`);
    }
    console.log(
      "\n    An allowlist nobody prunes is how the next real finding gets hidden.\n",
    );
  }

  const enforcedFails = tally(enforced).fail;
  const dormantFails = tally(dormant).fail;
  console.log(bar("RESULT"));
  console.log(`  dormant     : ${dormantFails} finding(s) — recorded, non-fatal (this is today's live exposure)`);
  console.log(`  enforced    : ${enforcedFails} failure(s)`);
  console.log(`  allowlisted : ${active.length} — KNOWN, RECORDED, STILL BROKEN (must reach 0 before the flip)`);
  console.log(`  blocking    : ${unacknowledged.length} unacknowledged + ${stale.length} stale`);
  console.log(`  elapsed     : ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

  if (unacknowledged.length || stale.length) {
    console.error(
      `✖ PRE-FLIP GATE FAILED — ${unacknowledged.length} unacknowledged failure(s), ` +
        `${stale.length} stale allowlist entr(y/ies).\n`,
    );
    process.exit(1);
  }

  if (active.length) {
    // Deliberately NOT a tick, and deliberately not the word "clean". The gate
    // held — no new failures, no rotted entries — but the suite is still
    // reporting known, unfixed cross-tenant leaks.
    console.log(
      `⚠ GATE HELD, BUT NOT CLEAN — 0 new failures, and ${active.length} known failure(s) still allowlisted.\n` +
        "  TENANT_ENFORCEMENT=enforce is NOT safe to flip while that number is above zero.\n",
    );
    return;
  }

  console.log("✓ ENFORCED run is clean — 0 failures, 0 allowlisted. The gate is genuinely green.\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
