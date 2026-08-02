import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { JOURNEY_EVENT_TRIGGERS, JOURNEY_SCHEDULED_TRIGGERS, JOURNEY_TRIGGERS } from "../src/lib/journeyTypes";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * Strip comments — a naive regex otherwise matches the very comment that
 * documents the fix. That is not hypothetical here: several files carry a note
 * naming `runLeadAutomations` and `lifecycleJourneys` to explain why they went,
 * and the guards below scan for exactly those names.
 *
 * Whole-line `//` only, so a `https://` inside a string literal survives.
 */
const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const shipped = (rel: string) => stripComments(src(rel));

/** Every .ts/.tsx under src/, so a re-introduction anywhere is caught. */
function sourceFiles(dir = "src"): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(root, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(path.join(root, rel)).isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.tsx?$/.test(entry)) out.push(rel);
  }
  return out;
}

const ALL_SOURCES = sourceFiles();

/**
 * THREE engines answered "when X happens to a lead, send an email / create an
 * activity / move a stage":
 *
 *   1. AutomationRule    — src/lib/automations.ts + the /automations builder
 *   2. the Journey engine — src/lib/journeys.ts + the /journeys builder
 *   3. lifecycleJourneys  — hardcoded anniversary + win-back copy
 *
 * The Journey engine is the one that survives. These tests are the fence around
 * that decision: they fail if a retired engine comes back, and — the test that
 * would have caught the original silent breakage — if the builder offers an
 * enrolment trigger that no write path ever emits.
 */

/* ── (a) nothing calls the retired engines ───────────────────────────────── */

test("nothing calls runLeadAutomations — the AutomationRule engine is gone", () => {
  assert.throws(
    () => src("src/lib/automations.ts"),
    "src/lib/automations.ts is back; there must be exactly one automation engine",
  );
  const offenders = ALL_SOURCES.filter((rel) => /runLeadAutomations|runIdleAutomations/.test(shipped(rel)));
  assert.deepEqual(offenders, [], "these files still call the retired AutomationRule engine");
});

test("nothing calls lifecycleJourneys — journeyScheduling reimplements it field for field", () => {
  assert.throws(
    () => src("src/lib/lifecycleJourneys.ts"),
    "the hardcoded lifecycle engine is back alongside the journey scheduler",
  );
  const offenders = ALL_SOURCES.filter((rel) =>
    /runLifecycleJourneys|LIFECYCLE_ANNIVERSARY_ENABLED|LIFECYCLE_WINBACK_ENABLED/.test(shipped(rel)),
  );
  assert.deepEqual(
    offenders,
    [],
    "a second anniversary/win-back sender is back; both crons run every 15 minutes and their dedupe stores cannot see each other",
  );
});

test("the AutomationRule tables have no reader left", () => {
  const offenders = ALL_SOURCES.filter((rel) => /prisma\.automation(Rule|Log)\b/.test(shipped(rel)));
  assert.deepEqual(offenders, [], "AutomationRule/AutomationLog were dropped; these files still query them");
  assert.doesNotMatch(
    src("prisma/schema.prisma"),
    /^model Automation(Rule|Log) \{/m,
    "the retired models are back in the schema",
  );
});

/* ── (b) every lead-lifecycle write path emits through emitJourneyEvent ──── */

/**
 * The ~10 sites that used to call `runLeadAutomations(trigger, leadId)`. Each
 * must still reach the one surviving engine, through `emitLeadJourneyEvent`.
 * A site dropped from this list is a lead event that stops enrolling anybody —
 * which is the exact failure mode this whole change exists to fix.
 */
const WRITE_PATHS: Array<[string, string[]]> = [
  ["src/app/actions/leads.ts", ["lead_created", "stage_entered", "lead_won", "lead_lost"]],
  ["src/lib/leadIntake.ts", ["lead_created"]],
  ["src/app/actions/quotes.ts", ["lead_won", "quote_declined"]],
  ["src/lib/signing/postComplete.ts", ["lead_won", "quote_signed"]],
  ["src/app/actions/fulfilment.ts", ["delivered"]],
  ["src/lib/referrals.ts", ["referral_earned"]],
];

for (const [rel, triggers] of WRITE_PATHS) {
  test(`${rel} emits its lead events into the journey engine`, () => {
    const code = shipped(rel);
    assert.match(
      code,
      /emitLeadJourneyEvent/,
      `${rel} no longer reaches the journey engine at all`,
    );
    for (const trigger of triggers) {
      assert.match(
        code,
        new RegExp(`emitLeadJourneyEvent\\(\\s*"${trigger}"`),
        `${rel} stopped emitting ${trigger}`,
      );
    }
  });
}

test("moveLead and moveLeadToTestDrive both emit stage_entered", () => {
  // Three distinct paths change a lead's stage — the edit form, the board drag,
  // and the test-drive booking dialog. Missing one means a stage-entry journey
  // fires from some parts of the UI and not others.
  const code = shipped("src/app/actions/leads.ts");
  assert.equal(
    (code.match(/emitLeadJourneyEvent\("stage_entered"/g) ?? []).length,
    3,
    "updateLead, moveLead and moveLeadToTestDrive must each emit stage_entered",
  );
});

test("emitting can never break the write path it hangs off", () => {
  // runLeadAutomations wrapped its whole body in try/catch ("Automations must
  // never break the main flow") and callers relied on that with a bare await —
  // createIntakeLead, which runs under inbound webhooks, still does. So the
  // replacement must swallow too, or a broken journey turns an accepted lead
  // into a 500 that makes the provider retry.
  const code = shipped("src/lib/leadJourneyEvents.ts");
  assert.match(code, /try\s*\{[\s\S]+\}\s*catch\s*\{/, "emitLeadJourneyEvent must not be able to reject");
  assert.match(
    code,
    /Promise<void>/,
    "it must resolve to void — a caller must not be able to await a rejection",
  );
});

test("the marketing gate moved with the engine, not lost with it", () => {
  // runLeadAutomations gated the ENGINE rather than each of its ~10 callers, so
  // with the Marketing pack off nothing fired and nothing was written. Dropping
  // that gate would leave JourneyEvent rows piling up forever for a tenant whose
  // cron declines to process them.
  assert.match(shipped("src/lib/leadJourneyEvents.ts"), /isModuleEnabled\("marketing"\)/);
});

/* ── (c) every trigger the builder OFFERS is actually emitted somewhere ──── */

/**
 * THE TEST THAT WOULD HAVE CAUGHT THE ORIGINAL BREAKAGE.
 *
 * `emitJourneyEvent` was called from NO application write path. Its only
 * callers were the cron scheduler and the engine's own move_stage step. So all
 * eight event triggers — offered in the builder in wording identical to the
 * automations builder next to it, including "New lead created" and "Lead enters
 * a stage" — enrolled nobody, ever. You built the journey, activated it, and
 * nothing happened, with no error anywhere.
 *
 * Every trigger the builder offers must therefore be reachable: an event
 * trigger by a write path emitting it, a scheduled trigger by the scheduler
 * sweeping for it.
 */

const EMITTED_EVENT_TRIGGERS = (() => {
  const found = new Set<string>();
  for (const rel of ALL_SOURCES) {
    for (const [, trigger] of shipped(rel).matchAll(/emitLeadJourneyEvent\(\s*"([a-z_]+)"/g)) {
      found.add(trigger);
    }
  }
  return found;
})();

for (const trigger of JOURNEY_EVENT_TRIGGERS) {
  test(`the builder offers "${trigger}" and a write path emits it`, () => {
    assert.ok(
      EMITTED_EVENT_TRIGGERS.has(trigger),
      `"${trigger}" is selectable in the journey builder but NOTHING emits it — ` +
        `a journey built on it would activate cleanly and then enrol nobody, forever, with no error`,
    );
  });
}

for (const trigger of JOURNEY_SCHEDULED_TRIGGERS) {
  test(`the builder offers "${trigger}" and the scheduler enrols for it`, () => {
    const scheduler = shipped("src/lib/journeyScheduling.ts");
    assert.match(
      scheduler,
      new RegExp(`version\\.trigger === "${trigger}"`),
      `"${trigger}" is selectable in the journey builder but runScheduledJourneyEnrollments never sweeps for it`,
    );
  });
}

test("the two lists above cover exactly the triggers the builder OFFERS", () => {
  // The reachability tests above iterate the two typed halves. They are only a
  // real guard if those halves are the same set the <select> actually shows —
  // the builder spells its options out by hand rather than mapping
  // JOURNEY_TRIGGERS, so the two can drift, and a trigger that drifts into the
  // dropdown alone would be offered to users while escaping both checks.
  assert.deepEqual(
    [...JOURNEY_TRIGGERS].sort(),
    [...JOURNEY_EVENT_TRIGGERS, ...JOURNEY_SCHEDULED_TRIGGERS].sort(),
    "a declared trigger belongs to neither the event nor the scheduled half",
  );

  const builder = shipped("src/components/JourneyBuilder.tsx");
  const select = builder.match(/<select name="trigger"[\s\S]*?<\/select>/);
  assert.ok(select, "the enrolment trigger dropdown is not where this test expects it");
  const offered = [...select[0].matchAll(/<option value="([a-z_]+)"/g)].map(([, value]) => value);
  assert.deepEqual(
    offered.sort(),
    [...JOURNEY_TRIGGERS].sort(),
    "the builder offers a different set of triggers than the code declares — the extras are unreachable",
  );
});

/* ── capability parity with the engine that was retired ─────────────────── */

test("idle-lead enrolment kept the engagement test it inherited", () => {
  // runIdleAutomations did far more than compare updatedAt: it skipped a lead
  // with a quote still awaiting a decision, counted communications, activities
  // and quotes (including contact-scoped ones), and suppressed the nudge while
  // an open future follow-up was booked. The scheduler compared updatedAt and
  // nothing else, so retiring that engine without moving this across would have
  // started nudging customers who are mid-decision.
  const scheduler = shipped("src/lib/journeyScheduling.ts");
  assert.match(scheduler, /leadHasGoneQuiet\(/, "lead_idle must use the full gone-quiet test");
  const idle = shipped("src/lib/leadIdle.ts");
  assert.match(idle, /status: "sent"[\s\S]+signedAt: null/, "a quote pending a decision must still suppress the nudge");
  assert.match(idle, /isOpenFutureFollowUp/, "a booked future follow-up must still suppress the nudge");
});

test("journey activities honour next-step scheduling", () => {
  // AutomationRule's create_activity went through nextStepDueDate (work hour,
  // skip weekends); the journey step used addDays(new Date(), dueDays). Without
  // this, retiring the rules engine silently drops the setting — and a same-day
  // task could land already overdue, which runActivityReminders then never
  // pushes for (it only pushes while dueDate is still in the future).
  const code = shipped("src/lib/journeyStepExecutor.ts");
  assert.match(code, /nextStepDueDate\(new Date\(\), dueDays, await getNextStepScheduling\(\)\)/);
  assert.doesNotMatch(code, /dueDate: addDays\(new Date\(\), dueDays\)/);
});

test("the next-step scheduling control survived the screen that hosted it", () => {
  // It lived on /automations, which is now a redirect. Its only reader is the
  // journey create_activity step, so losing the form would have frozen the
  // setting at whatever it was.
  const settings = shipped("src/app/(app)/settings/page.tsx");
  assert.match(settings, /saveNextStepScheduling/, "the form must have a home now that /automations is a redirect");
});

test("a stage_entered event is judged against the stage that was ENTERED", () => {
  // Events are drained by a cron every 15 minutes. Judging the event against
  // the lead's stage NOW means a rep who moves a lead twice inside that window
  // has the first event silently match nothing.
  const code = shipped("src/lib/journeyEvents.ts");
  assert.match(code, /payload\.stageId/, "triggerMatches must prefer the stage recorded on the event");
  assert.match(shipped("src/lib/leadJourneyEvents.ts"), /stageId: lead\.stageId/, "the emitter must record it");
});

/* ── the retired screen ──────────────────────────────────────────────────── */

test("the automations page is a redirect and nothing else", () => {
  const page = src("src/app/(app)/automations/page.tsx");
  assert.match(page, /redirect\("\/journeys"\)/, "it must land on the surviving builder");
  assert.ok(page.split("\n").length < 30, "anything more than a redirect has crept back in");
  for (const gone of ["prisma", "AutomationRuleForm", "SaveForm", "ModalTrigger", "ConfirmDelete"]) {
    assert.ok(!page.includes(gone), `${gone} is back on a page that should only redirect`);
  }
});

test("no orphan is left behind the redirect", () => {
  assert.throws(() => src("src/components/AutomationRuleForm.tsx"), "dead builder component still present");
  assert.throws(() => src("src/app/actions/automations.ts"), "the rule CRUD actions should have gone with the page");
});

test("nothing renders the retired page or links at it as a destination", () => {
  // Settings embedded the whole page inline (`<AutomationsPage />`), which a
  // redirect cannot do, and the sidebar plus the journeys breadcrumb pointed at
  // it. Those are repointed; only the redirect file itself may mention the path.
  const offenders = ALL_SOURCES.filter(
    (rel) => rel !== "src/app/(app)/automations/page.tsx" && /href="\/automations"|from "\.\.\/automations\/page"/.test(shipped(rel)),
  );
  assert.deepEqual(offenders, [], "these still send people through the bounce instead of to /journeys");
});

/* ── the data migration ─────────────────────────────────────────────────── */

test("the migration converts every rule rather than dropping any", () => {
  const sql = src("prisma/migrations/20260802120000_retire_automation_rules/migration.sql");
  // It drops the tables, so every row must be represented first.
  assert.match(sql, /INSERT INTO "Journey"[\s\S]+FROM "_rule_convert"/);
  assert.match(sql, /INSERT INTO "JourneyVersion"[\s\S]+FROM "_rule_convert"/);
  assert.match(sql, /NEEDS REVIEW/, "an unconvertible rule must be kept for review, not dropped");
  assert.match(sql, /DROP TABLE IF EXISTS "AutomationLog"/);
  assert.match(sql, /DROP TABLE IF EXISTS "AutomationRule"/);
  // Journey/JourneyVersion/JourneyEvent are FORCE ROW LEVEL SECURITY, which
  // applies to the table owner too — without the escape hatch this migration
  // would insert nothing at all and then drop the source tables.
  assert.match(sql, /SET app\.bypass_rls = 'on'/);
});

test("the migration cannot double-send an anniversary during rollout", () => {
  const sql = src("prisma/migrations/20260802120000_retire_automation_rules/migration.sql");
  // 1. Never create a lifecycle journey for a tenant that already has one —
  //    that is the reported double-send, not a fix for it.
  assert.match(sql, /NOT EXISTS \([\s\S]+v\."trigger" = 'purchase_anniversary'/);
  assert.match(sql, /NOT EXISTS \([\s\S]+v\."trigger" = 'win_back'/);
  // 2. Seed the journey engine's OWN dedupe store for anyone the old engine
  //    already emailed — the two stores cannot otherwise see each other.
  assert.match(sql, /INSERT INTO "JourneyEvent"[\s\S]+'processed'/);
  assert.match(sql, /encode\(sha256\(convert_to\(/, "the seeded key must be the one hashJourneyKey computes");
  assert.match(sql, /LIKE '%Purchase anniversary%'/);
  assert.match(sql, /LIKE '%Win-back%'/);
  // 3. Leave the old switches off so a restored copy of the old code is inert.
  assert.match(sql, /UPDATE "AppSetting"[\s\S]+SET "value" = 'false'/);
});

test("the cron no longer runs the two retired sweeps", () => {
  const cron = shipped("src/app/api/cron/automations/route.ts");
  assert.doesNotMatch(cron, /idle-automations/, "idle nudges are a lead_idle journey now");
  assert.doesNotMatch(cron, /lifecycle-journeys/, "anniversary and win-back are journeys now");
});
