import assert from "node:assert/strict";
import test from "node:test";
import {
  ALL_MODULE_IDS,
  MODULE_REGISTRY,
  moduleForPath,
  isPathEnabled,
  isAutomotiveOwnedDocument,
  automotiveDocumentWhere,
  nonAutomotiveDocumentWhere,
} from "../src/lib/modules/registry";
import { buildNav } from "../src/components/nav-config";

type DocLike = { vehicleId?: string | null; jobCardId?: string | null; tag?: string | null };

/**
 * Evaluate a Prisma `where` fragment against an in-memory doc using SQL
 * three-valued logic — the point being that IN / notIn against a NULL column is
 * UNKNOWN (never TRUE), so this catches the null-tag bug the NOT { OR } form had.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
function matches(where: any, doc: DocLike): boolean {
  return Object.entries(where).every(([key, cond]: [string, any]) => {
    if (key === "OR") return (cond as any[]).some((c) => matches(c, doc));
    const val = (doc as any)[key] ?? null;
    if (cond === null) return val === null;
    if (cond && typeof cond === "object") {
      if ("not" in cond && cond.not === null) return val !== null;
      if ("in" in cond) return val !== null && (cond.in as string[]).includes(val);
      if ("notIn" in cond) return val !== null && !(cond.notIn as string[]).includes(val);
    }
    return val === cond;
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

test("the document where-fragments agree with isAutomotiveOwnedDocument and are null-safe", () => {
  const docs: DocLike[] = [
    { vehicleId: null, jobCardId: null, tag: null }, // core, untagged — the regression case
    { vehicleId: null, jobCardId: null, tag: "invoice" }, // core, non-delivery tag
    { vehicleId: null, jobCardId: null, tag: "pop" }, // core
    { vehicleId: null, jobCardId: null, tag: "delivery-note" }, // automotive (tagged)
    { vehicleId: "v1", jobCardId: null, tag: null }, // automotive (vehicle)
    { vehicleId: null, jobCardId: "j1", tag: null }, // automotive (job card)
    {}, // nothing set — a bare core doc
  ];
  for (const doc of docs) {
    const owned = isAutomotiveOwnedDocument(doc);
    // Each fragment must agree with the predicate…
    assert.equal(matches(automotiveDocumentWhere(), doc), owned, `automotive where mismatch: ${JSON.stringify(doc)}`);
    assert.equal(matches(nonAutomotiveDocumentWhere(), doc), !owned, `non-automotive where mismatch: ${JSON.stringify(doc)}`);
    // …and the two must partition every doc exactly once (no doc vanishes).
    assert.notEqual(
      matches(automotiveDocumentWhere(), doc),
      matches(nonAutomotiveDocumentWhere(), doc),
      `doc matched by both or neither fragment: ${JSON.stringify(doc)}`
    );
  }
});

function hrefs(enabled?: Set<string>) {
  const { topLinks, groups } = buildNav(true, [], enabled);
  return [...topLinks, ...groups.flatMap((g) => g.links)].map((l) => l.href);
}

test("moduleForPath maps routes to the owning pack (unknown → core)", () => {
  assert.equal(moduleForPath("/vehicles"), "automotive");
  assert.equal(moduleForPath("/vehicles/abc123"), "automotive");
  assert.equal(moduleForPath("/test-drives"), "automotive");
  assert.equal(moduleForPath("/test-drives/demo-fleet"), "automotive");
  assert.equal(moduleForPath("/jobcards"), "automotive");
  assert.equal(moduleForPath("/stock"), "commerce");
  assert.equal(moduleForPath("/inbox"), "inbox");
  assert.equal(moduleForPath("/messages"), "inbox");
  assert.equal(moduleForPath("/messages/cases"), "support");
  // The Messages-PWA landing route is core so the module guard never blocks it
  // before its permission-aware redirect runs (longest-prefix beats "/messages").
  assert.equal(moduleForPath("/messages/start"), "core");
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
  assert.equal(isPathEnabled("/test-drives", none), false); // automotive off
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
  assert.ok(!links.includes("/test-drives"), "test-drive link should be hidden");
  assert.ok(!links.includes("/jobcards"), "automotive link should be hidden");
  assert.ok(links.includes("/"), "core dashboard stays");
  assert.ok(links.includes("/leads"), "core CRM stays");
});
