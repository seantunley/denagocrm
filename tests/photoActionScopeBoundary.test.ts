import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const shipped = (file: string) =>
  src(file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, "");

function functionBody(code: string, name: string, nextName?: string): string {
  const start = code.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `${name} must exist`);
  const end = nextName ? code.indexOf(`export async function ${nextName}`, start + 1) : -1;
  return code.slice(start, end === -1 ? undefined : end);
}

test("the deployment-only photo plan does not demand a workspace", () => {
  const actions = shipped("src/app/actions/photoUploads.ts");
  const body = functionBody(actions, "getPhotoUploadPlan", "reportPhotoUploadFailure");
  assert.match(body, /await requireUser\(\);/, "the plan remains staff-only");
  assert.doesNotMatch(body, /actingTenantId\(\)/, "choosing the transport must not require tenant scope");
});

test("the Blob token request binds the recovered workspace around authorization", () => {
  const route = shipped("src/app/api/photos/upload/route.ts");
  const branchStart = route.indexOf("if (photoUploadNeedsStaffSession(body?.type)) {");
  const callbackGate = route.indexOf('body?.type === "blob.upload-completed"', branchStart);
  assert.ok(branchStart >= 0 && callbackGate > branchStart, "staff and callback branches must remain distinct");
  const staffBranch = route.slice(branchStart, callbackGate);

  assert.match(staffBranch, /withActingStaffScope\(async \(\) => \{/, "the whole token branch needs an enclosing scope");
  assert.match(staffBranch, /tenantId = await actingTenantId\(\);/, "the scoped branch resolves its tenant");
  assert.match(route, /requireQuoteAccess\(target\.recordId, "deliveries\.manage"\)/);
  assert.match(route, /requireJobCardAccess\(/);
  assert.match(route, /if \(!pathname\.startsWith\(prefix\)\)/, "the granted Blob path stays record-bound");

  const callbackBranch = route.slice(callbackGate, route.indexOf("return handlePhotoUpload(request, body, null);", callbackGate));
  assert.doesNotMatch(callbackBranch, /withActingStaffScope/, "Vercel's sessionless callback must not require staff scope");
});

test("the browser uses scoped entrypoints for both direct finalization and form fallback", () => {
  const uploader = shipped("src/components/DirectPhotoUploader.tsx");
  assert.match(uploader, /from "@\/app\/actions\/photoUploads"/);
  assert.doesNotMatch(uploader, /from "@\/app\/actions\/(?:fulfilment|jobcards)"/,
    "photo requests must not bypass the scoped action facade");

  for (const action of [
    "registerDeliveryPhotos",
    "uploadDeliveryPhotos",
    "registerJobCardPhotos",
    "uploadJobCardPhotos",
    "uploadCheckoutPhotos",
    "registerInspectionPhoto",
    "uploadInspectionPhoto",
  ]) {
    assert.ok(uploader.includes(`${action}(`), `${action} remains wired in the uploader`);
  }
});

test("every photo action facade encloses the delegate and records facade failures", () => {
  const actions = shipped("src/app/actions/photoUploads.ts");
  const names = [
    "registerDeliveryPhotos",
    "uploadDeliveryPhotos",
    "registerJobCardPhotos",
    "uploadJobCardPhotos",
    "uploadCheckoutPhotos",
    "registerInspectionPhoto",
    "uploadInspectionPhoto",
  ];
  for (let i = 0; i < names.length; i++) {
    const body = functionBody(actions, names[i], names[i + 1]);
    assert.match(body, /withPhotoActionScope\(/,
      `${names[i]} must bind an authenticated recovered workspace around the whole underlying action`);
    assert.match(body, /asActionResult\(/,
      `${names[i]} must still turn facade/import failures into a durable reference`);
  }
});
