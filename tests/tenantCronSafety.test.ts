import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("tenant cron fan-out isolates failures and reports partial completion", () => {
  const code = src("src/lib/tenantCron.ts");
  assert.match(code, /status:\s*"error"/, "tenant failures must be represented in the result");
  assert.match(code, /catch\s*\(error\)/, "each tenant slice must have its own catch boundary");
  assert.match(code, /Reporting must never turn one tenant failure back into a global abort/, "error reporting must also fail closed locally");
});

test("tenant cron fan-out has fair bounded scheduling and an explicit deadline", () => {
  const code = src("src/lib/tenantCron.ts");
  assert.match(code, /rotationWindowMs/, "the starting tenant must rotate between cron windows");
  assert.match(code, /startDeadlineAt/, "the fan-out must stop admitting work at a deadline");
  assert.match(code, /Promise\.all\(/, "tenant slices must run through a bounded worker pool");
  assert.match(code, /Math\.max\(1, Math\.floor\(options\.concurrency/, "concurrency must be explicitly bounded");
  assert.match(code, /status:\s*"skipped"/, "tenants not admitted before the deadline must be visible");
});

test("competitor watch cooperates with the shared execution budget", () => {
  const code = src("src/app/api/cron/competitor-watch/route.ts");
  // The reservation below the 300s platform maximum now lives on the route
  // budget, which the database warm-up spends from before the sweep starts —
  // the sweep itself gets whatever survived, so it can no longer be a literal.
  assert.match(code, /routeBudgetMs:\s*270_000/, "route must reserve time below the platform maximum");
  assert.match(
    code,
    /maxRuntimeMs:\s*\w*[Bb]udget\.remainingMs/,
    "the sweep must run on the budget left after the warm-up",
  );
  assert.match(code, /concurrency:\s*2/, "route must bound tenant concurrency");
  assert.match(code, /budget\.shouldStop\(/, "expensive phases must check the remaining route budget");
});

test("per-tenant automation failures cannot suppress global maintenance", () => {
  const code = src("src/app/api/cron/automations/route.ts");
  const tenantRunAt = code.indexOf("runCronPerTenant(");
  const maintenanceAt = code.indexOf("await runGlobalMaintenance()", tenantRunAt);
  assert.ok(tenantRunAt >= 0 && maintenanceAt > tenantRunAt, "global maintenance must run after the isolated tenant fan-out");
  assert.match(code, /finally\s*\{[\s\S]*await runGlobalMaintenance\(\)/, "global maintenance must run even when tenant enumeration throws");
});

test("non-user audit entries inherit only an explicit normal tenant scope", () => {
  const code = src("src/lib/audit.ts");
  assert.match(code, /currentTenantScope/, "audit attribution must read the explicit async tenant scope");
  assert.match(code, /scope\s*&&\s*!scope\.system\s*&&\s*scope\.tenantId/, "system or missing scopes must remain global");
  assert.match(code, /if\s*\(!entry\.user\)/, "scope attribution must apply to cron, portal, webhook and public-token actors");
});

// ── Dormant mode must still establish a tenant scope ────────────────────────

// The dormant path used to run its slice with NO scope bound at all, so any queue
// that asks which tenant it is working for threw. The survey distribution queue
// does exactly that, and failed on every run for days — surveys were never sent,
// and because the error was caught and logged it read as noise rather than a dead
// feature. Dormant mode must look like the single-tenant case of the enforcing
// path, or a queue can work in one mode and be silently broken in the other.
test("dormant cron still binds the founding tenant's scope", () => {
  const code = src("src/lib/tenantCron.ts");
  const dormantAt = code.indexOf("if (!tenantEnforcing())");
  assert.ok(dormantAt > 0, "the dormant branch must exist");
  // The branch ends at its own return; slicing on the next `const startedAt`
  // would cut the branch in half, since it declares one itself.
  const dormantEnd = code.indexOf('return [{ tenantId: null', dormantAt);
  assert.ok(dormantEnd > dormantAt, "the dormant branch must return a single unscoped run");
  const dormantBranch = code.slice(dormantAt, dormantEnd);
  assert.match(
    dormantBranch,
    /runInTenantScope\(\s*\{\s*tenantId:\s*DEFAULT_TENANT_ID/,
    "the dormant slice must run inside the founding tenant's scope",
  );
});

test("survey distribution queue still requires a scope (the guard is not weakened)", () => {
  const code = src("src/lib/surveyDistributionQueue.ts");
  assert.match(
    code,
    /requires a tenant scope/,
    "the queue must keep failing closed rather than guessing a tenant",
  );
});

// ── Meta lead dedupe must see soft-deleted leads ────────────────────────────

// `externalId` is unique in the DATABASE regardless of deletedAt, but the
// soft-delete extension hides deleted rows from the guarded client. Deduping
// through `prisma` therefore missed leads a user had deleted, re-created them, and
// violated the unique index on every run — 692 logged failures on production from
// four deleted leads. Both entry points must dedupe through basePrisma.
for (const file of ["src/lib/metaLeadSync.ts", "src/app/api/webhooks/meta/route.ts"]) {
  test(`${file}: Meta lead dedupe sees soft-deleted leads`, () => {
    const code = src(file);
    assert.match(
      code,
      /basePrisma\.lead\.findUnique\(\s*\{\s*\n?\s*where:\s*\{\s*externalId/,
      "the externalId dedupe must use basePrisma so deleted leads are not resurrected",
    );
    assert.doesNotMatch(
      code,
      /[^e]prisma\.lead\.findUnique\(\s*\{\s*where:\s*\{\s*externalId/,
      "the guarded client hides soft-deleted rows and must not be used for this dedupe",
    );
  });
}
