import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { activeTenantPredicate } from "../src/lib/tenantPredicate";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(root, "src/lib/tenantScopeEntry.ts"), "utf8").replace(/\r\n/g, "\n");

test("a bound authenticated workspace constrains explicit basePrisma predicates while dormant", async () => {
  __setTenantEnforcingForTests(false);
  try {
    await runInTenantScope({ tenantId: "tenant_b", system: false }, async () => {
      assert.deepEqual(activeTenantPredicate("record access"), { tenantId: "tenant_b" });
    });
    assert.deepEqual(activeTenantPredicate("legacy unscoped path"), {});
  } finally {
    __setTenantEnforcingForTests(null);
  }
});

test("the staff chokepoint resolves and binds before the dormant return", () => {
  const start = source.indexOf("export async function establishStaffTenantScope");
  const end = source.indexOf("export function establishTenantScopeFromId", start);
  assert.ok(start >= 0 && end > start, "staff scope function must be locatable");
  const fn = source.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  const resolveAt = fn.indexOf("await resolveActingTenant(userId)");
  const dormantAt = fn.indexOf("if (!tenantEnforcing())");
  const bindAt = fn.indexOf("if (tenantId) enterTenantScope({ tenantId, system: false })");
  assert.ok(resolveAt >= 0, "the validated membership must be resolved");
  assert.ok(dormantAt > resolveAt, "dormant mode must not return before tenant resolution");
  assert.ok(bindAt > dormantAt, "a resolved dormant workspace must be bound");
  assert.doesNotMatch(fn, /if \(!tenantEnforcing\(\)\) return \{ ok: true \};/);
});

test("dormant failure to resolve does not invent a tenant or reject the session", () => {
  const start = source.indexOf("export async function establishStaffTenantScope");
  const end = source.indexOf("export function establishTenantScopeFromId", start);
  const fn = source.slice(start, end);
  assert.match(fn, /if \(!tenantEnforcing\(\)\) \{[\s\S]*?if \(tenantId\) enterTenantScope\([\s\S]*?return \{ ok: true \};[\s\S]*?\}/);
  assert.doesNotMatch(fn, /DEFAULT_TENANT_ID/);
});
