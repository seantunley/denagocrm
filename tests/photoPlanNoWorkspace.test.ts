import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const shipped = (f: string) =>
  readFileSync(path.join(process.cwd(), f), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, "");

const planBody = () => {
  const code = shipped("src/app/actions/photoUploads.ts");
  const start = code.indexOf("export async function getPhotoUploadPlan");
  const end = code.indexOf("export async function reportPhotoUploadFailure");
  return code.slice(start, end === -1 ? undefined : end);
};

/**
 * A DISCARDED CALL STOPPED PEOPLE TAKING PHOTOS.
 *
 * getPhotoUploadPlan awaited actingTenantId() and threw the result away. Nothing
 * in it needs a workspace — the only thing it reveals is which Blob store mode
 * the DEPLOYMENT uses — but actingTenantId throws when a sign-in resolves no
 * workspace, and this is the first server call the camera makes. So a session
 * with no `tid` claim could not upload a photo, blocked by a line whose value was
 * never read; and because the same missing claim also empties the System Log, the
 * failure left no trace anyone could find.
 */
test("preparing an upload does not require a workspace", () => {
  assert.doesNotMatch(
    planBody(),
    /actingTenantId\(\)/,
    "this action resolves no workspace and must not fail for want of one",
  );
});

test("but it is still staff-only", () => {
  // Dropping the tenant call must not drop the gate. The plan is not secret, but
  // it is not anonymous either.
  assert.match(planBody(), /await requireUser\(\);/, "requireUser is the gate that belongs here");
});

test("the real authorisation still happens where a decision is made", () => {
  // The token mint grants write access to a specific path, and the register step
  // files a row against a specific record. Both need a workspace; both resolve
  // one themselves. That is why the plan does not have to.
  const route = shipped("src/app/api/photos/upload/route.ts");
  assert.match(route, /tenantId = await actingTenantId\(\)/, "the token mint resolves its own workspace");
  assert.match(route, /requireQuoteAccess\(target\.recordId, "deliveries\.manage"\)/);
  assert.match(route, /if \(!pathname\.startsWith\(prefix\)\)/, "and pins the granted path to it");

  const finalize = shipped("src/app/actions/fulfilment.ts");
  assert.match(finalize, /assertOwnedBlob\(url, quote\.tenantId\)/, "filing re-checks ownership");
});
