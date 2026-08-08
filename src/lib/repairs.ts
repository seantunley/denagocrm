import "server-only";
import { prisma } from "./db";
import { DEFAULT_TENANT_ID } from "./tenant";
import { writeTenantId } from "./tenantWrite";

/**
 * The issue registry — the reconciliation half of Repairs.
 *
 * The failures worth a page of their own are the ones nothing else reports. A
 * journey whose email template was deleted returns
 * `{ status: "skipped", note: "Email skipped: template was deleted" }` and keeps
 * going, so the run completes, nothing is logged, and the first person to notice
 * is the customer who never got the mail.
 *
 * A DETECTOR reports the problems it can see right now. This module turns that
 * report into rows, and the important word is *reconciliation*: a detector says
 * what is true, not what changed. Raising, refreshing and CLEARING all fall out
 * of comparing the report against what is currently open, so no detector has to
 * remember to un-raise anything and no problem can outlive its cause.
 */

export type RepairSeverity = "critical" | "warning";

/** One problem, as a detector currently sees it. */
export type RaisedIssue = {
  /**
   * STABLE IDENTITY, derived only from the detector and the thing that is
   * wrong. See prisma/repairs.prisma — a key must never contain a measurement.
   */
  key: string;
  severity: RepairSeverity;
  title: string;
  /** Refreshed on every re-detection; this is where counts and dates belong. */
  description: string;
  /** In-app path where the problem is fixed. */
  fixRoute?: string;
};

export type DetectorReport = {
  /** Namespace this detector owns; it may only ever clear its own rows. */
  detector: string;
  issues: RaisedIssue[];
  /**
   * Did this run see EVERYTHING the detector covers?
   *
   * THIS IS THE SAFETY VALVE ON AUTOMATIC CLEARING. "Resolve what I did not
   * re-raise" is only sound if the detector actually looked at everything; a
   * detector that bailed early, hit its cap, or ran with a module switched off
   * has an incomplete picture, and clearing from it would mark real, unfixed
   * problems as solved — the one failure this whole surface exists to prevent.
   * An incomplete run may still RAISE; it may never CLEAR.
   */
  complete: boolean;
};

export type RepairSyncResult = {
  /** Newly raised, including a resolved issue that has recurred. */
  raised: number;
  /** Already open and re-confirmed. */
  refreshed: number;
  /** Open, not re-raised by a complete detector, therefore fixed. */
  resolved: number;
};

/**
 * Ceiling on the rows ONE detector may own at once.
 *
 * A detector is a query over a tenant's data, and a workspace can always be
 * pathological — five hundred active journeys all pointing at one deleted
 * template would be five hundred writes per tick, forever, on a page nobody
 * could read anyway. Hitting the cap also forces `complete: false` below, so a
 * truncated picture can never clear anything.
 */
export const MAX_ISSUES_PER_DETECTOR = 50;

/**
 * The tenant this run reads AND writes as.
 *
 * ONE resolution for both halves, deliberately. The detectors that read a global
 * or bypass-client model have to supply a tenant predicate by hand, and if that
 * predicate were derived differently from the one stamped onto the issue row,
 * a workspace could file issues about data it was not looking at — or, worse,
 * look at data and file nothing. Reading and writing as the same tenant by
 * construction removes the possibility.
 *
 * `writeTenantId()` returns null when enforcement is dormant or the scope is a
 * trusted system scope — the founding tenant stands in, so a row is never
 * written tenantless during the pre-enforcement window — and THROWS when
 * enforcement is on with no usable scope, rather than quietly falling back to
 * everyone's data.
 */
export function repairsTenantId(): string {
  return writeTenantId() ?? DEFAULT_TENANT_ID;
}

/**
 * Reconcile a set of detector reports against the open issues.
 *
 * SHAPED AROUND THE EMPTY CASE, because a healthy workspace is nearly every
 * call. This runs once PER TENANT on the automations cron, so whatever happens
 * here happens tenants-times-ticks often, and on a workspace with nothing wrong
 * the answer must cost almost nothing.
 *
 * So ONE indexed query — `tenantId = $1 AND resolvedAt IS NULL`, served by
 * RepairIssue_tenantId_resolvedAt_lastSeenAt_idx — answers "is anything open?"
 * for EVERY detector at once. With nothing open and nothing raised, that query
 * is the whole of it: no writes, no per-detector round trip. Fetching all open
 * rows rather than one query per detector is the cheaper shape precisely because
 * the table is small by construction (one row per distinct problem, capped per
 * detector), which is not true of the tables the detectors themselves scan.
 */
export async function syncRepairIssues(reports: DetectorReport[]): Promise<RepairSyncResult> {
  const tenantId = repairsTenantId();

  // Apply the per-detector cap HERE rather than trusting each detector to do it.
  // A cap a detector can forget is not a cap. Truncating also revokes `complete`
  // — a report we cut short is by definition not the whole picture.
  const capped = reports.map((report) => {
    const overflowed = report.issues.length > MAX_ISSUES_PER_DETECTOR;
    return {
      detector: report.detector,
      issues: overflowed ? report.issues.slice(0, MAX_ISSUES_PER_DETECTOR) : report.issues,
      complete: report.complete && !overflowed,
    };
  });

  const raisedNow = capped.flatMap((report) =>
    report.issues.map((issue) => ({ ...issue, detector: report.detector })),
  );

  // THE EARLY OUT.
  const open = await prisma.repairIssue.findMany({
    where: { tenantId, resolvedAt: null },
    select: { id: true, key: true, detector: true },
  });
  if (open.length === 0 && raisedNow.length === 0) return { raised: 0, refreshed: 0, resolved: 0 };

  const openByKey = new Map(open.map((row) => [row.key, row]));
  const now = new Date();
  let raised = 0;
  let refreshed = 0;

  for (const issue of raisedNow) {
    const existing = openByKey.get(issue.key);
    const facts = {
      severity: issue.severity,
      title: issue.title,
      description: issue.description,
      fixRoute: issue.fixRoute ?? null,
      lastSeenAt: now,
    };

    if (existing) {
      // ALREADY OPEN — the problem has never gone away. Refresh the wording and
      // the confirmation time and leave `ignoredAt` ALONE: a dismissal means
      // "stop telling me about this while it lasts", and re-showing it fifteen
      // minutes later would make Ignore a button that does nothing.
      await prisma.repairIssue.update({ where: { id: existing.id }, data: facts });
      refreshed += 1;
      continue;
    }

    // NOT OPEN — either brand new, or resolved earlier and now RECURRING. The
    // upsert covers both because the unique key is the same either way, and
    // that is the point of deriving the key from the problem.
    //
    // `ignoredAt` IS cleared on this branch, and only on this branch. A
    // dismissal given while the problem existed says nothing about the problem
    // coming BACK — it answered the thing in front of the person at the time.
    // Honouring it after the issue healed and broke again is how a fixed bug
    // quietly stops being fixed, with the page reporting all clear.
    await prisma.repairIssue.upsert({
      where: { tenantId_key: { tenantId, key: issue.key } },
      create: { tenantId, detector: issue.detector, key: issue.key, firstSeenAt: now, ...facts },
      update: { ...facts, detector: issue.detector, resolvedAt: null, ignoredAt: null, ignoredById: null },
    });
    raised += 1;
  }

  // AUTOMATIC CLEARING. An open issue that a COMPLETE detector did not re-raise
  // is a problem that has been fixed — by the person the page told, or by
  // whatever else changed. Only detectors that ran to completion this tick get
  // to clear, and each may only clear its own namespace: a detector that threw,
  // was skipped for a disabled module, or hit its cap leaves its rows exactly
  // where they are rather than declaring everything solved.
  const stillRaised = new Set(raisedNow.map((issue) => issue.key));
  const clearing = new Set(capped.filter((report) => report.complete).map((report) => report.detector));
  const stale = open.filter((row) => clearing.has(row.detector) && !stillRaised.has(row.key));
  const resolved = stale.length
    ? (
        await prisma.repairIssue.updateMany({
          where: { id: { in: stale.map((row) => row.id) } },
          data: { resolvedAt: now },
        })
      ).count
    : 0;

  return { raised, refreshed, resolved };
}

export type RepairIssueView = {
  id: string;
  detector: string;
  key: string;
  severity: string;
  title: string;
  description: string;
  fixRoute: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  ignoredAt: Date | null;
};

/**
 * What /repairs renders: this tenant's unresolved issues, split into the ones
 * still asking for attention and the ones somebody dismissed.
 *
 * Ignored issues are RETURNED, not filtered out at the database. A dismissal
 * that cannot be undone is a way to lose a real problem permanently by
 * mis-clicking, so the page keeps them in a collapsed section with an Un-ignore
 * button. Both sets come out of the one indexed read.
 *
 * The tenant predicate is EXPLICIT even though `RepairIssue` is a tenant-scoped
 * model the db.ts guard would scope on its own. The guard is dormant until
 * TENANT_ENFORCEMENT=enforce, and this table is written by a cron slice that
 * resolves its tenant through `repairsTenantId()` in both modes — so filtering
 * on the same resolution keeps the read and the write agreeing in the mode the
 * app actually runs in today, instead of only after enforcement flips on.
 */
export async function listRepairIssues(): Promise<{
  open: RepairIssueView[];
  ignored: RepairIssueView[];
}> {
  const rows = await prisma.repairIssue.findMany({
    where: { tenantId: repairsTenantId(), resolvedAt: null },
    orderBy: { lastSeenAt: "desc" },
    select: {
      id: true,
      detector: true,
      key: true,
      severity: true,
      title: true,
      description: true,
      fixRoute: true,
      firstSeenAt: true,
      lastSeenAt: true,
      ignoredAt: true,
    },
  });
  // Critical first inside each group — a silently-unsent email outranks a
  // journey that is merely misconfigured, and `lastSeenAt` alone would bury it
  // under whatever a detector happened to touch most recently.
  const bySeverity = (a: RepairIssueView, b: RepairIssueView) =>
    Number(b.severity === "critical") - Number(a.severity === "critical");
  return {
    open: rows.filter((row) => row.ignoredAt === null).sort(bySeverity),
    ignored: rows.filter((row) => row.ignoredAt !== null).sort(bySeverity),
  };
}

/**
 * Dismiss / restore one issue.
 *
 * `updateMany` with an explicit `tenantId`, not `update({ where: { id } })`. The
 * id arrives from a form, the db.ts tenant guard is dormant in every environment
 * today, and an id is the whole of the authorization otherwise — so the tenant
 * predicate is written by hand here for the same reason the document scope
 * writes one. A mismatched id simply updates nothing.
 */
export async function setRepairIssueIgnored(
  id: string,
  ignored: boolean,
  userId: string | null,
): Promise<number> {
  const { count } = await prisma.repairIssue.updateMany({
    where: { id, tenantId: repairsTenantId(), resolvedAt: null },
    data: ignored
      ? { ignoredAt: new Date(), ignoredById: userId }
      : { ignoredAt: null, ignoredById: null },
  });
  return count;
}
