import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * `actingScopeClass()` used to read the ambient scope and nothing else under
 * enforcement, which made it correct only if some caller upstream had established
 * that scope in the SAME execution context.
 *
 * That assumption failed in production twice on one click — "Research" on a
 * contact, 2026-08-13 07:16 and again 08:57 after #517 had shipped:
 *
 *     TenantScopeError: contact access check: this request has no resolvable
 *     workspace.                                context: POST /contacts/<id>
 *
 * #517 made `getCurrentUser()` re-enter the scope on every call. Real defect,
 * real fix, did not help here: `canAccessContact(user, id)` is HANDED its user,
 * so nothing in its context calls `getCurrentUser()` at all.
 *
 * So it now resolves at the point of USE instead of trusting a caller. These
 * tests guard the two properties that make that safe.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = readFileSync(path.join(root, "src/lib/actingScope.ts"), "utf8").replace(/\r\n/g, "\n");
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function actingScopeClassBody(): string {
  const start = CODE.indexOf("export async function actingScopeClass");
  assert.notEqual(start, -1, "could not find actingScopeClass — this test would pass vacuously");
  const end = CODE.indexOf("\n}", start);
  assert.notEqual(end, -1, "could not slice actingScopeClass");
  return CODE.slice(start, end);
}

test("it recovers a MISSING scope rather than refusing", () => {
  const body = actingScopeClassBody();
  assert.match(
    body,
    /await restoreStaffScopeFromSession\(\)/,
    "the point of use must be able to establish the scope itself, instead of depending " +
      "on whichever caller happened to run first in this execution context",
  );
  assert.match(
    body,
    /enforcedScope = currentScopeClass\(\)/,
    "and must re-read the scope after establishing it, or the recovery is inert",
  );
});

test("it keys on `closed`, never on `global`", () => {
  // THE DISTINCTION IS LOAD-BEARING AND I GOT IT WRONG FIRST.
  //
  // Under enforcement `currentScopeClass()` answers:
  //   closed  → no scope established           ← the failure this recovers from
  //   global  → a DELIBERATE system bypass (scope.system === true)
  //
  // Keying on `global` would never fire on the actual failure, AND would replace a
  // trusted cross-tenant scope with the acting user's tenant — silently narrowing
  // backups, trash purge and the audit sweep.
  const body = actingScopeClassBody();
  assert.match(
    body,
    /if \(enforcing && enforcedScope\.mode === "closed"\)/,
    "recovery must be gated on `closed`",
  );
  assert.doesNotMatch(
    body,
    /enforcedScope\.mode === "global"/,
    "a system scope must never be replaced by the acting user's tenant",
  );
});

test("recovery cannot widen: it only ever runs when there is no scope at all", () => {
  const body = actingScopeClassBody();
  const guard = body.indexOf('enforcedScope.mode === "closed"');
  const call = body.indexOf("await restoreStaffScopeFromSession()");
  assert.ok(guard !== -1 && call > guard, "the getCurrentUser call must sit INSIDE the closed guard");
  // A resolved scope — narrower, or system — is read once and left alone.
  assert.match(body, /let enforcedScope = currentScopeClass\(\);/);
});

const RECOVERY = readFileSync(path.join(root, "src/lib/scopeRecovery.ts"), "utf8").replace(/\r\n/g, "\n");
const RECOVERY_CODE = RECOVERY.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("a failure to resolve still fails closed", () => {
  const body = actingScopeClassBody();
  // Swallowed on purpose: if there is genuinely no session, the scope stays absent
  // and decideActingScope refuses exactly as it did before. What must NOT happen is
  // this throwing something other than the caller's own TenantScopeError.
  assert.match(
    RECOVERY_CODE,
    /export async function recoverStaffScopeFromSession\(\)[\s\S]*?catch \([\s\S]*?return null;/,
    "resolution failure must leave the scope absent, not raise a different error",
  );
  assert.doesNotMatch(body, /DEFAULT_TENANT_ID/, "never invent a workspace here");
  assert.doesNotMatch(RECOVERY_CODE, /DEFAULT_TENANT_ID/, "never invent a workspace here either");
});

test("the swallowed CAUSE is logged, and cannot recurse through logError", () => {
  // Failing closed is right; failing closed silently is what made this expensive.
  // The caller refuses with TenantScopeError, so the SYMPTOM was logged while the
  // real cause — a DB failure, a bad secret — was discarded one frame down.
  assert.match(RECOVERY_CODE, /logError\(/, "an unexpected failure must leave a row behind");

  // THE RECURSION GUARD IS LOAD-BEARING, not stylistic. logError otherwise infers
  // the tenant via actingTenantId() → actingScopeClass() → this very function, so
  // an error here would call itself without bound. Passing tenantId explicitly
  // short-circuits that inference.
  assert.match(
    RECOVERY_CODE,
    /\{\s*tenantId:\s*null\s*\}/,
    "logError must be given an explicit tenantId — inferring it recurses back into this function",
  );

  // And the ordinary sessionless paths — cron, queue drains, scripts — must stay
  // silent, or this files a row on every background pass and buries the real ones.
  assert.match(
    RECOVERY_CODE,
    /next-dynamic-api-wrong-context|outside a request scope/,
    "a missing request context is expected and must not be logged",
  );
});

test("the recovery revalidates the session in full, so it is not an auth path", () => {
  // REVIEW CAUGHT THIS AND IT WAS A REAL HOLE.
  //
  // The recovery is reachable from the db.ts guard, which runs for every
  // tenant-scoped query regardless of whether an auth guard ran first — and
  // `withActingStaffScope` runs it BEFORE the action reaches its permission check.
  // So it may not assume `getCurrentUser` has already validated anything. Skipping
  // these checks let a revoked device, a disabled account or a superseded session
  // turn a query on a mis-guarded path into an authorised tenant query.
  //
  // Asserted on the SOURCE because the end-to-end test cannot isolate this: a
  // properly guarded action refuses a revoked cookie at its own `requireUser`, so
  // it would pass either way. These three checks are the actual fix.
  assert.match(RECOVERY_CODE, /revokedAt/, "a revoked device must not recover a scope");
  assert.match(RECOVERY_CODE, /security\.disabledAt/, "a disabled account must not recover a scope");
  assert.match(
    RECOVERY_CODE,
    /security\.sessionVersion !== session\.sv/,
    "a superseded session (password change) must not recover a scope",
  );
  // Not `getCurrentUser()` — that re-enters the memoised promise and deadlocks (#518).
  assert.doesNotMatch(RECOVERY_CODE, /getCurrentUser\(/, "must not re-enter the memoised session promise");
});

test("the recovery returns the SCOPE, never the `ok` flag", () => {
  // `decideStaffTenantScope`'s owner escape hatch answers {ok: true, enterTenantId:
  // null} — success with NO scope. #519 returned `ok`, so the recovery reported
  // success on a path that established nothing, and the caller refused anyway.
  assert.match(
    RECOVERY_CODE,
    /Promise<TenantScope \| null>/,
    "a boolean cannot distinguish `resolved a workspace` from `the owner hatch fired`",
  );
  assert.match(RECOVERY_CODE, /return ok \? scope : null;/);
});

test("the caller BINDS the recovered scope in its own context", () => {
  // THE 2026-08-13 DEFECT, IN ONE ASSERTION.
  //
  // `establishStaffTenantScope` enters the scope internally, but in a Server Action
  // `enterWith` does not reach the frame that called it and there is no React
  // request store for #513's holder. Measured on a production build: the chokepoint
  // resolved the right workspace and the caller read `ambient=null` on the next
  // line. Reading the ambient rung without binding the returned value first is
  // therefore inert, which is exactly what shipped.
  const body = actingScopeClassBody();
  const recovered = body.indexOf("const recovered = await restoreStaffScopeFromSession()");
  const entered = body.indexOf("enterTenantScope(recovered)");
  // lastIndexOf: the FIRST `enforcedScope = currentScopeClass()` is the `let`
  // declaration at the top of the function. The re-read inside the recovery block is
  // the last one, and it is the one that has to come after the bind.
  const reread = body.lastIndexOf("enforcedScope = currentScopeClass()");
  assert.ok(recovered !== -1, "the recovery must capture the returned scope, not discard it");
  assert.ok(entered > recovered, "the recovered scope must be bound in THIS context");
  assert.ok(reread > entered, "and only then re-read, or the re-read sees nothing");
});

test("a whole Server Action can be bound at once", () => {
  // Binding inside the call tree fixes one reader at a time — the access check, then
  // Contact, then AppSetting. An action needs an ENCLOSING frame, which is what
  // runInTenantScope gives and enterWith cannot.
  assert.match(
    CODE,
    /export async function withActingStaffScope[\s\S]*?return runInTenantScope\(recovered, fn\);/,
    "the action-level helper must bind an enclosing scope, not enterWith",
  );
  assert.match(
    CODE,
    /export async function withActingStaffScope[\s\S]*?if \(currentTenantScope\(\)\) return fn\(\);/,
    "and must never replace a scope that is already bound",
  );
});
