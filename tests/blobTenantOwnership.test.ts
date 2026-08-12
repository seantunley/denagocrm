import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { blobBelongsToTenant } from "../src/lib/storage";

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
