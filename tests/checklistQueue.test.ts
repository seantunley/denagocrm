import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  MAX_QUEUE_ATTEMPTS,
  countPending,
  describeQueueError,
  drain,
  enqueue,
  isStuck,
  openQueue,
  pending,
  queueAvailable,
  recordFailure,
  remove as removeQueued,
  type QueueStore,
  type QueuedPhoto,
} from "../src/lib/checklists/queue";

/**
 * Guards for the offline photo queue.
 *
 * ── WHY THESE FOUR ──────────────────────────────────────────────────────────
 *
 * Every one of them is a way the queue loses or duplicates EVIDENCE, which is
 * the only thing this feature produces:
 *
 *   1. The blob is on disk before anything is sent. Break this and a photo taken
 *      in a basement is gone the moment the tab is killed — and nothing reports
 *      it, because from the app's point of view the photo was never taken.
 *   2. Draining twice does not upload twice. Drains overlap in ordinary use, and
 *      a duplicate is a second row of evidence against the same step that
 *      nobody can tell apart from the first.
 *   3. Retries are bounded and the reason is recorded. Unbounded, a photo that
 *      can never succeed is a phone grinding forever while the person believes
 *      their evidence is on its way.
 *   4. No IndexedDB degrades rather than throws. A browser that merely cannot
 *      cache offline must not lose the ability to capture at all.
 *
 * ── WHY THIS CAN BE TESTED WITHOUT A BROWSER ────────────────────────────────
 *
 * queue.ts touches nothing browser-only at module scope and every entry point
 * takes an optional `QueueStore`. So the accounting above is exercised for real
 * here — a Map standing in for the object store — rather than restated as a
 * regex over the source. The two contracts at the bottom are the exceptions:
 * they pin an ORDERING BETWEEN MODULES that no unit test can observe.
 */

const root = path.join(__dirname, "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/* ── a store double ───────────────────────────────────────────────────── */

/**
 * The object store, as a Map.
 *
 * Copies on the way in and on the way out, the way a structured clone does, so a
 * test cannot pass by accidentally holding the same object the queue holds.
 */
function memoryStore(log: string[] = []): QueueStore & { rows: Map<string, QueuedPhoto>; log: string[] } {
  const rows = new Map<string, QueuedPhoto>();
  return {
    rows,
    log,
    async put(item) {
      log.push(`put:${item.id}`);
      rows.set(item.id, { ...item });
    },
    async get(id) {
      const row = rows.get(id);
      return row ? { ...row } : undefined;
    },
    async all(runId) {
      return [...rows.values()]
        .filter((row) => row.runId === runId)
        .map((row) => ({ ...row }))
        .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    },
    async remove(id) {
      log.push(`remove:${id}`);
      rows.delete(id);
    },
  };
}

function photo(text = "photo-bytes"): Blob {
  return new Blob([text], { type: "image/jpeg" });
}

/* ── 1. the blob is stored before anything is sent ────────────────────── */

test("enqueue writes the blob to the store and sends nothing", async () => {
  const store = memoryStore();
  const sent: string[] = [];

  const result = await enqueue({ runId: "run-1", entryId: "entry-1", blob: photo() }, store);
  assert.equal(result.stored, true, "a working store must accept the photo");

  const held = await store.all("run-1");
  assert.equal(held.length, 1, "the photo must be on disk the instant it is taken");
  assert.equal(await held[0].blob.text(), "photo-bytes", "the bytes themselves must be kept, not a reference");
  assert.equal(held[0].attempts, 0);
  assert.equal(held[0].lastError, null);
  assert.deepEqual(sent, [], "enqueue must not attempt an upload — that is drain's job");
});

test("the write happens before the send, in that order, for the same photo", async () => {
  // The ordering is the guarantee, so the ordering is what is asserted. A queue
  // that uploaded first and stored on failure would satisfy every other test in
  // this file and still lose a photo to a tab that dies mid-request.
  const log: string[] = [];
  const store = memoryStore(log);
  await enqueue({ id: "p1", runId: "run-1", entryId: "entry-1", blob: photo() }, store);
  await drain("run-1", async (item) => { log.push(`upload:${item.id}`); }, store);

  assert.deepEqual(log, ["put:p1", "upload:p1", "remove:p1"]);
});

test("a photo survives being read back from a store the caller reopened", async () => {
  // Standing in for "the app was closed and opened again": the same rows, a
  // fresh caller, no in-memory state carried over.
  const store = memoryStore();
  await enqueue({ id: "p1", runId: "run-1", entryId: "entry-1", blob: photo("tunnel") }, store);

  const survivors = await pending("run-1", store);
  assert.equal(survivors.length, 1);
  assert.equal(await survivors[0].blob.text(), "tunnel");
  assert.equal(await countPending("run-1", store), 1);
  assert.equal(await countPending("run-2", store), 0, "another run's queue must not be counted");
});

/* ── 2. draining is idempotent ────────────────────────────────────────── */

test("draining twice uploads once", async () => {
  const store = memoryStore();
  const sent: string[] = [];
  await enqueue({ id: "p1", runId: "run-1", entryId: "entry-1", blob: photo() }, store);

  const first = await drain("run-1", async (item) => { sent.push(item.id); }, store);
  const second = await drain("run-1", async (item) => { sent.push(item.id); }, store);

  assert.deepEqual(sent, ["p1"], "the second drain must find nothing left to send");
  assert.equal(first.uploaded, 1);
  assert.equal(second.uploaded, 0);
  assert.equal(await countPending("run-1", store), 0, "an uploaded photo must leave the queue");
});

test("two drains running at once do not send the same photo twice", async () => {
  /*
   * The real shape of the race: the screen drains after a sync while an
   * online-again handler drains at the same time. Both read the same waiting
   * items; without the in-flight guard both send every one of them.
   */
  const store = memoryStore();
  const sent: string[] = [];
  let release: (() => void) | null = null;
  const held = new Promise<void>((resolve) => { release = resolve; });

  await enqueue({ id: "p1", runId: "run-1", entryId: "entry-1", blob: photo() }, store);
  await enqueue({ id: "p2", runId: "run-1", entryId: "entry-1", blob: photo() }, store);

  const uploader = async (item: QueuedPhoto) => {
    sent.push(item.id);
    await held;
  };
  const both = Promise.all([
    drain("run-1", uploader, store),
    drain("run-1", uploader, store),
  ]);
  // Let both drains get as far as their first send before anything completes.
  await new Promise((resolve) => setImmediate(resolve));
  release!();
  const [a, b] = await both;

  assert.deepEqual([...sent].sort(), ["p1", "p2"], "each photo must be sent exactly once");
  assert.equal(a.uploaded + b.uploaded, 2);
  assert.ok(a.skipped + b.skipped > 0, "the overlapping drain must report what it stood aside from");
  assert.equal(await countPending("run-1", store), 0);
});

test("a photo another drain finished mid-loop is not resent from the stale snapshot", async () => {
  /*
   * The gap the in-flight set cannot close. The list a drain walks is read once;
   * every await inside it is a window in which somebody else can finish an item
   * and delete it. Sending the stale snapshot would file the same evidence
   * twice, so the item is re-read immediately before it is sent.
   */
  const store = memoryStore();
  const sent: string[] = [];
  await enqueue({ id: "p1", runId: "run-1", entryId: "entry-1", blob: photo() }, store);
  await enqueue({ id: "p2", runId: "run-1", entryId: "entry-1", blob: photo() }, store);

  const report = await drain(
    "run-1",
    async (item) => {
      sent.push(item.id);
      // While p1 is in flight, p2 is finished and removed by somebody else.
      if (item.id === "p1") await store.remove("p2");
    },
    store,
  );

  assert.deepEqual(sent, ["p1"], "p2 was already gone and must not be sent from the snapshot");
  assert.equal(report.uploaded, 1);
  assert.equal(report.skipped, 1);
});

/* ── 3. retries are bounded and the reason is kept ────────────────────── */

test("a failed upload keeps the blob, counts the attempt and records why", async () => {
  const store = memoryStore();
  await enqueue({ id: "p1", runId: "run-1", entryId: "entry-1", blob: photo("evidence") }, store);

  const report = await drain("run-1", async () => { throw new Error("Network unreachable"); }, store);

  assert.equal(report.uploaded, 0);
  assert.equal(report.failed, 1);
  const [held] = await store.all("run-1");
  assert.ok(held, "a failed upload must never destroy the only copy of the photo");
  assert.equal(await held.blob.text(), "evidence");
  assert.equal(held.attempts, 1);
  assert.equal(held.lastError, "Network unreachable");
});

test("retries stop at the cap and the photo becomes visible rather than looping", async () => {
  const store = memoryStore();
  let attempts = 0;
  await enqueue({ id: "p1", runId: "run-1", entryId: "entry-1", blob: photo() }, store);

  const failing = async () => { attempts++; throw new Error("This checklist step is not available."); };
  // Drained far more times than the cap allows, the way a phone reconnecting
  // repeatedly would.
  let last = await drain("run-1", failing, store);
  for (let i = 0; i < MAX_QUEUE_ATTEMPTS + 5; i++) last = await drain("run-1", failing, store);

  assert.equal(attempts, MAX_QUEUE_ATTEMPTS, "the queue must stop trying a photo that cannot succeed");
  assert.equal(last.failed, 0, "past the cap there is nothing left to try");
  assert.equal(last.stuck.length, 1, "a stuck photo must be reported, not silently skipped");
  assert.equal(last.stuck[0].lastError, "This checklist step is not available.");
  assert.equal(await countPending("run-1", store), 1, "the blob stays so somebody can act on it");
});

test("the attempt cap is counted on the item, not on the drain", () => {
  const item: QueuedPhoto = {
    id: "p1",
    runId: "run-1",
    entryId: "entry-1",
    blob: photo(),
    capturedAt: "2026-08-21T09:00:00.000Z",
    attempts: MAX_QUEUE_ATTEMPTS - 1,
    lastError: "timeout",
  };
  assert.equal(isStuck(item), false);
  const worse = recordFailure(item, new Error("timeout again"));
  assert.equal(worse.attempts, MAX_QUEUE_ATTEMPTS);
  assert.equal(worse.lastError, "timeout again");
  assert.equal(isStuck(worse), true);
  assert.equal(item.attempts, MAX_QUEUE_ATTEMPTS - 1, "recordFailure must not mutate the item it was given");
  assert.equal(describeQueueError("plain string"), "plain string");
  assert.equal(describeQueueError(undefined), "The upload failed for an unknown reason.");
});

/* ── 4. no IndexedDB degrades instead of throwing ─────────────────────── */

test("with no store the photo is handed back to be sent immediately, with a reason", async () => {
  const result = await enqueue({ runId: "run-1", entryId: "entry-1", blob: photo("no-store") }, null);
  assert.equal(result.stored, false, "nothing was kept, and the caller has to be told so");
  assert.ok(result.reason.length > 0, "the caller needs something to show the person");
  assert.equal(result.item.entryId, "entry-1", "the photo itself still comes back, ready to upload now");
  assert.equal(await result.item.blob.text(), "no-store");
});

test("a store that refuses the write is reported, not swallowed", async () => {
  // Almost always a quota that is full. Reporting success here would be the
  // worst outcome available: twenty photos believed safe and none of them kept.
  const full: QueueStore = {
    async put() { throw new Error("QuotaExceededError"); },
    async get() { return undefined; },
    async all() { return []; },
    async remove() {},
  };
  const result = await enqueue({ runId: "run-1", entryId: "entry-1", blob: photo() }, full);
  assert.equal(result.stored, false);
  assert.equal(result.reason, "QuotaExceededError");
});

test("every other entry point is inert without a store rather than throwing", async () => {
  assert.deepEqual(await pending("run-1", null), []);
  assert.equal(await countPending("run-1", null), 0);
  await removeQueued("p1", null);

  let called = false;
  const report = await drain("run-1", async () => { called = true; }, null);
  assert.equal(report.unavailable, true, "the screen has to be able to say there is no offline queue");
  assert.equal(report.uploaded, 0);
  assert.equal(called, false);
});

test("availability is decided by the global, so SSR and private mode both fall back", async () => {
  const original = Reflect.get(globalThis, "indexedDB") as unknown;
  try {
    Reflect.deleteProperty(globalThis, "indexedDB");
    assert.equal(queueAvailable(), false, "there is no indexedDB during SSR");
    assert.equal(await openQueue(), null, "and opening one must answer null rather than throw");
  } finally {
    if (original !== undefined) Object.defineProperty(globalThis, "indexedDB", { value: original, configurable: true });
  }
});

/* ── contracts no unit test can observe ───────────────────────────────── */

test("the queue cannot upload anything by itself", () => {
  /*
   * Structural, and it is the load-bearing half of guard 1. `enqueue` takes no
   * uploader and this module imports nothing that could send — so "stored before
   * sent" is a property of the API rather than of the order two statements
   * happen to be written in, and it cannot be undone by editing a call site.
   */
  const queue = src("src/lib/checklists/queue.ts");
  assert.doesNotMatch(queue, /@vercel\/blob/);
  assert.doesNotMatch(queue, /from "@\/app\/actions/);
  assert.doesNotMatch(queue, /\bfetch\(/);
});

test("the runner syncs the run before it drains the photo queue", () => {
  /*
   * The mandated order, and the reason is server-side: /api/photos/upload
   * authorises a checklist photo against the ENTRY — it looks the entry up,
   * resolves the run behind it and demands that host's permission. Drain first
   * and every photo fails authorisation, burns an attempt, and lands in the
   * stuck list for a reason that has nothing to do with the photo.
   *
   * Only observable across modules, so it is pinned by position in the source.
   */
  const runner = src("src/components/checklists/ChecklistRunner.tsx");
  const sync = runner.indexOf("await syncChecklistRun(");
  const drainCall = runner.indexOf("await drain(");
  const complete = runner.indexOf("await completeChecklistRun(");
  assert.ok(sync > -1 && drainCall > -1 && complete > -1, "the runner must perform all three steps");
  assert.ok(sync < drainCall, "photos cannot upload until the entry exists server-side");
  assert.ok(drainCall < complete, "completeness is computed from photos that arrived, so drain first");
});
