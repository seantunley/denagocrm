import assert from "node:assert/strict";
import test from "node:test";

import {
  effectiveModuleIds,
  grantedModuleIds,
  installWideModuleIds,
  parseModuleCsv,
  serialiseModuleGrant,
} from "../src/lib/modules/entitlement";

test("parseModuleCsv keeps known optional ids and drops junk", () => {
  const parsed = parseModuleCsv("inbox, marketing ,not-a-module,,portal");
  assert.deepEqual([...parsed].sort(), ["inbox", "marketing", "portal"]);
});

test("parseModuleCsv drops core — mandatory packs are never part of a grant", () => {
  assert.deepEqual([...parseModuleCsv("core,inbox")], ["inbox"]);
});

test("parseModuleCsv treats empty/null as no grant", () => {
  assert.equal(parseModuleCsv("").size, 0);
  assert.equal(parseModuleCsv(null).size, 0);
  assert.equal(parseModuleCsv(undefined).size, 0);
});

test("serialiseModuleGrant sorts, de-duplicates and rejects unknown ids", () => {
  assert.equal(
    serialiseModuleGrant(["portal", "inbox", "inbox", "core", "bogus"]),
    "inbox,portal",
  );
});

test("serialiseModuleGrant of nothing is the empty grant", () => {
  assert.equal(serialiseModuleGrant([]), "");
});

test("core is always granted, even with an empty grant", () => {
  assert.ok(grantedModuleIds("").has("core"));
  assert.ok(grantedModuleIds(null).has("core"));
});

test("effective = granted MINUS locally disabled", () => {
  const effective = effectiveModuleIds("inbox,marketing,portal", ["marketing"]);
  assert.ok(effective.has("inbox"));
  assert.ok(effective.has("portal"));
  assert.ok(!effective.has("marketing"), "locally disabled pack must be off");
});

test("a tenant CANNOT gain a module it was not granted", () => {
  // The local setting only ever removes; there is no local way to add.
  const effective = effectiveModuleIds("inbox", []);
  assert.ok(!effective.has("marketing"));
  assert.ok(!effective.has("portal"));
});

test("revoking a grant overrides local preference immediately", () => {
  // The tenant never disabled 'portal' locally, but the platform revoked it.
  const effective = effectiveModuleIds("inbox", []);
  assert.ok(!effective.has("portal"), "revoked module must disappear");
});

test("core cannot be disabled locally", () => {
  const effective = effectiveModuleIds("inbox", ["core"]);
  assert.ok(effective.has("core"), "mandatory module must survive any local setting");
});

test("locally disabling a never-granted module is harmless", () => {
  const effective = effectiveModuleIds("inbox", ["portal", "marketing"]);
  assert.deepEqual([...effective].sort(), ["core", "inbox"]);
});

test("installWideModuleIds preserves pre-tenancy behaviour", () => {
  // No tenant resolved: everything except what is locally disabled, exactly as
  // the app behaved before entitlement existed.
  const all = installWideModuleIds([]);
  assert.ok(all.has("core"));
  assert.ok(all.has("inbox"));
  assert.ok(all.has("portal"));

  const some = installWideModuleIds(["portal"]);
  assert.ok(!some.has("portal"));
  assert.ok(some.has("inbox"));
});

test("installWideModuleIds ignores an attempt to disable core", () => {
  assert.ok(installWideModuleIds(["core"]).has("core"));
});

test("a grant round-trips through serialise and parse", () => {
  const csv = serialiseModuleGrant(["automotive", "inbox"]);
  assert.deepEqual([...parseModuleCsv(csv)].sort(), ["automotive", "inbox"]);
});
