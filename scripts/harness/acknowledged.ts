/**
 * THE ENFORCED-PASS ALLOWLIST — a shrinking, justified debt ratchet.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 *
 * The enforced pass is the pre-flip gate, and it is BLOCKING: the workflow step
 * runs with `continue-on-error: false`, so a failure genuinely fails the run.
 *
 * That is only honest if the gate can actually be satisfied, and today it cannot
 * be. At least one enforced failure is not an application defect and cannot be
 * fixed anywhere in this repository — `TimelinePin` READ needs a DATABASE ROLE
 * change, because the application connects as a `BYPASSRLS` role and therefore
 * no RLS policy ever evaluates (see the entry below). Making the step blocking
 * with no allowlist would paint CI permanently red for a reason no commit here
 * can clear, and a permanently red check is one everybody learns to scroll past.
 * Leaving it advisory would mean it is not a gate at all.
 *
 * So: BLOCKING, with a recorded allowlist. Every failure that is NOT in the list
 * below fails the build. The list is the whole of the exemption, and it is
 * visible, attributed, and counted out loud on every single run.
 *
 * ── THIS IS NOT A SUBSTITUTE FOR FIXING THEM ─────────────────────────────────
 *
 * THE ALLOWLIST MUST REACH ZERO BEFORE `TENANT_ENFORCEMENT` IS SWITCHED ON
 * ANYWHERE. Every entry is a statement that flipping enforcement today would
 * leak or lose data in that exact way. An entry is a deadline, not a dispensation
 * — the run prints the count in the RESULT block precisely so that a non-zero
 * allowlist can never be read as "the isolation gate is green".
 *
 * ── WHY IT CANNOT ROT ────────────────────────────────────────────────────────
 *
 * Modelled on `ACKNOWLEDGED_DRIFT` in scripts/apply-migrations.mjs, which pairs
 * an acknowledgement list with a staleness check for the same reason: an
 * allowlist nobody prunes is how the next real finding gets hidden.
 *
 * The list is squeezed from both sides, so it is physically unable to grow
 * silently:
 *
 *   GROWING   a failure whose key is not in the list is UNACKNOWLEDGED and fails
 *             the build. Adding one means editing this file, in a diff, with a
 *             `why` and a `fix` — never by a check quietly going red.
 *
 *   ROTTING   an entry that does not correspond to a currently-FAILING check is
 *             STALE and also fails the build. One rule, no exceptions: if the
 *             check now passes, the entry is a lie and must be deleted; if the
 *             check has vanished, the entry names nothing; if the check has
 *             become a `skip`, the entry is guarding something nobody is
 *             measuring any more, which is the most dangerous of the three
 *             because it looks like coverage.
 *
 * That second rule is what stops the easy dodge. Without it, the way to make
 * this gate green is to rename or disable the probe rather than fix the defect,
 * and nothing would notice.
 *
 * ── HOW TO ADD AN ENTRY ──────────────────────────────────────────────────────
 *
 * You should be reluctant. An entry needs all five fields, and `why` and `fix`
 * are not decorative — `why` must say what the defect actually is, and `fix`
 * must say WHERE THE REAL FIX LIVES, so that "when can this be deleted?" has a
 * checkable answer instead of being institutional memory.
 *
 * `model`, `check` and `name` must match the CheckResult exactly. They are
 * matched as a triple, not by substring, so an entry cannot accidentally cover
 * a check it was not written for.
 */
import type { CheckResult } from "./engine";

export type AcknowledgedFailure = {
  /** Must match CheckResult.model exactly. */
  model: string;
  /** Must match CheckResult.check exactly. */
  check: CheckResult["check"];
  /** Must match CheckResult.name exactly. */
  name: string;
  /** What the defect actually is. Not a restatement of the check name. */
  why: string;
  /** WHERE THE REAL FIX LIVES. A branch, PR, doc or migration — something checkable. */
  fix: string;
};

/**
 * ⚠ THIS LIST MUST REACH ZERO BEFORE TENANT_ENFORCEMENT IS FLIPPED. ⚠
 *
 * Every entry is a known way in which enforcement would still leak or lose data.
 * Delete entries as the fixes land; never add one to make a run green.
 *
 * ── STATE OF PLAY, 2026-08-11 (main @ 80e7b6c8): 11 entries ──────────────────
 *
 * BE CLEAR ABOUT THE SHAPE OF THIS. Ten of the eleven are REAL APPLICATION
 * DEFECTS. Only one — TimelinePin READ — is the database-role problem that
 * genuinely cannot be fixed here. The other ten are exempted because their fixes
 * are WRITTEN AND IN FLIGHT, not because they are acceptable:
 *
 *   5  SalesPipeline OWN/READ/UPDATE/DELETE/LIST → PR #457   (open, unmerged)
 *   2  SalesPipeline UNIQUE ×2                   → PR #469   (open, unmerged)
 *   2  Quote OWN, JobCard OWN                    → PR #459   (open, unmerged)
 *   1  TimelinePin OWN            → branch fix/tenant-stamp-audit-trail
 *                                   (⚠ NO PR RAISED — that is a gap, not a plan)
 *   1  TimelinePin READ           → database role change; no code fix exists
 *
 * So the list should fall to 1 as those four land, and to 0 at the RLS-role
 * cutover. If it is not falling, the ratchet has stopped ratcheting and that is
 * the thing to escalate — not the number itself.
 */
export const ACKNOWLEDGED_ENFORCED_FAILURES: AcknowledgedFailure[] = [
  /* ── THE ONE THAT IS NOT AN APPLICATION DEFECT ────────────────────────────
   *
   * This is the entry the allowlist exists for. Everything else below is a real
   * defect with a real fix in flight; this one cannot be fixed by any commit in
   * this repository, which is why a bare blocking gate was not an option.
   */
  {
    model: "TimelinePin",
    check: "READ",
    name: "read of B's row by id returns nothing",
    why:
      "NOT AN APPLICATION DEFECT — a DATABASE ROLE problem, and the only failure here that " +
      "enforcement cannot reach. getTimelinePins is prisma.$queryRaw. The Prisma extension " +
      "cannot rewrite raw SQL, so the boundary was supposed to be RLS via SET LOCAL " +
      "app.current_tenant. Production connects as neondb_owner with rolbypassrls = true, so no " +
      "policy ever evaluates and the SET LOCAL is inert. Verified read-only against production " +
      "on 2026-08-11: RLS is enabled AND forced on TimelinePin, and does nothing. Flipping " +
      "TENANT_ENFORCEMENT does not change this — it scopes model operations, not raw SQL.",
    fix:
      "Not a code change. Connect as a role WITHOUT BYPASSRLS, with the policies granted to it. " +
      "Written up in docs/rls-role-is-the-flip-blocker.md on branch docs/tenant-preflip-audit, " +
      "which sets out the cutover and names this check as the canary: it must flip from fail to " +
      "pass with NO application change. Role work is started on branch chore/rls-app-role; see " +
      "also docs/RLS-ROLE-CUTOVER.md. Delete this entry the day that lands.",
  },

  /* ── SalesPipeline was never tenant-isolated at all ───────────────────────
   *
   * Five checks, one root cause, one fix. createPipeline's INSERT column list in
   * src/lib/pipelines.ts is ("id","name","description","type","isDefault") — no
   * tenantId — and the reads alongside it carry no tenant predicate. This is the
   * module the pre-flip audit found had been skipped entirely.
   */
  {
    model: "SalesPipeline",
    check: "OWN",
    name: "create via action stamps the acting tenant",
    why:
      "createPipeline's raw INSERT omits tenantId entirely, so every pipeline is created " +
      "UNOWNED and becomes invisible to its own creator at the flip.",
    fix: "PR #457, branch feat/kanban-pipeline-context — src/lib/pipelines.ts + new src/lib/pipelineTenantRule.ts. Open, unmerged.",
  },
  {
    model: "SalesPipeline",
    check: "READ",
    name: "read of B's row by id returns nothing",
    why: "pipeline reads carry no tenant predicate — tenant A resolves tenant B's pipeline by id.",
    fix: "PR #457, branch feat/kanban-pipeline-context — pipelineScopeFor() / requireOwnedPipeline() in src/lib/pipelines.ts. Open, unmerged.",
  },
  {
    model: "SalesPipeline",
    check: "UPDATE",
    name: "update of B's row changes zero rows",
    why: "editSalesPipeline updates by id with no ownership check — A renamed B's pipeline outright.",
    fix: "PR #457, branch feat/kanban-pipeline-context — getOwnedPipelineRow(id) in src/app/actions/pipelines.ts. Open, unmerged.",
  },
  {
    model: "SalesPipeline",
    check: "DELETE",
    name: "delete of B's row changes zero rows",
    why: "archiveSalesPipeline soft-deletes by id with no ownership check — A destroyed B's pipeline.",
    fix: "PR #457, branch feat/kanban-pipeline-context — getOwnedPipelineRow(id) in src/app/actions/pipelines.ts. Open, unmerged.",
  },
  {
    model: "SalesPipeline",
    check: "LIST",
    name: "list never contains a B row",
    why: "the pipeline list query has no tenant filter — B's pipelines appear in A's list.",
    fix: "PR #457, branch feat/kanban-pipeline-context — pipelineTenantFilter() in src/lib/pipelines.ts. Open, unmerged.",
  },

  /* ── Two GLOBAL unique indexes with no tenant column ──────────────────────
   *
   * Not an isolation leak but a hard multi-tenancy blocker: these make a second
   * workspace structurally impossible to set up. Schema-level, so the fix is a
   * migration rather than a code change.
   */
  {
    model: "SalesPipeline",
    check: "UNIQUE",
    name: "two tenants can each own a DEFAULT pipeline",
    why:
      "SalesPipeline_single_default_key is UNIQUE on (\"isDefault\") WHERE isDefault = true with no " +
      "tenant column, so only ONE default pipeline may exist database-wide — and the migrations " +
      "already seed it. A second workspace can never have a default pipeline.",
    fix: "PR #469, branch fix/tenant-default-and-pipeline-uniques — migration 20260811090000_pipeline_uniques_per_tenant re-creates it on (\"tenantId\",\"isDefault\"). Open, unmerged.",
  },
  {
    model: "SalesPipeline",
    check: "UNIQUE",
    name: "two tenants can each have a pipeline with the same NAME",
    why:
      "SalesPipeline_name_key is UNIQUE on (name) WHERE deletedAt IS NULL with no tenant column — " +
      "if one tenant names a pipeline \"Sales\", no other tenant ever can.",
    fix: "PR #469, branch fix/tenant-default-and-pipeline-uniques — same migration, re-creates it on (\"tenantId\",\"name\"). Open, unmerged.",
  },

  /* ── Writes the app-layer guard cannot intercept by construction ──────────
   *
   * All three run outside the guard's reach — raw SQL in the pin's case, the
   * RLS-bypass client in the other two — so the guard has no `args` to rewrite
   * and each call site has to stamp the tenant explicitly. There is deliberately
   * no shared root-cause fix; two separate branches cover them.
   */
  {
    model: "TimelinePin",
    check: "OWN",
    name: "create via action stamps the acting tenant",
    why:
      "toggleTimelinePin writes a raw INSERT ... ON CONFLICT, which the db.ts guard structurally " +
      "cannot see (it rewrites Prisma args; raw SQL has none). tenantId is omitted, so every pin " +
      "is created UNOWNED.",
    fix:
      "Branch fix/tenant-stamp-audit-trail — src/lib/timelinePins.ts (adds tenantId to the INSERT " +
      "and the DO UPDATE SET) plus new src/lib/customerRecordTenant.ts. ⚠ NO PR HAS BEEN RAISED " +
      "for this branch, which is why it is missing from the PR-based merge planning. Raise one.",
  },
  {
    model: "Quote",
    check: "OWN",
    name: "create via action stamps the acting tenant",
    why:
      "saveQuoteDraft's new-quote path runs on basePrisma, the RLS-bypass client, so nothing " +
      "scopes the transaction and the header plus nested items/fees inherit no tenant.",
    fix: "PR #459, branch fix/p0-bypass-write-stamping — src/app/actions/quotes.ts stamps tenantId on the header and nested creates. Open, unmerged.",
  },
  {
    model: "JobCard",
    check: "OWN",
    name: "create via action stamps the acting tenant",
    why: "createJobCard runs on basePrisma for the same reason, leaving the job card and its check-in odometer row unowned.",
    fix: "PR #459, branch fix/p0-bypass-write-stamping — src/app/actions/jobcards.ts. Same PR also fixes a cross-tenant stock claim in claimPartStock. Open, unmerged.",
  },
];

/** The identity of a check. Same shape the run report uses to line the passes up. */
export function acknowledgementKey(entry: {
  model: string;
  check: string;
  name: string;
}): string {
  return `${entry.model}::${entry.check}::${entry.name}`;
}

/**
 * Enforced failures nobody has recorded a reason for.
 *
 * These fail the build. This is the direction that matters: a NEW way to break
 * tenant isolation cannot arrive quietly, because the only way to stop it
 * failing the run is to write down what it is and where it gets fixed.
 */
export function unacknowledgedFailures(
  enforced: readonly CheckResult[],
  acknowledged: readonly AcknowledgedFailure[] = ACKNOWLEDGED_ENFORCED_FAILURES,
): CheckResult[] {
  const known = new Set(acknowledged.map(acknowledgementKey));
  return enforced.filter((r) => r.verdict === "fail" && !known.has(acknowledgementKey(r)));
}

export type StaleAcknowledgement = {
  entry: AcknowledgedFailure;
  reason: string;
};

/**
 * Acknowledgements that no longer describe a currently-failing check.
 *
 * THE RULE IS SINGULAR: an entry is valid only while the check it names is
 * actually FAILING. Anything else is stale and fails the build.
 *
 *   passing   the defect is fixed — the entry now claims something untrue, and
 *             leaving it there re-exempts the check the moment it regresses.
 *   absent    renamed or deleted. The entry guards nothing, and the check it was
 *             written for may well be failing again under a different name.
 *   skipped   the probe stopped measuring. This is the one worth being strict
 *             about: it is how an exemption outlives the thing it exempted, and
 *             it reads exactly like coverage from the outside.
 */
export function staleAcknowledgements(
  enforced: readonly CheckResult[],
  acknowledged: readonly AcknowledgedFailure[] = ACKNOWLEDGED_ENFORCED_FAILURES,
): StaleAcknowledgement[] {
  const byKey = new Map(enforced.map((r) => [acknowledgementKey(r), r]));
  const stale: StaleAcknowledgement[] = [];
  for (const entry of acknowledged) {
    const result = byKey.get(acknowledgementKey(entry));
    if (!result) {
      stale.push({
        entry,
        reason:
          "no such check ran — it was renamed or removed. Delete this entry, and check that " +
          "what it described is not now failing under a different name.",
      });
    } else if (result.verdict === "pass") {
      stale.push({
        entry,
        reason: "THIS NOW PASSES — the fix landed. Delete this entry so it can never be re-exempted.",
      });
    } else if (result.verdict === "skip") {
      stale.push({
        entry,
        reason:
          `the check is being SKIPPED, not failing (${result.detail || "no detail"}). Nothing is ` +
          "measuring this any more, so the exemption is guarding a hole. Restore the probe, or " +
          "delete the entry if the check is genuinely gone.",
      });
    }
  }
  return stale;
}

/** Entries that are doing their job right now: recorded, and still failing. */
export function activeAcknowledgements(
  enforced: readonly CheckResult[],
  acknowledged: readonly AcknowledgedFailure[] = ACKNOWLEDGED_ENFORCED_FAILURES,
): AcknowledgedFailure[] {
  const failing = new Set(
    enforced.filter((r) => r.verdict === "fail").map(acknowledgementKey),
  );
  return acknowledged.filter((entry) => failing.has(acknowledgementKey(entry)));
}
