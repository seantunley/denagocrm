/**
 * The device-side photo queue.
 *
 * ── WHY A QUEUE AT ALL ──────────────────────────────────────────────────────
 *
 * A handover happens in a driveway; a vehicle check-in happens in a basement
 * workshop. The camera works there and the network does not. Every design in
 * this file follows from one rule:
 *
 *     THE BLOB IS WRITTEN TO DISK BEFORE ANY UPLOAD IS ATTEMPTED.
 *
 * Not "attempted first, queued on failure" — that loses the photo when the tab
 * is killed mid-request, which on a phone is what happens the moment somebody
 * switches to the torch. `enqueue` does not take an uploader and cannot send
 * anything; `drain` only ever sends what it has just read back out of the store.
 * The two are separate functions so the ordering is a property of the API rather
 * than of the order somebody wrote two statements in.
 *
 * ── WHY THE SERVER HAS NO "PENDING PHOTO" ROW ───────────────────────────────
 *
 * See the note on ChecklistPhoto in prisma/checklists.prisma. A pending row is a
 * claim the server cannot verify, cannot retry and cannot clear when the phone
 * is dropped in a bay. The waiting list belongs on the device that is holding
 * the bytes, and completeness is computed from photos that actually arrived.
 *
 * ── WHY THE RUN MUST BE SYNCED FIRST ────────────────────────────────────────
 *
 * `/api/photos/upload` authorises a checklist photo against the ENTRY: it looks
 * the entry up, resolves the run behind it, and demands the permission that
 * run's host demands. So the entry must already exist server-side before a token
 * can be minted. Nothing in this file enforces that — it cannot, it has no idea
 * what a run is — but the uploader a caller passes to `drain` will fail every
 * item with an authorisation error if the caller drains before it syncs. The
 * bounded retries below are what stop that mistake becoming an infinite loop.
 *
 * ── PLAIN IndexedDB ─────────────────────────────────────────────────────────
 *
 * No wrapper library. This is one object store, four operations, and a
 * dependency here would be shipped to every phone that opens the app for the
 * sake of about sixty lines.
 *
 * ── THIS MODULE IS IMPORTABLE BY `node --test` ──────────────────────────────
 *
 * Nothing browser-only is touched at module scope, and every entry point takes
 * an optional `QueueStore` — the seam a test implements with a Map. That is not
 * a testing courtesy: the retry accounting and the double-upload guard are the
 * two things most worth proving, and neither is provable through an API that can
 * only be reached from a browser.
 */

/* ── what is in the queue ─────────────────────────────────────────────── */

/** One photo waiting to go up. */
export type QueuedPhoto = {
  /**
   * Minted on the DEVICE, before the photo has anywhere to go.
   *
   * It becomes `ChecklistPhoto.id`, which is what makes a retry after a crash
   * re-send the same photo instead of a duplicate: the finalising action upserts
   * by this id, so the same bytes arriving twice converge on one row.
   */
  id: string;
  runId: string;
  /** The entry the evidence belongs to, and what the upload token authorises. */
  entryId: string;
  /**
   * The image itself, already shrunk (see lib/photoTransport.ts).
   *
   * Shrunk BEFORE it is stored, not on the way out. A 4 MB original sitting in
   * IndexedDB is four megabytes of a quota that is measured in tens on a phone
   * in private mode, and a walk-around of a vehicle is twenty photos. Storing
   * the original would mean the queue itself is what fills the disk.
   */
  blob: Blob;
  /**
   * When the CAMERA fired, ISO-8601.
   *
   * Kept because it can be hours before the upload lands, and it is the first of
   * the two times that describes the vehicle. A string rather than a Date so the
   * value survives the structured clone unchanged and reaches the server action
   * in the form it wants.
   */
  capturedAt: string;
  /** How many times sending this has been tried and failed. */
  attempts: number;
  /** Why the last attempt failed, so a stuck photo can say what is wrong. */
  lastError: string | null;
};

/**
 * How many times one photo may fail before the queue stops trying it.
 *
 * Bounded on purpose. An unbounded retry on a photo that can never succeed — the
 * entry was deleted, the tenant no longer owns the record, the file is not
 * actually an image — is a phone that uploads nothing else while it grinds
 * forever on one item, silently, with the person believing their evidence is on
 * its way. Five attempts is more than a flaky connection needs and few enough
 * that the failure surfaces on the same visit.
 */
export const MAX_QUEUE_ATTEMPTS = 5;

export const QUEUE_DB_NAME = "denago-checklist-photos";
export const QUEUE_STORE_NAME = "photos";
const QUEUE_RUN_INDEX = "runId";

/* ── the storage seam ─────────────────────────────────────────────────── */

/**
 * The four things the queue needs from storage.
 *
 * `get` looks redundant beside `all` and is the whole of the idempotency
 * guarantee — see `drain`. A snapshot taken at the top of a drain goes stale the
 * moment a second drain finishes an item, so every send re-reads first.
 */
export type QueueStore = {
  put(item: QueuedPhoto): Promise<void>;
  get(id: string): Promise<QueuedPhoto | undefined>;
  /** Every photo waiting for one run, oldest capture first. */
  all(runId: string): Promise<QueuedPhoto[]>;
  remove(id: string): Promise<void>;
};

/**
 * Can this browser hold a photo across a page close?
 *
 * False on the server (there is no `indexedDB` during SSR) and false in the
 * handful of contexts that withhold it — some private-browsing modes, an iframe
 * with storage partitioned off, a browser with site data disabled.
 */
export function queueAvailable(): boolean {
  return typeof indexedDB !== "undefined" && indexedDB !== null;
}

/**
 * The one open connection, shared.
 *
 * Every public function resolves a store, and the capture screen calls several
 * of them per photo — so opening a fresh IDBDatabase each time would leave a
 * connection per call open for the life of the page, and each one of those holds
 * a version lock that blocks any other tab from upgrading the schema.
 *
 * Never caches a FAILURE. A refusal is frequently temporary (another tab is
 * mid-upgrade, or storage was momentarily unavailable), and remembering it would
 * mean one bad moment turns the queue off for the whole session.
 */
let connection: Promise<QueueStore | null> | null = null;

/**
 * Open the device queue, or return null when there isn't one.
 *
 * NULL RATHER THAN A THROW, deliberately. The caller's fallback is to upload the
 * photo immediately and tell the person it will not survive the app closing —
 * which is a worse experience and a working one. A throw here would take out the
 * capture screen itself, so a browser that merely cannot cache offline would
 * lose the ability to record anything at all. Degrading is the only reading of
 * "IndexedDB is unavailable" that keeps the evidence.
 */
export async function openQueue(): Promise<QueueStore | null> {
  if (!queueAvailable()) return null;
  connection ??= openConnection();
  const store = await connection;
  if (!store) connection = null;
  return store;
}

async function openConnection(): Promise<QueueStore | null> {
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(QUEUE_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(QUEUE_STORE_NAME)) {
          const store = database.createObjectStore(QUEUE_STORE_NAME, { keyPath: "id" });
          // Every read is "what is still waiting for THIS run", so the run is
          // the index. Without it a device holding three runs' photos would scan
          // all of them on every progress update.
          store.createIndex(QUEUE_RUN_INDEX, "runId", { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB refused to open."));
      // A version change held open by another tab. Rejecting rather than waiting
      // means the capture screen falls back to direct upload instead of hanging
      // on a promise that may never settle.
      request.onblocked = () => reject(new Error("The photo store is busy in another tab."));
    });
    /*
     * Step aside when another tab wants to upgrade the schema.
     *
     * A held-open connection blocks a `versionchange` indefinitely, and the tab
     * doing the upgrading has no way to say so — it simply waits. Closing and
     * forgetting the connection means the next call here reopens against the new
     * version rather than sitting on a lock nobody can see.
     */
    db.onversionchange = () => {
      db.close();
      connection = null;
    };
    return indexedDbStore(db);
  } catch {
    return null;
  }
}

function indexedDbStore(db: IDBDatabase): QueueStore {
  /**
   * One transaction per operation.
   *
   * An IndexedDB transaction auto-closes as soon as its microtask queue drains,
   * so a transaction held across an `await` is already dead by the time the next
   * statement runs — the classic TransactionInactiveError. Keeping each
   * operation inside its own transaction makes that unreachable.
   */
  function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(QUEUE_STORE_NAME, mode);
      const request = work(transaction.objectStore(QUEUE_STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("The photo store refused the write."));
      transaction.onabort = () => reject(transaction.error ?? new Error("The photo store aborted."));
    });
  }

  return {
    async put(item) {
      await run("readwrite", (store) => store.put(item));
    },
    async get(id) {
      return run<QueuedPhoto | undefined>("readonly", (store) => store.get(id));
    },
    async all(runId) {
      const rows = await run<QueuedPhoto[]>("readonly", (store) =>
        store.index(QUEUE_RUN_INDEX).getAll(runId),
      );
      // Capture order, so a step's photos reach the server in the order they
      // were taken rather than in whatever order the index hands them back.
      return [...rows].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    },
    async remove(id) {
      await run("readwrite", (store) => store.delete(id));
    },
  };
}

/**
 * Resolve the store a public function should use.
 *
 * `undefined` means "open the real device queue" and `null` means "there isn't
 * one" — which is what lets a test drive every path, including the no-storage
 * path, without a browser and without stubbing a global.
 */
async function resolve(given: QueueStore | null | undefined): Promise<QueueStore | null> {
  return given === undefined ? openQueue() : given;
}

/* ── pure accounting, so the guards can be tested on their own ────────── */

/** A photo that has used up its retries and is now waiting for a human. */
export function isStuck(item: QueuedPhoto): boolean {
  return item.attempts >= MAX_QUEUE_ATTEMPTS;
}

/**
 * Turn whatever was thrown into something a person can read.
 *
 * Recorded rather than logged and forgotten: a photo that will never upload has
 * to be able to say why, on the device, hours later, to somebody who was not
 * there when it failed.
 */
export function describeQueueError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "The upload failed for an unknown reason.";
}

/** The same item, one attempt worse off. Never mutates the input. */
export function recordFailure(item: QueuedPhoto, error: unknown): QueuedPhoto {
  return { ...item, attempts: item.attempts + 1, lastError: describeQueueError(error) };
}

/* ── enqueue ──────────────────────────────────────────────────────────── */

export type NewPhoto = {
  /** Optional so callers can mint it themselves and reference it immediately. */
  id?: string;
  runId: string;
  entryId: string;
  blob: Blob;
  capturedAt?: Date | string;
};

/**
 * What happened to the photo the person just took.
 *
 * `stored: false` is not a failure to report and move on from — it is an
 * instruction. The bytes are only in memory, so the caller must upload them NOW
 * and say out loud that this one will not survive the app being closed.
 */
export type EnqueueResult =
  | { stored: true; item: QueuedPhoto }
  | { stored: false; item: QueuedPhoto; reason: string };

export async function enqueue(input: NewPhoto, store?: QueueStore | null): Promise<EnqueueResult> {
  const item: QueuedPhoto = {
    id: input.id ?? crypto.randomUUID(),
    runId: input.runId,
    entryId: input.entryId,
    blob: input.blob,
    capturedAt: toIso(input.capturedAt),
    attempts: 0,
    lastError: null,
  };

  const target = await resolve(store);
  if (!target) {
    return {
      stored: false,
      item,
      reason: "This browser will not keep photos offline, so this one is being sent right away.",
    };
  }
  try {
    await target.put(item);
    return { stored: true, item };
  } catch (error) {
    /*
     * Almost always QuotaExceededError. The honest answer is the same as having
     * no store at all: the caller uploads immediately and says so. Swallowing
     * this and reporting success would be the worst outcome available — the
     * person believes twenty photos are safely queued and the browser kept none
     * of them.
     */
    return { stored: false, item, reason: describeQueueError(error) };
  }
}

function toIso(value: Date | string | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value) return value;
  return new Date().toISOString();
}

/* ── reading the queue ────────────────────────────────────────────────── */

/** Everything still waiting for one run, oldest capture first. */
export async function pending(runId: string, store?: QueueStore | null): Promise<QueuedPhoto[]> {
  const target = await resolve(store);
  return target ? target.all(runId) : [];
}

/** How many photos are still waiting — the number the capture screen shows. */
export async function countPending(runId: string, store?: QueueStore | null): Promise<number> {
  return (await pending(runId, store)).length;
}

/** Forget one photo. Used when the person deletes a capture before it goes up. */
export async function remove(id: string, store?: QueueStore | null): Promise<void> {
  const target = await resolve(store);
  await target?.remove(id);
}

/* ── draining ─────────────────────────────────────────────────────────── */

/** Send one photo, or throw. Supplied by the caller because only it knows the
 *  tenant, the blob path and which action files the resulting row. */
export type QueueUploader = (item: QueuedPhoto) => Promise<void>;

export type DrainReport = {
  uploaded: number;
  /** Attempts that failed this time round and will be tried again later. */
  failed: number;
  /**
   * Photos that have used up their retries, each carrying its `lastError`.
   *
   * Returned rather than counted so the screen can name them. A permanently
   * failing photo that is only a number is a photo nobody ever investigates.
   */
  stuck: QueuedPhoto[];
  /** Items another drain was already carrying, or had finished. */
  skipped: number;
  /** True when there is no device queue, so there was nothing to drain. */
  unavailable: boolean;
};

/**
 * Ids being uploaded RIGHT NOW, across every drain in this tab.
 *
 * Module-level because the point is to be shared. Drains overlap in ordinary
 * use — the screen drains after a sync, an interval drains when the connection
 * returns, and the person taps "upload now" because nothing seems to be
 * happening. Without this, three callers each read the same waiting item and the
 * same photo is transferred three times.
 *
 * A tab close clears it, which is correct: nothing is in flight any more.
 */
const inFlight = new Set<string>();

/**
 * Send everything waiting for one run. Safe to call as often as you like.
 *
 * ── WHY THIS CANNOT DOUBLE-UPLOAD ───────────────────────────────────────────
 *
 * Two guards, and both are needed because they cover different races.
 *
 * `inFlight` covers overlap: an item another drain has picked up is skipped
 * rather than sent a second time while the first send is still open.
 *
 * The RE-READ before each send covers the gap the first guard cannot. The list
 * this loop walks was read once, at the top; every `await` inside is a window in
 * which a concurrent drain can finish an item and delete it. By the time this
 * loop reaches that item, it is neither in flight nor in the store — and sending
 * the stale snapshot would file the same evidence twice. So the snapshot is used
 * only to decide WHICH ids to consider; the item that is actually sent is read
 * back immediately before sending, and a missing one means somebody else already
 * did the work.
 *
 * A third guard exists outside this file and is the one that survives a crash:
 * the photo's id is client-minted and is used as the ChecklistPhoto's primary
 * key, so bytes that reach storage twice still converge on one row.
 *
 * Failures do NOT remove the item. The blob stays exactly where it was, one
 * attempt worse off, with the reason recorded on it.
 */
export async function drain(
  runId: string,
  uploader: QueueUploader,
  store?: QueueStore | null,
): Promise<DrainReport> {
  const report: DrainReport = { uploaded: 0, failed: 0, stuck: [], skipped: 0, unavailable: false };
  const target = await resolve(store);
  if (!target) return { ...report, unavailable: true };

  for (const snapshot of await target.all(runId)) {
    /*
     * CLAIMED BEFORE THE FIRST AWAIT, and that is not a stylistic choice.
     *
     * Claiming after the re-read below does not work, and the failure is easy to
     * miss by reading: `await target.get(...)` yields, so a second drain runs its
     * own `has` check while the first is still suspended, finds the set empty,
     * and both go on to send. Test "two drains running at once" caught exactly
     * that — every photo transferred twice. `has` and `add` with no await
     * between them is atomic on a single-threaded runtime; anything else is not.
     */
    if (inFlight.has(snapshot.id)) {
      report.skipped++;
      continue;
    }
    inFlight.add(snapshot.id);
    try {
      const item = await target.get(snapshot.id);
      if (!item) {
        // Finished and deleted by a concurrent drain while this one was working.
        report.skipped++;
        continue;
      }
      if (isStuck(item)) {
        // Left in the store on purpose. Deleting it would destroy the photo and
        // the explanation together; the screen lists these so somebody can decide.
        report.stuck.push(item);
        continue;
      }
      try {
        await uploader(item);
        // Only now. The blob is the only copy until the server has it.
        await target.remove(item.id);
        report.uploaded++;
      } catch (error) {
        const failed = recordFailure(item, error);
        await target.put(failed);
        report.failed++;
        if (isStuck(failed)) report.stuck.push(failed);
      }
    } finally {
      inFlight.delete(snapshot.id);
    }
  }

  return report;
}
