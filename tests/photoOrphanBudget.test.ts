import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runOrphanSweep } from "../src/lib/photoOrphanRules";

const src = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const T = "tenant_a";
const OLD = new Date(0);

/**
 * The sweep runs on a cron budget. A version that listed the WHOLE namespace
 * before touching anything spent that budget walking the store, and always began
 * again at the first object — so as storage grew it did less real work per tick
 * and objects past the first stretch were never reached at all. Those are exactly
 * the oldest and most certainly abandoned ones.
 */

type Blob = { pathname: string; url: string; uploadedAt: Date | null };

/** A fake store of N pages, recording which cursors were actually requested. */
function fakeStore(pages: Blob[][]) {
  const requested: Array<string | null> = [];
  const listPage = async (_prefix: string, cursor?: string | null) => {
    requested.push(cursor ?? null);
    const index = cursor ? Number(cursor) : 0;
    return {
      blobs: pages[index] ?? [],
      cursor: index + 1 < pages.length ? String(index + 1) : null,
    };
  };
  return { listPage, requested };
}

function blobsFor(page: number, count: number): Blob[] {
  return Array.from({ length: count }, (_, i) => ({
    pathname: `uploads/${T}/delivery/q_${page}_${i}/photo.jpg`,
    url: `https://blob.example/${page}-${i}.jpg`,
    uploadedAt: OLD,
  }));
}

function harness(pages: Blob[][], opts: { stopAfter?: number; cursor?: string } = {}) {
  const store = fakeStore(pages);
  const removed: string[] = [];
  const written: Array<[string, string]> = [];
  let seen = 0;
  return {
    store,
    removed,
    written,
    run: () =>
      runOrphanSweep({
        tenantId: T,
        now: () => Date.now(),
        shouldStop: () => (opts.stopAfter === undefined ? false : seen >= opts.stopAfter),
        io: {
          listPage: store.listPage as never,
          claimed: async () => false,
          remove: async (url: string) => { seen++; removed.push(url); },
          readCursor: async () => opts.cursor ?? null,
          writeCursor: async (k: string, v: string) => { written.push([k, v]); },
        },
      }),
  };
}

test("a whole namespace is swept across pages, not just the first", async () => {
  const h = harness([blobsFor(0, 2), blobsFor(1, 2), blobsFor(2, 1)]);
  const result = await h.run();
  assert.equal(result.deleted, 5, "every page must be reached");
  assert.equal(result.completed, true);
  assert.deepEqual(h.store.requested, [null, "1", "2"], "it must page through the store");
});

test("a completed pass clears the cursor so the next one starts fresh", async () => {
  const h = harness([blobsFor(0, 1)]);
  await h.run();
  assert.deepEqual(h.written.at(-1)?.[1], "", "a finished pass must not leave a stale resume point");
});

test("an interrupted pass advances, so the next tick reaches new ground", async () => {
  // Budget runs out inside page 0. Resuming at page 0 looks kinder — nothing is
  // skipped — but it is exactly how the tail starves: a page whose photos are all
  // legitimately claimed never shortens, so the same page would be re-examined
  // every night and nothing after it would ever be reached.
  const h = harness([blobsFor(0, 3), blobsFor(1, 3)], { stopAfter: 2 });
  const result = await h.run();

  assert.equal(result.completed, false, "it did not reach the end of the namespace");
  assert.ok(result.deleted < 6, "it should not have finished");
  const [, value] = h.written.at(-1)!;
  assert.equal(value, "1", "the next tick must start at the page AFTER the one it was cut off in");
});

test("a pass cut off in the LAST page still completes rather than looping on it", async () => {
  const h = harness([blobsFor(0, 3)], { stopAfter: 2 });
  const result = await h.run();
  assert.equal(result.completed, true, "there is nothing after the last page to resume into");
  assert.equal(h.written.at(-1)?.[1], "", "so the cursor resets and the next pass starts fresh");
});

test("the next tick resumes from the recorded cursor instead of the beginning", async () => {
  const h = harness([blobsFor(0, 2), blobsFor(1, 2), blobsFor(2, 2)], { cursor: "2" });
  const result = await h.run();
  assert.deepEqual(h.store.requested, ["2"], "it must start where the last tick stopped");
  assert.equal(result.deleted, 2, "only the resumed page's objects");
  assert.equal(result.completed, true);
});

test("the budget is checked before a page is fetched, not after", async () => {
  // A page listed and then abandoned is budget spent for nothing.
  const h = harness([blobsFor(0, 1), blobsFor(1, 1)], { stopAfter: 0 });
  const result = await h.run();
  assert.deepEqual(h.store.requested, [], "no listing should happen with no budget");
  assert.equal(result.scanned, 0);
});

test("the sweep no longer collects the whole store up front", () => {
  const lib = src("src/lib/photoOrphans.ts");
  assert.ok(!lib.includes("listActiveUploadBlobs("), "the collect-everything helper must not be used here");
  const rules = src("src/lib/photoOrphanRules.ts");
  assert.ok(rules.includes("io.listPage(prefix, cursor)"), "it must page");

});

/*
 * The store-less fallback posts real files through a Server Action. Twelve
 * photos at up to 4 MB is far past the declared body limit, and the framework
 * rejects the request BEFORE the action runs — so its per-file validation never
 * happens and the person sees a generic failure with no reason in it.
 */
test("the store-less fallback splits a batch to fit the body limit", () => {
  const uploader = src("src/components/DirectPhotoUploader.tsx");
  assert.ok(uploader.includes("MAX_UPLOAD_TOTAL_BYTES"), "the split must use the budget the server states");
  assert.ok(uploader.includes("batchBytes + file.size > MAX_UPLOAD_TOTAL_BYTES"), "batches are bounded by bytes, not count");
  assert.ok(uploader.includes("checkUploadPayload(group.map((f) => f.size))"), "each request is checked before it is sent");
  assert.ok(uploader.includes("already uploaded"), "a later failure must say what already landed");
});
