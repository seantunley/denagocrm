import "server-only";
import { basePrisma, prisma } from "./db";
import { logError } from "./errorLog";
import { getEnabledModuleIds } from "./modules/enabled";
import { decryptValue } from "./settings";
import {
  repairsTenantId,
  syncRepairIssues,
  type DetectorReport,
  type RaisedIssue,
  type RepairSyncResult,
} from "./repairs";

/**
 * The detectors.
 *
 * Each one answers "what is silently wrong in this workspace right now?" and
 * reports the WHOLE current answer — never a delta. `syncRepairIssues` does the
 * rest: raising, refreshing and clearing all fall out of comparing the report
 * with what is open.
 *
 * Every detector here was chosen because the data it needs genuinely exists and
 * the failure it finds is genuinely invisible today. Several obvious candidates
 * did not survive that test and are deliberately absent — see the note at the
 * bottom of this file.
 *
 * TENANT SCOPING IS EXPLICIT IN EVERY QUERY, never inherited from the guard.
 *
 * These run on the automations cron, once per tenant per tick, and they FILE
 * ROWS: whatever a detector reads is written back as a repair issue stamped with
 * `repairsTenantId()`. The db.ts tenant extension deliberately does not scope
 * anything while enforcement is off, so a detector relying on it alone would,
 * during a dormant or monitor rollout, read every tenant's journeys and file
 * another workspace's failures against the founding tenant — a cross-tenant
 * read AND a wrong write, from housekeeping nobody is watching.
 *
 * So each query names `repairsTenantId()` itself — the SAME value the issues are
 * stamped with, so what a detector reads and what it writes can never disagree.
 * Under enforcement the guard overwrites the predicate with the identical
 * authoritative value (`scopeWhere` spreads its own tenantId last), so this is
 * belt-and-braces there and load-bearing everywhere else.
 *
 * Strict equality, deliberately: a NULL-tenant row is un-owned, and matching it
 * would re-open the same hole the moment enforcement were ever switched back
 * off. Legacy NULL rows are therefore skipped rather than guessed at — a
 * detector that under-reports is recoverable; one that files across tenants is
 * not.
 */

/** How far back the run-failure detector looks. Two cron ticks' worth is noise; a day is a pattern. */
export const RUN_FAILURE_WINDOW_HOURS = 24;
/**
 * Failures in that window before a journey is called broken.
 *
 * Not 1. A journey step can fail for reasons that are nobody's problem — one
 * bounced address, one provider blip — and an inbox that fires on every single
 * failure is an inbox people stop reading, which costs more than the signal it
 * carries.
 */
export const RUN_FAILURE_THRESHOLD = 3;
/** Rows per page of the active-journey walk. */
export const JOURNEY_PAGE_SIZE = 200;
/**
 * Ceiling on PAGES walked per tick, so the sweep stays bounded inside a cron
 * tick. Hitting it revokes `complete`, so a truncated pass can raise but never
 * clear. At the page size above this is 2,000 active journeys in one tenant —
 * far past any real workspace, where the previous flat cap of 200 was not.
 */
export const MAX_JOURNEY_PAGES = 10;
/** Total journeys any one tick will examine. */
export const MAX_JOURNEYS_SCANNED = JOURNEY_PAGE_SIZE * MAX_JOURNEY_PAGES;

export const JOURNEY_TEMPLATE_DETECTOR = "journey.email_template_missing";
export const JOURNEY_UNPUBLISHED_DETECTOR = "journey.active_without_published_version";
export const JOURNEY_RUNS_FAILING_DETECTOR = "journey.runs_failing";
export const CREDENTIAL_UNREADABLE_DETECTOR = "integration.credential_unreadable";

/**
 * Every `emailTemplateId` a journey definition would hand to the executor.
 *
 * Walks the raw JSON rather than `parseJourneyDefinition`, on purpose. A step
 * list is flat at the top level and nests inside `choose` and `repeat`, and the
 * parser is lazy about those branches — a template referenced from the third
 * arm of a choose is exactly as capable of being deleted as one at the top, and
 * exactly as silent when it is. Walking the value finds both.
 *
 * The match is deliberately narrow — an object whose `type` is `send_email`
 * with a non-empty string `config.emailTemplateId` — because that is precisely
 * what `stringConfig(step, "emailTemplateId")` reads in journeyStepExecutor.ts.
 * `.trim()` for the same reason: the executor looks the TRIMMED id up, so a
 * padded id must be checked trimmed or the detector and the engine would
 * disagree about which row they are talking about.
 */
export function referencedEmailTemplateIds(node: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) referencedEmailTemplateIds(item, into);
    return into;
  }
  if (!node || typeof node !== "object") return into;
  const record = node as Record<string, unknown>;
  if (record.type === "send_email" && record.config && typeof record.config === "object") {
    const id = (record.config as Record<string, unknown>).emailTemplateId;
    if (typeof id === "string" && id.trim()) into.add(id.trim());
  }
  for (const value of Object.values(record)) referencedEmailTemplateIds(value, into);
  return into;
}

/**
 * The two journey-configuration detectors, from ONE pass.
 *
 * They share a query because they share a question — "which journeys are live?"
 * — and asking it twice per tenant per tick to answer two halves of the same
 * problem is the kind of cost that makes housekeeping more expensive than what
 * it cleans up.
 *
 * THE EMPTY CASE IS ONE QUERY. A workspace with no active journeys — which is
 * most of them, most of the time — does one indexed read and returns two empty
 * reports. A workspace WITH active journeys but no `send_email` steps stops at
 * two. Only a definition that actually names a template costs a third.
 */
async function detectJourneyConfiguration(): Promise<DetectorReport[]> {
  const tenantId = repairsTenantId();

  // DETERMINISTIC PAGINATION, not a single truncated page.
  //
  // A bare `take: N` had two failure modes. With EXACTLY N active journeys the
  // first page came back full, `complete` was revoked on every tick forever, and
  // rows that should have cleared never could. With MORE than N — and no
  // `orderBy` — the page was whatever the planner returned, so journeys outside
  // it were never examined at all, on any tick.
  //
  // Ordering by `id` makes the walk total and repeatable, and `complete` is now
  // earned: it is only set when a SHORT page proves the end was reached. Hitting
  // the page ceiling still revokes it, so a truncated pass can raise but never
  // clear — the original guarantee, now with a bound that a normal workspace
  // cannot trip.
  const journeys: Array<{ id: string; name: string; activeVersion: number | null }> = [];
  let cursor: string | undefined;
  let complete = false;
  for (let page = 0; page < MAX_JOURNEY_PAGES; page++) {
    const batch = await prisma.journey.findMany({
      where: { tenantId, status: "active" },
      select: { id: true, name: true, activeVersion: true },
      orderBy: { id: "asc" },
      take: JOURNEY_PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    journeys.push(...batch);
    if (batch.length < JOURNEY_PAGE_SIZE) {
      complete = true;
      break;
    }
    cursor = batch[batch.length - 1]!.id;
  }

  // An ACTIVE journey with no active version enrols nobody, silently and
  // forever. The journeys page does print "Active version: none" — in the
  // middle of a metadata line, next to the trigger and the run count, styled
  // exactly like the facts either side of it. This says it is a problem.
  const unpublished: DetectorReport = {
    detector: JOURNEY_UNPUBLISHED_DETECTOR,
    complete,
    issues: journeys
      .filter((journey) => journey.activeVersion === null)
      .map((journey) => ({
        key: `${JOURNEY_UNPUBLISHED_DETECTOR}:${journey.id}`,
        severity: "warning" as const,
        title: `“${journey.name}” is active but has no published version`,
        description:
          "The journey is switched on, so it looks live, but nothing is published for it to run — " +
          "every trigger it would have matched is being dropped. Publish a version, or set the journey back to draft.",
        fixRoute: "/journeys",
      })),
  };

  const published = journeys.filter((journey) => journey.activeVersion !== null);
  if (published.length === 0) {
    return [unpublished, { detector: JOURNEY_TEMPLATE_DETECTOR, complete, issues: [] }];
  }

  const versions = await prisma.journeyVersion.findMany({
    where: { tenantId, journeyId: { in: published.map((journey) => journey.id) }, state: "published" },
    select: { journeyId: true, version: true, definition: true },
  });

  // Only the version a NEW enrolment would run. A run already in flight is
  // pinned to whatever version it started on, and chasing every historical
  // published version would turn a bounded check into an unbounded one to
  // report problems nobody can fix — the fix for a pinned run is to let it end.
  const activeVersionOf = new Map(published.map((journey) => [journey.id, journey.activeVersion]));
  const live = versions.filter((version) => activeVersionOf.get(version.journeyId) === version.version);

  const referenced = new Map<string, Set<string>>();
  const allIds = new Set<string>();
  for (const version of live) {
    const ids = referencedEmailTemplateIds(version.definition);
    if (ids.size === 0) continue;
    referenced.set(version.journeyId, ids);
    for (const id of ids) allIds.add(id);
  }
  if (allIds.size === 0) {
    return [unpublished, { detector: JOURNEY_TEMPLATE_DETECTOR, complete, issues: [] }];
  }

  // ONE query for every template referenced anywhere, not one per journey. The
  // `in` list is bounded by the journey cap above.
  const existing = await prisma.emailTemplate.findMany({
    where: { tenantId, id: { in: [...allIds] } },
    select: { id: true },
  });
  const alive = new Set(existing.map((template) => template.id));

  const nameOf = new Map(published.map((journey) => [journey.id, journey.name]));
  const missing: DetectorReport = {
    detector: JOURNEY_TEMPLATE_DETECTOR,
    complete,
    issues: [...referenced].flatMap(([journeyId, ids]) =>
      [...ids]
        .filter((id) => !alive.has(id))
        .map((id) => ({
          // Per journey AND per template: two journeys pointing at the same
          // deleted template are two separate things to fix, and one journey
          // with two dead references is two lines, not one that half-clears.
          key: `${JOURNEY_TEMPLATE_DETECTOR}:${journeyId}:${id}`,
          severity: "critical" as const,
          title: `“${nameOf.get(journeyId) ?? journeyId}” sends an email template that no longer exists`,
          description:
            "A send-email step in the published version points at a deleted email template. " +
            "Email templates are deleted outright, not moved to Trash, so the step does not fail — " +
            "it skips, the run completes, and nothing is logged. Nobody in this journey is receiving that email. " +
            "Re-point the step at a template that exists, or remove it.",
          fixRoute: "/journeys",
        })),
    ),
  };

  return [unpublished, missing];
}

/**
 * Journeys whose runs keep dying.
 *
 * The activity page already lists failed runs one by one, with the error. What
 * it cannot show is the shape: three hundred rows of "failed" scrolling past
 * looks the same as three hundred rows of anything else, and there is nothing
 * that says "this ONE journey has failed eleven times today".
 *
 * THE EMPTY CASE IS ONE COUNT, served by JourneyRun_tenantId_status_createdAt_idx
 * (added for the retention sweep — `tenantId = $1 AND status = 'failed' AND
 * createdAt >= $2` is the same shape). Below the threshold nothing else runs.
 */
async function detectFailingJourneyRuns(): Promise<DetectorReport> {
  const tenantId = repairsTenantId();
  const since = new Date(Date.now() - RUN_FAILURE_WINDOW_HOURS * 60 * 60 * 1000);
  const where = { tenantId, status: "failed", createdAt: { gte: since } };

  // THE EARLY OUT. Cheaper than the groupBy and answers "is this worth asking
  // properly?" — a workspace under the threshold in total cannot have any one
  // journey over it.
  const total = await prisma.journeyRun.count({ where });
  if (total < RUN_FAILURE_THRESHOLD) {
    return { detector: JOURNEY_RUNS_FAILING_DETECTOR, complete: true, issues: [] };
  }

  const grouped = await prisma.journeyRun.groupBy({
    by: ["journeyId"],
    where,
    _count: { _all: true },
  });
  const offenders = grouped.filter((row) => row._count._all >= RUN_FAILURE_THRESHOLD);
  if (offenders.length === 0) {
    return { detector: JOURNEY_RUNS_FAILING_DETECTOR, complete: true, issues: [] };
  }

  const journeys = await prisma.journey.findMany({
    where: { tenantId, id: { in: offenders.map((row) => row.journeyId) } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(journeys.map((journey) => [journey.id, journey.name]));

  return {
    detector: JOURNEY_RUNS_FAILING_DETECTOR,
    complete: true,
    issues: offenders.map((row) => ({
      // The COUNT is not in the key. It moves every tick, and a key that moves
      // is a new issue every tick — one broken journey would become an
      // unbounded pile of rows that Ignore could never keep up with.
      key: `${JOURNEY_RUNS_FAILING_DETECTOR}:${row.journeyId}`,
      severity: "critical" as const,
      title: `“${nameOf.get(row.journeyId) ?? row.journeyId}” is failing repeatedly`,
      description:
        `${row._count._all} runs of this journey have failed in the last ${RUN_FAILURE_WINDOW_HOURS} hours. ` +
        "Open the activity trace to see which step is throwing and what it said.",
      fixRoute: "/journeys/activity",
    })),
  };
}

/**
 * Per-tenant integration credentials that cannot be decrypted.
 *
 * This is the closest HONEST version of "credentials expired or near expiry":
 * `TenantIntegrationCredential` has no expiry column, so expiry cannot be
 * detected at all (see the note at the foot of this file). What CAN be detected
 * is worse and just as quiet.
 *
 * `getTenantCredentialOverride` (settings.ts) wraps `decryptValue` in a bare
 * `catch { return null }`, and `resolveTenantCredential` reads that null as
 * "this tenant has no override". For the founding tenant that silently falls
 * back to the platform's global credential — mail goes out from the wrong
 * account. For any SECOND tenant it returns null and the send simply does not
 * happen. Neither throws, neither is logged, and the row is still sitting in
 * the settings page looking configured.
 *
 * Read on `basePrisma`, which BYPASSES the tenant extension entirely, so the
 * `tenantId` predicate is supplied BY HAND — from `repairsTenantId()`, the same
 * resolution the issue rows are stamped with, so the detector cannot look at
 * one tenant's credentials and file against another's.
 *
 * The decrypted value is never stored, logged, or returned; only the setting's
 * KEY NAME (e.g. "WA_ACCESS_TOKEN") reaches the issue row.
 */
async function detectUnreadableCredentials(): Promise<DetectorReport> {
  const rows = await basePrisma.tenantIntegrationCredential.findMany({
    where: { tenantId: repairsTenantId() },
    select: { key: true, value: true },
    orderBy: { key: "asc" },
  });
  if (rows.length === 0) {
    return { detector: CREDENTIAL_UNREADABLE_DETECTOR, complete: true, issues: [] };
  }

  const issues: RaisedIssue[] = [];
  for (const row of rows) {
    if (!row.value) continue;
    try {
      // Decryption is the whole test and the result is deliberately discarded:
      // this detector wants to know whether the value CAN be read, never what
      // it says. Nothing derived from it reaches the issue row.
      decryptValue(row.value);
    } catch {
      issues.push({
        key: `${CREDENTIAL_UNREADABLE_DETECTOR}:${row.key}`,
        severity: "critical" as const,
        title: `The saved credential for ${row.key} cannot be read`,
        description:
          "This workspace has its own credential saved for this integration, but it no longer decrypts — " +
          "the encryption key has changed, or the stored value is damaged. Nothing errors: the app treats it " +
          "as though no override were set, so this integration is either using the platform's credentials or " +
          "silently sending nothing. Re-enter the credential to replace it.",
        fixRoute: "/settings/integration-overrides",
      });
    }
  }

  return { detector: CREDENTIAL_UNREADABLE_DETECTOR, complete: true, issues };
}

/**
 * Run one detector, keeping its failure to itself.
 *
 * A detector that throws must NOT take the others' reports down with it. Reports
 * are what authorise clearing, so one broken query becoming "no reports at all"
 * would freeze every other detector's rows — the failure would be invisible and
 * the page would go stale while looking healthy.
 */
async function safely(
  name: string,
  run: () => Promise<DetectorReport[] | DetectorReport>,
): Promise<DetectorReport[]> {
  try {
    const reports = await run();
    return Array.isArray(reports) ? reports : [reports];
  } catch (error) {
    // An omitted report clears nothing — see DetectorReport.complete.
    await logError(`repairs-detector:${name}`, error);
    return [];
  }
}

/**
 * Run every detector and reconcile the results. Called once per tenant per
 * automations tick.
 *
 * The journey detectors are skipped when the marketing pack is off, and skipped
 * by reporting EMPTY rather than by reporting nothing: with the pack disabled
 * /journeys is unreachable, so a repair issue whose Fix button leads nowhere is
 * worse than no issue at all. Empty-and-complete clears those rows; if the pack
 * is switched back on and the journeys are still broken, the next tick raises
 * them again from the same keys.
 */
export async function runRepairsDetectors(): Promise<RepairSyncResult> {
  const marketing = await getEnabledModuleIds()
    .then((ids) => ids.has("marketing"))
    .catch(() => true);

  const reports = (
    await Promise.all([
      marketing
        ? safely("journey-configuration", detectJourneyConfiguration)
        : Promise.resolve([
            { detector: JOURNEY_UNPUBLISHED_DETECTOR, complete: true, issues: [] },
            { detector: JOURNEY_TEMPLATE_DETECTOR, complete: true, issues: [] },
          ]),
      marketing
        ? safely("journey-runs-failing", detectFailingJourneyRuns)
        : Promise.resolve([{ detector: JOURNEY_RUNS_FAILING_DETECTOR, complete: true, issues: [] }]),
      safely("credential-unreadable", detectUnreadableCredentials),
    ])
  ).flat();

  return syncRepairIssues(reports);
}

/*
 * NOT BUILT, and why. Each of these was checked against the schema and the code
 * before being dropped, so nobody has to check again.
 *
 * CREDENTIAL EXPIRY — `TenantIntegrationCredential` is (id, tenantId, key,
 *   value, createdAt, updatedAt). There is no expiry, no issued-at, no refresh
 *   token and no provider metadata, and `value` is an opaque AES-GCM envelope.
 *   "Expired or near expiry" cannot be computed from anything stored. It would
 *   need either an expiry column or a live token-introspection call per
 *   credential per tick, and the second is not something to put on a cron.
 *
 * REPEATED ErrorLog FAILURES — already built, in the place it belongs.
 *   /settings?tab=system collapses identical errors into one row per
 *   scope+message with an occurrence count and first/last-seen, tenant-scoped
 *   and owner-only. A repairs issue reading "smtp failed 47 times" whose Fix
 *   button pointed at that very tab would be the same information twice.
 *
 * LEADS WITH NO OWNER — the data exists (`Lead.assignedToId`, `status`,
 *   `createdAt`) and the detector is three lines, but the query it needs is
 *   `tenantId = $1 AND status = 'open' AND assignedToId IS NULL AND deletedAt
 *   IS NULL AND createdAt < $2`, and Lead has only `@@index([tenantId])` to
 *   serve it. Every tenant would walk its whole lead table every fifteen
 *   minutes to usually find nothing. The index it wants —
 *   (tenantId, status, assignedToId, createdAt) — belongs on the model in
 *   prisma/schema.prisma; adding it in SQL alone would leave the deployed
 *   schema permanently disagreeing with the Prisma model and raise a drift
 *   warning on every deploy (scripts/apply-migrations.mjs, classifyDiffScript).
 *   Worth building the moment that index can be added properly.
 *
 * JOURNEYS WHOSE TRIGGER NOBODY EMITS — already visible. `JourneyEvent.decisions`
 *   was added for exactly this and the activity trace renders it per event.
 */
