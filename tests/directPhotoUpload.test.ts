import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  photoBlobAccess,
  photoBlobToken,
  photoUploadNeedsStaffSession,
} from "../src/lib/photoBlob";

const src = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const blobEnv = (overrides: Partial<NodeJS.ProcessEnv> = {}) => ({
  BLOB_PRIVATE: undefined,
  BLOB_PRIVATE_READ_WRITE_TOKEN: undefined,
  BLOB_READ_WRITE_TOKEN: undefined,
  ...overrides,
});

/*
 * THE SENDING HALF NOW LIVES IN lib/photoTransport.ts.
 *
 * It moved there when the guided checklist runner became a second thing that
 * sends photos. The blob pathname a sender builds has to match the prefix
 * /api/photos/upload checks before it will sign anything — that check IS the
 * tenant isolation on direct uploads — so a second copy of it is how one screen
 * silently loses the ability to upload while the other keeps working.
 *
 * These assertions follow the code rather than being deleted: the properties
 * they guard are unchanged, only the file holding them.
 */
const transport = () => src("src/lib/photoTransport.ts");

test("photo batches bypass Server Action request bodies one file at a time", () => {
  const uploader = src("src/components/DirectPhotoUploader.tsx");
  assert.match(transport(), /from "@vercel\/blob\/client"/);
  // Still ONE REQUEST PER FILE, which is the property that keeps a batch under
  // the Server Action body limit — and it is still this component's own loop.
  assert.match(uploader, /for \(const \[index, original\] of selected\.entries\(\)\)/);
  assert.match(transport(), /handleUploadUrl: "\/api\/photos\/upload"/);
  assert.match(uploader, /DIRECT_PHOTO_BATCH_LIMIT/);
  assert.match(src("src/lib/photoBudget.ts"), /DIRECT_PHOTO_BATCH_LIMIT = 12/);
});

test("delivery and job-card screens use the shared direct uploader", () => {
  const delivery = src("src/app/(app)/deliveries/page.tsx");
  const jobList = src("src/app/(app)/jobcards/page.tsx");
  const job = src("src/app/(app)/jobcards/[id]/page.tsx");
  for (const code of [delivery, jobList, job]) assert.match(code, /<DirectPhotoUploader/);
  assert.doesNotMatch(delivery, /uploadDeliveryPhotos\.bind/);
  assert.doesNotMatch(jobList, /uploadJobCardPhotos\.bind/);
  assert.doesNotMatch(job, /uploadJobCardPhotos\.bind/);
});

test("upload tokens are permission checked and bound to tenant plus record path", () => {
  const route = src("src/app/api/photos/upload/route.ts");
  assert.match(route, /actingTenantId\(\)/);
  assert.match(route, /requireQuoteAccess\(target\.recordId, "deliveries\.manage"\)/);
  assert.match(route, /requireJobCardAccess\(target\.recordId, "jobcards\.manage"\)/);
  assert.match(route, /where: \{ id: target\.recordId, tenantId \}/);
  assert.match(route, /uploads\/\$\{tenantId\}\/\$\{target\.kind\}\/\$\{target\.recordId\}\//);
  assert.match(route, /maximumSizeInBytes: MAX_PHOTO_BYTES/);
  assert.match(route, /token: photoBlobToken\(\)/);
  assert.match(route, /logError\(/);
});

test("Vercel completion callbacks never require a staff session", () => {
  assert.equal(photoUploadNeedsStaffSession("blob.generate-client-token"), true);
  assert.equal(photoUploadNeedsStaffSession("blob.upload-completed"), false);
  assert.equal(photoUploadNeedsStaffSession("anything-else"), false);

  const route = src("src/app/api/photos/upload/route.ts");
  // actingTenantId() is resolved for the TOKEN branch only, and its refusal is
  // now caught so an anonymous caller is turned away rather than logged (see
  // photoUploadCallbackReach.test.ts). The property this test guards is
  // unchanged: the resolution stays inside the staff-session branch, so the
  // callback — which has no session — never reaches it.
  const guarded = route.slice(
    route.indexOf("if (photoUploadNeedsStaffSession(body?.type)) {"),
    route.indexOf("const response = await handleUpload("),
  );
  assert.ok(guarded.length > 0, "the staff-session branch is gone — was the route restructured?");
  assert.match(guarded, /tenantId = await actingTenantId\(\);/, "the token branch must still resolve the acting workspace");
  assert.equal(
    (route.match(/await actingTenantId\(\)/g) ?? []).length,
    1,
    "actingTenantId must be called once, inside the staff-session branch — a second call would gate the callback too",
  );
  assert.match(route, /body\?\.type === "blob\.upload-completed"\s*\n?\s*\? "photo-upload-callback"/);
});

test("direct photos use the configured public Blob store", () => {
  const env = blobEnv({ BLOB_READ_WRITE_TOKEN: "public-token" });
  assert.equal(photoBlobAccess(env), "public");
  assert.equal(photoBlobToken(env), "public-token");
});

test("direct photos use the private store and fail closed without its token", () => {
  const privateEnv = blobEnv({
    BLOB_PRIVATE: "true",
    BLOB_PRIVATE_READ_WRITE_TOKEN: "private-token",
    BLOB_READ_WRITE_TOKEN: "public-token",
  });
  assert.equal(photoBlobAccess(privateEnv), "private");
  assert.equal(photoBlobToken(privateEnv), "private-token");

  const brokenPrivateEnv = blobEnv({
    BLOB_PRIVATE: "true",
    BLOB_READ_WRITE_TOKEN: "public-token",
  });
  assert.throws(
    () => photoBlobToken(brokenPrivateEnv),
    /BLOB_PRIVATE=true requires BLOB_PRIVATE_READ_WRITE_TOKEN/,
  );
});

test("browser receives only the access mode and never a Blob write token", () => {
  const uploader = src("src/components/DirectPhotoUploader.tsx");
  const actions = src("src/app/actions/photoUploads.ts");
  // The browser is told WHICH STORE MODE to use and nothing else. The plan now
  // also decides the transport (see the store-less test below), but it still
  // carries only `access` — the token stays server-side.
  assert.match(uploader, /const plan = await getPhotoUploadPlan\(\)/);
  assert.match(uploader, /const access = plan\.access/);
  // The mode is handed to the shared transport, which is the only place that
  // calls upload(). Hardcoding "public" there would file every photo in the
  // wrong store the moment a deployment set BLOB_PRIVATE.
  assert.match(transport(), /access: target\.access,\s*\r?\n\s*handleUploadUrl:/);
  assert.doesNotMatch(uploader, /BLOB_(?:PRIVATE_)?READ_WRITE_TOKEN/);
  assert.doesNotMatch(transport(), /BLOB_(?:PRIVATE_)?READ_WRITE_TOKEN/);
  assert.doesNotMatch(actions, /return \{ transport: "direct", access: photoBlobToken/, "the token must never be returned to the browser");
  // The plan is now built inside asActionResult, so a failure is LOGGED rather
  // than thrown into a redacted void — but it still carries only the access
  // mode, never the token.
  assert.match(actions, /plan = token \? \{ transport: "direct", access: photoBlobAccess\(\) \}/);
});

test("finalizers verify blob ownership and log every filing failure", () => {
  const fulfilment = src("src/app/actions/fulfilment.ts");
  const jobcards = src("src/app/actions/jobcards.ts");
  assert.match(fulfilment, /assertOwnedBlob\(url, quote\.tenantId\)/);
  assert.match(fulfilment, /delivery-photo-finalize/);
  assert.match(jobcards, /assertOwnedBlob\(url, jobCard\.tenantId\)/);
  assert.match(jobcards, /jobcard-photo-finalize/);
  assert.match(jobcards, /category === "checkout" \? "jobcard-checkout" : "jobcard"/);
});

test("browser transfer failures are authorised and persisted", () => {
  const uploader = src("src/components/DirectPhotoUploader.tsx");
  const reporter = src("src/app/actions/photoUploads.ts");
  assert.match(uploader, /reportPhotoUploadFailure\(/);
  assert.match(reporter, /requireQuoteAccess/);
  assert.match(reporter, /requireJobCardAccess/);
  assert.match(reporter, /where: { id: t.recordId, jobCardId, tenantId }/, "the inspection ownership re-check keeps its shape");
  assert.match(reporter, /"photo-upload-client"/);
});

/*
 * NOT EVERY DEPLOYMENT HAS A BLOB STORE. storage.ts supports two modes by
 * design — Vercel Blob when a token is set, files on disk when self-hosted — and
 * browser-to-Blob upload only exists in the first. Making the camera
 * unconditionally use @vercel/blob/client took photo capture away from the
 * second entirely: the upload call fails in the browser before the server is
 * reached, so nothing even reaches the System Log to explain it.
 */
test("a deployment with no Blob store still captures photos", () => {
  const actions = src("src/app/actions/photoUploads.ts");
  assert.match(actions, /transport: "form"/, "there must be a path for a store-less deployment");
  assert.match(actions, /plan = token \? \{ transport: "direct"[^}]*\} : \{ transport: "form" \};/,
    "the absence of a token is what selects it");

  const uploader = src("src/components/DirectPhotoUploader.tsx");
  assert.match(uploader, /if \(plan\.transport === "form"\)/, "the component must honour the plan");
  // The fallback must reach the ORIGINAL actions, which write via saveFile() and
  // therefore work on disk.
  for (const action of ["uploadDeliveryPhotos", "uploadJobCardPhotos", "uploadCheckoutPhotos", "uploadInspectionPhoto"]) {
    assert.ok(uploader.includes(`await ${action}(`), `${action} is the store-less path for its kind`);
  }
  // …and it must be chosen BEFORE any file is prepared or uploaded, so a
  // store-less deployment never makes a doomed upload call.
  const decision = uploader.indexOf('if (plan.transport === "form")');
  const directUpload = uploader.indexOf("await uploadPhoto(");
  assert.ok(decision !== -1 && decision < directUpload, "the fallback must short-circuit before the direct upload");

  /*
   * The checklist runner has NO form fallback — it drains a queue of blobs and
   * there is no Server Action shaped to accept them. It must therefore refuse
   * with a stated reason on a store-less deployment rather than making the
   * doomed call this test exists to prevent.
   */
  const shared = transport();
  assert.match(shared, /if \(plan\.transport !== "direct"\)/);
  assert.match(shared, /no photo storage configured/);
  assert.match(src("src/components/checklists/ChecklistRunner.tsx"), /await photoUploadAccess\(\)/);
});

test("a missing PRIVATE token still fails closed rather than downgrading", () => {
  // BLOB_PRIVATE=true with no private token is a misconfiguration. Reporting
  // "form" there would quietly route sensitive photos somewhere else and hide it.
  const env = blobEnv({ BLOB_PRIVATE: "true", BLOB_READ_WRITE_TOKEN: "public-token" });
  assert.throws(() => photoBlobToken(env), /BLOB_PRIVATE=true requires BLOB_PRIVATE_READ_WRITE_TOKEN/);
});
