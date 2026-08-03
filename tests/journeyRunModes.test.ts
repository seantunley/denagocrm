import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  MAX_OPEN_RUNS_PER_ENTITY,
  OPEN_RUN_STATUSES,
  enrolmentLockKey,
  parseRunMode,
} from "../src/lib/journeyArbitration";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const shipped = (rel: string) =>
  src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * Run modes decide what a SECOND live enrolment means for one person on one
 * journey. Every one of them is a read-then-write, and every one of them loses
 * a race differently — so the guards here are mostly about atomicity, not about
 * the mode logic, which is the easy half.
 */

/* ── the lock ────────────────────────────────────────────────────────────── */

test("the lock key is per (journey, entity) and stable across processes", () => {
  // Two workers must derive the SAME key for the same person, or the lock
  // serialises nothing. And different people must not contend, or one busy lead
  // stalls enrolment for everybody on that journey.
  const a = enrolmentLockKey("journey-1", "lead", "lead-1");
  assert.equal(a, enrolmentLockKey("journey-1", "lead", "lead-1"), "not deterministic");
  assert.notEqual(a, enrolmentLockKey("journey-2", "lead", "lead-1"), "journeys must not share a key");
  assert.notEqual(a, enrolmentLockKey("journey-1", "lead", "lead-2"), "people must not share a key");
  assert.notEqual(a, enrolmentLockKey("journey-1", "contact", "lead-1"), "entity type is part of identity");
});

test("the lock key always fits a signed bigint", () => {
  // pg_advisory_xact_lock takes int8. A key built from the full 64 bits of a
  // hash overflows for half of all inputs, and the failure is a runtime error
  // on some leads and not others — the worst kind to reproduce.
  // BigInt(...) rather than 0n/63n literals: this repo's tsconfig target is
  // below ES2020, where BigInt literals are a compile error.
  const zero = BigInt(0);
  const max = BigInt(2) ** BigInt(63) - BigInt(1);
  for (let i = 0; i < 500; i++) {
    const key = enrolmentLockKey(`j${i}`, "lead", `lead-${i}`);
    assert.ok(key >= zero && key <= max, `key out of range for lead-${i}: ${key}`);
  }
});

test("arbitration and creation happen in ONE transaction, under the lock", () => {
  // THE BLOCKER. Read-then-write across two statements lets concurrent
  // enrolments start two runs on `single`, exceed the cap, double a `restart`
  // replacement, or release several `queued` runs together. An event burst on
  // one lead is the ordinary case, not an exotic one.
  const shared = shipped("src/lib/journeyEngineShared.ts");
  // `return await`, not a bare `return`: the call is wrapped in a try/catch for
  // the P2002 backstop, and a bare return would settle the promise outside the
  // catch — so the backstop would never see the rejection it exists for.
  assert.match(
    shared,
    /return await withEnrolmentLock\([\s\S]*?arbitrateEnrolment\(tx,[\s\S]*?tx\.journeyRun\.create\(/,
    "arbitration and creation must be inside one withEnrolmentLock callback",
  );
  const arb = shipped("src/lib/journeyArbitration.ts");
  assert.match(arb, /pg_advisory_xact_lock/, "serialisation must use an advisory lock");
  // Transaction-scoped, so there is no unlock path to forget on an error.
  assert.ok(
    !/pg_advisory_lock\b/.test(arb),
    "a session-scoped lock leaks when the transaction aborts — use the _xact_ form",
  );
});

test("the lock transaction runs on basePrisma, and pays the tenant cost explicitly", () => {
  // Not a style choice. The exported `prisma` wraps every model op in its OWN
  // array transaction against the TOP-LEVEL client, so inside
  // prisma.$transaction(async tx => …) the model ops escape to a different
  // pooled connection — the advisory lock would guard nothing and the reads
  // would sit outside the transaction. lib/db.ts records this as a defect it
  // already had to fix once.
  //
  // basePrisma bypasses the tenant extension, so every query under the lock has
  // to carry the predicate by hand or it reads across tenants.
  const arb = shipped("src/lib/journeyArbitration.ts");
  assert.match(arb, /basePrisma\.\$transaction/, "must use basePrisma for a real transaction");
  assert.ok(!/\bprisma\.\$transaction/.test(arb), "the extended client cannot hold this transaction");
  const arbitrate = arb.slice(arb.indexOf("export async function arbitrateEnrolment"));
  assert.match(arbitrate, /activeTenantPredicate\(/, "bypassing the extension means scoping by hand");
  const queries = (arbitrate.match(/tx\.journeyRun\.(findMany|updateMany|count)/g) ?? []).length;
  const scoped = (arbitrate.match(/\.\.\.tenant[,\s]/g) ?? []).length;
  assert.ok(queries > 0, "arbitration no longer queries runs — has it been rewritten?");
  assert.equal(scoped, queries, `${queries} queries but ${scoped} carry the tenant predicate`);
});

/* ── the modes ───────────────────────────────────────────────────────────── */

test("an unknown or missing run mode reads as `single`", () => {
  // The safe default: dropping a duplicate enrolment is recoverable, sending a
  // second sequence to a customer is not.
  for (const value of [undefined, null, "", "SINGLE", "nonsense", 7, {}]) {
    assert.equal(parseRunMode(value), "single", `${JSON.stringify(value)} must fall back to single`);
  }
  for (const value of ["restart", "queued", "parallel", "single"]) {
    assert.equal(parseRunMode(value), value);
  }
});

test("restart retires EVERY open run, not just the newest", () => {
  // Cancelling only the newest leaves the older ones running beside the
  // replacement — the opposite of what the mode promises. Several open runs are
  // reachable through a journey that ran as `parallel` before its mode changed.
  const arb = shipped("src/lib/journeyArbitration.ts");
  const restart = arb.slice(arb.indexOf("if (mode === \"queued\")"));
  assert.match(
    restart,
    /id: \{ in: openRuns\.map\(\(run\) => run\.id\) \}/,
    "restart must cancel all open runs, not openRuns[0]",
  );
  assert.ok(
    !/id: open\.id, status/.test(restart),
    "cancelling a single run leaves the others live",
  );
});

test("the cap applies to every mode, including parallel", () => {
  // parallel piles up fastest precisely because it never consults open runs.
  const arb = shipped("src/lib/journeyArbitration.ts");
  const body = arb.slice(arb.indexOf("export async function arbitrateEnrolment"));
  const capCheck = body.indexOf("MAX_OPEN_RUNS_PER_ENTITY");
  const parallelExit = body.indexOf('mode === "parallel"');
  assert.ok(capCheck !== -1 && parallelExit !== -1);
  assert.ok(capCheck < parallelExit, "the cap must be checked BEFORE parallel returns early");
  assert.equal(MAX_OPEN_RUNS_PER_ENTITY, 10, "HA's default `max`; changing it is a product decision");
});

test("blocked counts as open, or the cap and `single` both leak", () => {
  // A run parked behind a predecessor has not finished. Leaving it out of the
  // open set would let `single` start a second run beside a queued one, and
  // would let the cap admit an unbounded parked backlog.
  for (const status of ["queued", "running", "waiting", "blocked"]) {
    assert.ok(OPEN_RUN_STATUSES.includes(status), `${status} must count as open`);
  }
  for (const status of ["completed", "failed", "cancelled"]) {
    assert.ok(!OPEN_RUN_STATUSES.includes(status), `${status} is closed and must not block`);
  }
});

/* ── the worker cannot resurrect a run ───────────────────────────────────── */

test("a cancelled run cannot be written back to life by its own worker", () => {
  // THE OTHER HALF OF THE BLOCKER. The claim takes the run to `running`, and
  // that is the worker's entire title to it. Every later write was an
  // unconditional update({ where: { id } }), so a run cancelled mid-flight by
  // `restart` finished its steps and wrote `completed` over `cancelled` — while
  // the replacement was already sending. The customer got both sequences and
  // the trace showed two completed runs.
  const runs = shipped("src/lib/journeyRuns.ts");
  const loop = runs.slice(
    runs.indexOf("export async function processOneRun"),
    runs.indexOf("export async function processJourneyRuns"),
  );
  assert.ok(loop.length > 0, "the slice ran backwards");
  assert.match(
    loop,
    /const stillOurs = async[\s\S]*?updateMany\(\{[\s\S]*?where: \{ id: run\.id, status: "running" \}/,
    "writes must be conditional on the run still being ours",
  );
  assert.ok(
    !/prisma\.journeyRun\.update\(\{/.test(loop),
    "an unconditional update in the worker loop is how a cancelled run comes back",
  );
});

test("the worker checks ownership BEFORE it sends, not only before it writes", () => {
  // An unsent message is recoverable; a sent one is not. The check that matters
  // is the one in front of executeJourneyStep.
  const runs = shipped("src/lib/journeyRuns.ts");
  const check = runs.indexOf('journeyRun.count({ where: { id: run.id, status: "running" } })');
  const execute = runs.indexOf("await executeJourneyStep({");
  assert.notEqual(check, -1, "the pre-send ownership check is gone");
  assert.ok(check < execute, "the ownership check must come before the step executes");
});

test("retry cannot resurrect a run its journey has already replaced", () => {
  // `restart` cancels the open run; the cancelled row then sits in the list
  // with a Retry button, and pressing it put the superseded sequence back in
  // the queue beside its replacement — two live sequences on the mode whose
  // entire purpose is preventing that.
  const action = shipped("src/app/actions/journeyRuns.ts");
  const retry = action.slice(action.indexOf("export async function retryJourneyRun"));
  assert.match(retry, /parseRunMode\(run\.journey\.runMode\)/);
  assert.match(retry, /mode !== "parallel"/, "parallel is the one mode where a second run is fine");
  assert.match(retry, /status: \{ in: OPEN_RUN_STATUSES \}/, "…and it must actually look for open runs");
  assert.match(retry, /superseded/i, "the refusal has to say why, or it reads as a broken button");
});

/* ── queued releases one at a time ───────────────────────────────────────── */

test("releasing queued runs hands back ONE per person, not the whole queue", () => {
  // Three runs queued behind one predecessor all become eligible the moment it
  // closes. Releasing them together starts three at once — a queue that
  // delivers in parallel, which is the one thing the mode promises not to do.
  const runs = shipped("src/lib/journeyRuns.ts");
  const release = runs.slice(
    runs.indexOf("export async function releaseBlockedJourneyRuns"),
    runs.indexOf("export async function recoverStaleJourneyRuns"),
  );
  assert.ok(release.length > 0, "the slice ran backwards");
  assert.match(release, /const releasedFor = new Set<string>\(\)/, "one release per lane per sweep");
  assert.match(release, /if \(releasedFor\.has\(lane\)\) continue;/);
  assert.match(release, /withEnrolmentLock\(/, "and it must take the same lock enrolment takes");
  assert.match(
    release,
    /status: \{ in: \["queued", "running", "waiting"\] \}/,
    "re-check open runs inside the lock — an enrolment can land between the read and the write",
  );
  assert.match(release, /orderBy: \{ createdAt: "asc" \}/, "a queue drains in the order it formed");
});

/* ── a duplicate must not abort the transaction ──────────────────────────── */

test("a duplicate enrolment is CHECKED, not caught inside the transaction", () => {
  // Postgres marks a transaction aborted the moment a statement fails, so
  // catching P2002 from the insert and returning normally does not work: every
  // later statement errors with "current transaction is aborted" and the COMMIT
  // fails too. The handler would report `duplicate_event` and then the commit
  // would throw on the way out — turning an ordinary repeat event into a failed
  // one, and (because the event processor retries) into three of them.
  //
  // The read is safe here where it would not be outside the lock: the advisory
  // lock serialises every enrolment for this (journey, entity), and the same
  // event on the same person always hashes to the same key.
  const shared = shipped("src/lib/journeyEngineShared.ts");
  const start = shared.indexOf("return await withEnrolmentLock");
  assert.notEqual(start, -1, "the lock call is gone — was it renamed?");
  const inside = shared.slice(start, shared.indexOf("  } catch (error) {", start));
  assert.ok(inside.length > 0, "the slice ran backwards");

  assert.match(
    inside,
    /findUnique\(\{\s*where: \{ idempotencyKey \}/,
    "the duplicate must be found by a read before the insert",
  );
  const check = inside.indexOf("idempotencyKey }");
  const insert = inside.indexOf("tx.journeyRun.create(");
  assert.ok(check !== -1 && insert !== -1 && check < insert, "the check must precede the insert");
  assert.ok(
    !/P2002/.test(inside),
    "catching P2002 INSIDE the transaction leaves it aborted — the commit still fails",
  );
  // The backstop belongs outside, where the transaction has already rolled back.
  const outside = shared.slice(shared.indexOf("  } catch (error) {", start));
  assert.match(outside, /error\.code === "P2002"/, "keep a backstop, but outside the transaction");
});

test("a failure after enrolment does not erase the runs already created", () => {
  // Runs are committed one at a time as the loop goes; the event row is only
  // updated at the end. So a failure after some journeys have enrolled — the
  // final update, or anything else late — used to discard every decision made
  // so far and return one "it failed" placeholder. The manual test run then had
  // no runId, reported that nothing happened, and the run it had ALREADY
  // created went on to execute and send.
  //
  // "Nothing was sent" while a live run sends is the worst answer this can give.
  const events = shipped("src/lib/journeyEvents.ts");
  const fn = events.slice(events.indexOf("async function processOneEvent"));
  assert.ok(fn.length > 0, "the slice ran backwards");

  // The array must be declared OUTSIDE the try, or the catch cannot see it.
  const declared = fn.indexOf("const decisions: JourneyEnrolmentDecision[] = []");
  const tryAt = fn.indexOf("try {");
  assert.notEqual(declared, -1, "the decisions array is gone — was it renamed?");
  assert.ok(declared < tryAt, "decisions must be declared before the try, or the catch loses them");

  const cat = fn.slice(fn.indexOf("} catch (error) {"));
  assert.match(cat, /decisions\.push\(/, "the failure is APPENDED to the decisions");
  assert.match(cat, /return \{ enrolled, decisions \}/, "…and the accumulated ones are returned");
  assert.ok(
    !/decisions: \[\{/.test(cat),
    "returning a fresh single-element array is what threw the committed runs away",
  );
});

test("a manual run acts on the run it created, by id", () => {
  // "The newest run for this journey and lead" is not the same thing. A
  // concurrent enrolment can be newer — and under run mode `parallel` a second
  // run is perfectly legal — so pressing "test" could report on, and drive, a
  // run somebody else's event had just created.
  const action = shipped("src/app/actions/journeyRuns.ts");
  const manual = action.slice(
    action.indexOf("export async function runJourneyOnLead"),
    action.indexOf("async function activeTriggerFor"),
  );
  assert.ok(manual.length > 0, "the slice ran backwards");
  assert.match(manual, /findUnique\(\{ where: \{ id: mine\.runId \}/, "the run must be fetched by its own id");
  assert.ok(
    !/orderBy: \{ createdAt: "desc" \}/.test(manual),
    "picking the newest run is the race this replaced",
  );
  // …and the id has to survive the trip through the decision record.
  assert.match(
    shipped("src/lib/journeyEvents.ts"),
    /\.\.\.\(outcome\.enrolled \? \{ runId: outcome\.runId \} : \{\}\)/,
    "the created runId must be carried on the decision",
  );
});

/* ── one bad definition must not stop the tick ───────────────────────────── */

test("an unreadable definition fails ITS run, not the whole tick", () => {
  // The run is claimed as "running" before the definition is parsed, and the
  // parse used to sit outside the try. A throw escaped processOneRun →
  // processJourneyRuns → runJourneyEngine, so one journey with a hand-edited
  // definition (unknown step type, duplicate id) aborted the entire tenant
  // tick: every run behind it stopped, and this one sat claimed as "running"
  // until the 15-minute stale sweep, then did it again.
  const runs = shipped("src/lib/journeyRuns.ts");
  const start = runs.indexOf("function processOneRun");
  assert.notEqual(start, -1, "processOneRun is gone — was it renamed?");
  const end = runs.indexOf("function processJourneyRuns", start);
  assert.notEqual(end, -1, "processJourneyRuns is gone — was it renamed?");
  const body = runs.slice(start, end);
  assert.ok(body.length > 0, "the slice ran backwards");

  // No closing paren: the nested-flow engine passes `{ deep: false }` here, and
  // an anchor that assumed a single argument silently matched nothing.
  const parse = body.indexOf("parseJourneyDefinition(run.journeyVersion.definition");
  const guard = body.indexOf("try {");
  assert.notEqual(parse, -1, "the definition parse is gone — was it renamed?");
  assert.ok(guard !== -1 && guard < parse, "the parse must be inside a try, not before one");
  // Failed, not retried: an unparseable definition is deterministic, and
  // retrying only holds the run open while producing the same answer.
  assert.match(
    body.slice(parse),
    /status: "failed",[\s\S]*?Definition could not be read/,
    "a parse failure must fail this run with a reason, not retry it",
  );
});

/* ── manual run targets its own work ─────────────────────────────────────── */

test("a manual test run drives ONLY its own event and run", () => {
  // Pressing "test" called processJourneyEvents(100) and processJourneyRuns(50)
  // — workspace-wide. So testing one journey against one lead really sent up to
  // fifty unrelated customers' messages. And when the backlog was larger than
  // those limits, the test's own run could still be pending while the action
  // reported success.
  const action = shipped("src/app/actions/journeyRuns.ts");
  const manual = action.slice(
    action.indexOf("export async function runJourneyOnLead"),
    action.indexOf("async function activeTriggerFor"),
  );
  assert.ok(manual.length > 0, "the slice ran backwards");
  assert.match(manual, /processJourneyEventById\(event\.id\)/, "process THIS event, by id");
  assert.match(manual, /processOneRun\(run\.id\)/, "and THIS run, by id");
  assert.ok(!/processJourneyEvents\(/.test(manual), "the workspace-wide event drain must be gone");
  assert.ok(!/processJourneyRuns\(/.test(manual), "the workspace-wide run drain must be gone");
});

test("a manual run reports what actually happened, not just 'ok'", () => {
  // "Ran" with nothing sent and no reason is the failure this whole trace
  // effort exists to stop.
  const action = shipped("src/app/actions/journeyRuns.ts");
  const manual = action.slice(
    action.indexOf("export async function runJourneyOnLead"),
    action.indexOf("async function activeTriggerFor"),
  );
  assert.match(manual, /if \(!mine\?\.enrolled\)/, "a refusal must be reported as a refusal");
  assert.match(manual, /Not enrolled: \$\{mine\?\.reason/, "…and must carry the reason through");
  assert.match(manual, /status: after\?\.status/, "the final run status is the point of a test run");
});

test("a manual run does not force a queued run past its predecessor", () => {
  // A run parked as `blocked` is waiting on purpose. Driving it here would
  // defeat the mode the operator chose, in the one place they are most likely
  // to be checking whether that mode works.
  const action = shipped("src/app/actions/journeyRuns.ts");
  assert.match(action, /if \(run\.status !== "blocked"\) await processOneRun\(run\.id\)/);
});
