import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  enterTenantScope,
  runInTenantScope,
  currentTenantScope,
  withSystemScope,
} from "../src/lib/tenantScope";

/**
 * 2026-08-12: turning enforcement on took the CRM down. Every page redirected to
 * /platform/login and production logged `TenantScopeError: No tenant scope
 * established for Dashboard` on `GET /`.
 *
 * The cause was not a flaky AsyncLocalStorage. It was this, exactly:
 *
 *   `getCurrentUser()` is wrapped in React `cache()`. The LAYOUT called it first,
 *   so the body ran and `enterWith` bound the scope in the LAYOUT's async context.
 *   The PAGE then called it, got a CACHE HIT, and the body never re-ran — so
 *   `enterWith` never fired in the page's context. The page queried with no store.
 *
 * The fix carries the scope in a `cache()`d holder as well, which is keyed to the
 * REQUEST rather than to an async context, so it does not matter which segment
 * ran the body.
 *
 * NOTE ON WHAT THESE TESTS CAN AND CANNOT PROVE. They run in plain Node, where
 * there is no React request store, so `holder()` degrades to null and the ALS
 * path is what executes. That makes them a real guard on the ORDERING rules below
 * — which are the part that could silently widen access — and NOT a proof that
 * the render-tree carrier works. Only a PRODUCTION BUILD serving a real request
 * can prove that, because the dev server already passed while production failed
 * (docs/enterwith-request-scope-finding.md). Do not read a green run here as
 * clearance to re-flip TENANT_ENFORCEMENT.
 */

const SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/tenantScope.ts", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function bodyOf(name: string): string {
  const start = CODE.indexOf(`export function ${name}`);
  assert.notEqual(start, -1, `could not find ${name} — this test would pass vacuously`);
  const open = CODE.indexOf("{", start);
  const end = CODE.indexOf("\n}", open);
  assert.notEqual(end, -1, `could not slice the body of ${name}`);
  return CODE.slice(open, end);
}

test("a scope entered without a callback is readable afterwards", async () => {
  await runInTenantScope({ tenantId: null, system: false }, async () => {
    enterTenantScope({ tenantId: "t_alpha", system: false });
    assert.deepEqual(currentTenantScope(), { tenantId: "t_alpha", system: false });
    // Survives an await — the whole point of carrying it at all.
    await Promise.resolve();
    assert.equal(currentTenantScope()?.tenantId, "t_alpha");
  });
});

test("a nested runInTenantScope wins while active and REVERTS on return", async () => {
  await runInTenantScope({ tenantId: "t_alpha", system: false }, async () => {
    assert.equal(currentTenantScope()?.tenantId, "t_alpha");

    // The trusted cross-tenant path, nested inside a normal request scope.
    await withSystemScope(async () => {
      const inner = currentTenantScope();
      assert.equal(inner?.system, true, "a nested system scope must win while it is active");
      assert.equal(inner?.tenantId, null);
    });

    const after = currentTenantScope();
    assert.equal(after?.tenantId, "t_alpha", "the outer scope must be restored");
    assert.equal(after?.system, false, "a system bypass must NOT survive its callback");
  });
});

test("the bound async scope is read BEFORE the request holder", () => {
  const body = bodyOf("currentTenantScope");
  const als = body.indexOf("storage.getStore()");
  const held = body.indexOf("holder()");
  assert.notEqual(als, -1, "currentTenantScope must still consult AsyncLocalStorage");
  assert.notEqual(held, -1, "currentTenantScope must fall back to the request holder");
  assert.ok(
    als < held,
    "ALS must be checked FIRST: runInTenantScope binds narrower, shorter-lived scopes " +
      "(system bypass, token-derived portal/signing tenants) that must win while active and " +
      "stop winning once reverted. Holder-first would let a request's ambient scope override " +
      "a nested system scope, and would keep applying a scope that had already returned.",
  );
});

test("runInTenantScope does NOT write the holder — a temporary scope leaves no trace", () => {
  const body = bodyOf("runInTenantScope");
  assert.doesNotMatch(
    body,
    /holder\(\)/,
    "writing the holder here would outlive the callback: the scope reverts in ALS but would " +
      "linger in the request-keyed holder, so a system bypass could apply to the rest of the request",
  );
});

test("enterTenantScope writes BOTH carriers", () => {
  const body = bodyOf("enterTenantScope");
  assert.match(body, /storage\.enterWith\(scope\)/, "the async carrier must be kept, not replaced");
  assert.match(
    body,
    /holder\(\)[\s\S]*\.scope = scope/,
    "the request-keyed carrier is the one a cache()-hit sibling segment can actually read",
  );
});

test("the holder is guarded so non-render callers degrade to ALS", () => {
  // Cron ticks, queue drains and operator scripts have no React request behind
  // them. They establish scope via runInTenantScope, so "no holder" is correct —
  // but an unguarded cache() call would throw and take those paths down.
  assert.match(
    CODE,
    /function holder\(\)[\s\S]*?try\s*\{[\s\S]*?return requestScopeHolder\(\);[\s\S]*?\}\s*catch\s*\{[\s\S]*?return null;/,
    "holder() must swallow the no-request case and return null",
  );
});
