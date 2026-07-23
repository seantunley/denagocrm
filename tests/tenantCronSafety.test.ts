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
  assert.match(code, /maxRuntimeMs:\s*270_000/, "route must reserve time below the platform maximum");
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
