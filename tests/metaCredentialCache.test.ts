import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { DerivedCredentialCache } from "../src/lib/derivedCredentialCache";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * A Meta page token is a per-tenant credential, and the send it authorises goes
 * out on that tenant's Facebook Page.
 *
 * Every earlier version of this file described the cache by matching the shape of
 * the statements inside `getPageToken` — which tested that the code had not been
 * edited, not that it behaved. The rules now live on DerivedCredentialCache and
 * are exercised here: a real cache, a stubbed derivation, a controlled clock, and
 * a counter for how many times the derivation actually ran.
 */

const TTL = 30 * 60 * 1000;

/** A cache with a clock the test moves, and a derivation it can count and vary. */
function harness(initial = 0) {
  let clock = initial;
  const calls: string[] = [];
  const cache = new DerivedCredentialCache<string>({ ttlMs: TTL, now: () => clock });
  return {
    cache,
    calls,
    advance: (ms: number) => { clock += ms; },
    /** Derives a value that names the source it came from, so mix-ups are visible. */
    derive: async (source: string) => { calls.push(source); return `derived(${source})`; },
    failing: async () => null,
  };
}

test("a second call for the same tenant is served from the cache", async () => {
  const h = harness();
  const first = await h.cache.resolve("tenant_a", "sysA", h.derive);
  const second = await h.cache.resolve("tenant_a", "sysA", h.derive);
  assert.equal(first, "derived(sysA)");
  assert.equal(second, "derived(sysA)");
  assert.equal(h.calls.length, 1, "the exchange must not be repeated on a hit");
});

test("one tenant NEVER receives another tenant's derived credential", async () => {
  // The defect with a customer-visible blast radius: a warm process that had
  // served tenant A handed A's page token to tenant B, and B's reply went out
  // from A's Facebook Page to B's customer.
  const h = harness();
  const a = await h.cache.resolve("tenant_a", "sysA", h.derive);
  const b = await h.cache.resolve("tenant_b", "sysB", h.derive);
  assert.equal(a, "derived(sysA)");
  assert.equal(b, "derived(sysB)", "tenant B must get a value derived from B's own credential");
  assert.equal(h.calls.length, 2, "B's value cannot come from A's cached exchange");

  // And A is still A's afterwards — the second tenant must not have overwritten
  // the first under a shared key.
  assert.equal(await h.cache.resolve("tenant_a", "sysA", h.derive), "derived(sysA)");
  assert.equal(h.calls.length, 2);
});

test("rotating the source credential invalidates the derived one immediately", async () => {
  // Not after the TTL: a hit used to short-circuit reading the source credential
  // entirely, so a rotated system-user token kept authorising sends for another
  // half hour.
  const h = harness();
  await h.cache.resolve("tenant_a", "sysA", h.derive);
  h.advance(60_000); // well inside the TTL

  const afterRotation = await h.cache.resolve("tenant_a", "sysA-rotated", h.derive);
  assert.equal(afterRotation, "derived(sysA-rotated)");
  assert.equal(h.calls.length, 2, "a changed source must force a fresh derivation");
});

test("disconnecting the integration drops the derived credential rather than serving it", async () => {
  const h = harness();
  await h.cache.resolve("tenant_a", "sysA", h.derive);

  assert.equal(await h.cache.resolve("tenant_a", null, h.derive), null, "no source means no value");
  assert.equal(h.calls.length, 1, "and no exchange is attempted");

  // Reconnecting with the SAME credential must not find the old entry still
  // sitting there — the disconnect has to have evicted it, not just refused once.
  await h.cache.resolve("tenant_a", "sysA", h.derive);
  assert.equal(h.calls.length, 2, "the entry must have been evicted by the disconnect");
});

test("an empty-string credential is treated as absent, not as a valid source", async () => {
  // resolveTenantCredential can return "" for a cleared setting. Fingerprinting
  // that would cache a value derived from nothing.
  const h = harness();
  await h.cache.resolve("tenant_a", "sysA", h.derive);
  assert.equal(await h.cache.resolve("tenant_a", "", h.derive), null);
  assert.equal(h.calls.length, 1);
});

test("the TTL still expires an entry whose source has not changed", async () => {
  const h = harness();
  await h.cache.resolve("tenant_a", "sysA", h.derive);

  h.advance(TTL - 1);
  await h.cache.resolve("tenant_a", "sysA", h.derive);
  assert.equal(h.calls.length, 1, "one millisecond inside the TTL is still a hit");

  h.advance(1);
  await h.cache.resolve("tenant_a", "sysA", h.derive);
  assert.equal(h.calls.length, 2, "exactly at the TTL the entry is stale");
});

test("a failed derivation is not cached as a value", async () => {
  // Caching null would turn one bad Graph response into a TTL of them.
  const h = harness();
  assert.equal(await h.cache.resolve("tenant_a", "sysA", h.failing), null);
  assert.equal(await h.cache.resolve("tenant_a", "sysA", h.derive), "derived(sysA)");
  assert.equal(h.calls.length, 1);
});

test("a failed derivation does not destroy the entry it failed to replace", async () => {
  // The previous entry is either still valid or already unreachable by the rules
  // above; a transient Graph failure must not be a third outcome that clears it.
  const h = harness();
  await h.cache.resolve("tenant_a", "sysA", h.derive);
  h.advance(TTL + 1);
  assert.equal(await h.cache.resolve("tenant_a", "sysA", h.failing), null);
  assert.equal(h.cache.size, 1, "the stale entry may remain; it can never be served");
});

test("the cache does not grow without bound as tenants come and go", async () => {
  // One live credential per tenant, held for the life of the process, is a leak
  // the TTL does not address: it bounded how long an entry was USED, not how long
  // it was kept. Nothing but the write path is guaranteed to run.
  const h = harness();
  for (let i = 0; i < 50; i++) await h.cache.resolve(`tenant_${i}`, `sys_${i}`, h.derive);
  assert.equal(h.cache.size, 50);

  h.advance(TTL + 1);
  await h.cache.resolve("tenant_new", "sys_new", h.derive);
  assert.equal(h.cache.size, 1, "expired entries must be reclaimed, leaving only the fresh one");
});

test("reclaiming expired entries never discards a live one", async () => {
  const h = harness();
  await h.cache.resolve("tenant_old", "sys_old", h.derive);
  h.advance(TTL + 1);
  await h.cache.resolve("tenant_live", "sys_live", h.derive);
  h.advance(TTL - 10); // tenant_live is still inside its TTL
  await h.cache.resolve("tenant_third", "sys_third", h.derive);

  const beforeCount = h.calls.length;
  assert.equal(await h.cache.resolve("tenant_live", "sys_live", h.derive), "derived(sys_live)");
  assert.equal(h.calls.length, beforeCount, "a live entry must survive another tenant's write");
});

test("forget() evicts one key and leaves the rest", async () => {
  const h = harness();
  await h.cache.resolve("tenant_a", "sysA", h.derive);
  await h.cache.resolve("tenant_b", "sysB", h.derive);
  h.cache.forget("tenant_a");
  assert.equal(h.cache.size, 1);
  assert.equal(await h.cache.resolve("tenant_b", "sysB", h.derive), "derived(sysB)");
  assert.equal(h.calls.length, 2, "tenant B was untouched");
});

/**
 * The one property the behavioural tests above CANNOT reach, because it is about
 * how the caller wires the cache up rather than what the cache does: the source
 * credential must be read before the cache is consulted, and the tenant must be
 * read once.
 *
 * Both are now structural — `resolve` takes the source as an argument, so it
 * cannot be read afterwards — but the argument can still be filled in from the
 * wrong place, and that is what this checks.
 */
test("getPageToken reads the tenant once and passes the credential in", () => {
  const code = src("src/lib/messenger.ts").replace(/^\s*\/\/.*$/gm, "");
  const fn = code.slice(
    code.indexOf("async function getPageToken"),
    code.indexOf("export async function sendDirectMessage"),
  );
  assert.match(fn, /const tenantId = ambientTenantId\(\);/, "the tenant is resolved once, up front");
  assert.match(
    fn,
    /resolveTenantCredential\(tenantId, "META_PAGE_ACCESS_TOKEN"\)/,
    "and the credential is looked up for THAT value, not re-read from ambient scope",
  );
  const resolveAt = fn.indexOf("pageTokenCache.resolve(");
  assert.ok(resolveAt > fn.indexOf("resolveTenantCredential("), "the credential is read before the cache");
  assert.doesNotMatch(
    fn.slice(fn.indexOf("const tenantId") + 20),
    /ambientTenantId\(\)/,
    "reading ambient scope again lets the key and the credential describe different tenants",
  );
  // The token itself is never derived inline any more, so there is no second path
  // that could reach the Graph exchange without going through the cache's rules.
  assert.doesNotMatch(fn, /fetch\(/, "the exchange belongs behind the cache, not beside it");
});
