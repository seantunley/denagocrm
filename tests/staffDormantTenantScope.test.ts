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
  // The bind no longer sits on one line: the scope is built, entered AND returned,
  // so the caller can re-enter it in its own execution context (see
  // tests/scopeReenteredPerCall.test.ts for why that had to change). What this
  // test protects is unchanged — a dormant request that RESOLVED a workspace must
  // still bind it, and must do so after resolution.
  const bindAt = fn.indexOf("enterTenantScope(scope)");
  assert.ok(resolveAt >= 0, "the validated membership must be resolved");
  assert.ok(dormantAt > resolveAt, "dormant mode must not return before tenant resolution");
  assert.ok(bindAt > dormantAt, "a resolved dormant workspace must be bound");
  assert.doesNotMatch(fn, /if \(!tenantEnforcing\(\)\) return \{ ok: true[,}]/);
});

test("dormant failure to resolve does not invent a tenant or reject the session", () => {
  const start = source.indexOf("export async function establishStaffTenantScope");
  const end = source.indexOf("export function establishTenantScopeFromId", start);
  const fn = source.slice(start, end);
  // Inside the dormant branch: a resolved workspace is bound and returned; an
  // UNresolved one returns ok with NO scope — it neither invents a tenant nor
  // rejects a previously-valid session.
  const dormantStart = fn.indexOf("if (!tenantEnforcing())");
  const dormantEnd = fn.indexOf("const decision = decideStaffTenantScope", dormantStart);
  assert.ok(dormantStart >= 0 && dormantEnd > dormantStart, "the dormant branch must be locatable");
  const dormant = fn
    .slice(dormantStart, dormantEnd)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.match(dormant, /if \(tenantId\) \{[\s\S]*?enterTenantScope\(scope\);[\s\S]*?return \{ ok: true, scope \};/);
  assert.match(
    dormant,
    /return \{ ok: true, scope: null \};/,
    "an unresolved dormant request stays ok and simply carries no scope",
  );
  assert.doesNotMatch(fn, /DEFAULT_TENANT_ID/);
});
