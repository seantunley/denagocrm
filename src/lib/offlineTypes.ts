export const OFFLINE_DB_VERSION = 1;
export const OFFLINE_MAX_AGE_MS = 72 * 60 * 60 * 1000;

export type OfflineOperationType =
  | "lead.create"
  | "lead.update"
  | "contact.create"
  | "contact.update"
  | "jobcard.notes"
  | "jobcard.inspection"
  | "jobcard.photo"
  | "inspection.photo"
  | "delivery.complete"
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
 * An inspection update is guarded by its JOB CARD, not by the item — the item
 * has no version of its own in the snapshot, and the job card is what the
 * device downloaded.
 */
export function guardedRecordKey(operation: OfflineDescriptor): string | null {
  switch (operation.type) {
    case "lead.update":
    case "contact.update":
    case "delivery.complete":
    case "jobcard.notes":
      return operation.recordId ?? null;
    case "jobcard.inspection":
      return operation.parentId ?? null;
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
  leadCreate: boolean;
  leadEdit: boolean;
  contactCreate: boolean;
  contactEdit: boolean;
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
  leadCreate: false,
  leadEdit: false,
  contactCreate: false,
  contactEdit: false,
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

export type OfflineSnapshot = {
  tenantId: string;
  userId: string;
  capturedAt: number;
  leads: Array<{
    id: string; title: string; name: string; email: string | null; phone: string | null;
    status: string; stage: string; stageId: string; source: string; color: string | null;
    notes: string | null; quantity: number; valueCents: number; productId: string | null;
    contactId: string | null; assignedToId: string | null; updatedAt: string;
  }>;
  contacts: Array<{
    id: string; name: string; firstName: string; lastName: string | null; company: string | null;
    email: string | null; phone: string | null; whatsapp: string | null; address: string | null;
    suburb: string | null; city: string | null; province: string | null; postalCode: string | null;
    source: string | null; notes: string | null; marketingOptOut: boolean; ownerId: string | null;
    fleetId: string | null; isCompany: boolean; vatNumber: string | null; tags: string[]; updatedAt: string;
  }>;
  jobCards: Array<{
    id: string; number: number; status: string; description: string; customer: string; vehicle: string;
    checkinNotes: string | null; checkoutNotes: string | null; updatedAt: string;
    inspectionItems: Array<{ id: string; label: string; status: string; notes: string | null; hasPhoto: boolean }>;
  }>;
  deliveries: Array<{ id: string; number: number; customer: string; scheduledFor: string | null; updatedAt: string }>;
  /* What this user may write. Read it through NO_OFFLINE_CAPABILITIES: a
     snapshot cached before this field existed has no `can` at all. */
  can: OfflineCapabilities;
  options: {
    stages: Array<{ id: string; name: string }>;
    products: Array<{ id: string; name: string }>;
  };
};
