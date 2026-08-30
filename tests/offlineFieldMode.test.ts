import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  chainableSiblings,
  guardedRecordKey,
  NO_OFFLINE_CAPABILITIES,
  recoverableFields,
  recoveryText,
  requeueBase,
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
  // SHELL_KEY is "/offline" — the constant exists because the owner stamp beside
  // it must be deleted in step with it, and two string literals drift.
  assert.match(navigationBranch, /cache\.put\(SHELL_KEY/);
  assert.match(worker, /const SHELL_KEY = "\/offline";/);
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

test("AN INSPECTION IS GUARDED BY THE ITEM, NOT ITS JOB CARD", () => {
  /*
   * setInspectionItem and uploadInspectionPhoto write only the ITEM row, so the
   * parent job card's updatedAt never moves when an inspection result changes.
   * Guarding the parent left a stale baseVersion still matching, and the offline
   * replay silently overwrote a technician's newer result.
   */
  assert.equal(
    guardedRecordKey({ type: "jobcard.inspection", recordId: "item1", parentId: "job1" }),
    "item1",
  );
  // A replaced photo is a genuine collision, so it is guarded too.
  assert.equal(
    guardedRecordKey({ type: "inspection.photo", recordId: "item1", parentId: "job1" }),
    "item1",
  );
  assert.equal(guardedRecordKey({ type: "jobcard.notes", recordId: "job1" }), "job1");
  // Creates and photo APPENDS guard nothing — there is no version to collide.
  assert.equal(guardedRecordKey({ type: "lead.create" }), null);
  assert.equal(guardedRecordKey({ type: "jobcard.photo", recordId: "job1" }), null);
  assert.equal(guardedRecordKey({ type: "delivery.photo", recordId: "q1" }), null);
});

test("the item carries its own version, end to end", () => {
  // A guard is only as good as the column behind it.
  assert.match(
    src("prisma/schema.prisma"),
    /model JobCardInspectionItem[\s\S]*?updatedAt\s+DateTime\s+@default\(now\(\)\) @updatedAt/,
  );
  assert.match(
    src("prisma/migrations/20260829080000_inspection_item_version/migration.sql"),
    /ALTER TABLE "JobCardInspectionItem"[\s\S]*?ADD COLUMN IF NOT EXISTS "updatedAt"/,
  );
  // Shipped in the snapshot…
  const bootstrap = src("src/app/api/offline/bootstrap/route.ts");
  assert.match(bootstrap, /updatedAt: item\.updatedAt\.toISOString\(\)/);
  // …looked up by the sync route…
  assert.match(
    src("src/app/api/offline/sync/route.ts"),
    /prisma\.jobCardInspectionItem\.findUnique\(\{ where: \{ id \}, select: \{ updatedAt: true \} \}\)/,
  );
  // …and used as the base version by both screens that queue the operation.
  assert.match(src("src/app/(app)/offline/page.tsx"), /baseVersion: item\.updatedAt/);
  assert.match(src("src/app/(app)/jobcards/[id]/page.tsx"), /baseVersion: item\.updatedAt\.toISOString\(\)/);
});

test("A STAGE PICKER THE REPLAY WILL REFUSE IS NOT LEFT ENABLED", () => {
  /*
   * updateLead refuses a stage change without leads.change_stage. Left enabled,
   * the picker took the change into the outbox, reported it saved, and had it
   * refused on replay with the form long since reset.
   */
  const workspace = src("src/app/(app)/offline/page.tsx");
  assert.match(workspace, /disabled=\{!can\.leadChangeStage\}/);
  /*
   * A disabled select posts NOTHING, and updateLead compares the submitted
   * stageId against the stored one — so without carrying the current stage the
   * replay would read the silence as a stage change and refuse it for exactly
   * the reason being avoided.
   */
  assert.match(workspace, /!can\.leadChangeStage && <input type="hidden" name="stageId" value=\{lead\.stageId\}/);
  assert.match(src("src/app/api/offline/bootstrap/route.ts"), /hasPermission\(user, "leads\.change_stage"\)/);
  // The refusal being avoided must still exist.
  assert.match(src("src/app/actions/leads.ts"), /You do not have permission to change the lead stage/);
});

test("A DISABLED MODULE WITHHOLDS ITS RECORDS, not just its buttons", () => {
  /*
   * Job cards and deliveries belong to the automotive pack and every one of
   * their actions calls requireModuleEnabled("automotive") first. A workspace
   * that switched the pack off while roles still carry jobcards.manage was
   * shipped the records and allowed to queue work that every replay refused.
   */
  const bootstrap = src("src/app/api/offline/bootstrap/route.ts");
  assert.match(bootstrap, /isModuleEnabled\("automotive"\)/);
  assert.match(bootstrap, /const jobCardManage = jobCardPermitted && automotive;/);
  assert.match(bootstrap, /const deliveryManage = deliveryPermitted && automotive;/);
  // …and the records themselves are absent, not merely ungated.
  assert.match(bootstrap, /!automotive \? \[\] : prisma\.jobCard\.findMany/);
  assert.match(bootstrap, /!automotive \? \[\] : prisma\.quote\.findMany/);
  assert.match(src("src/app/actions/fulfilment.ts"), /requireModuleEnabled\("automotive"\)/);
});

test("A CACHED SHELL CANNOT OUTLIVE THE USER IT NAMES", () => {
  /*
   * /offline is server-rendered for one user and carries their tenantId and
   * userId, which OfflineProvider uses to pick an IndexedDB partition. Served
   * later to somebody else, it points the app at the first user's cached CRM
   * records. Sign-out cannot be the answer: a session that simply EXPIRES never
   * runs it.
   */
  const worker = src("public/sw.js");
  assert.match(worker, /const SHELL_OWNER_KEY = "\/__offline-shell-owner";/);
  assert.match(worker, /if \(\(await cachedShellOwner\(cache\)\) === owner\) return;\s*\r?\n\s*await cache\.delete\(SHELL_KEY\);/,
    "a different owner must drop the shell");
  assert.match(worker, /addEventListener\("message"/);

  // The identity is announced from the authenticated layout, so it arrives on
  // every page a signed-in user renders — long before they could reach /offline.
  const provider = src("src/components/OfflineProvider.tsx");
  assert.match(provider, /type: "offline-shell-owner"/);
  assert.match(provider, /owner: `\$\{tenantId\}:\$\{userId\}`/);

  // Sign-out takes the stamp with the shell, or the worker would vouch for a
  // shell that no longer exists.
  assert.match(src("src/components/AccountMenu.tsx"), /cache\.delete\("\/__offline-shell-owner"\)/);
});

test("SAVING NOTES THEN AN INSPECTION OFFLINE IS NOT A CONFLICT", () => {
  /*
   * This was the reported case, and it is now impossible BY CONSTRUCTION rather
   * than by chaining: the notes guard the job card, the inspection guards its
   * own item, so replaying the notes cannot make the inspection look stale.
   * Nothing needs carrying, because nothing moved under it.
   */
  const notes = queued({
    id: "a",
    createdAt: 100,
    operation: { type: "jobcard.notes", recordId: "job1", baseVersion: "V1" },
  });
  const inspection = queued({
    id: "b",
    createdAt: 200,
    operation: { type: "jobcard.inspection", recordId: "item1", parentId: "job1", baseVersion: "I1" },
  });

  assert.notEqual(
    guardedRecordKey(notes.operation),
    guardedRecordKey(inspection.operation),
    "the two must not share a version at all",
  );
  assert.deepEqual(chainableSiblings(notes, [notes, inspection], "job1", "V2"), []);
});

test("TWO EDITS TO THE SAME RECORD STILL CHAIN", () => {
  /*
   * Separate versions fix the notes/inspection pair, not the general case: a
   * field user who corrects the same job card twice, or the same lead twice,
   * still queues two changes carrying one downloaded version. The second is
   * this device's own follow-up, not somebody else's edit.
   */
  const first = queued({ id: "a", createdAt: 100, operation: { type: "jobcard.notes", recordId: "job1", baseVersion: "V1" } });
  const second = queued({ id: "b", createdAt: 200, operation: { type: "jobcard.notes", recordId: "job1", baseVersion: "V1" } });

  const moved = chainableSiblings(first, [first, second], "job1", "V2");
  assert.deepEqual(moved.map((m) => m.id), ["b"], "the second edit must be carried onto the new version");

  // Same for two corrections to one inspection item.
  const shotA = queued({ id: "c", createdAt: 300, operation: { type: "jobcard.inspection", recordId: "item1", parentId: "job1", baseVersion: "I1" } });
  const shotB = queued({ id: "d", createdAt: 400, operation: { type: "inspection.photo", recordId: "item1", parentId: "job1", baseVersion: "I1" } });
  assert.deepEqual(
    chainableSiblings(shotA, [shotA, shotB], "item1", "I2").map((m) => m.id),
    ["d"],
  );
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
  // Every capability, whatever the list grows to, defaults to refusing.
  const values = Object.values(NO_OFFLINE_CAPABILITIES);
  assert.ok(values.length >= 7, "each gated workflow needs its own capability");
  assert.ok(values.every((allowed) => allowed === false));
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

/* ── the feature must not become a precondition for the app ──────────────── */

test("OFFLINE MODE CANNOT TAKE DOWN THE CRM FOR A TENANTLESS SESSION", () => {
  /*
   * The outbox needs a non-null tenant to key its IndexedDB partition, and
   * actingTenantId is the right ladder for that — but it THROWS when it cannot
   * resolve one, and this layout is what every authenticated page renders
   * through. A valid session with no `tid`, or a user with several memberships
   * while enforcement is dormant, would have lost the entire CRM to one optional
   * panel. requireUser and getActiveTenantId both keep supporting tenantless
   * sessions in dormant mode on purpose.
   */
  const layout = src("src/app/(app)/layout.tsx");
  assert.match(layout, /await actingTenantId\(\)\.catch\(\(\) => null\)/,
    "an unresolvable tenant must not throw out of the shell");
  assert.match(layout, /if \(!tenantId\) return <>\{children\}<\/>;/,
    "the shell must render without the provider");
  assert.match(layout, /<MaybeOffline tenantId=\{activeTenantId\} userId=\{user\.id\}>/);
  // …and the provider itself still refuses an empty partition key, so the
  // conditional above is the only thing deciding.
  assert.match(src("src/lib/offlineClient.ts"), /if \(!tenantId \|\| !userId\) throw new Error/);
});

test("THE WORKER IS REGISTERED, NOT MERELY AWAITED", () => {
  /*
   * `navigator.serviceWorker.ready` waits for a registration; it does not create
   * one. The only root registration in the app lives in PushToggle, which mounts
   * on Settings — so anybody who went straight to the offline workspace had no
   * cached shell and no navigation fallback, and found out when they lost signal.
   */
  const provider = src("src/components/OfflineProvider.tsx");
  assert.match(provider, /\.register\("\/sw\.js", \{ scope: "\/", updateViaCache: "none" \}\)/);
  const registerAt = provider.indexOf('.register("/sw.js"');
  const readyAt = provider.indexOf("serviceWorker.ready");
  assert.ok(registerAt !== -1 && registerAt < readyAt, "registration must come before the wait");
  // Same worker and scope as the Settings toggle, so the browser returns the
  // existing registration rather than installing a second one.
  assert.match(src("src/components/PushToggle.tsx"), /const ROOT_SW = "\/sw\.js";/);
});

test("AN EXPIRED SESSION LEAVES THE OUTBOX REPLAYABLE", () => {
  /*
   * /api/offline/sync answers 401 BEFORE claiming a receipt, so nothing was
   * applied and nothing is decided. Marking those `failed` stranded them: a
   * later pass only selects pending or syncing, and the Pending list offers no
   * way back, so signing in again could not replay work that was never refused
   * on its merits.
   */
  const provider = src("src/components/OfflineProvider.tsx");
  assert.match(provider, /else if \(response\.status === 401 \|\| response\.status === 403\)/);
  const branch = provider.slice(
    provider.indexOf("else if (response.status === 401"),
    provider.indexOf("} else {", provider.indexOf("else if (response.status === 401")),
  );
  assert.match(branch, /status: "pending"/, "an auth failure must stay replayable");
  assert.match(branch, /Sign in again/, "and say what to do about it");
  assert.match(branch, /break;/, "the pass must stop rather than burn an attempt on every entry");
  // The selection this depends on: only pending/syncing are ever retried, which
  // is exactly why `failed` was a dead end.
  assert.match(provider, /entry\.status === "pending" \|\| entry\.status === "syncing"/);
});

/* ── the pickers must only offer stages a replay accepts ─────────────────── */

test("OFFLINE LEAD PICKERS OFFER OPEN STAGES ONLY", () => {
  /*
   * createLead and updateLead both run the chosen stage through
   * validateOpenStage, which refuses a closed one outright — "Use Mark won or
   * Mark lost instead". Shipping every stage put Won and Lost in the offline
   * pickers: choose one, be told the lead was saved on the device, watch the
   * form clear, and have the replay refuse it with the details gone.
   *
   * Won and lost are not edits to a stage field anyway — they are their own
   * actions, with their own permissions and outcome fields, and neither exists
   * offline.
   */
  const bootstrap = src("src/app/api/offline/bootstrap/route.ts");
  const stageQuery = bootstrap.slice(bootstrap.indexOf("prisma.pipelineStage.findMany"));
  assert.match(stageQuery.slice(0, 200), /where: \{ isClosed: false \}/);
  // The refusal being avoided must still be there.
  assert.match(src("src/app/actions/leads.ts"), /Use Mark won or Mark lost instead/);
  assert.match(src("src/app/actions/leads.ts"), /await validateOpenStage\(data\.stageId\)/);
});

test("A LEAD ALREADY IN A CLOSED STAGE IS NOT OFFERED FOR EDITING", () => {
  /*
   * updateLead validates the submitted stage UNCONDITIONALLY — not only when it
   * changes — so every edit to a won or lost lead is refused whatever else was
   * typed. Shipping only open stages makes "this lead's stage is not among them"
   * the exact test for a closed one, with no extra snapshot field to keep in
   * step.
   */
  const workspace = src("src/app/(app)/offline/page.tsx");
  assert.match(
    workspace,
    /!snapshot\.options\.stages\.some\(\(stage\) => stage\.id === lead\.stageId\)/,
    "the closed case must be detected from the shipped options",
  );
  assert.match(workspace, /Closed leads cannot be edited offline/, "and explained rather than silently dropped");
  // The permission gate still comes first — a role that cannot edit sees that
  // reason, not a stage explanation.
  const gate = workspace.slice(workspace.indexOf("{!can.leadEdit ?"), workspace.indexOf("Closed leads cannot be edited offline"));
  assert.match(gate, /^\{!can\.leadEdit \? readOnly\("leads"\)/);
});

/* ── round five ──────────────────────────────────────────────────────────── */

test("A MISSING RECORD ID IS NOT EVIDENCE OF A CREATE", () => {
  /*
   * LeadForm read `offlineRecordId ? "lead.update" : "lead.create"`, and the edit
   * modal on the lead detail page passed updateLead and the lead's defaults but
   * never passed offlineRecordId. Offline it queued a NEW LEAD: a user with
   * create permission got a duplicate on replay; an edit-only user got a refusal
   * after being told it was saved.
   */
  const detail = src("src/app/(app)/leads/[id]/page.tsx");
  assert.match(detail, /offlineRecordId=\{lead\.id\}/, "the edit modal must pass its identity");
  assert.match(detail, /offlineBaseVersion=\{lead\.updatedAt\.toISOString\(\)\}/);

  // …and the inference fails safe, so the next call site that forgets loses
  // offline support rather than writing the wrong verb.
  for (const form of ["src/components/LeadForm.tsx", "src/components/ContactForm.tsx"]) {
    assert.match(src(form), /defaults\.id && !offlineRecordId\s*\r?\n?\s*\? undefined/, `${form} must refuse rather than guess`);
    assert.match(src(form), /id\?: string;/, "an edit is identified by defaults.id");
  }
  // SaveForm is what turns "no operation" into a refusal the person can read.
  assert.match(src("src/components/SaveForm.tsx"), /This operation requires an internet connection/);
});

test("SIGNING OUT OFFLINE DOES NOT DESTROY WORK THAT CANNOT SYNC", () => {
  /*
   * The purge is irreversible and runs first, on purpose. But `logout()` is a
   * Server Action, so offline it fails AFTER the snapshots, photos and queued
   * mutations are already gone — and the session stays signed in. A field user
   * tapping Sign out at the end of a day with no signal lost the day's work and
   * remained logged in.
   */
  const menu = src("src/components/AccountMenu.tsx");
  assert.match(menu, /if \(!navigator\.onLine\) \{/);
  const guard = menu.slice(menu.indexOf("if (!navigator.onLine) {"), menu.indexOf("await purgeOfflineData()"));
  assert.match(guard, /return;/, "the refusal must come BEFORE the purge");
  assert.match(menu, /Connect and let queued work synchronise before signing out/);
});

test("A STAGE MOVE THE DEVICE CANNOT PRE-VALIDATE IS NOT OFFERED", () => {
  /*
   * gateStageMove runs on replay and can refuse outright, or demand a reason or
   * remedy that only the pipeline board can capture. None of that is answerable
   * from a cached snapshot.
   */
  const bootstrap = src("src/app/api/offline/bootstrap/route.ts");
  assert.match(bootstrap, /entryGateMode: true, exitGateMode: true/);
  assert.match(bootstrap, /stage\.entryGateMode !== "off" \|\| stage\.exitGateMode !== "off"/);
  assert.match(bootstrap, /leadChangeStage: leadChangeStage && !stageGated/);
  // The snapshot type is unchanged — the gate columns are read and dropped.
  assert.match(bootstrap, /stages: stages\.map\(\(\{ id, name \}\) => \(\{ id, name \}\)\)/);
  // The refusal being avoided must still exist.
  assert.match(src("src/app/actions/leads.ts"), /gateStageMove\(\{/);
});

test("A GUARDED RECORD THAT NO LONGER EXISTS IS A CONFLICT", () => {
  /*
   * liveVersion returns null for two different situations: an operation that
   * guards nothing, and a guarded record that has been DELETED. Treating both as
   * "nothing to compare" let the second past the check — and the write beneath
   * is an updateMany, which reports success for zero rows. The receipt completed
   * and the device discarded the technician's work.
   */
  const route = src("src/app/api/offline/sync/route.ts");
  assert.match(route, /const guarded = Boolean\(operation\.baseVersion && guardedRecordKey\(operation\)\);/);
  assert.match(route, /const stale = guarded && \(!version \|\| version\.toISOString\(\) !== operation\.baseVersion\);/);
  assert.match(route, /That record no longer exists\./, "and the two cases must read differently");
  // The write that made this silent: still an updateMany, which is why the guard
  // above has to be the thing that catches it.
  assert.match(src("src/app/actions/jobcards.ts"), /prisma\.jobCardInspectionItem\.updateMany\(/);
});

/* ── a refusal must not be the end of the work ───────────────────────────── */

/*
 * THE REFUSAL WAS NEVER THE DAMAGE.
 *
 * Every refusal an offline replay can produce — no permission, a closed stage, a
 * gated move, a module switched off, a deleted record, a conflict — ended the
 * same way: the form had already cleared, and Pending showed the operation TYPE
 * and nothing else. That is what made each of them lost work rather than a
 * sentence to read. The queue held the fields the whole time.
 *
 * This matters most for the refusals nobody has thought of yet.
 */

const captured = (over: Partial<OfflineMutation> & Pick<OfflineMutation, "id" | "operation">): OfflineMutation => ({
  tenantId: "t1",
  userId: "u1",
  fields: [],
  createdAt: 1_700_000_000_000,
  attempts: 1,
  status: "failed",
  ...over,
});

test("WHAT THE PERSON TYPED SURVIVES A REFUSAL", () => {
  const entry = captured({
    id: "a",
    operation: { type: "lead.create" },
    error: "You do not have permission to create leads",
    fields: [
      { name: "name", kind: "text", value: "Jan Bekker" },
      { name: "phone", kind: "text", value: "082 555 0134" },
      { name: "notes", kind: "text", value: "Wants a finance quote" },
    ],
  });
  assert.deepEqual(
    recoverableFields(entry).map((f) => `${f.name}=${f.value}`),
    ["name=Jan Bekker", "phone=082 555 0134", "notes=Wants a finance quote"],
  );
  const text = recoveryText(entry);
  assert.match(text, /lead\.create/);
  assert.match(text, /name: Jan Bekker/);
  assert.match(text, /notes: Wants a finance quote/);
});

test("plumbing and blanks are not shown back as if they were typed", () => {
  const entry = captured({
    id: "a",
    operation: { type: "lead.create" },
    fields: [
      { name: "name", kind: "text", value: "Jan" },
      { name: "source", kind: "text", value: "offline" },
      { name: "contactId", kind: "text", value: "c_123" },
      { name: "email", kind: "text", value: "   " },
    ],
  });
  assert.deepEqual(recoverableFields(entry).map((f) => f.name), ["name"]);
});

test("a queued photo is named, not lost", () => {
  const entry = captured({
    id: "a",
    operation: { type: "jobcard.photo", recordId: "job1" },
    fields: [{ name: "file", kind: "file", value: new Blob(["x"]), fileName: "front-bumper.jpg", contentType: "image/jpeg" }],
  });
  assert.deepEqual(recoverableFields(entry), [{ name: "file", value: "front-bumper.jpg", kind: "file" }]);
});

test("RE-QUEUEING REBASES ONTO THE RECORD AS IT IS NOW", () => {
  /*
   * A guarded operation needs a CURRENT version. Re-sending the stale one hits
   * the same conflict; dropping it would overwrite whatever replaced the record
   * without anyone deciding to.
   */
  const entry = captured({
    id: "a",
    status: "conflict",
    operation: { type: "lead.update", recordId: "l1", baseVersion: "V1" },
  });
  const snapshot = {
    leads: [{ id: "l1", updatedAt: "V2" }],
    contacts: [],
    jobCards: [],
    deliveries: [],
  } as unknown as Parameters<typeof requeueBase>[1];

  assert.deepEqual(requeueBase(entry, snapshot), { retryable: true, baseVersion: "V2" });
});

test("a record no longer on the device can be copied but not replayed", () => {
  // Nothing to rebase onto, so "Try again" is not offered — the honest answer is
  // to copy the details and re-enter them online.
  const entry = captured({ id: "a", status: "conflict", operation: { type: "lead.update", recordId: "gone", baseVersion: "V1" } });
  const snapshot = { leads: [], contacts: [], jobCards: [], deliveries: [] } as unknown as Parameters<typeof requeueBase>[1];
  assert.deepEqual(requeueBase(entry, snapshot), { retryable: false });
  assert.deepEqual(requeueBase(entry, null), { retryable: false });
});

test("an unguarded change needs no version to be replayed", () => {
  const entry = captured({ id: "a", operation: { type: "lead.create" } });
  assert.deepEqual(requeueBase(entry, null), { retryable: true });
});

test("an inspection re-queues against the ITEM's version", () => {
  // The guard moved to the item; recovery has to follow it or a retry would
  // rebase onto the wrong row.
  const entry = captured({
    id: "a",
    status: "conflict",
    operation: { type: "jobcard.inspection", recordId: "item1", parentId: "job1", baseVersion: "I1" },
  });
  const snapshot = {
    leads: [],
    contacts: [],
    deliveries: [],
    jobCards: [{ id: "job1", updatedAt: "J9", inspectionItems: [{ id: "item1", updatedAt: "I2" }] }],
  } as unknown as Parameters<typeof requeueBase>[1];
  assert.deepEqual(requeueBase(entry, snapshot), { retryable: true, baseVersion: "I2" });
});

test("a retry is a NEW mutation, because a rejected receipt is closed forever", () => {
  /*
   * The server keeps a receipt per mutation id and closes a refused one as
   * rejected — that is what makes replays at-most-once. Re-sending the same id
   * returns the stored rejection however the record has changed since, so a
   * retry button on the same id could never succeed.
   */
  const client = src("src/lib/offlineClient.ts");
  assert.match(client, /id: crypto\.randomUUID\(\)/);
  assert.match(client, /status: "pending",\s*\r?\n\s*error: undefined,/);
  // Stored before the old one is removed, so a failure leaves the work queued
  // rather than nowhere.
  const fn = client.slice(client.indexOf("export async function requeueOfflineMutation"));
  assert.ok(
    fn.indexOf("saveOfflineMutation(next)") < fn.indexOf("removeOfflineMutation(entry.id)"),
    "the replacement must exist before the original is deleted",
  );
  assert.match(src("src/app/api/offline/sync/route.ts"), /previous\.status === "rejected"/);
});

test("the Pending screen shows the fields and offers the way out", () => {
  const workspace = src("src/app/(app)/offline/page.tsx");
  assert.match(workspace, /const fields = recoverableFields\(entry\);/);
  assert.match(workspace, /const requeue = requeueBase\(entry, snapshot\);/);
  assert.match(workspace, /recoveryText\(entry\)/, "copying out is what makes a permanent refusal survivable");
  assert.match(workspace, /requeueOfflineMutation\(entry, requeue\.baseVersion\)/);
  assert.match(workspace, /no longer on this device — copy the details and re-enter them online/);
});

/* ── round six ───────────────────────────────────────────────────────────── */

test("MAKING THE STANDARD EDIT FORMS QUEUEABLE DID NOT SKIP THE STAGE GATE", () => {
  /*
   * Passing offlineRecordId turned the two standard lead edit routes into forms
   * that queue — and their stage picker had no capability gate, unlike the
   * offline workspace's. updateLead refuses a stage change without
   * leads.change_stage, so an enabled picker was a promise the save could not
   * keep: online the refusal is immediate and the form is still filled in;
   * offline it arrives after the modal has closed.
   */
  const form = src("src/components/LeadForm.tsx");
  assert.match(form, /disabled=\{!canChangeStage\}/);
  assert.match(form, /name=\{canChangeStage \? "stageId" : undefined\}/);
  // A disabled select posts nothing, and updateLead compares the submitted stage
  // against the stored one — the silence would itself read as a change.
  assert.match(form, /!canChangeStage && <input type="hidden" name="stageId" value=\{stageId\}/);
  // Both edit call sites must resolve it; a create does not need it, so the
  // default stays permissive.
  assert.match(form, /canChangeStage = true,/);
  for (const page of ["src/app/(app)/leads/[id]/page.tsx", "src/app/(app)/leads/[id]/edit/page.tsx"]) {
    assert.match(src(page), /hasPermission\(user, "leads\.change_stage"\)/, `${page} must resolve the permission`);
    assert.match(src(page), /canChangeStage=\{/, `${page} must pass it`);
  }
});

test("A REDIRECT TO LOGIN IS NOT CACHED AS THE OFFLINE SHELL", () => {
  /*
   * With an expired session /offline redirects to /login and fetch FOLLOWS it,
   * so response.ok is true and the body is the sign-in page. Caching that
   * overwrote the authenticated shell: the next loss of connectivity served a
   * login form with no workspace behind it, and no way to sign in either.
   */
  const worker = src("public/sw.js");
  assert.match(worker, /!response\.redirected && finalPath === SHELL_KEY/);
  assert.match(worker, /new URL\(response\.url \|\| event\.request\.url\)\.pathname/);
  // The guard must sit on the branch that WRITES the shell.
  const shellBranch = worker.slice(worker.indexOf('if (url.pathname === "/offline")'), worker.indexOf("event.respondWith(fetch(event.request).catch("));
  assert.match(shellBranch, /response\.ok && !response\.redirected/);
});
