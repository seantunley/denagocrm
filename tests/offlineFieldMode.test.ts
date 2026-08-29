import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  chainableSiblings,
  guardedRecordKey,
  NO_OFFLINE_CAPABILITIES,
  type OfflineMutation,
} from "../src/lib/offlineTypes";

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
  /*
   * PHOTOS ARE NOT QUEUED FROM THE ONLINE PAGES, and that is deliberate.
   *
   * DirectPhotoUploader sends a photo browser-to-Blob so a batch never travels
   * in a Server Action body; there is no action to wrap in an outbox descriptor,
   * and directPhotoUpload.test.ts asserts the old `.bind` forms are gone. Every
   * photo kind is still capturable offline — from the workspace below, which is
   * the screen a field user is on when there is no connection.
   */
  assert.doesNotMatch(jobs, /type: "inspection\.photo"/);
  assert.match(jobs, /<DirectPhotoUploader/);
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

/* ── chained local edits are not conflicts ───────────────────────────────── */

/*
 * Everything captured in ONE offline session carries the SAME downloaded
 * version. Replaying the first change moves the record on, so every later
 * change to it looked stale and was rejected as "this record changed while the
 * device was offline" — the device blaming a third party for its own earlier
 * edit, and permanently, because a conflict is never retried.
 */

const queued = (
  over: Partial<OfflineMutation> & Pick<OfflineMutation, "id" | "createdAt" | "operation">,
): OfflineMutation => ({
  tenantId: "t1",
  userId: "u1",
  fields: [],
  attempts: 0,
  status: "pending",
  ...over,
});

test("an inspection is guarded by its JOB CARD, not by the item", () => {
  // The item has no version in the snapshot; the job card is what was downloaded.
  assert.equal(
    guardedRecordKey({ type: "jobcard.inspection", recordId: "item1", parentId: "job1" }),
    "job1",
  );
  assert.equal(guardedRecordKey({ type: "jobcard.notes", recordId: "job1" }), "job1");
  // Creates and photo appends guard nothing — there is no version to collide.
  assert.equal(guardedRecordKey({ type: "lead.create" }), null);
  assert.equal(guardedRecordKey({ type: "jobcard.photo", recordId: "job1" }), null);
  assert.equal(guardedRecordKey({ type: "delivery.photo", recordId: "q1" }), null);
});

test("SAVING NOTES THEN AN INSPECTION OFFLINE IS NOT A CONFLICT", () => {
  // Both captured against the same job.updatedAt, which is the reported case.
  const notes = queued({
    id: "a",
    createdAt: 100,
    operation: { type: "jobcard.notes", recordId: "job1", baseVersion: "V1" },
  });
  const inspection = queued({
    id: "b",
    createdAt: 200,
    operation: { type: "jobcard.inspection", recordId: "item1", parentId: "job1", baseVersion: "V1" },
  });

  const moved = chainableSiblings(notes, [notes, inspection], "job1", "V2");
  assert.deepEqual(moved.map((m) => m.id), ["b"], "the inspection must be carried onto the new version");
});

test("an unrelated record in the queue is left alone", () => {
  const notes = queued({ id: "a", createdAt: 100, operation: { type: "jobcard.notes", recordId: "job1", baseVersion: "V1" } });
  const other = queued({ id: "b", createdAt: 200, operation: { type: "jobcard.notes", recordId: "job2", baseVersion: "W1" } });
  assert.deepEqual(chainableSiblings(notes, [notes, other], "job1", "V2"), []);
});

test("an entry queued BEFORE the accepted one is not rebased", () => {
  /*
   * It was authored against the older version and is only awaiting a retry.
   * Advancing it would silently claim it had seen a change it never saw.
   */
  const earlier = queued({ id: "a", createdAt: 100, operation: { type: "lead.update", recordId: "l1", baseVersion: "V1" } });
  const accepted = queued({ id: "b", createdAt: 200, operation: { type: "lead.update", recordId: "l1", baseVersion: "V1" } });
  assert.deepEqual(chainableSiblings(accepted, [earlier, accepted], "l1", "V2"), []);
});

test("a conflicted or failed sibling stays where the person left it", () => {
  // Those are waiting for a human to look at them; rebasing would hide that.
  const accepted = queued({ id: "a", createdAt: 100, operation: { type: "lead.update", recordId: "l1", baseVersion: "V1" } });
  const conflicted = queued({ id: "b", createdAt: 200, status: "conflict", operation: { type: "lead.update", recordId: "l1", baseVersion: "V1" } });
  const failed = queued({ id: "c", createdAt: 300, status: "failed", operation: { type: "lead.update", recordId: "l1", baseVersion: "V1" } });
  assert.deepEqual(chainableSiblings(accepted, [accepted, conflicted, failed], "l1", "V2"), []);
});

test("re-running a sync rewrites nothing", () => {
  const accepted = queued({ id: "a", createdAt: 100, operation: { type: "lead.update", recordId: "l1", baseVersion: "V1" } });
  const already = queued({ id: "b", createdAt: 200, operation: { type: "lead.update", recordId: "l1", baseVersion: "V2" } });
  assert.deepEqual(chainableSiblings(accepted, [accepted, already], "l1", "V2"), []);
});

test("a REJECTED replay advances nothing, so its siblings are refused too", () => {
  // They were all authored against a version somebody else has moved.
  const route = src("src/app/api/offline/sync/route.ts");
  assert.match(route, /const resultingVersion = rejected \? null : await liveVersion\(operation\);/);
  const provider = src("src/components/OfflineProvider.tsx");
  assert.match(provider, /if \(key && result\.version\) await advanceSiblings\(/);
});

/* ── the device must only offer what the replay will accept ──────────────── */

test("capabilities fail closed for a snapshot cached before they existed", () => {
  assert.deepEqual(Object.values(NO_OFFLINE_CAPABILITIES), [false, false, false, false, false, false]);
  const workspace = src("src/app/(app)/offline/page.tsx");
  assert.match(workspace, /snapshot\?\.can \?\? NO_OFFLINE_CAPABILITIES/);
});

test("WRITE PERMISSION IS SHIPPED WITH THE DATA, not assumed from visibility", () => {
  /*
   * getAccessible*Ids answers "what may they SEE". Every form was rendered on
   * that answer alone, so a role with leads.view_owned and no leads.create was
   * shown a create form that accepted the work, said "Saved on this device" and
   * cleared itself — and the replay was refused hours later by the permission
   * check that had been there the whole time, with the typed details gone.
   */
  const bootstrap = src("src/app/api/offline/bootstrap/route.ts");
  for (const permission of [
    "leads.create", "leads.edit", "contacts.create", "contacts.edit",
    "jobcards.manage", "deliveries.manage",
  ]) {
    assert.ok(
      bootstrap.includes(`hasPermission(user, "${permission}")`),
      `${permission} must be resolved for the device`,
    );
  }
  const workspace = src("src/app/(app)/offline/page.tsx");
  for (const gate of [
    "can.leadCreate", "can.leadEdit", "can.contactCreate", "can.contactEdit",
    "can.jobCardManage", "can.deliveryManage",
  ]) {
    assert.ok(workspace.includes(gate), `${gate} must gate its form`);
  }
});

test("SIGNING IS NOT OFFERED BEFORE THE DELIVERY IS SCHEDULED", () => {
  /*
   * The snapshot carries every signed, undelivered quote — scheduling is not one
   * of its conditions. Offering the handover on an unscheduled quote walked the
   * driver through the checklist and took the CUSTOMER'S signature in front of
   * them, then let markDelivered refuse it on reconnect, for a signature the
   * Pending list has no way to hand back.
   */
  const workspace = src("src/app/(app)/offline/page.tsx");
  const deliveries = workspace.slice(
    workspace.indexOf('tab === "Deliveries"'),
    workspace.indexOf('tab === "Pending"'),
  );
  assert.match(deliveries, /delivery\.scheduledFor \? \(\s*<ProofOfDelivery/, "the handover must be behind the scheduled check");
  assert.match(deliveries, /Customer signing becomes available here once the/, "and it must say why it is not offered");
  // Photos do not require scheduling and stay available.
  assert.match(deliveries, /type: "delivery\.photo"/);
  // markDelivered is the refusal being avoided; it must still be there.
  assert.match(src("src/app/actions/fulfilment.ts"), /Schedule the delivery before marking it delivered/);
});
