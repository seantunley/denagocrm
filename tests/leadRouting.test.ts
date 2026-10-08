import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  parseLeadRoutingConfig,
  pickLeadAssignee,
  routingCandidateIds,
  ROUND_ROBIN,
  type LeadRoutingConfig,
} from "../src/lib/leadRouting";

const cfg = (patch: Partial<LeadRoutingConfig> = {}): LeadRoutingConfig => ({
  enabled: true,
  mode: "round_robin",
  members: ["a", "b", "c"],
  rules: [],
  ...patch,
});
const all = new Set(["a", "b", "c", "z"]);
const web = { source: "website", productId: null };

test("disabled or unreadable config assigns nobody (today's behaviour)", () => {
  assert.equal(pickLeadAssignee(cfg({ enabled: false }), web, all, null).userId, null);
  assert.equal(parseLeadRoutingConfig("not json").enabled, false);
  assert.equal(parseLeadRoutingConfig(null).enabled, false);
});

test("round robin rotates in member order and wraps", () => {
  const picks: string[] = [];
  let last: string | null = null;
  for (let i = 0; i < 4; i++) {
    const d = pickLeadAssignee(cfg(), web, all, last);
    assert.equal(d.rotated, true);
    picks.push(d.userId!);
    last = d.userId;
  }
  assert.deepEqual(picks, ["a", "b", "c", "a"]);
});

test("round robin skips ineligible reps without skipping the next eligible one", () => {
  const eligible = new Set(["a", "c"]);
  assert.equal(pickLeadAssignee(cfg(), web, eligible, "a").userId, "c");
  // The last rep has since been removed from the list: restart at the top.
  assert.equal(pickLeadAssignee(cfg(), web, all, "gone").userId, "a");
});

test("nobody eligible leaves the lead unassigned, never someone outside the members", () => {
  const d = pickLeadAssignee(cfg(), web, new Set(["z"]), null);
  assert.deepEqual(d, { userId: null, rotated: false });
});

test("rules match source (case-insensitive) and product in order; first match wins", () => {
  const config = cfg({
    rules: [
      { source: "facebook", productId: "p1", assignTo: "z" },
      { source: "facebook", assignTo: "c" },
    ],
  });
  assert.equal(pickLeadAssignee(config, { source: "Facebook", productId: "p1" }, all, null).userId, "z");
  assert.equal(pickLeadAssignee(config, { source: "facebook", productId: "p2" }, all, null).userId, "c");
  const fixed = pickLeadAssignee(config, { source: "facebook", productId: "p1" }, all, null);
  assert.equal(fixed.rotated, false, "a fixed rule does not move the rotation");
  assert.equal(pickLeadAssignee(config, web, all, null).userId, "a", "no match falls back to round robin");
});

test("a rule naming an ineligible user falls through to the next rule / fallback", () => {
  const config = cfg({ rules: [{ source: "website", assignTo: "z" }] });
  assert.equal(pickLeadAssignee(config, web, new Set(["a", "b"]), null).userId, "a");
});

test("a round_robin rule rotates; fixed mode falls back to the first eligible member", () => {
  const rr = cfg({ mode: "fixed", rules: [{ source: "website", assignTo: ROUND_ROBIN }] });
  assert.deepEqual(pickLeadAssignee(rr, web, all, "a"), { userId: "b", rotated: true });
  const fixed = cfg({ mode: "fixed" });
  assert.deepEqual(pickLeadAssignee(fixed, web, new Set(["b", "c"]), null), { userId: "b", rotated: false });
});

test("parse sanitises a posted config and candidates cover reps and fixed targets", () => {
  const config = parseLeadRoutingConfig({
    enabled: true,
    mode: "weird",
    members: ["a", "a", "", 7, "b"],
    rules: [{ source: "  WhatsApp ", assignTo: "z" }, { source: "x" }, null, { productId: "p", assignTo: ROUND_ROBIN }],
  });
  assert.equal(config.mode, "round_robin");
  assert.deepEqual(config.members, ["a", "b"]);
  assert.deepEqual(config.rules, [{ source: "whatsapp", assignTo: "z" }, { productId: "p", assignTo: ROUND_ROBIN }]);
  assert.deepEqual(routingCandidateIds(config).sort(), ["a", "b", "z"]);
});

// Wiring, not just the pure logic: the chokepoint, the lock and the guards.
const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("routing runs once, in the shared creator, only for unowned system-created leads", () => {
  const src = read("src/lib/leadCreate.ts");
  assert.match(src, /if \(!input\.assignedToId && !input\.createdById\) lead = await routeInboundLead\(lead\);/);
  assert.match(src, /pg_advisory_xact_lock\(hashtext\(\$\{`lead-routing:\$\{tenantId\}`\}\)::bigint\)/);
  // Eligibility is membership of the LEAD's workspace, re-checked at assignment.
  const route = src.slice(src.indexOf("async function routeInboundLead"), src.indexOf("export async function createLeadRecord("));
  assert.match(route, /const tenantId = lead\.tenantId;/);
  assert.match(route, /WHERE m\."tenantId" = \$\{tenantId\} AND t\."active" = true AND u\."disabledAt" IS NULL/);
  assert.doesNotMatch(route, /DEFAULT_TENANT_ID|ownedWriteTenantId/);
});

test("the settings page and its action are both workspace-owner only and validate membership", () => {
  assert.match(read("src/app/(app)/settings/lead-routing/page.tsx"), /await requireTenantOwner\(\);/);
  const action = read("src/app/actions/settings.ts");
  const body = action.slice(action.indexOf("export async function saveLeadRouting"));
  assert.match(body, /await requireTenantOwner\(\);/);
  assert.match(body, /listActingTenantStaff\(\)/);
});
