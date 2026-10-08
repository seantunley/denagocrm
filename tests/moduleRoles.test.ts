import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { MODULE_ROLES, roleAvailable } from "../src/lib/provisioning";

// Tenant-fit audit 5.3: every workspace was seeded a Technician and a Workshop
// manager, so a non-automotive one (Breastfeeding Art) had workshop roles.

const code = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

test("workshop roles belong to the automotive module; the rest to everyone", () => {
  assert.deepEqual(Object.keys(MODULE_ROLES).sort(), ["role_technician", "role_workshop_manager"]);
  const core = new Set(["core"]);
  for (const id of ["role_technician", "role_workshop_manager", "role_technician:tenant_b"]) {
    assert.equal(roleAvailable(id, core), false, id);
    assert.equal(roleAvailable(id, new Set(["core", "automotive"])), true, id);
  }
  for (const id of ["role_crm_admin", "role_sales_rep:tenant_b", "custom_role_123"]) {
    assert.equal(roleAvailable(id, core), true, id);
  }
});

test("seeding skips module roles until the module is granted, and granting re-seeds", () => {
  const provisioning = code("src/lib/provisioning.ts");
  assert.match(provisioning, /const granted = grantedModuleIds\(tenant\?\.modules\);/);
  assert.match(provisioning, /if \(!roleAvailable\(source\.id, granted\)\) continue;/);
  assert.match(code("src/app/actions/tenants.ts"), /data: \{ modules \} \}\);\s*await basePrisma\.\$transaction\(\(tx\) => seedTenantDefaultRoles\(tx, tenantId\)\);/);
});

test("hidden on the roles screen and refused by the assign action, unless already held", () => {
  assert.match(
    code("src/app/(app)/settings/access/page.tsx"),
    /roleAvailable\(role\.id, enabledModules\) \|\| userRoles\.some\(\(ur\) => ur\.roleId === role\.id\)/,
  );
  assert.match(
    code("src/app/actions/accessControl.ts"),
    /validRoleSet\.has\(roleId\) && \(roleAvailable\(roleId, enabledModules\) \|\| alreadyHeld\.has\(roleId\)\)/,
  );
});
