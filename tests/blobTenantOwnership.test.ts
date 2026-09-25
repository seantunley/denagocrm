import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { blobBelongsToTenant, libraryUploadPrefix } from "../src/lib/storage";

/**
 * Audit P2-4 — public blob storage.
 *
 * `assertOwnedBlob` proved an object was in OUR store. Our store is ONE store
 * shared by every workspace, so that answered "is this ours?" and never "is this
 * yours?". The file's own comment reasoned one level short of it: it correctly
 * noted that the hostname proves the vendor rather than the owner, then treated
 * the store as if it were the owner.
 *
 * The concrete path: `registerLibraryDocuments` takes a blob URL from the client.
 * A library manager in workspace B who has come by a URL from workspace A — a
 * forwarded email, a pasted link, browser history, a screenshot — could register
 * A's file into B's library and then download it through B's own authorised
 * route. Nothing forged, nothing guessed; the URL is the only secret and objects
 * are written `access: "public"` unless BLOB_PRIVATE is on.
 */

const A = "tenant_a";
const FOUNDING = "tenant_denago_cpt";

test("a namespaced object belongs only to the workspace in its path", () => {
  assert.equal(blobBelongsToTenant(`uploads/${A}/abc.pdf`, A), true);
  assert.equal(blobBelongsToTenant(`uploads/${A}/abc.pdf`, "tenant_b"), false,
    "workspace B must not claim workspace A's object");
  assert.equal(blobBelongsToTenant(`uploads/${A}/abc.pdf`, FOUNDING), false,
    "not even the founding tenant may claim a namespaced object it does not own");
});

test("a legacy object belongs to the founding tenant, and to nobody else", () => {
  // Sound here, unlike the NULL-means-founding rule removed in #463: production
  // has only ever had ONE tenant, so an object written before namespacing
  // necessarily belongs to it. That is a fact about the deployment's history.
  assert.equal(blobBelongsToTenant("uploads/legacy.pdf", FOUNDING), true);
  assert.equal(blobBelongsToTenant("uploads/legacy.pdf", A), false);
});

test("THE LIBRARY'S OWN FILES PASS THE CHECK — the path shape the library really writes", () => {
  /*
   * Every test above used `uploads/…` paths. The library wrote `library/<name>`,
   * so from 2026-08-12, when the download route started passing the row's
   * tenant, every library download 404'd and every new library file was
   * refused at registration. Nothing here noticed, because nothing here used the
   * path the library actually produces.
   */
  // The ten files production holds: legacy, founding tenant, like uploads/<file>.
  assert.equal(blobBelongsToTenant("library/Denago EV Price List-a1B2c3.pdf", FOUNDING), true);
  assert.equal(blobBelongsToTenant("library/Denago EV Price List-a1B2c3.pdf", A), false);
  assert.equal(blobBelongsToTenant("library/nested/x.pdf", FOUNDING), false, "only the flat legacy shape");
  // New library files: inside the uploading workspace's namespace.
  assert.equal(libraryUploadPrefix(A), `uploads/${A}/library/`);
  assert.equal(blobBelongsToTenant(`${libraryUploadPrefix(A)}brochure-x9Y8z7.pdf`, A), true);
  assert.equal(blobBelongsToTenant(`${libraryUploadPrefix(A)}brochure-x9Y8z7.pdf`, "tenant_b"), false);
});

test("the library upload route signs only this workspace's library folder", () => {
  const route = code("src/app/api/library/upload/route.ts");
  assert.match(route, /tenantId = await withActingStaffScope\(\(\) => actingTenantId\(\)\);/);
  assert.match(route, /const prefix = libraryUploadPrefix\(tenantId\);/);
  assert.match(
    route,
    /if \(!pathname\.startsWith\(prefix\) \|\| pathname\.slice\(prefix\.length\)\.includes\("\/"\)\) \{\s*throw/,
    "anything outside the prefix, or nested below it, is refused before a token exists",
  );
  // And the browser asks the server where that is, rather than choosing a path.
  const uploader = code("src/components/LibraryUploader.tsx");
  assert.match(uploader, /upload\(`\$\{await getLibraryUploadPrefix\(\)\}\$\{file\.name\}`/);
  assert.ok(!uploader.includes("`library/"), "no upload to the old, unowned path");
  assert.match(code("src/app/actions/library.ts"), /return libraryUploadPrefix\(await actingTenantId\(\)\);/);
});

test("a library download streams, and a failed one is logged, not only answered", () => {
  const route = code("src/app/api/library/[id]/route.ts");
  // Two of production's ten library files are over the 4.5 MB buffered-response cap.
  assert.match(route, /const stream = await openFileStream\(version\.storedName, version\.tenantId\);/);
  assert.ok(!/\breadFile\(/.test(route));
  assert.match(route, /await logError\("library-download", error,/);
});

test("a path outside uploads/ is never a per-tenant upload", () => {
  for (const p of ["backups/2026-08-11.sql", "managed/thing.json", "", "uploads"]) {
    assert.equal(blobBelongsToTenant(p, FOUNDING), false, `"${p}" must not resolve as an upload`);
  }
});

test("a deeper path cannot smuggle a tenant segment", () => {
  // uploads/<tenant>/<file> is the shape; the check reads segment 1 and nothing
  // else, so a nested path cannot present a different owner further down.
  assert.equal(blobBelongsToTenant(`uploads/${A}/nested/deep.pdf`, A), true);
  assert.equal(blobBelongsToTenant(`uploads/tenant_b/${A}/deep.pdf`, A), false);
});

/* ------------------------------------------------------------------ wiring */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const code = (rel: string) =>
  readFileSync(path.join(root, rel), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

test("the library registration path asks whether the object is YOURS", () => {
  const lib = code("src/app/actions/library.ts");
  assert.match(lib, /await assertOwnedBlob\(file\.url, expectedTenantId\)/,
    "registration must pass the expected owner, not just check the store");
  assert.match(lib, /const scope = await actingScopeClass\(\);/,
    "the expected owner is the ACTING workspace, resolved through the shared rule");
});

test("a cross-tenant refusal is a verdict, not a store miss", () => {
  // Without this the refusal would be swallowed by the try/catch that walks the
  // two stores, and the caller would be told "not in our store" — a misleading
  // message, and one that hides the fact that someone tried.
  const storage = code("src/lib/storage.ts");
  assert.match(storage, /if \(error instanceof BlobNotYoursError\) throw error;/);
});

test("new uploads are namespaced, local refs stay flat", () => {
  const storage = code("src/lib/storage.ts");
  assert.match(storage, /const storedName = tenantId \? `\$\{tenantId\}\/\$\{localName\}` : localName;/);
  // isLocalRef rejects anything containing a slash, so the disk fallback must
  // keep the bare name or every local ref becomes unreadable.
  assert.match(storage, /await fs\.writeFile\(path\.join\(UPLOAD_DIR, localName\), buffer\);/);
  assert.match(storage, /return localName;/);
});
