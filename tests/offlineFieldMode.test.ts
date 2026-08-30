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

test("field capture workflows are offline enabled", () => {
  const saveForm = src("src/components/SaveForm.tsx");
  const jobs = src("src/app/(app)/jobcards/[id]/page.tsx");
  assert.match(saveForm, /offline\.queue\(offlineOperation, formData\)/);
  assert.match(jobs, /type: "jobcard\.notes"/);
  assert.match(jobs, /type: "jobcard\.inspection"/);
  /*
   * PHOTOS ARE NOT QUEUED FROM THE ONLINE PAGES, and that is deliberate.
   *
   * DirectPhotoUploader sends a photo browser-to-Blob so a batch never travels
   * in a Server Action body; there is no action to wrap in an outbox descriptor.
   * Every photo kind is still capturable offline — from the workspace, which is
   * the screen a field user is on when there is no connection.
   */
  assert.doesNotMatch(jobs, /type: "inspection\.photo"/);
  assert.match(jobs, /<DirectPhotoUploader/);
  const workspace = src("src/app/(app)/offline/page.tsx");
  assert.match(workspace, /type: "jobcard\.photo"/);
  assert.match(workspace, /type: "jobcard\.inspection"/);
  assert.match(workspace, /type: "inspection\.photo"/);
  assert.match(workspace, /type: "delivery\.photo"/);
  // …and RECORD writes are not offered at all — see the split test below.
  assert.doesNotMatch(workspace, /type: "lead\.|type: "contact\.|type: "delivery\.complete"/);
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
  assert.equal(guardedRecordKey({ type: "jobcard.photo", recordId: "j1" }), null);
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
  const earlier = queued({ id: "a", createdAt: 100, operation: { type: "jobcard.notes", recordId: "l1", baseVersion: "V1" } });
  const accepted = queued({ id: "b", createdAt: 200, operation: { type: "jobcard.notes", recordId: "l1", baseVersion: "V1" } });
  assert.deepEqual(chainableSiblings(accepted, [earlier, accepted], "l1", "V2"), []);
});

test("a conflicted or failed sibling stays where the person left it", () => {
  // Those are waiting for a human to look at them; rebasing would hide that.
  const accepted = queued({ id: "a", createdAt: 100, operation: { type: "jobcard.notes", recordId: "l1", baseVersion: "V1" } });
  const conflicted = queued({ id: "b", createdAt: 200, status: "conflict", operation: { type: "jobcard.notes", recordId: "l1", baseVersion: "V1" } });
  const failed = queued({ id: "c", createdAt: 300, status: "failed", operation: { type: "jobcard.notes", recordId: "l1", baseVersion: "V1" } });
  assert.deepEqual(chainableSiblings(accepted, [accepted, conflicted, failed], "l1", "V2"), []);
});

test("re-running a sync rewrites nothing", () => {
  const accepted = queued({ id: "a", createdAt: 100, operation: { type: "jobcard.notes", recordId: "l1", baseVersion: "V1" } });
  const already = queued({ id: "b", createdAt: 200, operation: { type: "jobcard.notes", recordId: "l1", baseVersion: "V2" } });
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
  assert.ok(values.length >= 2, "each gated workflow needs its own capability");
  assert.ok(values.every((allowed) => allowed === false));
  const workspace = src("src/app/(app)/offline/page.tsx");
  assert.match(workspace, /snapshot\?\.can \?\? NO_OFFLINE_CAPABILITIES/);
});

test("WRITE PERMISSION IS SHIPPED WITH THE DATA, not assumed from visibility", () => {
  /*
   * getAccessible*Ids answers "what may they SEE". Every capture form was
   * rendered on that answer alone, so a role that could view job cards but not
   * manage them was shown forms that accepted the work, said "Saved on this
   * device" and cleared themselves — and the replay was refused hours later by
   * the permission check that had been there the whole time.
   */
  const bootstrap = src("src/app/api/offline/bootstrap/route.ts");
  for (const permission of ["jobcards.manage", "deliveries.manage"]) {
    assert.ok(
      bootstrap.includes(`hasPermission(user, "${permission}")`),
      `${permission} must be resolved for the device`,
    );
  }
  const workspace = src("src/app/(app)/offline/page.tsx");
  for (const gate of ["can.jobCardManage", "can.deliveryManage"]) {
    assert.ok(workspace.includes(gate), `${gate} must gate its form`);
  }
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
  assert.match(layout, /const activeTenantId = await getActiveTenantId\(\);/,
    "the null-able resolver, not the throwing one — this layout renders every page");
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

/* ── round five ──────────────────────────────────────────────────────────── */

test("SIGNING OUT NEVER SILENTLY DISCARDS QUEUED WORK", () => {
  /*
   * The purge is irreversible and runs first, on purpose — the next person on
   * this device must not inherit the last one's records. Everything therefore
   * rests on there being nothing left worth keeping.
   *
   * BEING ONLINE IS NOT THAT ASSURANCE, which is what the first version of this
   * guard got wrong. A full outbox on a connected device is the ordinary state
   * moments after coming back into signal, and failed or conflicted entries sit
   * there indefinitely BY DESIGN, waiting to be read. Sign-out was deleting a
   * day of captured work and its photos.
   *
   * Offline it was worse still: `logout()` is a Server Action, so it failed
   * AFTER the purge and left the session signed in.
   */
  const menu = src("src/components/AccountMenu.tsx");
  const guard = menu.slice(menu.indexOf("async function signOutSafely"), menu.indexOf("await purgeOfflineData()"));
  assert.match(guard, /const outbox = offline\?\.pending \?\? 0;/, "the queue is the question, not connectivity");
  assert.match(guard, /offlinePendingCount\(\{ tenantId, userId: user\.id \}\)/,
    "guided checklists keep their own device store — both are purged, so both must be counted");
  assert.match(guard, /if \(pending > 0\) \{/);
  assert.match(guard, /if \(!navigator\.onLine\) \{/, "connectivity still matters — logout() is a Server Action");
  assert.ok(
    guard.indexOf("const outbox") < guard.indexOf("if (!navigator.onLine)"),
    "the work is counted before the connection is judged",
  );
  assert.ok(
    (guard.match(/return;/g) ?? []).length >= 2,
    "both refusals must come BEFORE the purge",
  );
});

test("AN AMBIGUOUSLY APPLIED CHANGE IS NEVER SENT AGAIN", () => {
  /*
   * At-most-once rests on the server's receipt, and re-queueing deliberately
   * mints a NEW id — which is exactly what walks past a closed one. Right for a
   * change refused BEFORE it was applied; wrong for one the server may have
   * committed and then failed to record, where a create would land twice and a
   * photo append would file twice.
   */
  const entry: OfflineMutation = {
    id: "a",
    tenantId: "t1",
    userId: "u1",
    operation: { type: "jobcard.photo", recordId: "job1" },
    fields: [],
    createdAt: 1_700_000_000_000,
    attempts: 1,
    status: "failed",
    indeterminate: true,
  };
  assert.deepEqual(
    requeueBase(entry, null),
    { retryable: false },
    "an unguarded create is otherwise always retryable — the flag is what stops it",
  );

  const route = src("src/app/api/offline/sync/route.ts");
  assert.match(route, /let executionStarted = false;/);
  assert.match(
    route,
    /executionStarted = true;\s*\r?\n\s*const result = \(await execute\(/,
    "the flag must be set immediately before the write, so everything earlier stays retryable",
  );
  assert.match(route, /const failure = executionStarted/);
  assert.match(route, /may or may not have been applied/);
  // …and the device has to carry it through onto the queue entry.
  assert.match(src("src/components/OfflineProvider.tsx"), /indeterminate: result\.indeterminate === true/);
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
    operation: { type: "jobcard.notes", recordId: "job1", baseVersion: "V1" },
    error: "You do not have permission to manage job cards",
    fields: [
      { name: "checkinNotes", kind: "text", value: "Scratch on the near-side panel" },
      { name: "checkoutNotes", kind: "text", value: "Customer shown the repair" },
    ],
  });
  assert.deepEqual(
    recoverableFields(entry).map((f) => `${f.name}=${f.value}`),
    ["checkinNotes=Scratch on the near-side panel", "checkoutNotes=Customer shown the repair"],
  );
  const text = recoveryText(entry);
  assert.match(text, /jobcard\.notes/);
  assert.match(text, /checkinNotes: Scratch on the near-side panel/);
});

test("plumbing and blanks are not shown back as if they were typed", () => {
  const entry = captured({
    id: "a",
    operation: { type: "jobcard.photo", recordId: "job1" },
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
    operation: { type: "jobcard.notes", recordId: "l1", baseVersion: "V1" },
  });
  const snapshot = {
    jobCards: [{ id: "l1", updatedAt: "V2", inspectionItems: [] }],
    deliveries: [],
  } as unknown as Parameters<typeof requeueBase>[1];

  assert.deepEqual(requeueBase(entry, snapshot), { retryable: true, baseVersion: "V2" });
});

test("a record no longer on the device can be copied but not replayed", () => {
  // Nothing to rebase onto, so "Try again" is not offered — the honest answer is
  // to copy the details and re-enter them online.
  const entry = captured({ id: "a", status: "conflict", operation: { type: "jobcard.notes", recordId: "gone", baseVersion: "V1" } });
  const snapshot = { jobCards: [], deliveries: [] } as unknown as Parameters<typeof requeueBase>[1];
  assert.deepEqual(requeueBase(entry, snapshot), { retryable: false });
  assert.deepEqual(requeueBase(entry, null), { retryable: false });
});

test("an unguarded change needs no version to be replayed", () => {
  const entry = captured({ id: "a", operation: { type: "jobcard.photo", recordId: "job1" } });
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

/* ── the boundary of this feature ────────────────────────────────────────── */

test("OFFLINE IS CAPTURE ONLY — records are not written from a cached snapshot", () => {
  /*
   * WHY THE LINE IS HERE.
   *
   * Everything offline can do is an APPEND, or a field write on a record the
   * device already holds: photos, condition notes, inspection results. Those
   * replay through one permission and one module gate, and both travel with the
   * snapshot.
   *
   * Creating or editing a lead or a contact does not. `createLead` and
   * `updateLead` between them enforce create permission, edit permission, a
   * separate stage-change permission, open-stage validity, per-stage entry and
   * exit gates that can demand a reason or a remedy, pipeline-move permission
   * and assignment rules. `markDelivered` adds scheduling state and module
   * entitlement. Every one is a rule the device would have to mirror from a
   * snapshot and keep in step with the server for ever.
   *
   * Seven review rounds on the original pull request produced sixteen findings.
   * Almost all of them were one bug — the device accepting work the server would
   * refuse — and almost all of them were on that surface. This is where it is
   * drawn instead.
   */
  const types = src("src/lib/offlineTypes.ts");
  const operations = types.slice(types.indexOf("export type OfflineOperationType"), types.indexOf("export type OfflineDescriptor"));
  for (const gone of ["lead.create", "lead.update", "contact.create", "contact.update", "delivery.complete"]) {
    assert.ok(!operations.includes(`"${gone}"`), `${gone} is not part of offline capture`);
  }
  for (const kept of ["jobcard.notes", "jobcard.inspection", "jobcard.photo", "inspection.photo", "delivery.photo"]) {
    assert.ok(operations.includes(`"${kept}"`), `${kept} must remain capturable`);
  }

  // The server half must agree, or a hand-made POST could still reach an action
  // the UI no longer offers.
  const route = src("src/app/api/offline/sync/route.ts");
  const schema = route.slice(route.indexOf("const operationSchema"), route.indexOf("type Operation"));
  for (const gone of ["lead.create", "lead.update", "contact.create", "contact.update", "delivery.complete"]) {
    assert.ok(!schema.includes(`"${gone}"`), `${gone} must be rejected by the schema, not merely unrendered`);
  }
  assert.doesNotMatch(route, /createLead|updateLead|createContact|updateContact|markDelivered/,
    "the replay must not be able to reach a record-writing action at all");

  // And the record forms are online-only again.
  for (const form of ["src/components/LeadForm.tsx", "src/components/ContactForm.tsx", "src/components/ProofOfDelivery.tsx"]) {
    assert.doesNotMatch(src(form), /offlineOperation/, `${form} must not queue`);
  }
});

test("THE SHARED COUNT IS REPAIRED BY THE SCREEN THAT WRITES THE QUEUE", () => {
  /*
   * `pending` is what the connectivity badge shows and what sign-out consults
   * before it purges. The Pending tab deletes and re-queues entries directly, so
   * without a way to repair the count from there, discarding the last entry left
   * a device claiming work it no longer had — and while offline no sync would
   * ever run to correct it, so sign-out stayed blocked on a phantom.
   */
  const provider = src("src/components/OfflineProvider.tsx");
  assert.match(provider, /recount: \(\) => Promise<void>;/, "the provider must expose it");
  assert.match(provider, /refreshSnapshot, recount \}\}/, "…and actually pass it through the context");

  const workspace = src("src/app/(app)/offline/page.tsx");
  const discard = workspace.slice(workspace.indexOf("await removeOfflineMutation(entry.id)"));
  assert.match(discard.slice(0, 160), /await offline\.recount\(\)/, "discarding must repair the count");
  const retry = workspace.slice(workspace.indexOf("await requeueOfflineMutation("));
  assert.match(retry.slice(0, 600), /await offline\.recount\(\)/, "so must re-queueing");
});

test("THE SHELL RE-WARM APPLIES THE SAME REDIRECT CHECK AS THE NAVIGATION PATH", () => {
  /*
   * If the session expires while a newly registered worker is handling the owner
   * announcement, this second fetch follows /offline → /login exactly as the
   * navigation one did, and `ok` is true for a sign-in page.
   */
  const worker = src("public/sw.js");
  const rewarm = worker.slice(worker.indexOf("async function claimShell"), worker.indexOf("async function forgetShell"));
  assert.match(rewarm, /!fresh\.redirected && freshPath === SHELL_KEY/);
  // Both paths, or the hole simply moves.
  assert.equal(
    (worker.match(/redirected/g) ?? []).length >= 2,
    true,
    "the navigation path and the re-warm path must both check it",
  );
});
