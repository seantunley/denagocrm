/**
 * Pairing a timeline entry with the detail behind it.
 *
 * The timeline is built from `AuditLog`, which holds an action, a summary and
 * who did it — enough for "Updated details for Gavin Tagg" and nothing more.
 * What actually changed lives in `AuditEvent`: `changedFieldsJson`, `beforeJson`
 * and `afterJson`.
 *
 * The two tables carry no key between them. They are written together in one
 * transaction, but `AuditLog.createdAt` is set by Prisma and
 * `AuditEvent.createdAt` by PostgreSQL, so the timestamps are close rather than
 * equal — measured against production, never identical. Matching is therefore on
 * action + subject + proximity in time, and deliberately conservative: an entry
 * with no confident match simply shows no detail, which is what it did before.
 *
 * Not every entry has one. Of 470 audit rows in production, 171 have a matching
 * event — `AuditEvent` is newer than the timeline, and `logAudit`'s fallback
 * path writes only the legacy row. A timeline that hid the rest would be a
 * regression, so the detail is additive.
 */

/** How far apart the two writes may be and still be the same event. */
const MATCH_WINDOW_MS = 3_000;

export type AuditDetailSource = {
  eventType: string;
  entityId: string | null;
  createdAt: Date;
  changedFieldsJson: unknown;
  beforeJson: unknown;
  afterJson: unknown;
};

export type AuditTimelineRow = {
  id: string;
  action: string;
  contactId: string | null;
  leadId: string | null;
  createdAt: Date;
};

export type FieldChange = { field: string; before: unknown; after: unknown };

export type AuditDetail = {
  changed: FieldChange[];
  /** True when an event was found but recorded no field-level diff. */
  empty: boolean;
};

/** Values a person should never be shown, whatever the audit captured. */
const HIDDEN = /^(id|tenantId|createdAt|updatedAt|deletedAt|passwordHash|totpSecret|totpPendingSecret|totpBackupCodes)$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asFieldList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Build the field-level changes for one event.
 *
 * `changedFieldsJson` names the fields; before/after supply the values. When the
 * field list is empty but both snapshots exist, the fields are derived from the
 * snapshots — older entries were written before the list was populated, and
 * throwing away detail we hold would be perverse.
 */
export function fieldChanges(source: AuditDetailSource): FieldChange[] {
  const before = asRecord(source.beforeJson);
  const after = asRecord(source.afterJson);
  const named = asFieldList(source.changedFieldsJson);

  const fields = named.length
    ? named
    : [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].filter(
        (field) => JSON.stringify(before?.[field]) !== JSON.stringify(after?.[field]),
      );

  return fields
    .filter((field) => !HIDDEN.test(field))
    .map((field) => ({ field, before: before?.[field] ?? null, after: after?.[field] ?? null }))
    // A "change" where nothing moved is noise; it happens when a form re-submits
    // an unchanged value and the field list was recorded optimistically.
    .filter((change) => JSON.stringify(change.before) !== JSON.stringify(change.after));
}

/**
 * Attach detail to timeline rows, keyed by the timeline row's own id.
 *
 * Each event is consumed at most once — two identical actions on the same
 * subject seconds apart (a double submit) must not both borrow the same detail
 * and claim the change twice.
 */
export function matchAuditDetail(
  rows: AuditTimelineRow[],
  events: AuditDetailSource[],
): Record<string, AuditDetail> {
  const unused = [...events];
  const detail: Record<string, AuditDetail> = {};

  // Oldest first, so when two rows compete for one event the earlier takes it.
  const ordered = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  for (const row of ordered) {
    const subject = row.leadId ?? row.contactId;
    if (!subject) continue;

    let bestIndex = -1;
    let bestGap = Number.POSITIVE_INFINITY;
    for (let index = 0; index < unused.length; index += 1) {
      const event = unused[index];
      if (event.eventType !== row.action || event.entityId !== subject) continue;
      const gap = Math.abs(event.createdAt.getTime() - row.createdAt.getTime());
      if (gap <= MATCH_WINDOW_MS && gap < bestGap) {
        bestGap = gap;
        bestIndex = index;
      }
    }
    if (bestIndex === -1) continue;

    const [event] = unused.splice(bestIndex, 1);
    const changed = fieldChanges(event);
    detail[row.id] = { changed, empty: changed.length === 0 };
  }

  return detail;
}
