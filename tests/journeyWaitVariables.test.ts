import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  JOURNEY_LIMITS,
  WAIT_TIMEOUT_MAX_MINUTES,
  parseJourneyDefinition,
  parseVariablesConfig,
  parseWaitForTriggerConfig,
  parseConditionGroup,
  evaluateConditions,
  type JourneyDefinition,
} from "../src/lib/journeyTypes";
import {
  clearWait,
  cloneCursor,
  flatCursor,
  parseCursor,
  withRepeatVars,
  type JourneyCursor,
} from "../src/lib/journeyCursor";
import {
  JourneyScriptCache,
  advanceCursor,
  chooseBranch,
  enterChoose,
  enterRepeat,
  pushFrame,
  resolveCursor,
  type ScriptLookup,
} from "../src/lib/journeyScript";
import {
  WAIT_POLL_INTERVAL_MS,
  armWaitState,
  armedWaitFor,
  decideWait,
  isInWaitWindow,
  waitPollAt,
  waitedMs,
} from "../src/lib/journeyWait";
import {
  applyJourneyVariables,
  journeyVars,
  variableTemplateVars,
  withJourneyVars,
} from "../src/lib/journeyVariables";
import { AbortJourney, ConditionFailed, StopJourney } from "../src/lib/journeyControlFlow";
import { conditionStepOutcome, stopStepOutcome } from "../src/lib/journeyStepControl";
import { journeyTemplateVars } from "../src/lib/journeyContext";
import { renderTemplate } from "../src/lib/template";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const shipped = (rel: string) =>
  src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * `wait_for_trigger` and `variables`, after Home Assistant's script syntax.
 *
 * Everything that can be is BEHAVIOURAL. `Engine` below is processOneRun's step
 * loop with the database swapped for two arrays and a fake clock — the same
 * parse, the same cursor primitives, the same order, the same per-step context
 * refresh — so a wait genuinely parks, genuinely polls across ticks, and
 * genuinely resumes on the frame it stopped on.
 */

/* ── the runner's loop, with the database and the clock taken out ─────────── */

const MAX_STEPS_PER_TICK = 20;

/**
 * The gap between the runner DECIDING to wait and the parked row reaching the
 * database: `updateStepLog` and then `parkWaiting`, two awaits.
 *
 * Modelled because it is where an event can be lost. The watermark is taken from
 * the clock read at the top of the handler, so an event landing inside this
 * window is still at-or-after it. Taking the clock at commit time instead would
 * put that event behind the watermark, and it would never wake anything.
 */
const COMMIT_LAG_MS = 50;

type FakeEvent = { id: string; type: string; entityId: string; createdAt: Date };

type TraceRow = {
  path: string;
  stepId: string;
  stepType: string;
  status: string;
  note: string;
  output: Record<string, unknown>;
  startedAt: Date;
  completedAt: Date | null;
};

type TickOutcome =
  | { kind: "waiting"; nextRunAt: Date }
  | { kind: "completed"; note: string }
  | { kind: "budget" };

class Engine {
  readonly definition: JourneyDefinition;
  readonly lookup: ScriptLookup;
  readonly entityId = "lead_1";
  cursor: JourneyCursor;
  context: Record<string, unknown>;
  stepsExecuted = 0;
  now: Date;
  events: FakeEvent[] = [];
  /** Step-log rows, keyed on the PATH exactly as the upsert is. */
  rows = new Map<string, TraceRow>();
  /** Every leaf/runner step that actually ran, by path, in order. */
  ran: string[] = [];
  /** Rendered `send_push` messages, so template substitution is observable. */
  sent: string[] = [];
  ended: "end" | "completed" | null = null;
  endNote = "";
  private readonly maxStepsPerRun: number;
  private readonly baseContext: () => Record<string, unknown>;
  /**
   * Drops the wake query's UPPER bound — the bug as filed, where the lookup only
   * knew `createdAt >= since`.
   *
   * Here so the second line of defence can be exercised on its own. With both
   * bounds in place the query never hands `decideWait` an out-of-window event,
   * which is correct and also means the decision's own window check is never
   * reached. This option reaches it.
   */
  private readonly unboundedWakeQuery: boolean;

  constructor(raw: unknown, opts: {
    context?: () => Record<string, unknown>;
    maxStepsPerRun?: number;
    cache?: JourneyScriptCache;
    start?: Date;
    unboundedWakeQuery?: boolean;
  } = {}) {
    this.unboundedWakeQuery = opts.unboundedWakeQuery ?? false;
    // `{ deep: false }` — the same shallow parse processOneRun uses.
    this.definition = parseJourneyDefinition(raw, { deep: false });
    this.lookup = { cache: opts.cache ?? new JourneyScriptCache(), versionId: "version-1" };
    this.cursor = flatCursor(this.definition.startStepId);
    this.baseContext = opts.context ?? (() => ({
      event: { type: "lead_created" },
      lead: { id: "lead_1", source: "web", status: "open" },
      contact: { id: "contact_1", firstName: "Ada", source: "referral", tags: ["a", "b"] },
    }));
    this.context = this.baseContext();
    this.maxStepsPerRun = opts.maxStepsPerRun ?? 500;
    this.now = opts.start ?? new Date("2026-08-03T09:00:00.000Z");
  }

  /** Mirrors updateStepLog, including the startedAt reset on "running". */
  private log(row: Omit<TraceRow, "startedAt" | "completedAt">) {
    const done = ["completed", "skipped", "failed"].includes(row.status);
    const existing = this.rows.get(row.path);
    const startedAt =
      !existing || row.status === "running" ? new Date(this.now) : existing.startedAt;
    this.rows.set(row.path, {
      ...row,
      startedAt,
      completedAt: done ? new Date(this.now) : null,
    });
  }

  row(path: string): TraceRow {
    const row = this.rows.get(path);
    assert.ok(row, `no step log at ${path}`);
    return row;
  }

  emit(type: string, at: Date, entityId = this.entityId) {
    this.events.push({ id: `evt_${this.events.length}`, type, entityId, createdAt: at });
  }

  /**
   * findWakeEvent, in memory: same filter, same ordering, same tie-break.
   *
   * Bounded at BOTH ends, like the query — `[since, until)`. A lower bound alone
   * lets a late tick pick up an event created after the window closed.
   */
  private findWakeEvent(triggers: readonly string[], since: Date, until: Date) {
    return (
      this.events
        .filter(
          (event) =>
            event.entityId === this.entityId &&
            triggers.includes(event.type) &&
            event.createdAt.getTime() >= since.getTime() &&
            (this.unboundedWakeQuery || event.createdAt.getTime() < until.getTime()),
        )
        .sort(
          (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1),
        )[0] ?? null
    );
  }

  /** Persist + resume through JSON, as a different cron process would. */
  reload() {
    const stored = JSON.parse(JSON.stringify(this.cursor));
    this.cursor = parseCursor(stored, stored.stepId);
    this.context = JSON.parse(JSON.stringify(this.context));
    this.lookup.cache.clear();
  }

  /** One engine tick: run until the run parks, finishes, or spends its budget. */
  tick(): TickOutcome {
    for (let count = 0; count < MAX_STEPS_PER_TICK; count++) {
      const position = resolveCursor(this.definition, this.cursor, this.lookup);
      if (!position) {
        this.ended = "end";
        return { kind: "completed", note: "" };
      }
      const { step, path: tracePath, keyPath } = position;
      const inSequence = this.cursor.frames.length > 0;
      const stepContext = withRepeatVars(this.context, this.cursor);

      const armedWait = armedWaitFor(this.cursor, step, tracePath);
      if (this.cursor.wait && !armedWait) this.cursor = clearWait(this.cursor);

      if (!armedWait) {
        if (this.stepsExecuted >= this.maxStepsPerRun) {
          throw new AbortJourney(`Journey exceeded ${this.maxStepsPerRun} steps in one run`);
        }
        this.stepsExecuted += 1;
      }

      /* containers */
      if (step.type === "choose" || step.type === "repeat") {
        const frame =
          step.type === "choose"
            ? (() => {
                const picked = chooseBranch(step, keyPath, stepContext, this.lookup);
                return picked ? enterChoose(step, picked.option) : null;
              })()
            : enterRepeat(step, keyPath, stepContext, this.lookup);
        this.cursor = frame
          ? pushFrame(this.cursor, frame)
          : advanceCursor({ definition: this.definition, cursor: this.cursor, context: stepContext, lookup: this.lookup });
        continue;
      }

      /* wait_for_trigger */
      if (step.type === "wait_for_trigger") {
        const config = parseWaitForTriggerConfig(step.config);
        const now = new Date(this.now);

        if (!armedWait) {
          const wait = armWaitState(tracePath, config, now);
          this.cursor = { ...cloneCursor(this.cursor), wait };
          this.ran.push(tracePath);
          this.log({
            path: tracePath,
            stepId: step.id,
            stepType: step.type,
            status: "running",
            note: `Waiting for ${config.triggers.join(" or ")}`,
            output: { triggers: config.triggers, until: wait.until, continueOnTimeout: config.continueOnTimeout },
          });
          // The two awaits between the decision and the committed row.
          this.now = new Date(this.now.getTime() + COMMIT_LAG_MS);
          return { kind: "waiting", nextRunAt: waitPollAt(wait, now) };
        }

        const woke = this.findWakeEvent(
          config.triggers,
          new Date(armedWait.since),
          new Date(armedWait.until),
        );
        const decision = decideWait(armedWait, now, woke?.createdAt ?? null);
        if (decision.kind === "keep_waiting") return { kind: "waiting", nextRunAt: decision.nextRunAt };

        const timedOut = decision.kind === "timed_out";
        const wokeBy = timedOut ? null : woke;
        const note = timedOut
          ? `Timed out after ${config.timeoutMinutes} minute(s) waiting for ${config.triggers.join(" or ")}`
          : `Woken by ${wokeBy?.type}`;
        this.log({
          path: tracePath,
          stepId: step.id,
          stepType: step.type,
          status: "completed",
          note,
          output: {
            timedOut,
            waitedMs: waitedMs(armedWait, now),
            triggers: config.triggers,
            event: wokeBy ? { id: wokeBy.id, type: wokeBy.type, at: wokeBy.createdAt.toISOString() } : null,
          },
        });
        if (timedOut && !config.continueOnTimeout) {
          this.ended = "completed";
          this.endNote = note;
          return { kind: "completed", note };
        }
        this.cursor = advanceCursor({
          definition: this.definition,
          cursor: clearWait(this.cursor),
          context: stepContext,
          lookup: this.lookup,
        });
        continue;
      }

      /* variables */
      if (step.type === "variables") {
        const assignments = parseVariablesConfig(step.config);
        const applied = applyJourneyVariables({
          stepId: step.id,
          assignments,
          existing: journeyVars(this.context),
          templateVars: journeyTemplateVars(stepContext as never),
        });
        this.context = withJourneyVars(this.context, applied.vars);
        this.ran.push(tracePath);
        this.log({
          path: tracePath,
          stepId: step.id,
          stepType: step.type,
          status: "completed",
          note: `Set ${assignments.map((assignment) => assignment.name).join(", ")}`,
          output: { variables: applied.vars, truncated: applied.truncated },
        });
        this.cursor = advanceCursor({
          definition: this.definition,
          cursor: this.cursor,
          context: withRepeatVars(this.context, this.cursor),
          lookup: this.lookup,
        });
        continue;
      }

      /* leaf actions */
      this.ran.push(tracePath);
      this.log({ path: tracePath, stepId: step.id, stepType: step.type, status: "running", note: "", output: {} });

      let override: { stepId: string | null } | undefined;
      try {
        if (step.type === "stop") stopStepOutcome(step);
        if (step.type === "condition") {
          override = conditionStepOutcome(step, stepContext, inSequence).branch;
        }
        if (step.type === "send_push") {
          this.sent.push(
            renderTemplate(String(step.config.message ?? ""), journeyTemplateVars(stepContext as never)),
          );
        }
      } catch (error) {
        if (error instanceof StopJourney || error instanceof ConditionFailed) {
          this.ended = "completed";
          this.endNote = error.message;
          return { kind: "completed", note: error.message };
        }
        throw error;
      }
      this.log({ path: tracePath, stepId: step.id, stepType: step.type, status: "completed", note: "", output: {} });

      this.cursor = advanceCursor({
        definition: this.definition,
        cursor: this.cursor,
        context: stepContext,
        lookup: this.lookup,
        ...(override ? { override: override.stepId } : {}),
      });

      // The per-step context refresh. loadJourneyContext returns a FRESH
      // { event, lead, contact } and nothing else — anything not carried
      // explicitly is erased here, which is the whole hazard for variables.
      this.context = withJourneyVars(this.baseContext(), journeyVars(this.context));
    }
    return { kind: "budget" };
  }

  /**
   * Run ticks until the run ends, advancing the clock to each park's nextRunAt —
   * which is what the cron does, and the only way a poll ever happens.
   */
  drain(maxTicks = 200): TickOutcome {
    let last: TickOutcome = { kind: "budget" };
    for (let i = 0; i < maxTicks; i++) {
      last = this.tick();
      if (last.kind !== "waiting") return last;
      this.now = new Date(Math.max(this.now.getTime(), last.nextRunAt.getTime()));
    }
    return last;
  }
}

const push = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "send_push",
  config: { message: id },
  ...extra,
});

/** `nextStepId` is a STEP key, everything else is step config. */
const waitStep = (id: string, extra: Record<string, unknown> = {}) => {
  const { nextStepId = null, ...config } = extra;
  return {
    id,
    type: "wait_for_trigger",
    nextStepId,
    config: { triggers: ["quote_signed"], timeoutMinutes: 60, ...config },
  };
};

/* ══ 1. wait_for_trigger: parking, waking, and the watermark ════════════════ */

test("a wait_for_trigger parks on its own position instead of advancing past it", () => {
  // The `retryStep` trap, restated: a `wait` step SUCCEEDED by pausing, so the
  // run resumes after it. A wait_for_trigger has NOT finished waiting, and
  // advancing would run the next step immediately — which for a "wait until they
  // sign, then chase" journey means chasing a customer who just signed.
  const engine = new Engine({
    startStepId: "hold",
    steps: [waitStep("hold", { nextStepId: "chase" }), push("chase", { nextStepId: null })],
  });

  const first = engine.tick();
  assert.equal(first.kind, "waiting");
  assert.equal(engine.cursor.stepId, "hold", "the cursor must not have moved");
  assert.ok(engine.cursor.wait, "the wait must be armed on the cursor");
  assert.equal(engine.cursor.wait?.path, "hold");
  assert.deepEqual(engine.sent, [], "nothing after the wait may run yet");
});

test("an event of a watched type wakes the run and it continues after the wait", () => {
  const engine = new Engine({
    startStepId: "hold",
    steps: [waitStep("hold", { nextStepId: "chase" }), push("chase", { nextStepId: null })],
  });
  engine.tick();
  engine.emit("quote_signed", new Date(engine.now.getTime() + 1_000));

  const outcome = engine.drain();
  assert.equal(outcome.kind, "completed");
  assert.deepEqual(engine.sent, ["chase"], "the step after the wait must run, exactly once");

  const row = engine.row("hold");
  assert.equal(row.output.timedOut, false);
  assert.equal((row.output.event as { type: string }).type, "quote_signed");
});

test("an event that predates the wait does NOT wake it — the watermark is the arm instant", () => {
  // HA's wait_for_trigger listens from the moment the action is reached. A
  // journey that moves a lead's stage and then waits for `stage_entered` must
  // not be woken by its own preceding move — the engine emits that event itself
  // (journeyStepExecutor's move_stage), so this is a real self-wake, not a
  // hypothetical.
  const engine = new Engine({
    startStepId: "hold",
    steps: [waitStep("hold", { nextStepId: null, timeoutMinutes: 10 })],
  });
  engine.emit("quote_signed", new Date(engine.now.getTime() - 60_000));

  engine.tick();
  const outcome = engine.drain();
  assert.equal(outcome.kind, "completed");
  assert.equal(engine.row("hold").output.timedOut, true, "the stale event must not have woken it");
  assert.equal(engine.row("hold").output.event, null);
});

test("an event landing between the park DECISION and the committed row is not lost", () => {
  // The race the polling design exists to survive. `since` comes from the clock
  // read at the top of the handler, so an event inside the two-await commit
  // window is still `>= since`. Reading the clock at commit time instead would
  // put it behind the watermark and lose it silently for the life of the wait.
  const engine = new Engine({
    startStepId: "hold",
    steps: [waitStep("hold", { nextStepId: "chase" }), push("chase", { nextStepId: null })],
  });
  const decidedAt = new Date(engine.now);
  engine.tick();
  assert.ok(engine.now.getTime() > decidedAt.getTime(), "the commit must lag the decision");

  // Strictly inside the window: after the decision, before the committed row.
  engine.emit("quote_signed", new Date(decidedAt.getTime() + 1));

  engine.drain();
  assert.deepEqual(engine.sent, ["chase"], "an event in the commit window must still wake the run");
  assert.equal(engine.row("hold").output.timedOut, false);
});

test("an event of an unwatched type is ignored", () => {
  const engine = new Engine({
    startStepId: "hold",
    steps: [waitStep("hold", { triggers: ["quote_signed"], timeoutMinutes: 10, nextStepId: null })],
  });
  engine.tick();
  engine.emit("lead_lost", new Date(engine.now.getTime() + 1_000));
  engine.drain();
  assert.equal(engine.row("hold").output.timedOut, true);
});

test("two events in the same tick wake the run ONCE, on the earlier one", () => {
  const engine = new Engine({
    startStepId: "hold",
    steps: [
      waitStep("hold", { triggers: ["quote_signed", "lead_won"], nextStepId: "chase" }),
      push("chase", { nextStepId: null }),
    ],
  });
  engine.tick();
  const base = engine.now.getTime();
  engine.emit("lead_won", new Date(base + 2_000));
  engine.emit("quote_signed", new Date(base + 1_000));

  engine.drain();
  assert.deepEqual(engine.sent, ["chase"], "one wake, not two");
  assert.equal((engine.row("hold").output.event as { type: string }).type, "quote_signed");
});

/* ══ 2. timeout ════════════════════════════════════════════════════════════ */

test("a timeout is distinguishable in the trace from an event that arrived", () => {
  const journey = {
    startStepId: "hold",
    steps: [waitStep("hold", { nextStepId: "chase", timeoutMinutes: 5 }), push("chase", { nextStepId: null })],
  };

  const timedOut = new Engine(journey);
  timedOut.drain();
  const woken = new Engine(journey);
  woken.tick();
  woken.emit("quote_signed", new Date(woken.now.getTime() + 1_000));
  woken.drain();

  // A FIELD, not prose. "Did the thing happen" is the only question this step
  // exists to answer, and both rows are otherwise a completed wait_for_trigger.
  assert.equal(timedOut.row("hold").output.timedOut, true);
  assert.equal(timedOut.row("hold").output.event, null);
  assert.equal(woken.row("hold").output.timedOut, false);
  assert.ok(woken.row("hold").output.event);
  assert.notEqual(timedOut.row("hold").note, woken.row("hold").note);
});

test("continue_on_timeout defaults to true — the sequence carries on", () => {
  const engine = new Engine({
    startStepId: "hold",
    steps: [waitStep("hold", { nextStepId: "chase", timeoutMinutes: 5 }), push("chase", { nextStepId: null })],
  });
  engine.drain();
  assert.deepEqual(engine.sent, ["chase"], "HA's default is to continue past a timeout");
});

test("continue_on_timeout false stops the run, and the trace still says why", () => {
  const engine = new Engine({
    startStepId: "hold",
    steps: [
      waitStep("hold", { nextStepId: "chase", timeoutMinutes: 5, continueOnTimeout: false }),
      push("chase", { nextStepId: null }),
    ],
  });
  const outcome = engine.drain();
  assert.equal(outcome.kind, "completed");
  assert.deepEqual(engine.sent, [], "nothing after the wait may run");
  assert.match(engine.endNote, /Timed out after 5 minute/);
  // The reason this is ended inline rather than by raising StopJourney: that
  // handler rewrites this same path with { stopped: true, reason: "stop" } and
  // would erase the one field the step had to record.
  assert.equal(engine.row("hold").output.timedOut, true);
});

/**
 * Arms a five-minute wait, then hands back the run parked at 09:00 with its
 * deadline, so a test can plant an event and choose when the cron shows up.
 */
function parkedWait(extra: Record<string, unknown> = {}, opts = {}) {
  const engine = new Engine(
    {
      startStepId: "hold",
      steps: [
        waitStep("hold", { nextStepId: "chase", timeoutMinutes: 5, ...extra }),
        push("chase", { nextStepId: null }),
      ],
    },
    opts,
  );
  engine.tick();
  const wait = engine.cursor.wait;
  assert.ok(wait, "the wait must be armed before the clock is moved");
  return { engine, until: Date.parse(wait.until) };
}

test("a delayed cron does not resume a wait on an event from outside its window", () => {
  // THE FIX, end to end. The wait expired at 09:05. The event lands at 09:20 —
  // after the author's window closed — and the cron does not get round to this
  // run until 10:35. The run must take the TIMEOUT branch: the event is late,
  // the engine is late, and neither makes the other one on time.
  const { engine, until } = parkedWait();
  engine.emit("quote_signed", new Date(until + 15 * 60_000));
  engine.now = new Date(until + 90 * 60_000);

  const outcome = engine.tick();
  assert.equal(outcome.kind, "completed");
  assert.equal(engine.row("hold").output.timedOut, true, "an event outside the window is not a wake");
  assert.equal(engine.row("hold").output.event, null, "and the trace must not name it as one");
  assert.match(engine.row("hold").note, /Timed out after 5 minute/);
  assert.deepEqual(engine.sent, ["chase"], "continue_on_timeout defaults to true, so the run carries on");
});

test("a timeout that genuinely passed still stops a continue_on_timeout: false run", () => {
  // The branch with consequences. If the out-of-window event were allowed to
  // win, this run would carry on past a point the author explicitly said to
  // give up at — the failure is a message sent to someone who never replied.
  //
  // Run with the wake query bounded and unbounded, because each way exercises a
  // different one of the two enforcement points and both must hold alone.
  for (const unboundedWakeQuery of [false, true]) {
    const { engine, until } = parkedWait({ continueOnTimeout: false }, { unboundedWakeQuery });
    engine.emit("quote_signed", new Date(until + 15 * 60_000));
    engine.now = new Date(until + 90 * 60_000);

    const outcome = engine.tick();
    assert.equal(outcome.kind, "completed");
    assert.deepEqual(engine.sent, [], `nothing after the wait may run (unbounded=${unboundedWakeQuery})`);
    assert.match(engine.endNote, /Timed out after 5 minute/);
    assert.equal(engine.row("hold").output.timedOut, true);
  }
});

test("a late cron still resumes on an event that DID arrive inside the window", () => {
  // The other half, and the reason the timeout is not simply checked first. The
  // engine being 90 minutes late must not lose an event that arrived a minute
  // into a five-minute wait.
  const { engine, until } = parkedWait();
  engine.emit("quote_signed", new Date(until - 4 * 60_000));
  engine.now = new Date(until + 90 * 60_000);

  engine.tick();
  assert.equal(engine.row("hold").output.timedOut, false, "the thing happened; the engine was merely slow");
  assert.ok(engine.row("hold").output.event, "and the trace names the event that woke it");
  assert.match(engine.row("hold").note, /Woken by quote_signed/);
  assert.deepEqual(engine.sent, ["chase"]);
});

test("the decision refuses a late event even if the wake query stops bounding one", () => {
  // Second line of defence, exercised on its own. The query is bounded, so
  // `decideWait` never normally sees an out-of-window event — this drives the
  // runner with the lookup the bug was filed against (`createdAt >= since` and
  // nothing else) and asserts the outcome is unchanged.
  const { engine, until } = parkedWait({}, { unboundedWakeQuery: true });
  engine.emit("quote_signed", new Date(until + 15 * 60_000));
  engine.now = new Date(until + 90 * 60_000);

  engine.tick();
  assert.equal(engine.row("hold").output.timedOut, true, "the window is enforced by the decision too");
  assert.equal(engine.row("hold").output.event, null);
});

const ARMED_AT = new Date("2026-08-03T09:00:00.000Z");
/** A five-minute wait armed at 09:00 — so `until` is 09:05:00.000. */
const armedFiveMinutes = () =>
  armWaitState(
    "hold",
    { triggers: ["quote_signed"], timeoutMinutes: 5, continueOnTimeout: true },
    ARMED_AT,
  );

test("an event found on a LATE tick beats an already-expired deadline", () => {
  // The poll runs on a cron. A busy queue or a deploy can put the tick after
  // `until`, and an event that genuinely arrived inside the window must not be
  // thrown away because the engine was not punctual.
  const armed = armedFiveMinutes();
  const late = new Date("2026-08-03T11:00:00.000Z");
  const inWindow = new Date("2026-08-03T09:02:00.000Z");
  assert.deepEqual(decideWait(armed, late, inWindow), { kind: "woken" });
  assert.deepEqual(decideWait(armed, late, null), { kind: "timed_out" });
});

test("an event that arrived AFTER the window does not beat the timeout", () => {
  // THE FIX. Tolerating a late tick is not the same as extending the wait by
  // however late the tick was. A wait armed at 09:00 for five minutes expired at
  // 09:05; a cron that limps in at 11:00 and finds an event stamped 10:20 must
  // still report the timeout, because 10:20 is not inside the window the author
  // configured. Otherwise the run's outcome depends on scheduler jitter — the
  // exact thing letting an event beat the deadline was meant to protect against.
  const armed = armedFiveMinutes();
  const late = new Date("2026-08-03T11:00:00.000Z");
  const afterWindow = new Date("2026-08-03T10:20:00.000Z");
  assert.deepEqual(decideWait(armed, late, afterWindow), { kind: "timed_out" });
});

test("the wait window is half-open: [since, until)", () => {
  const armed = armedFiveMinutes();
  const since = Date.parse(armed.since);
  const until = Date.parse(armed.until);
  const late = new Date(until + 60 * 60_000);

  // `since` INCLUSIVE. An event written in the same millisecond the wait armed
  // arrived while we were listening — the whole reason the watermark is taken
  // before the park commits — and losing it would be silent.
  assert.deepEqual(decideWait(armed, late, new Date(since)), { kind: "woken" });
  assert.deepEqual(decideWait(armed, late, new Date(since - 1)), { kind: "timed_out" });

  // `until` EXCLUSIVE, because `until` is already the first instant of "timed
  // out": decideWait gives up at now >= until. An inclusive upper bound would
  // put that one millisecond in both outcomes at once and make every wait
  // timeoutMinutes plus 1ms long.
  assert.deepEqual(decideWait(armed, late, new Date(until - 1)), { kind: "woken" });
  assert.deepEqual(decideWait(armed, late, new Date(until)), { kind: "timed_out" });
  assert.deepEqual(decideWait(armedFiveMinutes(), new Date(until), null), { kind: "timed_out" });

  // And the two ends agree with each other: nothing is both in-window and
  // past-deadline at the same instant.
  assert.equal(
    isInWaitWindow(armed, new Date(until)),
    false,
    "the instant the wait gives up cannot also be an instant it was still listening",
  );
});

test("a still-open wait with a stray out-of-window event keeps waiting", () => {
  // The out-of-window event must not short-circuit anything. Before the deadline
  // the only right answer is still "keep waiting" — not "woken", and not an
  // early timeout either.
  const armed = armedFiveMinutes();
  const midWait = new Date(Date.parse(armed.since) + 60_000);
  const decision = decideWait(armed, midWait, new Date(Date.parse(armed.until) + 60_000));
  assert.equal(decision.kind, "keep_waiting");
});

test("a poll never sleeps past the deadline it is racing", () => {
  const now = new Date("2026-08-03T09:00:00.000Z");
  const wait = armWaitState("hold", { triggers: ["lead_won"], timeoutMinutes: 10, continueOnTimeout: true }, now);

  // Mid-wait: a whole interval, because the deadline is further away than that.
  assert.equal(waitPollAt(wait, now).getTime(), now.getTime() + WAIT_POLL_INTERVAL_MS);

  // The LAST poll has to land ON the deadline. Sleeping a full interval from
  // here would overshoot it, and the timeout would be reported up to a minute
  // late — which for a `continue_on_timeout: false` wait means the run stays
  // open past the point the author said to give up.
  const nearEnd = new Date(Date.parse(wait.until) - 15_000);
  assert.equal(waitPollAt(wait, nearEnd).toISOString(), wait.until);
  assert.ok(waitPollAt(wait, nearEnd).getTime() < nearEnd.getTime() + WAIT_POLL_INTERVAL_MS);
});

/* ══ 3. waiting INSIDE a repeat — the frame question ════════════════════════ */

const chaseLoop = {
  startStepId: "loop",
  steps: [
    {
      id: "loop",
      type: "repeat",
      nextStepId: "done",
      config: {
        mode: "count",
        count: 2,
        sequence: [
          waitStep("hold", { timeoutMinutes: 60 }),
          push("nudge"),
        ],
      },
    },
    push("done", { nextStepId: null }),
  ],
};

test("a wait inside a repeat resumes at the exact FRAME, not a top-level step id", () => {
  const engine = new Engine(chaseLoop);
  engine.tick();
  assert.equal(engine.cursor.wait?.path, "loop/repeat/0/sequence/0", "armed on the frame path");
  assert.equal(engine.cursor.frames.length, 1);

  engine.emit("quote_signed", new Date(engine.now.getTime() + 1_000));
  // Everything in memory thrown away — a different cron process, three days on.
  engine.reload();
  engine.tick();

  assert.deepEqual(engine.sent, ["nudge"], "it resumed on the NEXT step of the SAME iteration");
  assert.equal(engine.row("loop/repeat/0/sequence/0").output.timedOut, false);
});

test("each iteration arms its OWN wait — iteration 1 is not woken by iteration 0's event", () => {
  // The trap the wait is keyed on the trace path to avoid. Keyed by step id,
  // iteration 1 would inherit iteration 0's watermark and be woken instantly by
  // the event that already resolved iteration 0 — a "chase them twice" journey
  // would fire both chases the moment the first reply landed.
  const engine = new Engine(chaseLoop);
  engine.tick();
  const firstEventAt = new Date(engine.now.getTime() + 1_000);
  engine.emit("quote_signed", firstEventAt);
  engine.now = new Date(firstEventAt.getTime() + 1_000);

  // Iteration 0 wakes, sends, and iteration 1 arms a NEW wait.
  const second = engine.tick();
  assert.equal(second.kind, "waiting");
  assert.deepEqual(engine.sent, ["nudge"]);
  assert.equal(engine.cursor.wait?.path, "loop/repeat/1/sequence/0", "a fresh wait, on a fresh path");
  assert.ok(
    Date.parse(engine.cursor.wait!.since) > firstEventAt.getTime(),
    "and a fresh watermark — iteration 0's event is already behind it",
  );

  // Drain with no further event: iteration 1 must TIME OUT, not re-use the one
  // that woke iteration 0.
  engine.drain();
  assert.deepEqual(engine.sent, ["nudge", "nudge", "done"]);
  assert.equal(engine.row("loop/repeat/0/sequence/0").output.timedOut, false, "iteration 0 was woken");
  assert.equal(engine.row("loop/repeat/1/sequence/0").output.timedOut, true, "iteration 1 timed out");
});

test("the two iterations' waits are separate rows in the trace", () => {
  const engine = new Engine(chaseLoop);
  engine.drain();
  assert.notEqual(
    engine.row("loop/repeat/0/sequence/0").startedAt.getTime(),
    engine.row("loop/repeat/1/sequence/0").startedAt.getTime(),
  );
});

test("a wait armed at a DIFFERENT position is dropped, not inherited", () => {
  // A wait belongs to ONE position, named by its trace path. Honouring one
  // armed elsewhere — a hand-edited cursor, or a definition changed under a
  // parked run — means arriving at a wait that believes it has been listening
  // since before it was reached, and waking on an event it never waited for.
  const engine = new Engine({
    startStepId: "hold",
    steps: [waitStep("hold", { nextStepId: null, timeoutMinutes: 10 })],
  });
  const stale = new Date(engine.now.getTime() - 3_600_000);
  engine.cursor = {
    ...engine.cursor,
    wait: { path: "some/other/position", since: stale.toISOString(), until: stale.toISOString() },
  };
  // An event from half an hour ago: after the STALE watermark, well before this
  // position was ever reached.
  engine.emit("quote_signed", new Date(engine.now.getTime() - 1_800_000));

  const outcome = engine.tick();
  assert.equal(outcome.kind, "waiting", "it must arm a FRESH wait, not resolve the stale one");
  assert.equal(engine.cursor.wait?.path, "hold");
  assert.ok(
    Date.parse(engine.cursor.wait!.since) > Date.parse(stale.toISOString()),
    "…with a watermark that starts here, leaving the old event behind it",
  );
});

test("a stale wait on a step that is not a wait at all is dropped", () => {
  const engine = new Engine({
    startStepId: "first",
    steps: [push("first", { nextStepId: null })],
  });
  engine.cursor = {
    ...engine.cursor,
    wait: { path: "first", since: engine.now.toISOString(), until: engine.now.toISOString() },
  };
  engine.tick();
  assert.equal(engine.cursor.wait, undefined, "the stale wait must be gone");
  assert.deepEqual(engine.sent, ["first"]);
});

/* ══ 4. what a wait costs the run ══════════════════════════════════════════ */

test("polling does not spend the LIFETIME step budget", () => {
  // Charging a poll would give the step a second, invisible ceiling — "500
  // engine ticks" rather than its own timeout — and a long wait would then abort
  // with a step-budget message naming nothing the author wrote.
  const engine = new Engine(
    { startStepId: "hold", steps: [waitStep("hold", { timeoutMinutes: 600, nextStepId: null })] },
    { maxStepsPerRun: 3 },
  );
  engine.tick();
  assert.equal(engine.stepsExecuted, 1, "arming costs one step");
  for (let i = 0; i < 20; i++) {
    engine.now = new Date(engine.now.getTime() + WAIT_POLL_INTERVAL_MS);
    engine.tick();
  }
  assert.equal(engine.stepsExecuted, 1, "…and twenty polls cost nothing");
});

test("the trace reports the whole wait, not the last poll interval", () => {
  // updateStepLog resets startedAt on a "running" upsert — correct for a
  // top-level back-edge — so rewriting the row on every poll would report a
  // three-day wait as sixty seconds.
  const engine = new Engine({
    startStepId: "hold",
    steps: [waitStep("hold", { timeoutMinutes: 10, nextStepId: null })],
  });
  const armedAt = new Date(engine.now);
  engine.drain();
  const row = engine.row("hold");
  assert.equal(row.startedAt.getTime(), armedAt.getTime(), "startedAt must be the ARM, not the last poll");
  assert.ok(
    row.completedAt!.getTime() - row.startedAt.getTime() >= 10 * 60_000,
    "the recorded duration must be the whole wait",
  );
  assert.ok((row.output.waitedMs as number) >= 10 * 60_000);
});

/* ══ 5. wait_for_trigger config, refused at save time ══════════════════════ */

test("wait_for_trigger config is validated at save time", () => {
  // A trigger nobody emits is a wait that can only ever time out — the same trap
  // journeyTrace.ts's `everSeen: false` exists to surface, and it is far cheaper
  // to refuse at save time than to explain a month later.
  const build = (config: Record<string, unknown>) =>
    parseJourneyDefinition({
      startStepId: "hold",
      steps: [{ id: "hold", type: "wait_for_trigger", nextStepId: null, config }],
    });

  assert.doesNotThrow(() => build({ triggers: ["quote_signed"], timeoutMinutes: 60 }));
  assert.throws(() => build({ timeoutMinutes: 60 }), /at least one trigger/);
  assert.throws(() => build({ triggers: [], timeoutMinutes: 60 }), /at least one trigger/);
  // Not an event type at all.
  assert.throws(() => build({ triggers: ["customer_thinks_about_it"], timeoutMinutes: 60 }), /nothing emits it/);
  // A SCHEDULED trigger: the cron enrols on it by sweeping records and writes no
  // JourneyEvent, so a waiter could never see one.
  assert.throws(() => build({ triggers: ["lead_idle"], timeoutMinutes: 60 }), /nothing emits it/);
  assert.throws(
    () => build({ triggers: Array.from({ length: JOURNEY_LIMITS.waitTriggers + 1 }, () => "lead_won"), timeoutMinutes: 60 }),
    new RegExp(`at most ${JOURNEY_LIMITS.waitTriggers} triggers`),
  );
  assert.throws(() => build({ triggers: ["lead_won", "lead_won"], timeoutMinutes: 60 }), /same trigger twice/);
});

test("a timeout is REQUIRED and capped — 'wait forever' is not expressible", () => {
  // HA lets the timeout be omitted because its script is a live object you can
  // see and cancel. Ours is a database row that would poll on every engine tick
  // until somebody noticed.
  const build = (config: Record<string, unknown>) =>
    parseJourneyDefinition({
      startStepId: "hold",
      steps: [{ id: "hold", type: "wait_for_trigger", nextStepId: null, config }],
    });
  assert.throws(() => build({ triggers: ["lead_won"] }), /timeoutMinutes between 1 and/);
  assert.throws(() => build({ triggers: ["lead_won"], timeoutMinutes: 0 }), /timeoutMinutes between 1 and/);
  assert.throws(() => build({ triggers: ["lead_won"], timeoutMinutes: 1.5 }), /timeoutMinutes between 1 and/);
  assert.throws(
    () => build({ triggers: ["lead_won"], timeoutMinutes: WAIT_TIMEOUT_MAX_MINUTES + 1 }),
    /timeoutMinutes between 1 and/,
  );
  assert.equal(WAIT_TIMEOUT_MAX_MINUTES, JOURNEY_LIMITS.waitDays * 24 * 60);
});

test("continueOnTimeout is true unless it is explicitly false", () => {
  const base = { triggers: ["lead_won"], timeoutMinutes: 5 };
  assert.equal(parseWaitForTriggerConfig(base).continueOnTimeout, true);
  assert.equal(parseWaitForTriggerConfig({ ...base, continueOnTimeout: false }).continueOnTimeout, false);
  // Anything that is not literally false gets the documented default, so a
  // config written before the flag existed behaves as HA does.
  assert.equal(parseWaitForTriggerConfig({ ...base, continueOnTimeout: "no" }).continueOnTimeout, true);
});

/* ══ 6. the persisted wait survives JSON, and degrades safely ══════════════ */

test("an armed wait round-trips through the cursor column", () => {
  const cursor: JourneyCursor = {
    stepId: "loop",
    frames: [{ kind: "repeat", step: "loop", iteration: 1, index: 0 }],
    wait: { path: "loop/repeat/1/sequence/0", since: "2026-08-03T09:00:00.000Z", until: "2026-08-03T10:00:00.000Z" },
  };
  const restored = parseCursor(JSON.parse(JSON.stringify(cursor)), cursor.stepId);
  assert.deepEqual(restored, cursor);
  // cloneCursor must CARRY it: a clone that quietly dropped the wait would make
  // "the wait is cleared" an invisible side effect of moving.
  assert.deepEqual(cloneCursor(cursor).wait, cursor.wait);
  assert.equal(clearWait(cursor).wait, undefined);
  assert.deepEqual(clearWait(cursor).frames, cursor.frames);
});

test("a corrupt wait drops the WAIT, never the cursor", () => {
  // Degrading the whole cursor to flat would restart an enclosing loop from the
  // top; re-arming the wait costs one poll interval.
  const frames = [{ kind: "repeat", step: "loop", iteration: 2, index: 1 }];
  for (const wait of [
    { path: "", since: "2026-08-03T09:00:00.000Z", until: "2026-08-03T10:00:00.000Z" },
    { path: "x", since: "not a date", until: "2026-08-03T10:00:00.000Z" },
    { path: "x", since: "2026-08-03T09:00:00.000Z", until: null },
    "nope",
  ]) {
    const restored = parseCursor({ stepId: "loop", frames, wait }, "loop");
    assert.equal(restored.wait, undefined, `wait ${JSON.stringify(wait)} must be dropped`);
    assert.deepEqual(restored.frames, frames, "…and the frames must survive");
  }
});

/* ══ 7. variables ══════════════════════════════════════════════════════════ */

test("a variable set by one step is readable by a later step's template", () => {
  const engine = new Engine({
    startStepId: "set",
    steps: [
      { id: "set", type: "variables", nextStepId: "shout", config: { set: { greeting: "Hi {{first_name}}" } } },
      push("shout", { nextStepId: null, config: { message: "{{var_greeting}}!" } }),
    ],
  });
  engine.drain();
  assert.deepEqual(engine.sent, ["Hi Ada!"]);
});

test("variables survive the per-step context refresh", () => {
  // loadJourneyContext returns { event, lead, contact } and the runner replaces
  // the whole context with it after EVERY leaf step. Without an explicit carry,
  // a variable would be erased by the very next step — silently, with the
  // template just rendering blank.
  const engine = new Engine({
    startStepId: "set",
    steps: [
      { id: "set", type: "variables", nextStepId: "one", config: { set: { tag: "vip" } } },
      push("one", { nextStepId: "two", config: { message: "1:{{var_tag}}" } }),
      push("two", { nextStepId: "three", config: { message: "2:{{var_tag}}" } }),
      push("three", { nextStepId: null, config: { message: "3:{{var_tag}}" } }),
    ],
  });
  engine.drain();
  assert.deepEqual(engine.sent, ["1:vip", "2:vip", "3:vip"], "three refreshes later, still there");
  assert.deepEqual(engine.context.vars, { tag: "vip" });
});

test("a variable is usable as a `vars.` condition field", () => {
  const engine = new Engine({
    startStepId: "set",
    steps: [
      { id: "set", type: "variables", nextStepId: "gate", config: { set: { tier: "gold" } } },
      {
        id: "gate",
        type: "condition",
        nextStepId: null,
        config: {
          condition: { logic: "and", conditions: [{ field: "vars.tier", operator: "equals", value: "gold" }] },
          trueStepId: "yes",
          falseStepId: "no",
        },
      },
      push("yes", { nextStepId: null }),
      push("no", { nextStepId: null }),
    ],
  });
  engine.drain();
  assert.deepEqual(engine.sent, ["yes"]);
});

test("a variable CANNOT shadow an engine context key", () => {
  // The namespace is the guarantee. A variable named `contact` becomes
  // `vars.contact`, and `contact.firstName` still reads the record.
  const engine = new Engine({
    startStepId: "set",
    steps: [
      { id: "set", type: "variables", nextStepId: "shout", config: { set: { contact: "IMPOSTOR", repeat: "IMPOSTOR" } } },
      push("shout", { nextStepId: null, config: { message: "{{first_name}}/{{var_contact}}" } }),
    ],
  });
  engine.drain();
  assert.deepEqual(engine.sent, ["Ada/IMPOSTOR"], "the record wins; the variable is reachable under its own name");
  assert.equal((engine.context.contact as { firstName: string }).firstName, "Ada");
  assert.deepEqual(engine.context.vars, { contact: "IMPOSTOR", repeat: "IMPOSTOR" });

  // And a condition on `contact.source` still reads the contact record, not the
  // variable that tried to take its name.
  const group = parseConditionGroup({
    logic: "and",
    conditions: [{ field: "contact.source", operator: "equals", value: "referral" }],
  });
  assert.equal(evaluateConditions(group, engine.context), true);
});

test("a later variables step merges over the earlier one", () => {
  const engine = new Engine({
    startStepId: "a",
    steps: [
      { id: "a", type: "variables", nextStepId: "b", config: { set: { one: "1", both: "old" } } },
      { id: "b", type: "variables", nextStepId: "shout", config: { set: { two: "2", both: "new" } } },
      push("shout", { nextStepId: null, config: { message: "{{var_one}}{{var_two}}{{var_both}}" } }),
    ],
  });
  engine.drain();
  assert.deepEqual(engine.sent, ["12new"]);
});

test("variables render against the loop variables the step can see", () => {
  const engine = new Engine({
    startStepId: "loop",
    steps: [{
      id: "loop",
      type: "repeat",
      nextStepId: null,
      config: {
        mode: "for_each",
        itemsPath: "contact.tags",
        sequence: [
          { id: "set", type: "variables", config: { set: { current: "{{repeat_item}}" } } },
          push("shout", { config: { message: "tag={{var_current}}" } }),
        ],
      },
    }],
  });
  engine.drain();
  assert.deepEqual(engine.sent, ["tag=a", "tag=b"]);
});

test("the trace records what was set, and names anything truncated", () => {
  const engine = new Engine({
    startStepId: "set",
    steps: [{ id: "set", type: "variables", nextStepId: null, config: { set: { small: "ok" } } }],
  });
  engine.drain();
  const row = engine.row("set");
  assert.deepEqual(row.output.variables, { small: "ok" });
  assert.deepEqual(row.output.truncated, []);
});

/* ══ 8. variables: the bounds ══════════════════════════════════════════════ */

test("variable names are refused at save time when they could not be addressed", () => {
  const build = (set: unknown) =>
    parseJourneyDefinition({
      startStepId: "set",
      steps: [{ id: "set", type: "variables", nextStepId: null, config: { set } }],
    });

  assert.doesNotThrow(() => build({ ok_name1: "x" }));
  assert.throws(() => build({}), /at least one variable/);
  assert.throws(() => build(undefined), /needs a `set` map/);
  assert.throws(() => build([["a", "b"]]), /needs a `set` map/);
  // A dotted name would be unreachable as `vars.<name>` and unrenderable as
  // `{{var_<name>}}` — renderTemplate's token cannot contain a dot.
  assert.throws(() => build({ "a.b": "x" }), /Unsafe variable name/);
  // JSON.parse — not an object literal, where `__proto__:` sets the prototype
  // instead of a key. A definition arrives as JSON, so this is the real shape.
  assert.throws(() => build(JSON.parse('{"__proto__":"x"}')), /Unsafe variable name/);
  assert.throws(() => build({ "1st": "x" }), /Unsafe variable name/);
  assert.throws(() => build({ "": "x" }), /Unsafe variable name/);
  assert.throws(() => build({ ok: 42 }), /must be a template string/);
  assert.throws(
    () => build(Object.fromEntries(Array.from({ length: JOURNEY_LIMITS.variables + 1 }, (_, i) => [`v${i}`, "x"]))),
    new RegExp(`at most ${JOURNEY_LIMITS.variables} variables`),
  );
  assert.throws(
    () => build({ big: "x".repeat(JOURNEY_LIMITS.variableChars + 1) }),
    new RegExp(`longer than ${JOURNEY_LIMITS.variableChars} characters`),
  );
});

test("a rendered value over the per-value cap is truncated AND reported", () => {
  const applied = applyJourneyVariables({
    stepId: "set",
    assignments: [{ name: "blurb", template: "{{note}}" }],
    existing: {},
    templateVars: { note: "x".repeat(JOURNEY_LIMITS.variableChars + 50) },
  });
  assert.equal(applied.vars.blurb.length, JOURNEY_LIMITS.variableChars);
  assert.deepEqual(applied.truncated, ["blurb"], "a value cut in half must never be silent");
});

test("the whole bag is capped, because every step re-writes it", () => {
  // The context is persisted as JSON after every step, so an unbounded bag
  // inflates every write for the remaining life of a run that may last weeks.
  const filler = "y".repeat(JOURNEY_LIMITS.variableChars);
  const assignments = Array.from({ length: JOURNEY_LIMITS.variables }, (_, i) => ({
    name: `v${i}`,
    template: filler,
  }));
  assert.throws(
    () => applyJourneyVariables({ stepId: "fat", assignments, existing: {}, templateVars: {} }),
    (error: unknown) =>
      // AbortJourney, not a plain Error: the same templates render the same size
      // next time, so three retries fail three times and spend the budget.
      error instanceof AbortJourney &&
      new RegExp(`over the ${JOURNEY_LIMITS.variableBytes} byte limit`).test((error as Error).message),
  );

  // The bag ACCUMULATES across steps, so the cap has to be re-checked each time
  // rather than only within one step.
  const half = Array.from({ length: 4 }, (_, i) => ({ name: `a${i}`, template: filler }));
  const first = applyJourneyVariables({ stepId: "one", assignments: half, existing: {}, templateVars: {} });
  assert.throws(
    () =>
      applyJourneyVariables({
        stepId: "two",
        assignments: half.map((a) => ({ ...a, name: `b${a.name}` })),
        existing: first.vars,
        templateVars: {},
      }),
    AbortJourney,
  );
});

test("`vars.<name>` is the ONLY field the closed condition list is opened for", () => {
  const field = (name: string) =>
    parseConditionGroup({ logic: "and", conditions: [{ field: name, operator: "equals", value: "x" }] });

  assert.doesNotThrow(() => field("vars.tier"));
  assert.doesNotThrow(() => field("lead.source"));
  // A typo must still be a typo, not "probably a variable".
  assert.throws(() => field("lead.sorce"), /Unsupported condition field/);
  assert.throws(() => field("vars"), /Unsupported condition field/);
  assert.throws(() => field("vars."), /Unsupported condition field/);
  assert.throws(() => field("vars.a.b"), /Unsupported condition field/);
  assert.throws(() => field("vars.__proto__"), /Unsupported condition field/);
  assert.throws(() => field("user.passwordHash"), /Unsupported condition field/);
});

test("the bag reader ignores anything that is not a string", () => {
  // A hand-edited run must not crash a tick, and a non-string value would break
  // both the template substitution and the byte accounting.
  assert.deepEqual(journeyVars({ vars: { a: "1", b: 2, c: null, d: { e: 1 } } }), { a: "1" });
  assert.deepEqual(journeyVars({ vars: "nope" }), {});
  assert.deepEqual(journeyVars({}), {});
  assert.deepEqual(variableTemplateVars({ a: "1" }), { var_a: "1" });
});

test("an empty bag leaves the context byte-for-byte as it was", () => {
  // A journey with no variables step must not start writing a new key.
  const context = { event: {}, lead: null, contact: null };
  assert.equal(withJourneyVars(context, {}), context);
  assert.deepEqual(withJourneyVars(context, { a: "1" }), { ...context, vars: { a: "1" } });
});

/* ══ 9. routing: the runner owns both, the executor refuses both ═══════════ */

test("both new steps are runner-owned, and reaching the executor is a routing bug", () => {
  // Behavioural cover cannot reach this: journeyStepExecutor imports the mail
  // provider and `server-only`. What matters is that the fallthrough is a THROW
  // and not the "Unknown step" skip at the bottom of the switch — a `variables`
  // step that quietly skipped would leave every later template rendering blank
  // with nothing on screen to explain it.
  const executor = shipped("src/lib/journeyStepExecutor.ts");
  const switchAt = executor.indexOf("switch (step.type)");
  assert.ok(switchAt > 0, "the executor's switch must exist");
  const throwAt = executor.indexOf("reached the action executor", switchAt);
  assert.ok(throwAt > switchAt, "the routing-bug throw must exist");
  const guard = executor.slice(switchAt, throwAt);
  assert.ok(guard.length > 0);
  for (const type of ["choose", "repeat", "wait_for_trigger", "variables"]) {
    assert.match(guard, new RegExp(`case "${type}":`), `${type} must fall into the routing-bug throw`);
  }
});

test("the wait handler reads the clock ONCE, before it writes anything", () => {
  // The behavioural test above proves the watermark semantics against the
  // model; this pins the real runner, because the model is only faithful if the
  // clock is genuinely read before the two awaits and not again inside them.
  const runner = shipped("src/lib/journeyRuns.ts");
  const waitAt = runner.indexOf('if (step.type === "wait_for_trigger") {');
  assert.ok(waitAt > 0, "the wait handler must exist");
  const endAt = runner.indexOf('if (step.type === "variables") {', waitAt);
  assert.ok(endAt > waitAt, "the variables handler must follow it");
  const handler = runner.slice(waitAt, endAt);
  assert.ok(handler.length > 0);

  assert.equal(
    (handler.match(/new Date\(\)/g) ?? []).length,
    1,
    "exactly one clock read — a second one inside the commit would move the watermark",
  );
  const nowAt = handler.indexOf("const now = new Date();");
  const armAt = handler.indexOf("armWaitState(");
  const logAt = handler.indexOf("await updateStepLog(");
  const parkAt = handler.indexOf("await parkWaiting(");
  assert.ok(nowAt > 0 && armAt > nowAt, "the watermark must come from the clock read at the top");
  assert.ok(logAt > armAt && parkAt > logAt, "…and both writes must happen after it");

  // The park must NOT advance the cursor. This is the retryStep lesson: a
  // wait_for_trigger has not finished waiting, and advancing would run the next
  // step immediately — and inside a container an override cannot undo it.
  assert.ok(
    handler.indexOf("advanceCursor(") > handler.lastIndexOf("await parkWaiting("),
    "the only advance in the wait handler must come after every park, on resolution",
  );
  assert.match(
    handler,
    /cursor: clearWait\(this\.cursor\)|cursor: clearWait\(cursor\)/,
    "resolving a wait must clear it, or the next iteration inherits this watermark",
  );
});

test("the wake query is not gated on the event's processing status", () => {
  // An event is a fact the moment the row exists. Requiring "processed" would
  // make a wake depend on a DIFFERENT cron having run first; requiring "pending"
  // would miss every event it had already drained.
  const runner = shipped("src/lib/journeyRuns.ts");
  const fnAt = runner.indexOf("async function findWakeEvent(");
  assert.ok(fnAt > 0, "the wake query must exist");
  const endAt = runner.indexOf("\n}", fnAt);
  assert.ok(endAt > fnAt);
  const query = runner.slice(fnAt, endAt);
  assert.ok(query.length > 0);
  assert.doesNotMatch(query, /status:/, "the waiter must not care whether the event has been drained");
  assert.match(query, /orderBy: \[\{ createdAt: "asc" \}, \{ id: "asc" \}\]/, "two events in a tick need a tie-break");
});

test("the wake query is bounded at BOTH ends of the wait window", () => {
  // The behavioural tests above drive a model of the runner's loop, and a model
  // can only mirror a query it is told about. This pins the real one.
  //
  // A lower bound alone lets a late tick pull back an event created after the
  // window closed — the poll runs on a cron, so "the tick is hours after
  // `until`" is ordinary, not exotic.
  const runner = shipped("src/lib/journeyRuns.ts");
  const fnAt = runner.indexOf("async function findWakeEvent(");
  assert.ok(fnAt > 0, "the wake query must exist");
  const endAt = runner.indexOf("\n}", fnAt);
  assert.ok(endAt > fnAt, "…and the slice must run forwards");
  const query = runner.slice(fnAt, endAt);
  assert.ok(query.length > 0);

  assert.match(
    query,
    /createdAt: \{ gte: since, lt: until \}/,
    "half-open [since, until): gt would lose an event written in the arming millisecond, " +
      "and no upper bound at all lets a late tick wake on an event from outside the window",
  );
  // The bound is only worth anything if the deadline actually reaches the query.
  assert.match(
    runner,
    /findWakeEvent\(\s*run,\s*config\.triggers,\s*new Date\(armedWait\.since\),\s*new Date\(armedWait\.until\),?\s*\)/,
    "the runner must pass the armed wait's own deadline, not re-derive one",
  );
  // And the decision must be given the event's TIME, not a boolean — a boolean
  // cannot tell "an event was found" from "an event was found in time".
  assert.match(
    runner,
    /decideWait\(armedWait, now, woke\?\.createdAt \?\? null\)/,
    "decideWait needs the timestamp to apply the window itself",
  );
  // The logged event follows the DECISION. Unreachable while the query is
  // bounded — which is why it is pinned here rather than asserted behaviourally:
  // the only way to observe it is to lose the bound, and then the trace would
  // say "timed out" while naming the event that supposedly woke the run.
  assert.match(
    runner,
    /const wokeBy = timedOut \? null : woke;/,
    "the trace's event field must come from the decision, not straight from the query",
  );
  assert.doesNotMatch(
    runner.slice(runner.indexOf("const wokeBy = timedOut")),
    /event: woke \?/,
    "…and the step log must use it",
  );
});

test("the runner carries the variables bag across its context refresh", () => {
  // The behavioural test above drives a model of the loop; this pins the real
  // runner, because the model is only faithful if the carry is actually there.
  // A bare `context = refreshed` erases every variable on the very next step.
  const runner = shipped("src/lib/journeyRuns.ts");
  const refreshAt = runner.indexOf("const refreshed = await loadJourneyContext(");
  assert.ok(refreshAt > 0, "the per-step context refresh must exist");
  const endAt = runner.indexOf("await persistPosition(", refreshAt);
  assert.ok(endAt > refreshAt, "…and be followed by the persist");
  const slice = runner.slice(refreshAt, endAt);
  assert.ok(slice.length > 0);
  assert.match(
    slice,
    /if \(refreshed\) context = withJourneyVars\(refreshed, journeyVars\(context\)\);/,
    "loadJourneyContext returns only { event, lead, contact } — the bag has to be carried",
  );
});

test("the poll index exists, and is not created CONCURRENTLY", () => {
  // Without it the poll is a sequential scan of every event ever recorded, once
  // per waiting run per tick. CONCURRENTLY cannot be used: Prisma wraps a
  // migration in a transaction and it fails outright rather than degrading.
  const schema = shipped("prisma/journeys.prisma");
  assert.match(schema, /@@index\(\[entityType, entityId, type, createdAt\]\)/);
  // The SQL only — the comment above the statement explains why CONCURRENTLY is
  // not used, and a raw scan would match its own explanation.
  const migration = src("prisma/migrations/20260803120000_journey_wait_for_trigger/migration.sql")
    .replace(/^\s*--.*$/gm, "")
    .trim();
  assert.ok(migration.length > 0, "the migration must contain SQL, not only comments");
  assert.match(migration, /CREATE INDEX IF NOT EXISTS "JourneyEvent_entityType_entityId_type_createdAt_idx"/);
  assert.doesNotMatch(migration, /CONCURRENTLY/i);
  // Ordering: it must sort after the migration that added the cursor it uses.
  assert.ok("20260803120000_journey_wait_for_trigger" > "20260803090000_journey_nested_flow");
});

test("the builder cannot silently destroy either new step type", () => {
  // Neither has a visual editor. A wait's `triggers` array and a variables
  // step's `set` map are structured config this form has no widget for, and
  // dropping either on save is silent damage with no error and no undo.
  const builder = shipped("src/components/JourneyBuilder.tsx");
  assert.match(
    builder,
    /READ_ONLY_STEP_TYPES = new Set\(\["choose", "repeat", "wait_for_trigger", "variables"\]\)/,
  );
  // The label map was hoisted out of this component into journeyTypes.ts, so
  // the builder and the activity trace cannot call the same step type two
  // different things. The requirement is unchanged — both new types must have a
  // human name — it just lives in the shared map now, which is typed
  // Record<JourneyStepType, string> so a new type without a name will not
  // compile.
  assert.match(builder, /stepLabels: Record<string, string> = JOURNEY_STEP_LABELS/, "one label map, not two");
  const labels = shipped("src/lib/journeyTypes.ts");
  assert.match(labels, /wait_for_trigger: "Wait for an event"/, "…and the type must be selectable-by-name");
  assert.match(labels, /variables: "Set variables"/);
});
