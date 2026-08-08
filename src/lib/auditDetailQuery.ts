import "server-only";
import { basePrisma } from "./db";
import {
  matchAuditDetail,
  type AuditDetail,
  type AuditDetailSource,
  type AuditTimelineRow,
} from "./auditDetail";

/**
 * Fetch the AuditEvent rows behind a set of timeline entries and pair them up.
 *
 * Reads through basePrisma because AuditEvent carries no tenant column of its
 * own — it is scoped by the entity it names, and those ids come from a page that
 * has already established access to the record. Widening the query beyond those
 * ids is therefore not possible: the `entityId` filter IS the scope.
 *
 * Bounded to the window the supplied rows already cover, so a contact with years
 * of history does not pull its whole event stream to annotate one page.
 */
export async function auditDetailFor(rows: AuditTimelineRow[]): Promise<Record<string, AuditDetail>> {
  const subjects = [...new Set(rows.map((row) => row.leadId ?? row.contactId).filter((id): id is string => Boolean(id)))];
  if (subjects.length === 0) return {};

  const times = rows.map((row) => row.createdAt.getTime());
  // A few seconds of slack at each end, matching the pairing window — the two
  // tables are written in one transaction but timestamped by different clocks.
  const from = new Date(Math.min(...times) - 5_000);
  const to = new Date(Math.max(...times) + 5_000);

  const events = await basePrisma.auditEvent.findMany({
    where: {
      entityId: { in: subjects },
      eventType: { in: [...new Set(rows.map((row) => row.action))] },
      createdAt: { gte: from, lte: to },
    },
    select: {
      eventType: true,
      entityId: true,
      createdAt: true,
      changedFieldsJson: true,
      beforeJson: true,
      afterJson: true,
    },
  });

  return matchAuditDetail(rows, events as AuditDetailSource[]);
}
