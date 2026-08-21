import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

test("offline storage is partitioned by tenant and user and expires stale work", () => {
  const client = src("src/lib/offlineClient.ts");
  const types = src("src/lib/offlineTypes.ts");
  assert.match(client, /entry\.tenantId === tenantId && entry\.userId === userId/);
  assert.match(client, /purgeOfflineData/);
  assert.match(types, /OFFLINE_MAX_AGE_MS = 72 \* 60 \* 60 \* 1000/);
});

test("offline sync authenticates and rejects a forged queue owner", () => {
  const route = src("src/app/api/offline/sync/route.ts");
  assert.match(route, /requireApiUser\(\)/);
  assert.match(route, /actingTenantId\(\)/);
  assert.match(route, /claimedTenantId !== tenantId \|\| claimedUserId !== user\.id/);
  assert.match(route, /Offline mutation identity collision/);
});

test("the receipt RLS policy uses the same tenant and bypass GUCs as the database client", () => {
  const migration = src("prisma/migrations/20260821130000_offline_field_mode/migration.sql");
  assert.match(migration, /current_setting\('app\.current_tenant', true\)/);
  assert.match(migration, /current_setting\('app\.bypass_rls', true\) = 'on'/);
  assert.doesNotMatch(migration, /app\.tenant_id/);
});

test("offline edits are conflict checked and retries are idempotent", () => {
  const route = src("src/app/api/offline/sync/route.ts");
  const schema = src("prisma/schema.prisma");
  assert.match(route, /version\.toISOString\(\) !== operation\.baseVersion/);
  assert.match(route, /status === "completed"/);
  assert.match(schema, /model OfflineMutationReceipt/);
  assert.match(schema, /id\s+String\s+@id/);
  assert.match(route, /receiptClaimed/);
  assert.match(route, /status: "rejected"/);
  assert.match(route, /retry: true/);
  assert.match(src("src/components/OfflineProvider.tsx"), /else if \(result\.retry\)/);
});

test("field workflows and delivery signatures are offline enabled", () => {
  const saveForm = src("src/components/SaveForm.tsx");
  const proof = src("src/components/ProofOfDelivery.tsx");
  const jobs = src("src/app/(app)/jobcards/[id]/page.tsx");
  assert.match(saveForm, /offline\.queue\(offlineOperation, formData\)/);
  assert.match(proof, /type: "delivery\.complete"/);
  assert.match(jobs, /type: "jobcard\.notes"/);
  assert.match(jobs, /type: "jobcard\.inspection"/);
  assert.match(jobs, /type: "inspection\.photo"/);
  const workspace = src("src/app/(app)/offline/page.tsx");
  assert.match(workspace, /type: "jobcard\.photo"/);
  assert.match(workspace, /type: "jobcard\.inspection"/);
  assert.match(workspace, /type: "inspection\.photo"/);
  assert.match(workspace, /type: "delivery\.photo"/);
  assert.match(src("src/app/api/offline/bootstrap/route.ts"), /inspectionItems:/);
});

test("connectivity is always explicit and help covers offline security", () => {
  const provider = src("src/components/OfflineProvider.tsx");
  const help = src("src/lib/help/articles/getting-started.ts");
  assert.match(provider, /online \? `Online/);
  assert.match(provider, /data-connectivity=/);
  assert.match(provider, /WifiOff/);
  assert.match(provider, /entry\.status === "pending" \|\| entry\.status === "syncing"/);
  assert.match(help, /slug: "offline-field-mode"/);
  assert.match(help, /expire after 72 hours/);
  assert.match(src("src/lib/offlineClient.ts"), /fileFields\.map/);
  assert.match(help, /Signing out removes local CRM records/);
});

test("the service worker caches only the offline shell, not CRM data routes", () => {
  const worker = src("public/sw.js");
  assert.match(worker, /url\.pathname === "\/offline"/);
  assert.match(worker, /caches\.match\("\/offline\.html"\)/);
  // Static framework assets are intentionally cached. The navigation branch
  // must never persist authenticated CRM responses under their request URL.
  const navigationBranch = worker.slice(worker.indexOf('if (event.request.mode !== "navigate")'));
  assert.doesNotMatch(navigationBranch, /cache\.put\(event\.request/);
  assert.match(navigationBranch, /cache\.put\("\/offline"/);
});
