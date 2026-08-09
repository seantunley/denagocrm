import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

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
