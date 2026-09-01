export const OFFLINE_DB_VERSION = 1;
export const OFFLINE_MAX_AGE_MS = 72 * 60 * 60 * 1000;

/**
 * WHAT MAY BE CAPTURED OFFLINE.
 *
 * Deliberately only appends and simple field writes on records the device
 * already holds. Offline lead and contact creation/editing, and offline
 * delivery SIGNING, are not here: those replay into actions enforcing
 * permissions, open-stage validity, stage gates, pipeline rules, module
 * entitlement and scheduling state, and every one of those is a rule the device
 * would have to mirror and keep in step. They are a separate piece of work.
 */
export type OfflineOperationType =
  | "jobcard.notes"
  | "jobcard.inspection"
  | "jobcard.photo"
  | "inspection.photo"
  | "delivery.photo";

export type OfflineDescriptor = {
  type: OfflineOperationType;
  recordId?: string;
  parentId?: string;
  baseVersion?: string;
};

/**
 * The record whose `updatedAt` guards this operation, or null when nothing is
 * guarded (a create, or a photo append that cannot collide).
 *
 * ONE DEFINITION, BOTH SIDES. The sync route uses it to decide what version to
 * compare and to report back; the outbox uses it to know which queued siblings
 * an accepted replay has just moved on. If those two ever disagreed about which
 * record an operation guards, chained edits would start being rejected as
 * conflicts again, which is precisely the failure this is here to prevent.
 *
 * AN INSPECTION IS GUARDED BY THE ITEM, NOT BY ITS JOB CARD. Guarding the
 * parent looked reasonable — the job card is what the device downloaded — but
 * `setInspectionItem` and `uploadInspectionPhoto` write only the ITEM row, so
 * the parent's `updatedAt` never moves when an inspection result changes. A
 * technician who re-checked an item after a device took its snapshot left the
 * guard still matching, and the offline replay overwrote their result with no
 * conflict reported. The item carries its own `updatedAt` now.
 *
 * `inspection.photo` is guarded for the same reason: it REPLACES the item's
 * single photo, so two devices doing it is a genuine collision. The other photo
 * operations only ever append and cannot collide.
 */
export function guardedRecordKey(operation: OfflineDescriptor): string | null {
  switch (operation.type) {
    case "jobcard.notes":
    case "jobcard.inspection":
    case "inspection.photo":
      return operation.recordId ?? null;
    default:
      return null;
  }
}

/**
 * What the signed-in user may actually DO offline.
 *
 * The snapshot is scoped by what a user can SEE (getAccessible*Ids), which is a
 * different question from what they may WRITE. Rendering a create form to
 * somebody with `leads.view_owned` and no `leads.create` produced the worst
 * possible outcome: the form accepted the work, said "Saved on this device",
 * cleared itself, and the replay was refused by `requirePermission` hours later
 * with the typed details gone. The permission check was never missing — it was
 * simply the last thing to run instead of the first.
 */
export type OfflineCapabilities = {
  jobCardManage: boolean;
  deliveryManage: boolean;
};

/**
 * What a snapshot from before capabilities existed is worth: nothing writable.
 *
 * A device that cached a snapshot under the old shape still has it in IndexedDB,
 * and `can` will be undefined there. Fail CLOSED and let "Refresh offline data"
 * fetch a snapshot that says what this user may do, rather than guessing
 * permissive defaults on the strength of an old cache.
 */
export const NO_OFFLINE_CAPABILITIES: OfflineCapabilities = {
  jobCardManage: false,
  deliveryManage: false,
};

export type OfflineField =
  | { name: string; kind: "text"; value: string }
  | { name: string; kind: "file"; value: Blob; fileName: string; contentType: string };

export type OfflineMutation = {
  id: string;
  tenantId: string;
  userId: string;
  operation: OfflineDescriptor;
  fields: OfflineField[];
  createdAt: number;
  attempts: number;
  status: "pending" | "syncing" | "failed" | "conflict";
  error?: string;
  /**
   * The server failed AFTER starting to apply this change.
   *
   * It may have committed and then fallen over recording that it had. Such an
   * entry must never be sent again -- a fresh mutation id would bypass the
   * closed receipt and could file a second lead or a second photo. The queue
   * keeps it so the person can read what they captured and check the record.
   */
  indeterminate?: boolean;
};

/**
 * The queued changes an accepted replay has just moved the ground under.
 *
 * Everything captured in one offline session carries the SAME downloaded
 * version, so replaying the first change makes every later change on that
 * record look stale. Those are not conflicts — they are this device's own
 * edits, in order — and rejecting them is both wrong and permanent, since a
 * conflict is never retried.
 *
 * Four conditions, and each one is load-bearing:
 *   - the SAME guarded record, so an unrelated queue entry is untouched;
 *   - queued at or AFTER the accepted change, so an earlier entry that is only
 *     being retried is not silently rebased onto a version it never saw;
 *   - still replayable, so a conflicted or failed entry stays where the person
 *     left it to review;
 *   - not already on that version, so a re-sync is a no-op rather than a write.
 */
export function chainableSiblings(
  after: Pick<OfflineMutation, "id" | "createdAt">,
  queued: readonly OfflineMutation[],
  key: string,
  version: string,
): OfflineMutation[] {
  return queued.filter(
    (sibling) =>
      sibling.id !== after.id &&
      sibling.createdAt >= after.createdAt &&
      (sibling.status === "pending" || sibling.status === "syncing") &&
      guardedRecordKey(sibling.operation) === key &&
      sibling.operation.baseVersion !== version,
  );
}

/**
 * What a person actually typed, ready to be shown back to them.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Every refusal an offline replay can produce — no permission, a closed stage, a
 * gated move, a module switched off, a record deleted, a conflict — used to end
 * the same way: the form had already cleared, and the Pending list showed the
 * operation TYPE and nothing else. So the damage was never the refusal. It was
 * that the work existed nowhere afterwards.
 *
 * The queue has held the fields the whole time. Showing them turns every one of
 * those refusals from lost work into a sentence and a form to re-enter — which
 * matters most for the refusals nobody has thought of yet.
 *
 * Hidden plumbing is dropped: a person reading "what did I type" is not helped
 * by `source=offline` or a contactId. Files are named rather than rendered —
 * a queued photo is evidence that it is still on the device, not something to
 * preview here.
 */
const RECOVERY_NOISE = new Set([
  "source",
  "contactId",
  "assignedToId",
  "ownerId",
  "quantity",
  "color",
  "contactKind",
  "tags",
  "marketingOptOut",
]);

export type RecoveredField = { name: string; value: string; kind: "text" | "file" };

export function recoverableFields(entry: OfflineMutation): RecoveredField[] {
  return entry.fields
    .filter((field) => !RECOVERY_NOISE.has(field.name))
    .map((field) =>
      field.kind === "text"
        ? { name: field.name, value: field.value.trim(), kind: "text" as const }
        : { name: field.name, value: field.fileName, kind: "file" as const },
    )
    .filter((field) => field.value.length > 0);
}

/** The same thing as one block of text, for pasting into the online form. */
export function recoveryText(entry: OfflineMutation): string {
  const lines = recoverableFields(entry).map((field) => `${field.name}: ${field.value}`);
  return [`${entry.operation.type} — captured ${new Date(entry.createdAt).toLocaleString("en-ZA")}`, ...lines].join("\n");
}

/**
 * Whether a refused change can honestly be queued again, and against what.
 *
 * A guarded operation needs a CURRENT version, or re-queueing it would either
 * hit the same conflict again or — worse, if the version were simply dropped —
 * overwrite whatever replaced it without anyone deciding to. When the record is
 * no longer in the snapshot at all there is nothing to rebase onto, so the
 * honest answer is that the work can be copied but not replayed.
 */
export function requeueBase(
  entry: OfflineMutation,
  snapshot: Pick<OfflineSnapshot, "jobCards" | "deliveries"> | null,
): { retryable: true; baseVersion?: string } | { retryable: false } {
  /*
   * AN AMBIGUOUS FAILURE IS NEVER RESENT.
   *
   * At-most-once rests on the server's receipt, and re-queueing deliberately
   * mints a NEW id -- which is exactly what walks past a closed one. That is
   * correct for a change the server refused before applying, and wrong for one
   * it may have applied and then failed to record: a create would land twice,
   * and a photo append would file twice.
   *
   * The route reports which of the two happened. Anything ambiguous can be read
   * and copied, never replayed.
   */
  if (entry.indeterminate) return { retryable: false };
  const key = guardedRecordKey(entry.operation);
  if (!key) return { retryable: true };
  if (!snapshot) return { retryable: false };

  const versions = new Map<string, string>();
  for (const quote of snapshot.deliveries) versions.set(quote.id, quote.updatedAt);
  for (const job of snapshot.jobCards) {
    versions.set(job.id, job.updatedAt);
    for (const item of job.inspectionItems) versions.set(item.id, item.updatedAt);
  }

  const baseVersion = versions.get(key);
  return baseVersion ? { retryable: true, baseVersion } : { retryable: false };
}

export type OfflineSnapshot = {
  tenantId: string;
  userId: string;
  capturedAt: number;
  jobCards: Array<{
    id: string; number: number; status: string; description: string; customer: string; vehicle: string;
    checkinNotes: string | null; checkoutNotes: string | null; updatedAt: string;
    inspectionItems: Array<{ id: string; label: string; status: string; notes: string | null; hasPhoto: boolean; updatedAt: string }>;
  }>;
  deliveries: Array<{ id: string; number: number; customer: string; scheduledFor: string | null; updatedAt: string }>;
  /* What this user may write. Read it through NO_OFFLINE_CAPABILITIES: a
     snapshot cached before this field existed has no `can` at all. */
  can: OfflineCapabilities;
};
