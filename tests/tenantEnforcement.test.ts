import test from "node:test";
import assert from "node:assert/strict";
import { parseTenantMode } from "../src/lib/tenantEnforcement";

test("parseTenantMode: unset/empty/unknown all fail safe to off", () => {
  assert.equal(parseTenantMode(undefined), "off");
  assert.equal(parseTenantMode(null), "off");
  assert.equal(parseTenantMode(""), "off");
  assert.equal(parseTenantMode("true"), "off");
  assert.equal(parseTenantMode("on"), "off");
  assert.equal(parseTenantMode("garbage"), "off");
});

test("parseTenantMode: recognises monitor and enforce (case/space tolerant)", () => {
  assert.equal(parseTenantMode("monitor"), "monitor");
  assert.equal(parseTenantMode("  Monitor "), "monitor");
  assert.equal(parseTenantMode("ENFORCE"), "enforce");
});
