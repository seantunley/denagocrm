import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * The assertions below describe what the code DOES, so an explanation of the bug
 * sitting in a comment must not be mistaken for the fix.
 */
const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** The body of `getPageToken`, comments removed. */
const pageTokenFn = () => {
  const code = stripComments(src("src/lib/messenger.ts"));
  return code.slice(
    code.indexOf("async function getPageToken"),
    code.indexOf("export async function sendDirectMessage"),
  );
};

/**
 * A Meta page token is a per-tenant credential, and the send it authorises goes
 * out on that tenant's Facebook Page.
 *
 * The cache used to be one module-level slot, read BEFORE the tenant credential
 * was resolved. A warm process that had served tenant A therefore handed A's
 * page token to tenant B, and B's reply went out from A's Page to B's customer.
 * That is a cross-tenant credential leak with a customer-visible blast radius,
 * not merely a stale-cache bug.
 */

test("the Meta page-token cache is keyed by the tenant it was resolved for", () => {
  const code = src("src/lib/messenger.ts");
  const fn = code.slice(code.indexOf("async function getPageToken"), code.indexOf("export async function sendDirectMessage"));

  // A single shared slot cannot express "whose token is this".
  assert.doesNotMatch(
    code,
    /let\s+cachedPageToken\s*:/,
    "a module-level single-slot token cache cannot distinguish tenants",
  );
  assert.match(code, /pageTokenCache\s*=\s*new Map</, "the cache must be keyed per tenant");

  // The lookup must be keyed, not just stored keyed.
  assert.match(fn, /pageTokenCache\.get\(/, "the read must be per-tenant");
  assert.match(fn, /pageTokenCache\.set\(/, "the write must be per-tenant");
});

test("the cache key and the credential lookup describe the same tenant", () => {
  const code = src("src/lib/messenger.ts");
  const fn = code.slice(code.indexOf("async function getPageToken"), code.indexOf("export async function sendDirectMessage"));

  // The whole defect was that these two could disagree: the cache answered for
  // whoever came before, while the credential would have been resolved for the
  // caller. Reading the tenant once and using that one value for both is what
  // makes them impossible to separate.
  assert.match(fn, /const tenantId = ambientTenantId\(\);/, "resolve the tenant once, up front");
  assert.match(fn, /const cacheKey = tenantId \?\? GLOBAL_TOKEN_KEY;/, "the key must come from that value");
  assert.match(
    fn,
    /resolveTenantCredential\(tenantId, "META_PAGE_ACCESS_TOKEN"\)/,
    "the credential must be resolved for that same value, not re-read from ambient scope",
  );
  assert.doesNotMatch(
    fn.slice(fn.indexOf("const cacheKey")),
    /ambientTenantId\(\)/,
    "re-reading ambient scope after the key is computed lets the two drift apart again",
  );
});

/**
 * Keying the cache by tenant answers WHOSE token it is. It does not answer
 * WHETHER the token is still the one the workspace's credential derives.
 *
 * Consulting the cache before resolving the tenant's source credential means a
 * hit short-circuits the lookup entirely, so the page token stays usable for up
 * to the full TTL after the system-user token was rotated or the integration was
 * disconnected — sending on behalf of a Page the workspace no longer authorises.
 * Resolving the source credential FIRST and fingerprinting it makes the cached
 * entry valid only while the credential it was derived from is unchanged.
 */

test("the source credential is resolved before the cache is consulted", () => {
  const fn = pageTokenFn();
  const resolveAt = fn.indexOf('resolveTenantCredential(tenantId, "META_PAGE_ACCESS_TOKEN")');
  const cacheReadAt = fn.indexOf("pageTokenCache.get(");
  assert.ok(resolveAt > 0, "the tenant's source credential must be resolved inside getPageToken");
  assert.ok(cacheReadAt > 0, "the cache must be read inside getPageToken");
  assert.ok(
    resolveAt < cacheReadAt,
    "a cache hit must not be able to short-circuit reading the tenant's current credential",
  );
});

test("a cached page token is only served while its source credential is unchanged", () => {
  const fn = pageTokenFn();
  assert.match(
    fn,
    /const sourceHash = sourceFingerprint\(sysToken\);/,
    "the credential actually read this call must be fingerprinted",
  );
  assert.match(
    fn,
    /cached\s*&&\s*cached\.sourceHash === sourceHash\s*&&/,
    "a cached entry must be rejected when the source credential no longer matches",
  );
  assert.match(
    fn,
    /pageTokenCache\.set\(cacheKey,\s*\{\s*token,\s*sourceHash,/,
    "the fingerprint must be stored alongside the derived token, or it can never be compared",
  );
  // A TTL alone is what let a rotated credential keep working; it stays as a
  // backstop but must not be the only condition.
  assert.match(fn, /Date\.now\(\) - cached\.fetchedAt < PAGE_TOKEN_TTL_MS/, "the TTL backstop must remain");
});

test("disconnecting the integration drops the derived page token immediately", () => {
  const fn = pageTokenFn();
  const missing = fn.slice(fn.indexOf("if (!sysToken)"), fn.indexOf("const sourceHash"));
  assert.ok(missing.length > 0, "getPageToken must handle a missing source credential");
  assert.match(
    missing,
    /pageTokenCache\.delete\(cacheKey\)/,
    "a disconnected integration must evict the derived token rather than serve it out of the TTL",
  );
  assert.match(missing, /return null;/, "no source credential means no page token");
});

test("the per-tenant cache cannot grow without bound", () => {
  const fn = pageTokenFn();
  // One Map slot per tenant in a long-lived process is a leak unless something
  // reclaims them; the write path is the only place guaranteed to run.
  assert.match(
    fn,
    /for \(const \[key, entry\] of pageTokenCache\)/,
    "expired entries must be reclaimed",
  );
  assert.match(fn, /pageTokenCache\.delete\(key\)/, "reclaiming must actually remove the entry");
});
