import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { BlobNotYoursError, deleteOwnedBlob, mayCleanUpStoredBlob } from "../src/lib/storage";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const code = (rel: string) =>
  readFileSync(path.join(root, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, "");

const MINE = "tenant_mine";
const THEIRS = "tenant_theirs";
const QUOTE = "q_1";
const PREFIX = `uploads/${MINE}/delivery/${QUOTE}/`;

/**
 * The cleanup path could undo the ownership check that rejected the file.
 *
 * registerDeliveryPhotos and registerJobCardPhotos take Blob URLs from the
 * browser and verify each with assertOwnedBlob. A URL belonging to another
 * workspace is correctly REFUSED — and the refusal threw into a catch whose job
 * was to tidy up the staged object, which called deleteFile(url). deleteFile has
 * no tenant check at all; it deletes using the application's own Blob
 * credentials. So the sequence was:
 *
 *   attacker supplies another workspace's Blob URL
 *     -> assertOwnedBlob refuses it, correctly
 *       -> catch
 *         -> deleteFile(url)   <- deletes the other workspace's file
 *
 * Any signed-in user holding deliveries.manage or jobcards.manage on a record in
 * their OWN workspace could delete another workspace's stored file by pasting
 * its URL. These tests run that exact sequence.
 */

/* --------------------------------------------------------------- behaviour */

function spyRemove() {
  const removed: string[] = [];
  return { removed, remove: async (ref: string) => { removed.push(ref); } };
}

test("a URL refused as another workspace's is NOT deleted", async () => {
  const { removed, remove } = spyRemove();
  const verify = async () => { throw new BlobNotYoursError("Refusing a stored file that belongs to another workspace"); };

  await assert.rejects(
    () => deleteOwnedBlob("https://blob.example/theirs.jpg", MINE, PREFIX, { verify, remove }),
    BlobNotYoursError,
  );
  assert.deepEqual(removed, [], "the refused URL must never reach the delete call");
});

test("a URL that verifies but sits under another workspace's path is NOT deleted", async () => {
  // Defence in depth: even if verification were ever loosened, the prefix is
  // checked against the pathname the store actually reports.
  const { removed, remove } = spyRemove();
  const verify = async () => ({ size: 10, contentType: "image/jpeg", pathname: `uploads/${THEIRS}/delivery/${QUOTE}/x.jpg` });

  await assert.rejects(
    () => deleteOwnedBlob("https://blob.example/x.jpg", MINE, PREFIX, { verify, remove }),
    /not bound to this record/,
  );
  assert.deepEqual(removed, []);
});

test("a URL of ours but belonging to a DIFFERENT record is NOT deleted", async () => {
  // Cleanup for quote q_1 must not tidy away q_2's evidence.
  const { removed, remove } = spyRemove();
  const verify = async () => ({ size: 10, contentType: "image/jpeg", pathname: `uploads/${MINE}/delivery/q_2/x.jpg` });

  await assert.rejects(
    () => deleteOwnedBlob("https://blob.example/x.jpg", MINE, PREFIX, { verify, remove }),
    /not bound to this record/,
  );
  assert.deepEqual(removed, []);
});

test("our own staged photo for this record IS cleaned up", async () => {
  // The fix must not break the thing cleanup exists for: a photo that uploaded
  // fine and then failed to file must not be left orphaned in the store.
  const { removed, remove } = spyRemove();
  const ref = "https://blob.example/mine.jpg";
  const verify = async () => ({ size: 10, contentType: "image/jpeg", pathname: `${PREFIX}mine.jpg` });

  await deleteOwnedBlob(ref, MINE, PREFIX, { verify, remove });
  assert.deepEqual(removed, [ref]);
});

test("an empty prefix cleans up nothing rather than everything", async () => {
  const { removed, remove } = spyRemove();
  const verify = async () => ({ size: 10, contentType: "image/jpeg", pathname: `uploads/${MINE}/delivery/${QUOTE}/x.jpg` });

  await assert.rejects(() => deleteOwnedBlob("https://blob.example/x.jpg", MINE, "", { verify, remove }));
  assert.deepEqual(removed, [], "a missing prefix must fail closed, not match every path");
});

/* -------------------------------------------------------------------- rule */

test("the cleanup rule needs BOTH ownership and the record binding", () => {
  assert.equal(mayCleanUpStoredBlob(`${PREFIX}a.jpg`, MINE, PREFIX), true);
  assert.equal(mayCleanUpStoredBlob(`uploads/${THEIRS}/delivery/${QUOTE}/a.jpg`, MINE, PREFIX), false, "another workspace's object");
  assert.equal(mayCleanUpStoredBlob(`uploads/${MINE}/delivery/q_2/a.jpg`, MINE, PREFIX), false, "our object, another record");
  assert.equal(mayCleanUpStoredBlob(`${PREFIX}a.jpg`, MINE, ""), false, "no prefix is not 'any prefix'");
  assert.equal(mayCleanUpStoredBlob("backups/2026-08-11.sql", MINE, "backups/"), false, "not a per-tenant upload at all");
});

/* ----------------------------------------------------------------- wiring  */

test("no photo cleanup path calls deleteFile on a client-supplied URL", () => {
  for (const rel of ["src/app/actions/fulfilment.ts", "src/app/actions/jobcards.ts"]) {
    const src = code(rel);
    assert.doesNotMatch(
      src,
      /deleteFile\(url\)/,
      `${rel} deletes a client-supplied URL without proving ownership — use deleteOwnedBlob`,
    );
    assert.match(src, /deleteOwnedBlob\(url, /, `${rel} must clean up through the tenant-aware helper`);
  }
});

test("the prefix that admits a photo is the same one that bounds its cleanup", () => {
  // Two copies of the path string would drift, and the cleanup copy is the one
  // nobody would notice going stale.
  for (const rel of ["src/app/actions/fulfilment.ts", "src/app/actions/jobcards.ts"]) {
    const src = code(rel);
    assert.match(src, /const ownPrefix = /, `${rel} must define the record prefix once`);
    assert.match(src, /startsWith\(ownPrefix\)/, `${rel} must admit photos using that prefix`);
    assert.match(src, /deleteOwnedBlob\(url, [^,]+, ownPrefix\)/, `${rel} must bound cleanup with the same prefix`);
  }
});
