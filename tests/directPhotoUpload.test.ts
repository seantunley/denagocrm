import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

test("photo batches bypass Server Action request bodies one file at a time", () => {
  const uploader = src("src/components/DirectPhotoUploader.tsx");
  assert.match(uploader, /from "@vercel\/blob\/client"/);
  assert.match(uploader, /for \(const \[index, original\] of selected\.entries\(\)\)/);
  assert.match(uploader, /handleUploadUrl: "\/api\/photos\/upload"/);
  assert.match(uploader, /DIRECT_PHOTO_BATCH_LIMIT/);
  assert.match(src("src/lib/photoBudget.ts"), /DIRECT_PHOTO_BATCH_LIMIT = 30/);
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
  assert.match(route, /logError\(/);
});

test("finalizers verify blob ownership and log every filing failure", () => {
  const fulfilment = src("src/app/actions/fulfilment.ts");
  const jobcards = src("src/app/actions/jobcards.ts");
  assert.match(fulfilment, /assertOwnedBlob\(url, quote\.tenantId\)/);
  assert.match(fulfilment, /delivery-photo-finalize/);
  assert.match(jobcards, /assertOwnedBlob\(url, jobCard\.tenantId\)/);
  assert.match(jobcards, /jobcard-photo-finalize/);
  assert.match(jobcards, /uploads\/\$\{jobCard\.tenantId\}\/jobcard\/\$\{jobCard\.id\}\//);
});
