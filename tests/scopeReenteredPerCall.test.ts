import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * ONE MECHANISM, TWO PRODUCTION FAILURES.
 *
 *   2026-08-12 — `TENANT_ENFORCEMENT=enforce` went live. The LAYOUT called
 *     `getCurrentUser()` and took the `cache()` MISS, so the body ran and bound
 *     the tenant scope in the LAYOUT's execution context. The PAGE took the HIT,
 *     the body never re-ran, and the page queried with no scope. Every signed-in
 *     page fell closed and redirected the owner to /platform/login.
 *
 *   2026-08-13 — "Research" on a contact died with
 *     `contact access check: this request has no resolvable workspace`. Same
 *     mechanism, later phase: a Server Action took the miss — and a Server Action
 *     runs with no React request store, so #513's request-keyed carrier could not
 *     be written either — then the post-action re-render took the hit.
 *
 * #513 added the carrier, which fixes the first case and cannot fix the second,
 * because the carrier is only WRITTEN when the body runs.
 *
 * The fix these tests guard is different in kind: the scope is re-entered by an
 * UNCACHED wrapper on every call, so it no longer matters which context ran the
 * body. These are source assertions because auth.ts reaches `server-only` and
 * cannot be imported outside a Next build — the whole-request behaviour is
 * covered separately by `npm run test:enforced-render`, which boots a production
 * build and fetches a real page.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

const AUTH = read("src/lib/auth.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const ENTRY = read("src/lib/tenantScopeEntry.ts")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

test("getCurrentUser is NOT the cached function itself", () => {
  // This is the regression in one line. `export const getCurrentUser = cache(...)`
  // means the only thing that ever establishes the scope is the body, and the body
  // runs once per request in one context.
  assert.doesNotMatch(
    AUTH,
    /export const getCurrentUser\s*=\s*cache\(/,
    "getCurrentUser must not BE the memoised function — callers that hit the cache " +
      "would never establish the scope in their own execution context",
  );
  assert.match(
    AUTH,
    /export async function getCurrentUser\(\)/,
    "it must be a plain uncached wrapper so its body runs for every caller",
  );
});

test("the expensive resolution is still cached exactly once per request", () => {
  // The point is not to stop memoising — the session lookup, the user read and
  // the security-state read must still happen once. Only the scope entry moves out.
  assert.match(
    AUTH,
    /const resolveCurrentUser = cache\(async \(\) => \{/,
    "the DB work must stay behind cache(), or every call would re-query",
  );
});

test("the wrapper re-enters the scope on every call", () => {
  const start = AUTH.indexOf("export async function getCurrentUser()");
  assert.notEqual(start, -1, "could not find getCurrentUser — this test would pass vacuously");
  const body = AUTH.slice(start, AUTH.indexOf("\n}", start));
  assert.match(
    body,
    /await resolveCurrentUser\(\)/,
    "the wrapper must delegate to the memoised resolver",
  );
  assert.match(
    body,
    /enterTenantScope\(resolved\.scope\)/,
    "and re-establish the scope in the CALLER's context, cached or not",
  );
});

test("establishStaffTenantScope hands the scope back instead of only entering it", () => {
  assert.match(
    ENTRY,
    /Promise<\{ ok: boolean; scope: TenantScope \| null \}>/,
    "the resolved scope must be returned so a later caller can re-enter it",
  );
  // Entering it remains — the wrapper is belt to this braces, not a replacement.
  assert.match(ENTRY, /enterTenantScope\(scope\)/);
  // A refusal must never hand back a scope to re-enter.
  assert.match(
    ENTRY,
    /return \{ ok: decision\.ok, scope: null \}/,
    "a fail-closed decision must return no scope",
  );
});

test("a system scope can never be handed to the staff path", () => {
  // decideStaffTenantScope has no `system` field by design. Assert the staff
  // chokepoint never constructs one: a user-facing request that could re-enter a
  // system scope would re-enter a cross-tenant bypass on every call.
  const start = ENTRY.indexOf("export async function establishStaffTenantScope");
  const body = ENTRY.slice(start, ENTRY.indexOf("\n}", start));
  assert.doesNotMatch(body, /system:\s*true/, "the staff path must never build a system scope");
});
