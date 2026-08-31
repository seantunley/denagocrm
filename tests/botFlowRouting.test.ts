import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { normalizeRoutePattern, routeMatches } from "../src/lib/flowRouteRule";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("keyword routes match normalized whole phrases, not accidental substrings", () => {
  assert.equal(routeMatches({ kind: "keyword", pattern: "Test   Drive" }, { text: "I'd like a test-drive please" }), true);
  assert.equal(routeMatches({ kind: "keyword", pattern: "car" }, { text: "Do you sell carts?" }), false);
  assert.equal(normalizeRoutePattern("  WARRANTY  "), "warranty");
});

test("referral and ad routes are exact and case-insensitive", () => {
  assert.equal(routeMatches({ kind: "referral", pattern: "Summer-Launch" }, { referralRef: "summer-launch" }), true);
  assert.equal(routeMatches({ kind: "referral", pattern: "summer" }, { referralRef: "summer-launch" }), false);
  assert.equal(routeMatches({ kind: "ad", pattern: "2389001" }, { adId: "2389001" }), true);
  assert.equal(routeMatches({ kind: "ad", pattern: "2389001" }, { adId: "23890010" }), false);
});

test("a pinned conversation version wins before any new entry route", () => {
  const code = src("src/lib/flowPublishing.ts");
  const resolver = code.slice(code.indexOf("export async function resolveFlowSnapshot"));
  const pinnedAt = resolver.indexOf("if (pinnedVersionId)");
  const routedAt = resolver.indexOf("resolveRoutedFlowVersion");
  assert.ok(pinnedAt >= 0 && routedAt > pinnedAt);
  assert.match(resolver, /resolveRoutedFlowVersion\(tenantId, channel, entry\)/);
  assert.match(resolver, /if \(routed\)[\s\S]*versionId: routed\.id/);
});

test("routes select only an immutable version published for the same tenant, flow and channel", () => {
  const code = src("src/lib/flowRouting.ts");
  assert.match(code, /where: \{ tenantId, channel, enabled: true \}/);
  assert.match(code, /orderBy: \[\{ priority: "asc" \}/);
  assert.match(code, /botFlowPublication\.findUnique/);
  assert.match(code, /publication\.flowId !== route\.flowId/);
  assert.match(code, /id: publication\.versionId/);
});

test("provider entry metadata reaches routing on Meta, WhatsApp and Telegram", () => {
  const meta = src("src/app/api/webhooks/meta/route.ts");
  const whatsapp = src("src/app/api/webhooks/whatsapp/route.ts");
  const telegram = src("src/lib/telegram.ts");
  assert.match(meta, /referralRef: referral\.ref/);
  assert.match(meta, /adId: referral\.ad_id/);
  assert.match(whatsapp, /adId: referral\.source_id/);
  assert.match(whatsapp, /entryContext/);
  assert.match(telegram, /\^\\\/start/);
  assert.match(telegram, /referralRef: startRef/);
});

test("route writes require owner access, tenant ownership and an existing published version", () => {
  const actions = src("src/app/actions/flow.ts");
  const add = actions.slice(actions.indexOf("export async function addFlowRoute"), actions.indexOf("export async function setFlowRouteEnabled"));
  assert.match(add, /await requireOwner\(\)/);
  assert.match(add, /const tenantId = await builderTenantId\(\)/);
  assert.match(add, /where: \{ id: flowId, tenantId, channel \}/);
  assert.match(add, /botFlowPublication\.findUnique/);
  assert.match(add, /tenantId_channel_kind_pattern/);
});

test("route storage has composite tenant integrity and FORCE RLS", () => {
  const migration = src("prisma/migrations/20260830220000_bot_flow_entry_routes/migration.sql");
  assert.match(migration, /FOREIGN KEY \("tenantId", "flowId"\) REFERENCES "BotFlow"\("tenantId", "id"\)/);
  assert.match(migration, /BotFlowRoute_tenant_isolation/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /priority_check/);
});

test("the flow library exposes channel creation and the route workspace", () => {
  const page = src("src/app/(app)/bot-builder/page.tsx");
  const routes = src("src/app/(app)/bot-builder/routes/page.tsx");
  assert.match(page, /name="channel"/);
  assert.match(page, /href="\/bot-builder\/routes"/);
  assert.match(routes, /First enabled match wins/);
  assert.match(routes, /Keyword phrase/);
  assert.match(routes, /Referral code/);
  assert.match(routes, /Ad ID/);
});
