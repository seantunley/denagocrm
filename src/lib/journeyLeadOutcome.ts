import {
  JOURNEY_LIMITS,
  type LeadOutcomeStepType,
} from "./journeyTypes";

/**
 * The three lead-outcome steps: mark won, mark lost, reopen.
 *
 * Split out of journeyStepExecutor for the reason journeyStepControl.ts was —
 * that module reaches the database, the mail provider, the SMS provider and
 * push, and is `server-only` by transitive import, so nothing in it can be
 * exercised by a test. What is worth exercising here is precisely the part that
 * can go wrong quietly: WHICH ROWS the write is allowed to match. So the where
 * clause is built and applied in this file, over an injected writer, and the
 * executor supplies `prisma.lead.updateMany` as that writer.
 *
 * ── WHY A CONDITIONAL updateMany AND NOT update({ where: { id } }) ──────────
 *
 * A journey run is not a request. It retries (three attempts), it is picked up
 * by whichever process drains the queue, and a `wait` can park it for up to
 * thirty days between two adjacent steps — so the process that resumes a run is
 * routinely not the one that started it, and the world has moved on in between.
 * Three consequences, and the same shape answers all three:
 *
 *  1. IDEMPOTENCE. `update({ where: { id } })` on a lead that is already won
 *     succeeds and rewrites the row — a second "win" against a deal that was
 *     already counted, with a fresh `updatedAt` that every won-this-month report
 *     in the app buckets by. Worse, it would emit a second `lead_won` event and
 *     earn the referral fee again. A conditional update matches nothing the
 *     second time, `count` is 0, and every side effect below is gated on that
 *     count — the same gate `setQuoteStatus` and the signing hub already use.
 *
 *  2. THE ROW MAY BE GONE. `update` throws P2025 for a lead deleted while the
 *     run was parked, which fails the step, burns one of three attempts, and can
 *     end with a permanently failed run over a lead nobody has any further
 *     interest in. `updateMany` returns 0 and the step records itself skipped.
 *
 *  3. TENANT. See below.
 *
 * ── THE TENANT PREDICATE IS EXPLICIT, AND HAS TO BE ────────────────────────
 *
 * The Prisma guard extension in db.ts is DORMANT: `tenantEnforcing()` is false
 * in every deployed environment today, so `scopeArgs` returns its input
 * untouched and RLS is bypassed. An implicit scope is therefore no scope at all,
 * and `where: { id: leadId }` means "any lead in the database with this id".
 *
 * So the tenant comes from the RUN ROW (`JourneyRun.tenantId`) and is written
 * into the where clause by hand. That works identically in both modes: with
 * enforcement off it is the only filter there is, and with enforcement on
 * `scopeWhere` overwrites it with the request scope's tenant — the same tenant,
 * since the journey cron runs one tenant at a time — so this can only ever be
 * equal to or narrower than what the guard would do, never wider.
 *
 * `tenantId: null` is a real predicate, not a missing one: Prisma renders it as
 * `IS NULL`, so a run belonging to no tenant (the legacy, pre-tenancy rows) may
 * touch legacy leads and nothing else. That is why the key is always present in
 * the where clause even when its value is null, and why a test asserts it.
 */

type LeadOutcomePlan = {
  /** The status the lead ends in. */
  to: "won" | "lost" | "open";
  /**
   * The statuses the lead may currently hold for the write to apply — the whole
   * of the idempotency argument, expressed as data.
   *
   * The destination is deliberately NOT in this list. That is what makes marking
   * an already-won lead won a clean no-op rather than a second win.
   *
   * Neither is the OTHER closed status. A journey cannot flip a lost lead
   * straight to won, or a won lead straight to lost, because overturning a
   * recorded outcome without a trace of the reopen is exactly the kind of silent
   * revision the audit trail exists to prevent — and it is not a thing the app
   * lets a person do either: the staff UI makes you reopen first. `lead_reopen`
   * is that step, so the transition is still expressible; it just has to be
   * written down. reopen → mark_lost is two steps and two audit lines.
   */
  from: readonly string[];
  /** Past participle, for the note and the audit summary. */
  verb: string;
  /** The SAME action name the staff verb writes, so one trail covers both. */
  auditAction: string;
  /**
   * The journey event this outcome emits, or null where the product has none.
   *
   * Reopening emits nothing because there is no `lead_reopened` trigger to emit
   * — `reopenLead` does not emit one either. Inventing a trigger name here would
   * put an event type into the stream that no builder offers and no wait can
   * watch for, which is the failure this codebase already paid for once.
   */
  event: "lead_won" | "lead_lost" | null;
};

export const LEAD_OUTCOME_PLANS: Record<LeadOutcomeStepType, LeadOutcomePlan> = {
  lead_mark_won: {
    to: "won",
    from: ["open"],
    verb: "won",
    auditAction: "lead.won",
    event: "lead_won",
  },
  lead_mark_lost: {
    to: "lost",
    from: ["open"],
    verb: "lost",
    auditAction: "lead.lost",
    event: "lead_lost",
  },
  lead_reopen: {
    to: "open",
    from: ["won", "lost"],
    verb: "reopened",
    auditAction: "lead.reopened",
    event: null,
  },
};

/**
 * The where clause. Every key earns its place:
 *
 *  id        — the lead this run is about, never one named in config.
 *  tenantId  — see the header. Always present, even as null.
 *  deletedAt — a lead in Trash must not be silently un-closed or re-won by a run
 *              that was parked when it was deleted. The db.ts extension injects
 *              this for updateMany anyway; stating it keeps the clause readable
 *              as one thing rather than half here and half in an extension.
 *  status    — the transition guard, and the idempotency argument.
 */
export type LeadOutcomeWhere = {
  id: string;
  tenantId: string | null;
  deletedAt: null;
  status: { in: string[] };
};

export type LeadOutcomeData = {
  status: string;
  lostReason?: string | null;
};

/**
 * The one write. A function rather than a `{ updateMany }` object so the
 * executor can hand over `prisma.lead.updateMany` without either side having to
 * know the other's generics.
 */
export type LeadOutcomeWriter = (args: {
  where: LeadOutcomeWhere;
  data: LeadOutcomeData;
}) => Promise<{ count: number }>;

export function leadOutcomeWhere(
  type: LeadOutcomeStepType,
  leadId: string,
  tenantId: string | null,
): LeadOutcomeWhere {
  return {
    id: leadId,
    tenantId,
    deletedAt: null,
    status: { in: [...LEAD_OUTCOME_PLANS[type].from] },
  };
}

export function leadOutcomeData(
  type: LeadOutcomeStepType,
  reason: string | null,
): LeadOutcomeData {
  if (type === "lead_mark_lost") return { status: "lost", lostReason: reason };
  // Clearing lostReason is not tidying up — a reopened lead that keeps the
  // reason it was lost for reads, everywhere it is shown, as a lead that is
  // still lost. `reopenLead` clears it for the same reason.
  if (type === "lead_reopen") return { status: "open", lostReason: null };
  return { status: "won" };
}

export type LeadOutcomeResult = {
  /** Mirrors StepResult.status — the runner records "skipped" as skipped. */
  status: "completed" | "skipped";
  note: string;
  /**
   * TRUE exactly once per real transition, and the gate for every side effect.
   *
   * Nothing outside the row — no referral, no journey event, no audit line —
   * may fire unless this is true. That is the whole reason the count is checked
   * rather than the write simply awaited: on a retry, or on a second pass of a
   * `repeat`, the write matches nothing and every effect below it stays put.
   */
  applied: boolean;
  event: LeadOutcomePlan["event"];
  auditAction: string;
  verb: string;
  output: Record<string, unknown>;
};

/**
 * Trim and cap the RENDERED reason.
 *
 * The save-time parse caps the template; this caps what actually reaches
 * `Lead.lostReason`, which is not the same string — `"Lost to {{name}}"` is 18
 * characters of template and however many the customer's name happens to be.
 */
export function cappedLostReason(rendered: string): string {
  return rendered.trim().slice(0, JOURNEY_LIMITS.leadOutcomeReason);
}

/**
 * Apply one lead-outcome step.
 *
 * A run with no lead — every contact-triggered journey has none, since
 * `purchase_anniversary` and `win_back` enrol a CONTACT — skips cleanly and
 * writes nothing. It is not an error: a journey that mixes contact-wide steps
 * with a lead outcome is a reasonable thing to build, and failing the run would
 * strand every step after it.
 */
export async function applyLeadOutcome(args: {
  type: LeadOutcomeStepType;
  leadId: string | null;
  tenantId: string | null;
  /** Rendered and capped by the caller; required for `lead_mark_lost`. */
  reason?: string | null;
  updateLead: LeadOutcomeWriter;
}): Promise<LeadOutcomeResult> {
  const { type, leadId, tenantId, updateLead } = args;
  const plan = LEAD_OUTCOME_PLANS[type];
  const reason = args.reason?.trim() ? args.reason.trim() : null;

  const skipped = (note: string, extra: Record<string, unknown> = {}): LeadOutcomeResult => ({
    status: "skipped",
    note,
    applied: false,
    event: plan.event,
    auditAction: plan.auditAction,
    verb: plan.verb,
    output: { applied: false, to: plan.to, from: [...plan.from], leadId, ...extra },
  });

  if (!leadId) return skipped(`Lead ${plan.verb} skipped: this run is not about a lead`);
  // NOT merely belt and braces behind the save-time parse — this is the only
  // check that can catch the case that actually happens.
  //
  // `parseLeadOutcomeConfig` validates the TEMPLATE, and a non-empty template
  // can still render to nothing: `renderTemplate` substitutes an unknown or
  // empty placeholder with "", so a reason of `"{{model}}"` is a perfectly valid
  // template that produces an empty string for a lead with no product. Only the
  // RENDERED value is knowable here, three days into a run, and an empty
  // `Lead.lostReason` is exactly the unexplained loss the save-time rule exists
  // to prevent — it would just arrive by a route that rule cannot see.
  //
  // Skipped rather than thrown: the author's mistake is a blank reason, not a
  // broken journey, and failing the step would burn one of three run attempts
  // and strand every step after it.
  if (type === "lead_mark_lost" && !reason) {
    return skipped("Mark lead lost skipped: the reason rendered empty");
  }

  const { count } = await updateLead({
    where: leadOutcomeWhere(type, leadId, tenantId),
    data: leadOutcomeData(type, reason),
  });

  // `=== 1`, not `> 0`, and matching setQuoteStatus and the signing hub exactly.
  // `id` is a primary key so more than one match is not reachable; if it ever
  // became reachable it would mean the predicate had stopped identifying one
  // lead, and firing the win effects for an unknown number of rows is not the
  // behaviour to fall back on.
  if (count !== 1) {
    return skipped(
      `Lead not ${plan.verb}: it must be ${plan.from.join(" or ")} and live in this workspace ` +
        `(already ${plan.to}, deleted, or another workspace's) — nothing changed`,
      { matched: count },
    );
  }

  return {
    status: "completed",
    note: reason ? `Lead marked ${plan.verb} — ${reason}` : `Lead marked ${plan.verb}`,
    applied: true,
    event: plan.event,
    auditAction: plan.auditAction,
    verb: plan.verb,
    output: {
      applied: true,
      to: plan.to,
      from: [...plan.from],
      leadId,
      ...(reason ? { reason } : {}),
    },
  };
}
