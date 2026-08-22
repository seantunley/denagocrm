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

test("photo batches bypass Server Action request bodies one file at a time", () => {
  const uploader = src("src/components/DirectPhotoUploader.tsx");
  assert.match(uploader, /from "@vercel\/blob\/client"/);
  assert.match(uploader, /for \(const \[index, original\] of selected\.entries\(\)\)/);
  assert.match(uploader, /handleUploadUrl: "\/api\/photos\/upload"/);
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
  assert.match(route, /if \(photoUploadNeedsStaffSession\(body\?\.type\)\) \{\s*tenantId = await actingTenantId\(\);\s*\}/);
  assert.match(route, /body\?\.type === "blob\.upload-completed"\s*\? "photo-upload-callback"/);
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
  assert.match(uploader, /const access = await getPhotoUploadAccess\(\)/);
  assert.match(uploader, /\{\s*access,\s*handleUploadUrl:/);
  assert.doesNotMatch(uploader, /BLOB_(?:PRIVATE_)?READ_WRITE_TOKEN/);
  assert.match(actions, /photoBlobToken\(\);\s*return photoBlobAccess\(\);/);
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
  assert.match(reporter, /where: \{ id: target\.recordId, jobCardId, tenantId \}/);
  assert.match(reporter, /"photo-upload-client"/);
});
