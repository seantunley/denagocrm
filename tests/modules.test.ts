import assert from "node:assert/strict";
import test from "node:test";
import {
  ALL_MODULE_IDS,
  MODULE_REGISTRY,
  moduleForPath,
  isPathEnabled,
  isAutomotiveOwnedDocument,
} from "../src/lib/modules/registry";
import { buildNav } from "../src/components/nav-config";

function hrefs(enabled?: Set<string>) {
  const { topLinks, groups } = buildNav("crm,workshop,reports,inbox", true, [], enabled);
  return [...topLinks, ...groups.flatMap((g) => g.links)].map((l) => l.href);
}

test("moduleForPath maps routes to the owning pack (unknown → core)", () => {
  assert.equal(moduleForPath("/vehicles"), "automotive");
  assert.equal(moduleForPath("/vehicles/abc123"), "automotive");
  assert.equal(moduleForPath("/jobcards"), "automotive");
  assert.equal(moduleForPath("/stock"), "commerce");
  assert.equal(moduleForPath("/inbox"), "inbox");
  assert.equal(moduleForPath("/messages"), "inbox");
  assert.equal(moduleForPath("/messages/cases"), "support");
  assert.equal(moduleForPath("/cases"), "support");
  assert.equal(moduleForPath("/campaigns"), "marketing");
  assert.equal(moduleForPath("/chatbot"), "automation");
  assert.equal(moduleForPath("/portal"), "portal");
  assert.equal(moduleForPath("/portal/support"), "portal");
  assert.equal(moduleForPath("/leads"), "core");
  assert.equal(moduleForPath("/something-new"), "core");
});

test("registry has no duplicate route prefixes", () => {
  const seen = new Set<string>();
  for (const m of MODULE_REGISTRY) {
    for (const p of m.routePrefixes) {
      if (p === "/") continue;
      assert.ok(!seen.has(p), `duplicate route prefix: ${p}`);
      seen.add(p);
    }
  }
});

test("core paths are always enabled, even outside the enabled set", () => {
  const none = new Set<string>(); // nothing enabled
  assert.equal(isPathEnabled("/leads", none), true); // core
  assert.equal(isPathEnabled("/vehicles", none), false); // automotive off
});

test("buildNav with all modules enabled matches unfiltered", () => {
  const all = new Set(ALL_MODULE_IDS);
  assert.deepEqual(hrefs(all).sort(), hrefs(undefined).sort());
});

test("isAutomotiveOwnedDocument flags vehicle/job-card/delivery docs, not core docs", () => {
  // Automotive-owned: vehicle- or job-card-linked, or tagged delivery paperwork
  // (which is filed against a contact/quote, so ids alone would miss it).
  assert.equal(isAutomotiveOwnedDocument({ vehicleId: "v1" }), true);
  assert.equal(isAutomotiveOwnedDocument({ jobCardId: "j1" }), true);
  assert.equal(isAutomotiveOwnedDocument({ tag: "delivery-note" }), true);
  assert.equal(isAutomotiveOwnedDocument({ tag: "delivery-photo" }), true);
  assert.equal(isAutomotiveOwnedDocument({ tag: "delivery-signature" }), true);
  assert.equal(
    isAutomotiveOwnedDocument({ vehicleId: null, jobCardId: null, tag: "delivery-note" }),
    true
  );
  // Core: plain contact/quote docs with null or non-delivery tags stay visible.
  assert.equal(isAutomotiveOwnedDocument({ vehicleId: null, jobCardId: null, tag: null }), false);
  assert.equal(isAutomotiveOwnedDocument({ tag: "invoice" }), false);
  assert.equal(isAutomotiveOwnedDocument({ tag: "pop" }), false);
  assert.equal(isAutomotiveOwnedDocument({}), false);
});

test("disabling a pack hides its nav but keeps core", () => {
  const noAuto = new Set(ALL_MODULE_IDS.filter((id) => id !== "automotive"));
  const links = hrefs(noAuto);
  assert.ok(!links.includes("/vehicles"), "automotive link should be hidden");
  assert.ok(!links.includes("/jobcards"), "automotive link should be hidden");
  assert.ok(links.includes("/"), "core dashboard stays");
  assert.ok(links.includes("/leads"), "core CRM stays");
});
