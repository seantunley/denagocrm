import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  JOURNEY_TRIGGER_LABELS,
  decideTrigger,
  describeTriggers,
  isScheduledTrigger,
  parseJourneyTriggers,
  readJourneyTriggers,
  triggerKeySuffix,
  triggerMatches,
  type JourneyTriggerSpec,
} from "../src/lib/journeyTriggers";
import { CONDITION_FIELDS, JOURNEY_LIMITS, JOURNEY_TRIGGERS } from "../src/lib/journeyTypes";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const shipped = (rel: string) =>
  src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const MIGRATION = "prisma/migrations/20260805120000_journey_multiple_triggers/migration.sql";

/**
 * A published journey version listens for SEVERAL triggers instead of one.
 *
 * The risk this file exists for is not that the new shape fails to work — it is
 * that it works while quietly changing what an EXISTING journey does. Every
 * live version was migrated from one `trigger` string and one shared
 * `triggerConfig`, and a version that used to enrol on lead_created must still
 * enrol on lead_created and on nothing else. So the first section below is not
 * about multiple triggers at all: it is an equivalence proof against the rule
 * this replaced.
 */

/* ── the matcher this replaced, restated ─────────────────────────────────── */

/**
 * THE OLD RULE, as it shipped: one string compared for equality, plus one
 * stage filter that preferred the stage recorded on the event.
 *
 * Kept here deliberately rather than described in prose. "Behaves identically
 * after the backfill" is only a claim you can check if the thing it must be
 * identical TO is executable.
 */
function legacyEnrols(
  trigger: string,
  triggerConfig: Record<string, unknown> | null,
  eventType: string,
  context: { lead?: Record<string, unknown> | null } | null,
  payload: Record<string, unknown>,
): boolean {
  if (trigger !== eventType) return false;
  if (!context) return false;
  if (trigger === "stage_entered") {
    const config = triggerConfig ?? {};
    const lead = (context.lead ?? {}) as Record<string, unknown>;
    const entered = typeof payload.stageId === "string" ? payload.stageId : lead.stageId;
    return !config.stageId || config.stageId === entered;
  }
  return true;
}

/** The SQL backfill's transformation, in TypeScript: one row → one-element list. */
function backfill(trigger: string, triggerConfig: Record<string, unknown> | null): unknown {
  return [{ type: trigger, config: triggerConfig ?? {} }];
}

const LEAD = { lead: { id: "lead_1", stageId: "stage_quoted" } };

/**
 * Every combination worth checking, as (stored row) × (arriving event).
 *
 * Deliberately includes a row whose trigger this engine does not know: the
 * retirement of the previous automations engine left unpublished drafts holding
 * the original rule's trigger name, and those rows are read by the same code.
 */
const LEGACY_ROWS: Array<{ trigger: string; config: Record<string, unknown> | null }> = [
  { trigger: "lead_created", config: null },
  { trigger: "lead_created", config: {} },
  { trigger: "lead_won", config: {} },
  { trigger: "stage_entered", config: {} },
  { trigger: "stage_entered", config: { stageId: "stage_quoted" } },
  { trigger: "stage_entered", config: { stageId: "stage_won" } },
  { trigger: "lead_idle", config: { idleDays: 4 } },
  { trigger: "win_back", config: { inactiveMonths: 12 } },
  { trigger: "some_retired_rule_trigger", config: null },
];

const EVENTS: Array<{ type: string; payload: Record<string, unknown> }> = [
  { type: "lead_created", payload: {} },
  { type: "lead_won", payload: {} },
  { type: "stage_entered", payload: { stageId: "stage_quoted" } },
  { type: "stage_entered", payload: { stageId: "stage_won" } },
  { type: "stage_entered", payload: {} },
  { type: "lead_idle", payload: { idleDays: 4 } },
  { type: "win_back", payload: {} },
  { type: "quote_signed", payload: {} },
  { type: "some_retired_rule_trigger", payload: {} },
];

test("a backfilled single-trigger version enrols exactly who it used to", () => {
  for (const row of LEGACY_ROWS) {
    const specs = readJourneyTriggers(backfill(row.trigger, row.config));
    for (const event of EVENTS) {
      const before = legacyEnrols(row.trigger, row.config, event.type, LEAD, event.payload);
      const after = Boolean(decideTrigger(specs, event.type, LEAD, event.payload).matched);
      assert.equal(
        after,
        before,
        `"${row.trigger}" ${JSON.stringify(row.config)} changed its answer to ${event.type} ${JSON.stringify(event.payload)}: ${before} → ${after}`,
      );
    }
  }
});

test("the backfill carries the trigger's own filter across, not just its name", () => {
  // The half of losslessness the equality check above cannot see on its own: a
  // stage_entered journey that dropped its stageId would start enrolling on
  // EVERY stage rather than none, which reads as working.
  const specs = readJourneyTriggers(backfill("stage_entered", { stageId: "stage_won" }));
  assert.deepEqual(specs, [{ type: "stage_entered", config: { stageId: "stage_won" } }]);
  assert.equal(decideTrigger(specs, "stage_entered", LEAD, { stageId: "stage_won" }).matched?.type, "stage_entered");
  assert.equal(decideTrigger(specs, "stage_entered", LEAD, { stageId: "stage_quoted" }).matched, null);
});

test("a backfilled trigger is UNNAMED, so scheduled dedupe keys do not move", () => {
  // The one way this migration could quietly re-mail a whole customer base. The
  // scheduler's dedupe key is what stops an anniversary journey greeting the
  // same person twice, and appending anything to it would make every already-
  // emitted key look new on the first tick after deploy.
  const [spec] = readJourneyTriggers(backfill("purchase_anniversary", {}));
  assert.equal(spec.id, undefined, "the backfill must not invent an id");
  assert.equal(triggerKeySuffix(spec), "", "an unnamed trigger contributes nothing to the key");
  assert.equal(triggerKeySuffix({ ...spec, id: "yearly" }), ":yearly");
});

/* ── several triggers ────────────────────────────────────────────────────── */

test("an event matching none of the triggers is refused, and the refusal names them", () => {
  const specs = parseJourneyTriggers([
    { type: "lead_created" },
    { type: "lead_won" },
  ]);
  const verdict = decideTrigger(specs, "quote_signed", LEAD, {});
  assert.equal(verdict.matched, null);
  assert.ok(!verdict.matched && verdict.reason.includes("quote_signed"), "the reason must name the event that arrived");
  assert.ok(!verdict.matched && verdict.reason.includes("lead_created"), "…and what the journey does listen for");
  assert.ok(!verdict.matched && verdict.reason.includes("lead_won"), "…all of it, not just the first");
});

test("a version listening for nothing says so rather than reading as a filter miss", () => {
  // "listens for nothing" and "listens, but the filter said no" are different
  // problems with different fixes, and only one of them is the author's.
  const verdict = decideTrigger([], "lead_created", LEAD, {});
  assert.equal(verdict.matched, null);
  assert.ok(!verdict.matched && /listens for nothing/.test(verdict.reason));
  assert.equal(describeTriggers([]), "nothing");
});

test("the two refusals stay apart: wrong type versus the trigger's own filter", () => {
  const specs = parseJourneyTriggers([{ type: "stage_entered", config: { stageId: "stage_won" } }]);
  const wrongType = decideTrigger(specs, "lead_created", LEAD, {});
  const wrongStage = decideTrigger(specs, "stage_entered", LEAD, { stageId: "stage_quoted" });
  assert.ok(!wrongType.matched && !wrongStage.matched);
  assert.notEqual(
    (wrongType as { reason: string }).reason,
    (wrongStage as { reason: string }).reason,
    "collapsing these is the defect the enrolment trace exists to prevent",
  );
  assert.match((wrongStage as { reason: string }).reason, /trigger filters did not match/);
});

test("an event matching SEVERAL of a version's triggers yields ONE trigger, not one per match", () => {
  // Enrolling per match would create a second run — or, once the idempotency key
  // caught it, a phantom "already enrolled" refusal sitting in the trace beside
  // the real enrolment, which reads as the engine double-firing.
  const specs = parseJourneyTriggers([
    // Both admit the same event: the first is qualified by a stage the lead is
    // actually in, the second is a catch-all for the same type.
    { id: "quoted", type: "stage_entered", config: { stageId: "stage_quoted" } },
    { id: "any", type: "stage_entered", config: {} },
  ]);
  const verdict = decideTrigger(specs, "stage_entered", LEAD, { stageId: "stage_quoted" });
  assert.ok(verdict.matched, "one of them must match");
  assert.equal(verdict.matched?.id, "quoted", "and it is the first one the author listed");
  // The shape of the verdict is the guarantee: ONE spec, not a list the caller
  // could iterate into two enrolments.
  assert.ok(!Array.isArray(verdict.matched));
});

test("enqueueJourneyRun is called once per journey, not once per matching trigger", () => {
  // The structural half of the guarantee above: decideTrigger can only return
  // one trigger, and the enrolment loop must not have grown a loop of its own
  // around the call.
  const code = shipped("src/lib/journeyEvents.ts");
  const start = code.indexOf("for (const journey of journeys)");
  assert.notEqual(start, -1, "the enrolment loop is gone — was it renamed?");
  const loop = code.slice(start, code.indexOf("journeyEvent.update(", start));
  assert.equal(
    (loop.match(/enqueueJourneyRun\(/g) ?? []).length,
    1,
    "more than one enrolment call in the journey loop",
  );
  assert.equal(
    (loop.match(/\bfor\s*\(/g) ?? []).length,
    1,
    "a nested loop inside the journey loop would enrol once per trigger",
  );
});

test("an event may name the trigger it was raised for, and only its own version's", () => {
  const specs = parseJourneyTriggers([
    { id: "quick", type: "lead_idle", config: { idleDays: 3 } },
    { id: "slow", type: "lead_idle", config: { idleDays: 30 } },
  ]);
  // Without this the second sweep's events would be attributed to the first
  // trigger, so one of the two configurations could never be the reason anybody
  // was enrolled.
  assert.equal(decideTrigger(specs, "lead_idle", LEAD, { triggerId: "slow" }).matched?.id, "slow");
  assert.equal(decideTrigger(specs, "lead_idle", LEAD, { triggerId: "quick" }).matched?.id, "quick");
  // A name this version does not have is ignored, not treated as a miss — it
  // came from somewhere else and must not be able to suppress a real match.
  assert.equal(decideTrigger(specs, "lead_idle", LEAD, { triggerId: "elsewhere" }).matched?.id, "quick");
});

test("which trigger fired is answerable from a condition", () => {
  // Two different TYPES are already separable by `event.type`. `event.triggerId`
  // is what separates two triggers of the SAME type — which is exactly what
  // per-trigger config makes worth having, and the only reason the id exists.
  assert.ok((CONDITION_FIELDS as readonly string[]).includes("event.type"));
  assert.ok((CONDITION_FIELDS as readonly string[]).includes("event.triggerId"));

  const events = shipped("src/lib/journeyEvents.ts");
  assert.match(
    events,
    /triggerId: verdict\.matched\.id/,
    "the matched trigger's id must reach the run context, or the condition field is unreadable",
  );
  assert.match(
    events,
    /verdict\.matched\.id\s*\n?\s*\?/,
    "…and only when the author named one — an invented id is a value a condition could match by accident",
  );
});

/* ── what the author is allowed to save ──────────────────────────────────── */

test("a journey must listen for at least one thing", () => {
  assert.throws(() => parseJourneyTriggers([]), /at least one enrolment trigger/);
  assert.throws(() => parseJourneyTriggers(null), /at least one enrolment trigger/);
});

test("the trigger list is capped", () => {
  const many = Array.from({ length: JOURNEY_LIMITS.triggers + 1 }, (_, i) => ({
    id: `t${i}`,
    type: "lead_created",
  }));
  assert.throws(() => parseJourneyTriggers(many), new RegExp(`at most ${JOURNEY_LIMITS.triggers}`));
});

test("an unknown trigger is refused at save time", () => {
  assert.throws(() => parseJourneyTriggers([{ type: "not_a_trigger" }]), /Unsupported journey trigger/);
  assert.throws(() => parseJourneyTriggers([{}]), /Unsupported journey trigger/);
});

test("two triggers of the same type must each be named", () => {
  // Unnamed they are indistinguishable to event.triggerId, indistinguishable in
  // the trace, and — the one that silently loses work — indistinguishable in the
  // scheduler's dedupe key, where the second one's enrolments would collide with
  // the first's and never be emitted at all.
  assert.throws(
    () => parseJourneyTriggers([{ type: "stage_entered" }, { type: "stage_entered" }]),
    /more than once, so each one needs its own ID/,
  );
  assert.doesNotThrow(() =>
    parseJourneyTriggers([
      { id: "a", type: "stage_entered", config: { stageId: "s1" } },
      { id: "b", type: "stage_entered", config: { stageId: "s2" } },
    ]),
  );
  // Different types need no ids at all — event.type already tells them apart.
  assert.doesNotThrow(() => parseJourneyTriggers([{ type: "lead_created" }, { type: "lead_won" }]));
});

test("two triggers may not share an ID", () => {
  assert.throws(
    () => parseJourneyTriggers([{ id: "x", type: "lead_created" }, { id: "x", type: "lead_won" }]),
    /share an ID/,
  );
});

test("an ID has to be safe to put in a dedupe key and a condition value", () => {
  assert.throws(() => parseJourneyTriggers([{ id: "has spaces", type: "lead_created" }]), /Unsafe trigger ID/);
  assert.throws(() => parseJourneyTriggers([{ id: "a:b", type: "lead_created" }]), /Unsafe trigger ID/);
  assert.deepEqual(parseJourneyTriggers([{ id: "won-2026_q1", type: "lead_won" }])[0].id, "won-2026_q1");
});

test("each trigger keeps its OWN config", () => {
  // The reason config is per-trigger and not one shared bag: every key it holds
  // qualifies exactly one trigger type, so one bag cannot hold two stageIds —
  // and "entered Quoted OR entered Won" is the first thing anyone wants here.
  const specs = parseJourneyTriggers([
    { id: "quoted", type: "stage_entered", config: { stageId: "stage_quoted" } },
    { id: "won", type: "stage_entered", config: { stageId: "stage_won" } },
  ]);
  assert.deepEqual(specs.map((spec) => spec.config.stageId), ["stage_quoted", "stage_won"]);
  assert.equal(decideTrigger(specs, "stage_entered", LEAD, { stageId: "stage_won" }).matched?.id, "won");
  assert.equal(decideTrigger(specs, "stage_entered", LEAD, { stageId: "stage_quoted" }).matched?.id, "quoted");
  assert.equal(decideTrigger(specs, "stage_entered", LEAD, { stageId: "stage_lost" }).matched, null);
});

/* ── reading what is stored ──────────────────────────────────────────────── */

test("the reader never throws on a stored row, however odd", () => {
  // It runs inside the loop that decides enrolment for EVERY active journey on
  // one event. One unreadable version throwing there fails the event, retries it
  // twice and then strands it — taking every unrelated journey with it.
  for (const stored of [null, undefined, {}, "lead_created", 7, [null], [7], [{}], [{ type: 3 }]]) {
    assert.doesNotThrow(() => readJourneyTriggers(stored), `threw on ${JSON.stringify(stored)}`);
  }
  assert.deepEqual(readJourneyTriggers([{ type: "" }, { type: "lead_won" }]), [
    { type: "lead_won", config: {} },
  ]);
});

test("a trigger name this engine never had matches nothing, exactly as it used to", () => {
  // The converted-rule drafts. The strict parser refuses them, which is right
  // for a save; the reader keeps them verbatim, which is what the single-string
  // comparison did with the same value.
  const specs = readJourneyTriggers([{ type: "some_retired_rule_trigger", config: {} }]);
  assert.equal(specs[0].type, "some_retired_rule_trigger");
  assert.equal(decideTrigger(specs, "lead_created", LEAD, {}).matched, null);
  assert.throws(() => parseJourneyTriggers([{ type: "some_retired_rule_trigger" }]));
});

test("a missing entity never matches, whatever the trigger says", () => {
  const spec: JourneyTriggerSpec = { type: "lead_created", config: {} };
  assert.equal(triggerMatches(spec, null, {}), false);
  assert.equal(decideTrigger([spec], "lead_created", null, {}).matched, null);
});

test("the scheduled half of the trigger list is what the cron sweeps", () => {
  assert.ok(isScheduledTrigger("lead_idle"));
  assert.ok(isScheduledTrigger("win_back"));
  assert.ok(!isScheduledTrigger("lead_created"));
  const scheduler = shipped("src/lib/journeyScheduling.ts");
  assert.match(
    scheduler,
    /for \(const spec of readJourneyTriggers\(version\.triggers\)\)/,
    "the sweep must run for EVERY scheduled trigger the version lists, not the first",
  );
});

/* ── the schema and the migration ────────────────────────────────────────── */

test("the expand phase keeps both representations, and nothing READS the old pair", () => {
  // This started life asserting the old columns were GONE. They are not, and
  // deliberately so: vercel.json runs `apply-migrations && next build`, so the
  // schema changes while the PREVIOUS deployment is still serving production —
  // and that build reads `trigger`/`triggerConfig`. Dropping them in the same
  // release breaks the app that is live at that moment, and leaves it broken if
  // the build fails. So both exist for one release, every writer populates both,
  // and a follow-up CONTRACT migration removes them.
  //
  // What still has to hold is the thing the original assertion was protecting:
  // no READER may be left on the old pair, because two sources of truth with a
  // stale reader is a journey that silently stops enrolling. The columns are
  // write-only for the length of the rollout.
  const schema = src("prisma/journeys.prisma");
  assert.match(schema, /^\s*trigger\s+String/m, "the expand phase must KEEP the old column for the running build");
  assert.match(schema, /^\s*triggers\s+Json$/m, "the list must be NOT NULL — a version listening for nothing enrols nobody");

  // The only permitted mention of the legacy pair in application code is the
  // dual-WRITE helper. Any `.trigger`/`triggerConfig` READ would be a second
  // source of truth.
  const writers = src("src/app/actions/journeys.ts");
  assert.match(writers, /legacyTriggerPair/, "writers must dual-write the legacy pair during the expand phase");

  const engine = ["src/lib/journeyScheduling.ts", "src/lib/journeyEvents.ts", "src/lib/journeyTriggers.ts"];
  for (const file of engine) {
    const text = src(file);
    assert.ok(
      !/triggerConfig/.test(text) && !/\.trigger(?!s)/.test(text),
      `${file} still reads the legacy single-trigger pair — the engine must read only "triggers"`,
    );
  }
});

test("the migration backfills every row before it drops anything", () => {
  const sql = src(MIGRATION);
  // FORCE ROW LEVEL SECURITY applies to the table owner, so without the escape
  // hatch the UPDATE matches zero rows in every tenant.
  assert.match(sql, /SET app\.bypass_rls = 'on'/);
  const backfillAt = sql.indexOf('SET "triggers" = jsonb_build_array');
  const notNullAt = sql.indexOf('ALTER COLUMN "triggers" SET NOT NULL');
  assert.ok(backfillAt > 0 && notNullAt > backfillAt, "SET NOT NULL is what proves the backfill reached every row");
  // EXPAND PHASE: nothing is dropped. The previous deployment serves production
  // while this migration runs (vercel.json: apply-migrations && next build) and
  // still reads these columns, so dropping them here breaks the app that is live
  // at that moment. The contract migration removes them in a later release.
  assert.ok(
    !/^\s*ALTER TABLE "JourneyVersion" DROP COLUMN/m.test(sql),
    "the expand migration must not drop the old columns — the running build still reads them",
  );
  assert.ok(
    !/^\s*DROP INDEX IF EXISTS "JourneyVersion_trigger_state_idx"/m.test(sql),
    "the old index serves the running build's query and must survive the expand phase",
  );
  // Both halves of the old shape, carried across.
  assert.match(sql, /'type', "trigger"/);
  assert.match(sql, /'config',[\s\S]*?"triggerConfig"/);
  // JSON null (Prisma.JsonNull) is not SQL NULL, and COALESCE only sees one of
  // them — a version would otherwise carry `"config": null` and every later
  // `spec.config.stageId` read would throw.
  assert.match(sql, /jsonb_typeof\(COALESCE\("triggerConfig", '\{\}'::jsonb\)\) = 'object'/);
  // No DEFAULT on the new column: '[]' would mean "listens for nothing", which
  // is a journey that stops enrolling and says nothing about it.
  assert.ok(!/"triggers" JSONB[^;]*DEFAULT/i.test(sql), "a default would hide an unbackfilled row");
});

test("the migration can be re-run after it has dropped its source columns", () => {
  // The runner applies SQL first and records second, so a crash between the two
  // re-runs this file against a database where "trigger" no longer exists.
  const sql = src(MIGRATION);
  assert.match(sql, /DO \$backfill\$/, "the backfill must sit in a PL/pgSQL block, which is not planned until it runs");
  assert.match(sql, /column_name = 'trigger'/, "…guarded on the column still being there");
  for (const statement of [
    /ADD COLUMN IF NOT EXISTS "triggers"/,
    /DROP INDEX IF EXISTS "JourneyVersion_trigger_state_idx"/,
    /DROP COLUMN IF EXISTS "trigger"/,
    /DROP COLUMN IF EXISTS "triggerConfig"/,
  ]) {
    assert.match(sql, statement, `not re-runnable: ${statement}`);
  }
});

test("the migration sorts after the journey migrations it builds on", () => {
  // apply-migrations.mjs orders by Number.parseInt(name, 10), not lexically.
  assert.ok(Number.parseInt("20260805120000_journey_multiple_triggers", 10) > 20260804120000);
});

test("in-flight runs are pinned to an immutable version, and this touches nothing they read", () => {
  // A run parked on a wait holds journeyVersionId for up to 30 days. On resume
  // it reads the definition, the entry conditions and the version number — never
  // the trigger, because enrolment is over by the time a run exists. So the
  // columns being replaced are not on the resume path at all.
  const sql = src(MIGRATION);
  for (const untouched of ["definition", "entryConditions", "publishedAt", "state"]) {
    assert.ok(
      !new RegExp(`SET[^;]*"${untouched}"`).test(sql),
      `the migration rewrites "${untouched}", which a parked run reads on resume`,
    );
  }
  assert.ok(!/JourneyRun/.test(sql), "no run row may be touched by a version-shape change");
  // And the runner genuinely does not consult it: a wait_for_trigger watches
  // event types named in its own step config, inside the definition.
  const runner = shipped("src/lib/journeyRuns.ts");
  assert.ok(!/version\.triggers|journeyVersion\.triggers/.test(runner), "the runner must not read the enrolment triggers");
});

/* ── the builder ─────────────────────────────────────────────────────────── */

test("the builder can author more than one trigger, and cannot author zero", () => {
  const builder = shipped("src/components/JourneyBuilder.tsx");
  assert.match(builder, /name="triggers"/, "the form has to carry the list");
  assert.match(builder, /triggers\.map\(\(spec, index\)/, "every trigger gets its own row, not just the first");
  assert.match(builder, /Add another trigger/);
  assert.match(
    builder,
    /disabled=\{triggers\.length === 1\}/,
    "removing the last trigger would save a journey that enrols nobody",
  );
  assert.match(
    builder,
    /disabled=\{triggers\.length >= JOURNEY_LIMITS\.triggers\}/,
    "the form must respect the same ceiling the parser enforces",
  );
});

test("a stored trigger the builder cannot offer survives being opened and re-saved", () => {
  // The converted-rule drafts again, from the other side: a <select> whose value
  // matches no <option> renders as the first option, so saving would silently
  // rewrite the trigger to lead_created.
  const builder = shipped("src/components/JourneyBuilder.tsx");
  assert.match(builder, /!\(JOURNEY_TRIGGERS as readonly string\[\]\)\.includes\(spec\.type\)/);
  assert.match(builder, /\(not available\)/, "…and it must say so rather than look like a valid choice");
});

test("changing a trigger's type clears that trigger's config and nothing else", () => {
  // stageId means nothing to lead_idle, and a carried-over filter is one the
  // engine never reads — a journey that looks configured and is not.
  const builder = shipped("src/components/JourneyBuilder.tsx");
  assert.match(builder, /patchTrigger\(index, \{ type, config: \{\} \}\)/);
  assert.match(
    builder,
    /current\.map\(\(spec, i\) => \(i === index \? \{ \.\.\.spec, \.\.\.patch \} : spec\)\)/,
    "editing one trigger must not rewrite its siblings",
  );
});

test("every trigger the code declares has a name a person can read", () => {
  for (const trigger of JOURNEY_TRIGGERS) {
    assert.equal(typeof JOURNEY_TRIGGER_LABELS[trigger], "string");
    assert.ok(JOURNEY_TRIGGER_LABELS[trigger].length > 0, `${trigger} has no label`);
  }
});
