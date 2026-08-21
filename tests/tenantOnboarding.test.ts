import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

const action = fs.readFileSync("src/app/actions/tenants.ts", "utf8");
const page = fs.readFileSync("src/app/platform/(console)/tenants/[id]/onboarding/page.tsx", "utf8");

test("new tenants are sent to their own onboarding route", () => {
  assert.match(action, /redirectTo: `\/platform\/tenants\/\$\{created\.tenantId\}\/onboarding`/);
});

test("onboarding scopes every readiness read to the requested tenant", () => {
  assert.match(page, /where: \{ id \}/);
  assert.doesNotMatch(page, /findFirst\(\{\s*select:/);
});

test("onboarding covers every tenant-owned setup surface", () => {
  for (const subject of ["Identity and brand", "Module entitlement", "Domain and login", "Owner and team", "Company profile", "Pipeline", "Quote and tax", "Email and notifications", "Integrations and social inbox", "roles and security", "Data import"]) {
    assert.ok(page.includes(subject), `missing onboarding subject: ${subject}`);
  }
});
