import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createSaveQueue, type SaveOutcome } from "../src/lib/dashboard/saveQueue";

/**
 * The dashboard editor's autosave, exercised rather than grepped.
 *
 * The editor debounces its saves and, until this suite existed, that debounce
 * was the only thing between the user and overlapping writes of the whole config
 * document. A debounce delays a write; it does not stop a second one starting
 * while the first is still out. Three orderings followed from that, and every one
 * of them ended with the screen and the row holding different arrangements:
 *
 *   1. old success after new success
 *   2. new failure after old success
 *   3. old failure after new success
 *
 * Each is reproduced below with the completion order chosen by the test — no
 * sleeps, no timing, no hoping. Every write is parked in an outbox and delivered
 * to the fake row exactly when the test says so, so "A lands second" is a
 * statement about the test, not about the scheduler.
 *
 * Both halves of the fix are covered:
 *
 *   - the CLIENT rule, that an answer from a superseded write may not touch
 *     state, driven through `dispatch` so the writes genuinely overlap;
 *   - the SERVER rule, that a write is conditional on the revision it was made
 *     against, modelled here with the same updateMany-and-count semantics the
 *     action uses.
 *
 * Both are needed and neither is sufficient. The server fence stops the older
 * edit becoming the last word in the row; the client fence stops a superseded
 * answer moving the screen. Ordering (2) is fixed by neither — it is fixed by
 * serialising, which is what makes a write's rollback target the outcome of the
 * write before it rather than a snapshot from two edits ago.
 */

/* ── harness ──────────────────────────────────────────────────────── */

/** Let every already-resolved promise callback run. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * The row, with the fence the server action applies.
 *
 * `write` is the model of `updateMany({ where: { id, updatedAt: expected } })`
 * followed by the count check: the write happens only if the revision it was
 * made against is still the one the row carries, and it produces a new revision.
 */
function createRow(config: string, stamp: string) {
  let revisions = 0;
  const row = {
    config,
    stamp,
    write(next: string, expected: string | null): SaveOutcome {
      if (expected !== row.stamp) {
        return { ok: false, conflict: true, message: "changed somewhere else" };
      }
      revisions += 1;
      row.config = next;
      row.stamp = `rev-${revisions}`;
      return { ok: true, stamp: row.stamp };
    },
  };
  return row;
}

type Sent = {
  config: string;
  stamp: string | null;
  settle: (outcome: SaveOutcome) => void;
};

/**
 * A queue whose writes go nowhere until the test releases them.
 *
 * `screen` tracks what the user is looking at: the editor applies an edit
 * optimistically the moment it is made, and only a refusal moves it back — so
 * the test sets it when it edits, and the queue's `onRejected` is the only other
 * thing that may touch it. That is precisely the property under test.
 */
function harness(initialStamp: string | null = "rev-0") {
  const row = createRow("c0", "rev-0");
  const sent: Sent[] = [];
  const conflicts: string[] = [];
  const rejections: string[] = [];
  let screen = "c0";
  let busyChanges = 0;

  const queue = createSaveQueue<string>({
    initialConfig: "c0",
    initialStamp,
    write: (config, stamp) =>
      new Promise<SaveOutcome>((resolve) => {
        sent.push({ config, stamp, settle: resolve });
      }),
    onRejected: (restore, message) => {
      screen = restore;
      rejections.push(message);
    },
    onConflict: (message) => conflicts.push(message),
    onBusyChange: () => {
      busyChanges += 1;
    },
  });

  return {
    row,
    sent,
    queue,
    conflicts,
    rejections,
    busyChanges: () => busyChanges,
    /** Make an edit: the screen shows it at once, and it is queued. */
    edit(config: string) {
      screen = config;
      queue.submit(config);
    },
    /** Show an edit on screen without queueing it — for `dispatch` cases. */
    show(config: string) {
      screen = config;
    },
    screen: () => screen,
    /** Deliver a parked write to the row and answer it. */
    async land(index: number) {
      const entry = sent[index];
      assert.ok(entry, `no write at index ${index}`);
      entry.settle(row.write(entry.config, entry.stamp));
      await tick();
    },
    /**
     * Answer a parked write with a bare success, without consulting the row.
     *
     * For isolating the CLIENT rule. The row's own fence normally refuses the
     * older of two overlapping writes, which masks what the client would do with
     * a late success — so this models the server the client must not depend on:
     * one that accepted both writes.
     */
    async accept(index: number, stamp: string) {
      const entry = sent[index];
      assert.ok(entry, `no write at index ${index}`);
      entry.settle({ ok: true, stamp });
      await tick();
    },
    /** Answer a parked write with an ordinary refusal — the row is untouched. */
    async refuse(index: number, message = "Cannot group by “colour”") {
      const entry = sent[index];
      assert.ok(entry, `no write at index ${index}`);
      entry.settle({ ok: false, message });
      await tick();
    },
  };
}

/* ── 1. old success after new success ─────────────────────────────── */

test("an older write's success cannot pull the editor back a step", async () => {
  /*
   * Both writes are dispatched before either lands — the overlap the queue's own
   * `flush` will not produce, forced here through `dispatch`, because the fence
   * has to be a guarantee of the module rather than a consequence of being
   * called carefully.
   *
   * B is answered first, then A, and BOTH are answered with a success — the
   * client rule in isolation. The row's own fence would normally refuse the
   * older write, which would mask this; the client must not be relying on that,
   * because it is the half that keeps the SCREEN honest.
   *
   * A is a generation behind, so its answer is discarded whole: it does not
   * become the committed arrangement, and the editor does not fall back to
   * arrangement 1 after having accepted 2.
   */
  const h = harness();
  h.show("c1");
  const a = h.queue.dispatch("c1");
  h.show("c2");
  const b = h.queue.dispatch("c2");

  assert.equal(h.sent.length, 2, "both writes must be out for this ordering to exist");

  await h.accept(1, "rev-2"); // B is accepted
  await h.accept(0, "rev-1"); // A's success arrives afterwards
  await Promise.all([a, b]);

  assert.equal(h.queue.committed(), "c2", "the newest accepted edit must stay committed");
  assert.equal(h.screen(), "c2", "the screen must not step back to the older edit");
  assert.equal(
    h.queue.stamp(),
    "rev-2",
    "and the revision must not go backwards — the next write would fence against a superseded one",
  );
});

test("the older write is also refused by the row, so it cannot land last", async () => {
  /*
   * The other half of the same ordering, and the one the client alone cannot
   * fix: if both writes were allowed into the row, the one that arrived last
   * decided its contents — routinely the OLDER edit. Both carry the revision
   * they were made against, so the row accepts exactly one.
   */
  const h = harness();
  const a = h.queue.dispatch("c1");
  const b = h.queue.dispatch("c2");

  await h.land(1); // B writes: rev-0 → rev-1
  await h.land(0); // A still carries rev-0 and must be refused
  await Promise.all([a, b]);

  assert.equal(h.row.config, "c2", "the older edit must not overwrite the newer one");
  assert.equal(h.conflicts.length, 0, "a superseded write's conflict is not announced either");
});

/* ── 2. new failure after old success ─────────────────────────────── */

test("a refusal restores the last edit the server accepted, not a stale snapshot", async () => {
  /*
   * THE ORDERING NEITHER FENCE FIXES — serialising does.
   *
   * A (c1) succeeds, B (c2) is refused. B is the newest write, so its refusal is
   * honoured and the screen goes back. The question is back to WHAT. The failure
   * handler used to restore the arrangement captured when the edit was made,
   * which for B was c0, because A had not landed at the time. Row: c1. Screen:
   * c0. Nothing said so.
   *
   * Dispatching only after the previous write settles is what fixes it: B's
   * rollback target is captured after A's outcome is known, so it is c1.
   */
  const h = harness();
  h.edit("c1");
  void h.queue.flush();

  // The user edits again while the first write is still out. The editor
  // restarts its debounce on every edit and the debounce always flushes, so the
  // flush here is what really happens — and it is the queue, not the caller,
  // that has to decline to start a second write.
  h.edit("c2");
  void h.queue.flush();
  assert.equal(h.sent.length, 1, "the second edit must NOT start a second write");

  await h.land(0); // A succeeds; the drain then sends B
  assert.equal(h.sent.length, 2, "the queued edit goes out once the first write lands");
  assert.equal(h.sent[1]?.stamp, "rev-1", "and it fences against the revision A produced");

  await h.refuse(1); // B is refused
  await h.queue.settled();

  assert.equal(h.rejections.length, 1, "the newest write's refusal must be reported");
  assert.equal(h.screen(), "c1", "the screen goes back to the last ACCEPTED edit, not to c0");
  assert.equal(h.row.config, "c1", "which is what the row holds");
  assert.equal(h.screen(), h.row.config, "screen and row converge");
});

/* ── 3. old failure after new success ─────────────────────────────── */

test("an older write's failure cannot roll back over a newer accepted edit", async () => {
  /*
   * A fails, B succeeds, and A's refusal arrives last. Rolling back on it would
   * throw away an arrangement the row has already accepted and raise an error
   * about a save nobody is waiting on. A is a generation behind: discarded.
   */
  const h = harness();
  h.show("c1");
  const a = h.queue.dispatch("c1");
  h.show("c2");
  const b = h.queue.dispatch("c2");

  await h.land(1); // B succeeds
  await h.refuse(0); // A's refusal arrives afterwards
  await Promise.all([a, b]);

  assert.equal(h.rejections.length, 0, "a superseded refusal must not be announced");
  assert.equal(h.screen(), "c2", "the newer accepted edit must stay on screen");
  assert.equal(h.row.config, "c2");
  assert.equal(h.queue.committed(), "c2");
  assert.equal(h.screen(), h.row.config, "screen and row converge");
});

/* ── serialising and coalescing ───────────────────────────────────── */

test("only one write is ever in flight", async () => {
  // Four edits in a burst, flushed each time — the shape of a drag through four
  // sections. The queue must never have two writes of the same document out.
  const h = harness();
  for (const config of ["c1", "c2", "c3", "c4"]) {
    h.edit(config);
    void h.queue.flush();
    assert.equal(h.sent.length, 1, `a second write started while one was in flight (${config})`);
  }

  await h.land(0);
  // Everything after the first edit collapsed into ONE follow-up carrying the
  // arrangement the user stopped on. The middle arrangements are never written.
  assert.equal(h.sent.length, 2, "the burst must collapse into a single follow-up write");
  assert.equal(h.sent[1]?.config, "c4", "and it must be the arrangement the user stopped on");

  await h.land(1);
  await h.queue.settled();
  assert.equal(h.row.config, "c4");
  assert.equal(h.screen(), "c4");
});

test("a queued edit is held back while a fresh debounce is running", async () => {
  /*
   * The drain writes a queued arrangement the moment the current write lands.
   * Mid-drag that would chase a half-finished arrangement, which is the wasteful
   * behaviour the debounce exists to prevent — so `hold` stops it.
   */
  let debouncing = false;
  const sent: Array<(outcome: SaveOutcome) => void> = [];
  const queue = createSaveQueue<string>({
    initialConfig: "c0",
    initialStamp: "rev-0",
    hold: () => debouncing,
    write: () => new Promise<SaveOutcome>((resolve) => sent.push(resolve)),
  });

  queue.submit("c1");
  void queue.flush();
  assert.equal(sent.length, 1);

  queue.submit("c2");
  debouncing = true; // the user is still moving; a new debounce is counting down
  sent[0]?.({ ok: true, stamp: "rev-1" });
  await tick();
  assert.equal(sent.length, 1, "the drain must not chase an edit that is still settling");

  debouncing = false;
  void queue.flush();
  assert.equal(sent.length, 2, "and it goes out once the debounce elapses");
});

/* ── the row's fence, on its own terms ────────────────────────────── */

test("consecutive saves adopt the revision they produced, so none conflicts with itself", async () => {
  // The failure this rules out: an editor that kept sending the revision it
  // LOADED would save once and then conflict against its own first write for the
  // rest of the session.
  const h = harness();
  for (let n = 1; n <= 3; n += 1) {
    h.edit(`c${n}`);
    void h.queue.flush();
    await h.land(n - 1);
    await h.queue.settled();
  }

  assert.deepEqual(
    h.sent.map((entry) => entry.stamp),
    ["rev-0", "rev-1", "rev-2"],
    "each write must fence against the revision the one before it produced",
  );
  assert.equal(h.conflicts.length, 0, "an editor must never conflict with itself");
  assert.equal(h.row.config, "c3");
  assert.equal(h.screen(), h.row.config, "screen and row converge");
});

test("a write made against a superseded revision is refused, and nothing is rolled back", async () => {
  /*
   * Two tabs. This one loaded rev-0 and started a save; the other wrote first.
   * The row now holds an arrangement this editor has never seen, so restoring
   * our own last-accepted config would replace one wrong screen with another —
   * the conflict is reported instead, and the editor re-reads.
   */
  const h = harness();
  h.edit("c1");
  void h.queue.flush();

  // Somebody else writes while our save is out.
  h.row.write("theirs", h.row.stamp);

  await h.land(0);
  await h.queue.settled();

  assert.equal(h.conflicts.length, 1, "the user must be told the row moved on");
  assert.equal(h.rejections.length, 0, "a conflict must not be rolled back — see onConflict");
  assert.equal(h.row.config, "theirs", "the other tab's work must survive");
  assert.equal(h.queue.committed(), "c0", "and we must not claim their arrangement as ours");
});

test("a queue with no revision yet still fences, once one exists", async () => {
  // A dashboard that has never been stored has no revision. `takeControl()`
  // materialises the row and supplies the first one; there is no unfenced write.
  const h = harness(null);
  h.edit("c1");
  void h.queue.flush();
  assert.equal(h.sent[0]?.stamp, null, "the first write has nothing to fence against yet");

  h.sent[0]?.settle({ ok: true, stamp: "rev-9" });
  await tick();
  await h.queue.settled();

  h.edit("c2");
  void h.queue.flush();
  assert.equal(h.sent[1]?.stamp, "rev-9", "every write after the first is fenced");
});

/* ── the parts that need a database, pinned as source ─────────────── */

const root = path.join(__dirname, "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("the conditional write and the revision it produced are ONE transaction", () => {
  /*
   * Cannot be executed here — it is a property of a Postgres transaction — so it
   * is pinned as source, the same way tests/flowSaveConcurrency.test.ts pins it
   * for the flow canvas.
   *
   * As two statements another legitimate writer could land between the update
   * and the read, and this editor would adopt THEIR revision without ever having
   * seen their arrangement. Its next save would then overwrite their work
   * without a conflict: the same lost update, in a narrower window.
   */
  const action = src("src/app/actions/dashboardConfig.ts");
  const save = action.slice(action.indexOf("export async function saveDashboardConfig"));
  const body = save.slice(0, save.indexOf("export async function takeControl"));

  assert.match(body, /prisma\.\$transaction\(async \(tx\) => \{/, "the write must be in a transaction");
  assert.match(
    body,
    /tx\.dashboard\.updateMany\(\{\s*where: \{ id: row\.id, updatedAt: expected \}/,
    "the write must be conditional on the revision the editor loaded",
  );
  assert.match(body, /if \(count\.count !== 1\) return null;/, "and the count must be checked");

  // The transaction callback runs from `$transaction(async (tx) => {` to the
  // refusal that follows it. Both statements must fall inside that span, in
  // order — a read after the block has closed is the two-statement version.
  const opens = body.indexOf("prisma.$transaction(async (tx) => {");
  const closes = body.indexOf("if (!stamp)");
  const update = body.indexOf("tx.dashboard.updateMany");
  const read = body.indexOf("tx.dashboard.findUnique");
  assert.ok(opens > -1 && closes > opens, "could not isolate the transaction");
  assert.ok(update > -1 && read > -1, "both statements must be present");
  assert.ok(update > opens && update < closes, "the write must be inside the transaction");
  assert.ok(read > update && read < closes, "the revision must be read INSIDE the same transaction");

  // No unfenced path. An optional stamp lets a caller opt out of the invariant.
  assert.ok(
    !/prisma\.dashboard\.update\(\{\s*where: \{ id: row\.id \},\s*data: \{ config:/.test(body),
    "there must be no unconditional config write left",
  );
});

test("the editor sends the revision it holds, and adopts the one each write returns", () => {
  const provider = src("src/components/dashboard/editor/EditorProvider.tsx");
  assert.match(
    provider,
    /saveDashboardConfig\(slug, next, fence\)/,
    "every save must carry the revision it is fenced against",
  );
  assert.match(
    provider,
    /return \{ ok: true, stamp: result\.updatedAt \?\? fence \};/,
    "and a successful save must adopt the revision it produced",
  );
  // The unmount write is chained behind anything in flight, or it would carry a
  // revision the in-flight write is about to supersede and be refused.
  assert.match(
    provider,
    /queue\.settled\(\)\.then\(\(\) => saveDashboardConfig\(slugAtMount, unsaved, queue\.stamp\(\)\)\)/,
    "the last write on the way out must wait for the one already in flight",
  );
});
