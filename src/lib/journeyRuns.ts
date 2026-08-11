import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { logAudit } from "./audit";
import { executeJourneyStep, resolveTopLevelNext } from "./journeyStepExecutor";
import {
  journeyTemplateVars,
  loadJourneyContext,
  type JourneyEntityType,
  type JourneyContext,
} from "./journeyContext";
import {
  evaluateConditions,
  explainConditions,
  parseJourneyDefinition,
  parseVariablesConfig,
  parseWaitForConditionConfig,
  parseWaitForTriggerConfig,
} from "./journeyTypes";
import { AbortJourney, ConditionFailed, StopJourney, isControlFlow } from "./journeyControlFlow";
import { cloneCursor, clearWait, parseCursor, withRepeatVars, type JourneyCursor } from "./journeyCursor";
import { armWaitState, armedWaitFor, decideWait, waitPollAt, waitedMs } from "./journeyWait";
import { applyJourneyVariables, journeyVars, withJourneyVars } from "./journeyVariables";
import {
  advanceCursor,
  chooseBranch,
  enterChoose,
  enterRepeat,
  journeyScriptCache,
  pushFrame,
  resolveCursor,
  type CursorPosition,
  type ScriptLookup,
} from "./journeyScript";
import { NEVER_STOP, type StopSignal } from "./stopSignal";
import { budgetStopUpdate } from "./journeyRunState";
import { withEnrolmentLock } from "./journeyArbitration";
import { activeTenantPredicate } from "./tenantPredicate";
import { inheritedTenantId } from "./tenantWrite";

const MAX_RUN_ATTEMPTS = 3;
const MAX_STEPS_PER_TICK = 20;
/**
 * The LIFETIME step budget for one run, and the replacement for the `visited`
 * Set that used to sit in the step loop.
 *
 * That Set was a cycle detector: revisiting a step id within a tick threw. It
 * was wrong in both directions. Too strict, because a `repeat` re-executes the
 * same step ids on purpose — every loop would have been reported as a cycle. Too
 * weak, because it was rebuilt from empty on every tick, so the actual infinite
 * automation — a back-edge with a `wait` in it — went round forever, one step
 * per tick, and was never caught at all.
 *
 * What genuinely bounds a run is total work done, counted durably. `stepsExecuted`
 * is persisted on the row, so it survives parks, waits and process restarts, and
 * a run that will not terminate hits this ceiling and ABORTS (no retry — a loop
 * that did not end in 500 steps will not end in the next three attempts either).
 * Legitimate loops spend the budget honestly; 100 iterations of a four-step body
 * is 400, so this leaves room for one full-size repeat plus its surroundings.
 */
const MAX_STEPS_PER_RUN = 500;
/** A single step can send an email or a WhatsApp message. */
const STEP_RESERVE_MS = 4_000;

type StepLogArgs = {
  runId: string;
  /**
   * The owning tenant, taken from the RUN this log belongs to — never from the
   * ambient scope and never from `writeTenantId()` alone.
   *
   * A step log is a fact about one run, so the run decides. Reading it from the
   * scope would let the two disagree: `processOneRun` fetches the run by bare id,
   * so a run belonging to workspace A can be driven inside a tick scoped to
   * whatever the caller last established, and a trace row filed under a different
   * workspace from its own run is worse than one filed under none.
   *
   * This was the whole of the defect. The upsert below stamped nothing at all and
   * relied on the db.ts guard, which stamps nothing while enforcement is dormant —
   * so every JourneyStepLog ever written carried a NULL tenant (6 of 6 on
   * production at the 2026-08-10 audit), while its `@@unique([runId, path])` and
   * its cascade from JourneyRun made it look properly parented.
   */
  tenantId: string;
  /** Hierarchical trace path — the identity of one EXECUTION of a step. */
  path: string;
  stepId: string;
  stepType: string;
  status: string;
  note?: string;
  output?: Record<string, unknown>;
};

async function writeStepLog(args: StepLogArgs) {
  const done = ["completed", "skipped", "failed"].includes(args.status);
  await prisma.journeyStepLog.upsert({
    // Keyed on the PATH, not the step id. `@@unique([runId, stepId])` could not
    // survive `repeat`: the same step id executes on every iteration, and the
    // second write would have collided with the first — or, through this upsert,
    // silently overwritten iteration one's record with iteration two's. The path
    // carries the iteration number, so each execution keeps its own row.
    where: { runId_path: { runId: args.runId, path: args.path } },
    create: {
      // The guard cannot supply this: `scopeArgs` returns its args untouched
      // unless `tenantEnforcing()`, and an upsert's `create` branch is not
      // stamped by anything else.
      tenantId: args.tenantId,
      runId: args.runId,
      path: args.path,
      stepId: args.stepId,
      stepType: args.stepType,
      status: args.status,
      note: args.note,
      output: args.output as Prisma.InputJsonValue | undefined,
      completedAt: done ? new Date() : null,
    },
    update: {
      status: args.status,
      note: args.note,
      output: args.output as Prisma.InputJsonValue | undefined,
      // A top-level back-edge can re-run the same path days later. Without this
      // reset the recorded duration would include the wait in between.
      ...(args.status === "running" ? { startedAt: new Date(), completedAt: null } : {}),
      completedAt: done ? new Date() : null,
    },
  });
}

/**
 * The earliest event that could wake an armed `wait_for_trigger`.
 *
 * Deliberately NOT filtered by the event's processing `status`. An event is a
 * fact the moment the row exists; whether `processJourneyEvents` has drained it
 * is a different cron's business. Requiring "processed" would make a wake depend
 * on that cron having already run, and requiring "pending" would miss every
 * event it had. Neither has anything to do with the question being asked.
 *
 * Not filtered by journeyId either: `emitJourneyEvent` sets one only for
 * targeted emissions, and the wait is asking "did this happen to this person",
 * not "did this happen because of this journey".
 *
 * BOUNDED AT BOTH ENDS — `[since, until)`, the same half-open window
 * `isInWaitWindow` states. The lower bound alone was not enough: the poll runs
 * on a cron, so a tick can land well after the deadline, and an unbounded query
 * would then hand back an event created after the window closed. A wait that
 * expired at 10:00 would resume at 10:30 on an event stamped 10:20 and take the
 * "it happened" branch — extending the author's window by however late the cron
 * happened to be, which is not the same thing as tolerating jitter.
 *
 * `gte` on `since`, not `gt`: an event written in the same millisecond as the
 * wait armed is one that arrived while we were listening, and losing it would be
 * silent. `lt` on `until`, not `lte`: `until` is already the first instant of
 * "timed out", so an event stamped exactly there is outside the window.
 */
async function findWakeEvent(
  run: { entityType: string; entityId: string },
  triggers: readonly string[],
  since: Date,
  until: Date,
) {
  return prisma.journeyEvent.findFirst({
    where: {
      entityType: run.entityType,
      entityId: run.entityId,
      type: { in: [...triggers] },
      createdAt: { gte: since, lt: until },
    },
    // Two events in the same tick must pick the same winner however the rows
    // happen to come back, so the millisecond tie is broken by id.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, type: true, createdAt: true },
  });
}

/** Terminal states — a predecessor in any of these no longer blocks anyone. */
const CLOSED_RUN_STATUSES = ["completed", "failed", "cancelled"];

/**
 * Release runs parked behind a predecessor by run mode "queued".
 *
 * Without this they wait forever: `blocked` is not in the statuses
 * processJourneyRuns picks up, so nothing would ever start them. A run whose
 * predecessor has been PURGED is released too — a dangling id must not strand
 * it behind something that no longer exists.
 */
export async function releaseBlockedJourneyRuns(): Promise<number> {
  const blocked = await prisma.journeyRun.findMany({
    where: { status: "blocked" },
    // Oldest first, so a queue that has built up drains in the order it formed.
    orderBy: { createdAt: "asc" },
    select: { id: true, journeyId: true, entityType: true, entityId: true, blockedByRunId: true },
    take: 200,
  });
  if (blocked.length === 0) return 0;

  const predecessorIds = [...new Set(blocked.map((run) => run.blockedByRunId).filter((id): id is string => Boolean(id)))];
  const stillOpen = new Set(
    (
      await prisma.journeyRun.findMany({
        where: { id: { in: predecessorIds }, status: { notIn: CLOSED_RUN_STATUSES } },
        select: { id: true },
      })
    ).map((run) => run.id),
  );

  let released = 0;
  // At most ONE release per person per journey per sweep. Three runs queued
  // behind one predecessor all become eligible the moment it closes, and
  // releasing them together would start three at once — a queue that delivers
  // in parallel, which is the one thing the mode promises not to do. The rest
  // stay blocked and the next sweep takes the next one, because by then the
  // released run is itself open and holds the line.
  const releasedFor = new Set<string>();
  for (const run of blocked) {
    if (run.blockedByRunId && stillOpen.has(run.blockedByRunId)) continue;
    const lane = `${run.journeyId}:${run.entityType}:${run.entityId}`;
    if (releasedFor.has(lane)) continue;

    // Under the same lock enrolment takes, and re-checking the open runs inside
    // it: an enrolment arriving between the eligibility read above and this
    // write would otherwise be invisible, and the released run would start
    // beside it.
    const { count } = await withEnrolmentLock(run.journeyId, run.entityType, run.entityId, async (tx) => {
      const tenant = activeTenantPredicate("releaseBlockedJourneyRuns");
      const openNow = await tx.journeyRun.count({
        where: {
          ...tenant,
          journeyId: run.journeyId,
          entityType: run.entityType,
          entityId: run.entityId,
          status: { in: ["queued", "running", "waiting"] },
        },
      });
      if (openNow > 0) return { count: 0 };
      return tx.journeyRun.updateMany({
        where: { ...tenant, id: run.id, status: "blocked" },
        data: { status: "queued", nextRunAt: new Date(), blockedByRunId: null },
      });
    });
    if (count > 0) releasedFor.add(lane);
    released += count;
  }
  return released;
}

export async function recoverStaleJourneyRuns() {
  const cutoff = new Date(Date.now() - 15 * 60_000);
  return prisma.journeyRun.updateMany({
    where: { status: "running", updatedAt: { lt: cutoff } },
    data: { status: "queued", nextRunAt: new Date(), lastError: "Recovered stale running journey" },
  });
}

/**
 * Drive ONE run to its next parking point.
 *
 * Exported so the manual-run action can process the run its own test produced,
 * instead of calling the global `processJourneyRuns(50)` and driving up to
 * fifty unrelated customers' journeys as a side effect of pressing "test".
 */
export async function processOneRun(runId: string, stop: StopSignal = NEVER_STOP) {
  const run = await prisma.journeyRun.findUnique({
    where: { id: runId },
    include: { journey: true, journeyVersion: true },
  });
  if (!run || !["queued", "waiting"].includes(run.status)) return false;

  /**
   * Every trace row this tick writes, stamped with the RUN'S OWN owner.
   *
   * Resolved once, from the row already in hand, and threaded into all thirteen
   * log sites so none of them can be added later without it. `inheritedTenantId`
   * prefers an enforced scope (and keeps its fail-closed throw), then the run,
   * then the tick's own scope, then the founding tenant — so a legacy run written
   * before runs were owned still produces reachable trace rows rather than
   * propagating its own NULL into thirteen more.
   */
  const logTenantId = inheritedTenantId(run.tenantId);
  const updateStepLog = (args: Omit<StepLogArgs, "tenantId">) =>
    writeStepLog({ ...args, tenantId: logTenantId });

  const claimed = await prisma.journeyRun.updateMany({
    where: { id: run.id, status: { in: ["queued", "waiting"] }, nextRunAt: { lte: new Date() } },
    data: {
      status: "running",
      startedAt: run.startedAt ?? new Date(),
      lastError: null,
    },
  });
  if (claimed.count === 0) return false;

  // PREPARATION SITS INSIDE ITS OWN GUARD, and the reason is blast radius.
  //
  // The run has just been claimed as "running". A throw from here escaped
  // processOneRun into processJourneyRuns and out of runJourneyEngine, so ONE
  // journey with an unreadable definition stopped every other run in that
  // tenant's tick and left itself claimed as "running" until the 15-minute
  // stale sweep — which then handed it back to do the same thing again.
  //
  // This branch made that far more likely, and it is worth being explicit about
  // why: refusing top-level cycles is a NEW way to throw here. Every journey
  // published while back-edges were still permitted now fails this parse, and a
  // published version is immutable — so the definition cannot be corrected in
  // place, and the run would have poisoned the tick on every retry forever.
  //
  // Failed outright rather than retried, for the same reason: the version is
  // immutable, so a definition that will not parse now will not parse on the
  // third attempt either. Retrying only holds the run open and burns budget.
  let definition;
  let lookup: ScriptLookup;
  let cursor: JourneyCursor;
  try {
    // Shallow on purpose: this parse happens on EVERY tick for EVERY run, and
    // validating ten `choose` branches to execute one of them is work nobody
    // asked for. The branch actually entered is prepared and validated on
    // entry, then cached by immutable version id. See journeyScript.ts.
    definition = parseJourneyDefinition(run.journeyVersion.definition, { deep: false });
    lookup = { cache: journeyScriptCache(), versionId: run.journeyVersionId };
    cursor = parseCursor(run.cursor, run.currentStepId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unreadable journey definition";
    await prisma.journeyRun.updateMany({
      where: { id: run.id, status: "running" },
      data: {
        status: "failed",
        completedAt: new Date(),
        lastError: `Definition could not be read: ${message}`.slice(0, 1000),
      },
    });
    return false;
  }

  let context = run.context as unknown as JourneyContext;
  let stepsExecuted = run.stepsExecuted;
  /** The last position reached, so the catch blocks can log against it. */
  let position: CursorPosition | null = null;

  /**
   * Write to the run ONLY while we still own it.
   *
   * The claim above takes the run from queued/waiting to `running`, and that is
   * the whole of this worker's title to it. Unconditional writes meant a run
   * cancelled mid-flight by run mode `restart` was quietly resurrected: the
   * worker finished its steps and wrote `completed` straight over `cancelled`,
   * while the replacement run was already sending. The customer got both
   * sequences, and the trace showed two completed runs with nothing to say one
   * had been superseded.
   *
   * Every write below goes through this. Returns false when the row is no
   * longer ours, which is the signal to stop touching it and get out.
   */
  const stillOurs = async (data: Prisma.JourneyRunUpdateManyMutationInput) => {
    const { count } = await prisma.journeyRun.updateMany({
      where: { id: run.id, status: "running" },
      data,
    });
    return count > 0;
  };

  const park = async () =>
    stillOurs(
      budgetStopUpdate(cursor.stepId, context as Prisma.InputJsonValue, {
        cursor: cursor as unknown as Prisma.InputJsonValue,
        stepsExecuted,
      }),
    );

  /**
   * Park on the CURRENT position — no advance — until `nextRunAt`.
   *
   * The same write the `wait` step's park does, reused by `wait_for_trigger`
   * because the requirement is identical and the mistake would be identical
   * too: advancing before parking is right for a `wait` (it succeeded) and
   * wrong for a wait_for_trigger, which has not finished waiting. That is the
   * distinction `StepResult.retryStep` exists for, and it is why this does not
   * touch the cursor at all.
   */
  const parkWaiting = async (nextRunAt: Date) =>
    // Through `stillOurs` like every other write: a wait_for_trigger parked by
    // a run that has since been cancelled and replaced must not be written back
    // to "waiting", which would resurrect it and leave it polling forever
    // beside its replacement.
    stillOurs({
      status: "waiting",
      currentStepId: cursor.stepId,
      cursor: cursor as unknown as Prisma.InputJsonValue,
      stepsExecuted,
      nextRunAt,
      attempts: 0,
      context: context as Prisma.InputJsonValue,
    });

  const finish = async (note: string) => {
    const finished = await stillOurs({
      status: "completed",
      currentStepId: null,
      // DbNull, not JsonNull: this must CLEAR the column, not store the JSON
      // literal `null` in it. A finished run has no position.
      cursor: Prisma.DbNull,
      stepsExecuted,
      completedAt: new Date(),
      attempts: 0,
      context: context as Prisma.InputJsonValue,
    });
    // Cancelled out from under us while the last steps ran. Write nothing and
    // say nothing: the "completed" status and the audit line both belong to the
    // replacement run, not to this one.
    if (!finished) return false;
    await logAudit({
      action: "journey.completed",
      summary: `Journey “${run.journey.name}” completed${note ? `: ${note}` : ""}`,
      leadId: run.leadId,
      contactId: run.contactId,
      userName: "Journey engine",
    });
    return true;
  };

  try {
    for (let count = 0; count < MAX_STEPS_PER_TICK; count++) {
      // Budget spent: park the run exactly where it is and RETURN.
      //
      // `break` here was wrong and actively harmful: falling out of the loop
      // used to land on an "exceeded MAX_STEPS_PER_TICK" throw, whose catch
      // marked the not-yet-executed step FAILED, incremented attempts, and after
      // MAX_RUN_ATTEMPTS budget stops failed the journey permanently. Running out
      // of time is not an error and must not consume a retry.
      //
      // The run was claimed as "running", so it has to be put back to "queued"
      // explicitly — leaving it running would strand it until the stale-run
      // recovery sweep. attempts is deliberately untouched: a budget stop is not
      // an attempt, and any genuine earlier failures keep their count.
      if (stop.shouldStop(STEP_RESERVE_MS)) {
        await park();
        return false;
      }

      position = resolveCursor(definition, cursor, lookup);
      if (!position) return finish("");
      const { step, path, keyPath } = position;
      const inSequence = cursor.frames.length > 0;
      // What the step sees: the run context plus the innermost loop's variables,
      // derived from the cursor rather than stored, because the context is
      // reloaded from the database after every step and would wipe them.
      const stepContext = withRepeatVars(context, cursor);

      // An armed wait belongs to exactly ONE position, named by its trace path.
      // Anything else here means the cursor moved on with a stale wait still
      // attached — a hand-edited cursor, or a corrupt one — and leaving it would
      // let a later arrival at that path believe it had been listening since
      // then, and wake on an event that predates it.
      const armedWait = armedWaitFor(cursor, step, path);
      if (cursor.wait && !armedWait) cursor = clearWait(cursor);

      // A POLL is not work, and must not be charged to the lifetime budget.
      // Charging it would give wait_for_trigger a second, invisible ceiling —
      // "500 engine ticks" rather than its own timeout — and a long wait would
      // then abort with a step-budget message naming nothing the author wrote.
      // Arming the wait costs one step; re-checking it costs none.
      if (!armedWait) {
        if (stepsExecuted >= MAX_STEPS_PER_RUN) {
          throw new AbortJourney(`Journey exceeded ${MAX_STEPS_PER_RUN} steps in one run`);
        }
        stepsExecuted += 1;
      }

      /* ── a disabled step is SKIPPED, and the trace SAYS it was skipped ───── */
      //
      // Checked here — before the container branch, before the wait handler,
      // before the executor — because "muted"
      // has to mean the same thing for every step type: a disabled `choose` must
      // not be entered, a disabled `wait_for_trigger` must not arm, a disabled
      // `stop` must not end the run.
      //
      // The step log write is the whole feature. Advancing quietly would be one
      // line shorter and would reproduce exactly the defect this engine's trace
      // work existed to fix: a step that did nothing and said nothing is
      // indistinguishable, three weeks later, from a step that was never
      // reached. `disabled: true` is a FIELD rather than only prose, for the
      // same reason `timedOut` is — the question is binary and a reader should
      // not have to parse a sentence to answer it.
      //
      // The cursor advances WITHOUT an override, so a disabled top-level
      // `condition` falls through to its own nextStepId rather than picking a
      // branch: a muted question has no answer to branch on.
      if (step.enabled === false) {
        await updateStepLog({
          runId: run.id,
          path,
          stepId: step.id,
          stepType: step.type,
          status: "skipped",
          note: "Skipped: this step is turned off",
          output: { disabled: true },
        });
        cursor = advanceCursor({ definition, cursor, context: stepContext, lookup });
        await persistPosition(run.id, cursor, stepsExecuted, context);
        continue;
      }

      /* ── control-flow containers: the RUNNER runs these, not the executor ── */
      if (step.type === "choose" || step.type === "repeat") {
        let entered = null;
        if (step.type === "choose") {
          const picked = chooseBranch(step, keyPath, stepContext, lookup);
          entered = picked ? enterChoose(step, picked.option) : null;
        } else {
          entered = enterRepeat(step, keyPath, stepContext, lookup);
        }

        await updateStepLog({
          runId: run.id,
          path,
          stepId: step.id,
          stepType: step.type,
          status: "completed",
          note: entered
            ? entered.kind === "choose"
              ? `Chose branch ${entered.option}`
              : "Entered repeat"
            : step.type === "choose"
              ? "No branch matched"
              : "Repeat skipped: nothing to iterate",
          output: entered?.kind === "repeat" ? { items: entered.items?.length ?? null } : {},
        });

        cursor = entered
          ? pushFrame(cursor, entered)
          : advanceCursor({ definition, cursor, context: stepContext, lookup });
        await persistPosition(run.id, cursor, stepsExecuted, context);
        continue;
      }

      /* ── wait_for_trigger: park on THIS frame until an event arrives ────── */
      if (step.type === "wait_for_trigger") {
        const config = parseWaitForTriggerConfig(step.config);
        // Read ONCE, and before anything is written. `since` is derived from
        // this instant, so an event landing between here and the commit below
        // is still at-or-after the watermark and is found by the next poll.
        // Taking the clock at commit time instead would put that event behind
        // the watermark and lose it, silently, for the life of the wait.
        const now = new Date();

        if (!armedWait) {
          const wait = armWaitState(path, config, now);
          cursor = { ...cloneCursor(cursor), wait };
          await updateStepLog({
            runId: run.id,
            path,
            stepId: step.id,
            stepType: step.type,
            status: "running",
            note: `Waiting for ${config.triggers.join(" or ")}`,
            output: {
              triggers: config.triggers,
              until: wait.until,
              continueOnTimeout: config.continueOnTimeout,
            },
          });
          await parkWaiting(waitPollAt(wait, now));
          return true;
        }

        const woke = await findWakeEvent(
          run,
          config.triggers,
          new Date(armedWait.since),
          new Date(armedWait.until),
        );
        const decision = decideWait(armedWait, now, woke?.createdAt ?? null);
        if (decision.kind === "keep_waiting") {
          // No step-log write on a poll. updateStepLog resets startedAt on a
          // "running" upsert — for a back-edge that is correct — so rewriting
          // the row every minute would report the last poll interval as the
          // duration of a three-day wait.
          await parkWaiting(decision.nextRunAt);
          return true;
        }

        const timedOut = decision.kind === "timed_out";
        // The trace follows the DECISION, not the query. Nothing can make them
        // disagree today — the query is bounded by the same window the decision
        // applies — but a row that reads "timed out" while naming the event that
        // woke it would be worse than either outcome on its own.
        const wokeBy = timedOut ? null : woke;
        const note = timedOut
          ? `Timed out after ${config.timeoutMinutes} minute(s) waiting for ${config.triggers.join(" or ")}`
          : `Woken by ${wokeBy?.type}`;
        await updateStepLog({
          runId: run.id,
          path,
          stepId: step.id,
          stepType: step.type,
          status: "completed",
          note,
          // The two outcomes are separated by a FIELD, not by reading prose.
          // "the event happened" versus "it never did" is the only question
          // this step exists to answer, and making a trace reader parse a
          // sentence for it is the same defect as "Condition did not match".
          output: {
            timedOut,
            waitedMs: waitedMs(armedWait, now),
            triggers: config.triggers,
            event: wokeBy ? { id: wokeBy.id, type: wokeBy.type, at: wokeBy.createdAt.toISOString() } : null,
          },
        });

        if (timedOut && !config.continueOnTimeout) {
          // `continueOnTimeout: false` ends the run. Ended here
          // rather than by raising StopJourney — the spelling a `stop` step
          // uses — because the StopJourney handler rewrites this same path's
          // log row with `{ stopped: true, reason: "stop" }` and would erase
          // the `timedOut` field just written. Raising and catching inside one
          // function, to lose the one thing the step had to record, is not a
          // symmetry worth having. The run still ends completed, exactly as a
          // stop does.
          return finish(note);
        }

        cursor = advanceCursor({ definition, cursor: clearWait(cursor), context: stepContext, lookup });
        await persistPosition(run.id, cursor, stepsExecuted, context);
        continue;
      }

      /* ── wait_for_condition: park until something BECOMES true ──────────── */
      if (step.type === "wait_for_condition") {
        const config = parseWaitForConditionConfig(step.config);
        const now = new Date();

        // RE-READ THE WORLD. This is the poll, and skipping it would make the
        // step a no-op dressed as a wait.
        //
        // `context` is a SNAPSHOT: it is written back after each leaf step and
        // then sits in the row untouched for as long as the run is parked. So
        // asking "is this lead Won yet" of the stored context answers what was
        // true when the run last moved — days ago — and the wait would either
        // fire on the instant it armed or never fire at all, depending only on
        // what the snapshot happened to hold. Neither answer is about the lead.
        //
        // The refreshed context is KEPT rather than used and thrown away, so
        // the step after the wait sees the world the wait actually observed —
        // and the variables bag is carried across it for the same reason it is
        // carried across every other refresh.
        const polled = await loadJourneyContext(
          run.entityType as JourneyEntityType,
          run.entityId,
          (context.event ?? {}) as Record<string, unknown>,
        );
        if (polled) context = withJourneyVars(polled, journeyVars(context));
        const pollContext = withRepeatVars(context, cursor);
        const met = evaluateConditions(config.condition, pollContext);
        // Recorded on EVERY outcome, including the timeout. "It never became
        // true" is the answer nobody can act on; "lead.status was still
        // qualified, not won" is the one they can.
        const clauses = explainConditions(config.condition, pollContext);

        // Already true on arrival: continue immediately rather than park.
        // Arming here would hold the run for a poll interval to re-learn
        // something already known — for "wait until Won" on a lead that is
        // already Won, a minute of nothing on every such enrolment.
        if (!armedWait && met) {
          await updateStepLog({
            runId: run.id,
            path,
            stepId: step.id,
            stepType: step.type,
            status: "completed",
            note: "Condition was already true",
            output: { met: true, timedOut: false, waitedMs: 0, clauses },
          });
          cursor = advanceCursor({ definition, cursor, context: pollContext, lookup });
          await persistPosition(run.id, cursor, stepsExecuted, context);
          continue;
        }

        if (!armedWait) {
          const wait = armWaitState(path, config, now);
          cursor = { ...cloneCursor(cursor), wait };
          await updateStepLog({
            runId: run.id,
            path,
            stepId: step.id,
            stepType: step.type,
            status: "running",
            note: "Waiting until the condition is true",
            output: { until: wait.until, continueOnTimeout: config.continueOnTimeout, clauses },
          });
          await parkWaiting(waitPollAt(wait, now));
          return true;
        }

        // `now` in place of an event's timestamp — see journeyWait.ts. A polled
        // condition never learns WHEN it became true, only that it is true now,
        // so only an observation made inside the window can count. Passing the
        // same decision function is the point: there is one rule about what the
        // deadline means, and a second wait must not quietly acquire its own.
        const decision = decideWait(armedWait, now, met ? now : null);
        if (decision.kind === "keep_waiting") {
          // No step-log write on a poll, for the reason wait_for_trigger has
          // none: a "running" upsert resets startedAt, so rewriting the row
          // every minute would report a three-day wait as sixty seconds.
          await parkWaiting(decision.nextRunAt);
          return true;
        }

        const timedOut = decision.kind === "timed_out";
        const note = timedOut
          ? `Timed out after ${config.timeoutMinutes} minute(s) waiting for the condition`
          : "Condition became true";
        await updateStepLog({
          runId: run.id,
          path,
          stepId: step.id,
          stepType: step.type,
          status: "completed",
          note,
          // `met` is the field, and it follows the DECISION rather than the
          // observation: a row reading "timed out" while also saying the
          // condition held would be worse than either outcome on its own.
          output: { met: !timedOut, timedOut, waitedMs: waitedMs(armedWait, now), clauses },
        });

        if (timedOut && !config.continueOnTimeout) {
          // Ended here rather than by raising StopJourney, for the reason the
          // trigger wait ends inline: the StopJourney handler rewrites this
          // same path's row with `{ stopped: true, reason: "stop" }` and would
          // erase the `met` field this step exists to record.
          return finish(note);
        }

        cursor = advanceCursor({ definition, cursor: clearWait(cursor), context: pollContext, lookup });
        await persistPosition(run.id, cursor, stepsExecuted, context);
        continue;
      }

      /* ── variables: named values later steps can read ───────────────────── */
      if (step.type === "variables") {
        const assignments = parseVariablesConfig(step.config);
        const applied = applyJourneyVariables({
          stepId: step.id,
          assignments,
          // Merged over what the run already has, so a second variables step
          // adds rather than replaces, and re-setting a name overwrites it.
          existing: journeyVars(context),
          // Rendered against the context the STEP sees — loop variables
          // included — so `{{repeat_item}}` works inside a for_each.
          templateVars: journeyTemplateVars(stepContext),
        });
        context = withJourneyVars(context, applied.vars);
        await updateStepLog({
          runId: run.id,
          path,
          stepId: step.id,
          stepType: step.type,
          status: "completed",
          note: `Set ${assignments.map((assignment) => assignment.name).join(", ")}`,
          // `truncated` names anything that hit the per-value cap. A value cut
          // in half and never mentioned is the silent-damage failure this
          // codebase keeps paying for.
          output: { variables: applied.vars, truncated: applied.truncated },
        });
        // Re-derived from the NEW context: a repeat's while/until may test a
        // variable this step just set.
        cursor = advanceCursor({
          definition,
          cursor,
          context: withRepeatVars(context, cursor),
          lookup,
        });
        await persistPosition(run.id, cursor, stepsExecuted, context);
        continue;
      }

      /* ── leaf actions ─────────────────────────────────────────────────── */
      // Re-check ownership BEFORE the step runs, not just before the write.
      // Leaf steps send email, SMS and push, and an unsent message is
      // recoverable where a sent one is not — so the check that matters is the
      // one in front of the send. This narrows the window to a single step's
      // execution; a cancellation landing inside that window still gets one
      // more send, which would need cooperative cancellation to close.
      const owned = await prisma.journeyRun.count({ where: { id: run.id, status: "running" } });
      if (owned === 0) return false;

      await updateStepLog({ runId: run.id, path, stepId: step.id, stepType: step.type, status: "running" });

      let result;
      try {
        result = await executeJourneyStep({
          step,
          context: stepContext,
          category: run.journey.category,
          journeyName: run.journey.name,
          runId: run.id,
          // From the RUN ROW, not the ambient scope and not the context. Every
          // Lead write in the executor names it in its `where`, which is the
          // only tenant boundary those writes have while the db.ts guard is
          // dormant — see journeyLeadOutcome.ts.
          tenantId: run.tenantId,
          inSequence,
        });
      } catch (error) {
        // The step's own continueOnError flag. Control flow is NEVER
        // swallowed: a stop, a condition gate or an abort is a decision, and
        // treating it as a recoverable fault would run steps the author put
        // behind it.
        if (isControlFlow(error) || !step.continueOnError) throw error;
        const message = error instanceof Error ? error.message : "Step failed";
        await updateStepLog({
          runId: run.id,
          path,
          stepId: step.id,
          stepType: step.type,
          status: "failed",
          note: `Continued past error: ${message}`.slice(0, 1000),
        });
        cursor = advanceCursor({ definition, cursor, context: stepContext, lookup });
        await persistPosition(run.id, cursor, stepsExecuted, context);
        continue;
      }

      const nextTop = inSequence ? null : resolveTopLevelNext(step, result);
      await updateStepLog({
        runId: run.id,
        path,
        stepId: step.id,
        stepType: step.type,
        // A step held for retry has not finished, so it is not "completed" —
        // the trace would otherwise read "completed: Email held for quiet
        // hours", which says two opposite things at once. The upsert is keyed
        // on the path, so the eventual real attempt overwrites this row.
        status:
          result.status === "skipped" ? "skipped" : result.retryStep ? "running" : "completed",
        note: result.note,
        output: {
          ...result.output,
          nextStepId: nextTop,
          nextRunAt: result.nextRunAt?.toISOString(),
        },
      });

      // A wait is a PARK, not an unwind — which is exactly why it stayed a
      // return value while stop/condition-fail became exceptions. The cursor is
      // advanced first, so the run resumes on the step AFTER the wait, possibly
      // days later and in another process.
      //
      // UNLESS the step is asking to be retried in place. A `wait` step
      // succeeded, so moving on is right; a step held by quiet hours or a
      // frequency cap did NOT run, and advancing would drop the send on the
      // floor. Note this cannot be expressed as a branch override back to the
      // same id: advanceCursor honours `override` only at the top level, and
      // inside a repeat or choose it steps the frame index on regardless — so a
      // nested marketing email would be skipped entirely.
      if (!(result.status === "waiting" && result.retryStep)) {
        cursor = advanceCursor({
          definition,
          cursor,
          context: stepContext,
          lookup,
          ...(result.branch ? { override: result.branch.stepId } : {}),
        });
      }

      if (result.status === "waiting") {
        await stillOurs({
          status: "waiting",
          currentStepId: cursor.stepId,
          cursor: cursor as unknown as Prisma.InputJsonValue,
          stepsExecuted,
          nextRunAt: result.nextRunAt ?? new Date(Date.now() + 60_000),
          attempts: 0,
          context: context as Prisma.InputJsonValue,
        });
        return true;
      }

      const refreshed = await loadJourneyContext(
        run.entityType as JourneyEntityType,
        run.entityId,
        (context.event ?? {}) as Record<string, unknown>
      );
      // loadJourneyContext returns `{ event, lead, contact }` and nothing else,
      // so a bare `context = refreshed` erases the variables bag on the very
      // next step after a `variables` step ran — the same wipe that stops
      // repeat variables from being stored in the context at all. They cannot be
      // derived (they are authored values), so they are carried explicitly.
      if (refreshed) context = withJourneyVars(refreshed, journeyVars(context));
      // Losing the row here means it was cancelled while this step ran. Stop
      // rather than stepping a run that has been replaced.
      const kept = await persistPosition(run.id, cursor, stepsExecuted, context);
      if (!kept) return false;
    }

    // Out of per-tick steps. This used to THROW, which was defensible when
    // twenty immediate steps could only mean a runaway definition — it cannot
    // mean that any more, because a `repeat` of forty passes reaches twenty
    // legitimately. Park and pick it up next tick; MAX_STEPS_PER_RUN is what
    // catches a run that genuinely never ends.
    await park();
    return false;
  } catch (error) {
    /* ── deliberate control flow: not faults, never retried ──────────────── */
    if (error instanceof StopJourney || error instanceof ConditionFailed) {
      if (position) {
        await updateStepLog({
          runId: run.id,
          path: position.path,
          stepId: position.step.id,
          stepType: position.step.type,
          status: "completed",
          note: error.message.slice(0, 1000),
          output: { stopped: true, reason: error instanceof ConditionFailed ? "condition" : "stop" },
        });
      }
      return finish(error.message);
    }

    const abort = error instanceof AbortJourney;
    const message = error instanceof Error ? error.message : "Unknown journey run error";
    if (position) {
      await updateStepLog({
        runId: run.id,
        path: position.path,
        stepId: position.step.id,
        stepType: position.step.type,
        status: "failed",
        note: message.slice(0, 1000),
      });
    }
    // An abort is deterministic — a loop that will not terminate, a cursor that
    // no longer matches its definition, an author-declared error stop. Retrying
    // it three times fails three times and burns the budget doing it.
    const attempts = abort ? MAX_RUN_ATTEMPTS : run.attempts + 1;
    const retry = !abort && attempts < MAX_RUN_ATTEMPTS;
    // Conditional like every other write: a run cancelled mid-flight must not be
    // dragged back to "queued" by the failure of the step it was cancelled
    // during, which would return it to the queue beside its replacement.
    await stillOurs({
      status: retry ? "queued" : "failed",
      attempts,
      stepsExecuted,
      nextRunAt: retry ? new Date(Date.now() + 5 * 60_000) : run.nextRunAt,
      lastError: message.slice(0, 1000),
    });
    return false;
  }
}

/**
 * The run's durable position after a step.
 *
 * `currentStepId` keeps carrying the TOP-LEVEL step so existing screens and
 * queries still read correctly; `cursor` carries the frames that say where
 * inside a container the run actually is. A run parked here can be resumed by
 * any process, from these two columns and the pinned (immutable) version alone.
 */
async function persistPosition(
  runId: string,
  cursor: JourneyCursor,
  stepsExecuted: number,
  context: JourneyContext,
) {
  // Conditional on the run still being ours — see `stillOurs` in processOneRun.
  // Returns false when it is not, which the caller uses to stop stepping a run
  // that has been cancelled and replaced.
  const { count } = await prisma.journeyRun.updateMany({
    where: { id: runId, status: "running" },
    data: {
      currentStepId: cursor.stepId,
      cursor: cursor as unknown as Prisma.InputJsonValue,
      stepsExecuted,
      attempts: 0,
      context: context as Prisma.InputJsonValue,
    },
  });
  return count > 0;
}

export async function processJourneyRuns(limit = 40, stop: StopSignal = NEVER_STOP) {
  const runs = await prisma.journeyRun.findMany({
    where: {
      status: { in: ["queued", "waiting"] },
      nextRunAt: { lte: new Date() },
    },
    orderBy: { nextRunAt: "asc" },
    take: limit,
    select: { id: true },
  });
  let processed = 0;
  for (const run of runs) {
    if (stop.shouldStop(STEP_RESERVE_MS)) break;
    if (await processOneRun(run.id, stop)) processed++;
  }
  return processed;
}
