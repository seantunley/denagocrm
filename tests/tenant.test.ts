import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ORG_ID, pickActiveOrg } from "../src/lib/tenant";

test("DEFAULT_ORG_ID matches the id seeded by the tenant-foundation migration", () => {
  assert.equal(DEFAULT_ORG_ID, "org_denago_cpt");
});

test("pickActiveOrg falls back to the founding org when there are no memberships", () => {
  assert.equal(pickActiveOrg([]), DEFAULT_ORG_ID);
});

test("pickActiveOrg returns the earliest-joined membership", () => {
  const memberships = [
    { organizationId: "org_b", createdAt: new Date("2026-02-01") },
    { organizationId: "org_a", createdAt: new Date("2026-01-01") },
    { organizationId: "org_c", createdAt: new Date("2026-03-01") },
  ];
  assert.equal(pickActiveOrg(memberships), "org_a");
});

test("pickActiveOrg does not mutate its input", () => {
  const memberships = [
    { organizationId: "org_b", createdAt: new Date("2026-02-01") },
    { organizationId: "org_a", createdAt: new Date("2026-01-01") },
  ];
  const before = memberships.map((m) => m.organizationId);
  pickActiveOrg(memberships);
  assert.deepEqual(memberships.map((m) => m.organizationId), before);
});
