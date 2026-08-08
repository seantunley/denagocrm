import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Prisma } from "@prisma/client";
import { JOURNEY_EVENT_TRIGGERS, JOURNEY_SCHEDULED_TRIGGERS, JOURNEY_TRIGGERS } from "../src/lib/journeyTypes";
import { JOURNEY_TRIGGER_LABELS } from "../src/lib/journeyTriggers";

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
  // `lead_created` is emitted by the ONE lead creator (lib/leadCreate.ts), which
  // every channel now goes through — the staff form, the intake API, WhatsApp,
  // Messenger and the bot. Asserting it per-call-site would demand the emit be
  // duplicated back out to five places, which is the thing that was fixed:
  // three of those five never fired an automation at all.
  ["src/lib/leadCreate.ts", ["lead_created"]],
  ["src/app/actions/leads.ts", ["stage_entered", "lead_won", "lead_lost"]],
  ["src/app/actions/quotes.ts", ["lead_won", "quote_declined"]],
  ["src/lib/signing/postComplete.ts", ["lead_won", "quote_signed"]],
  ["src/app/actions/fulfilment.ts", ["delivered"]],
  ["src/lib/referrals.ts", ["referral_earned"]],
];

/**
 * …and every channel must actually reach that creator, or its lead silently
 * stops enrolling. This is the other half of the guarantee the per-site list
 * above used to carry for `lead_created`.
 */
test("every lead channel reaches the one creator", () => {
  for (const [rel, what] of [
    ["src/lib/leadIntake.ts", "website / Lead Ads intake"],
    ["src/app/actions/leads.ts", "the staff form"],
    ["src/lib/whatsapp.ts", "inbound WhatsApp"],
    ["src/lib/messenger.ts", "Facebook / Instagram DMs"],
    ["src/lib/flowActions.ts", "the chatbot"],
  ] as const) {
    assert.match(
      shipped(rel),
      /createLeadRecord(IfPipelineReady)?\(/,
      `${what} (${rel}) must create through lib/leadCreate.ts, or its lead never emits lead_created`,
    );
  }
});

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
      new RegExp(`spec\\.type === "${trigger}"`),
      `"${trigger}" is selectable in the journey builder but runScheduledJourneyEnrollments never sweeps for it`,
    );
  });
}

test("the two lists above cover exactly the triggers the builder OFFERS", () => {
  // The reachability tests above iterate the two typed halves. They are only a
  // real guard if those halves are the same set the dropdown actually shows.
  assert.deepEqual(
    [...JOURNEY_TRIGGERS].sort(),
    [...JOURNEY_EVENT_TRIGGERS, ...JOURNEY_SCHEDULED_TRIGGERS].sort(),
    "a declared trigger belongs to neither the event nor the scheduled half",
  );

  // The dropdown used to spell its twelve options out by hand, which is how one
  // could drift into the builder alone — offered to users, reachable by nothing,
  // and invisible to both checks above. It maps the declared list instead, so
  // the drift is now impossible rather than merely detected. Assert THAT, since
  // it is the property that replaced the hand-written list.
  const builder = shipped("src/components/JourneyBuilder.tsx");
  assert.match(
    builder,
    /JOURNEY_TRIGGERS\.map\(\(type\) => \([\s\S]*?<option key=\{type\} value=\{type\}>/,
    "the enrolment dropdown must be rendered FROM JOURNEY_TRIGGERS, not from a hand-written list beside it",
  );
  assert.match(
    builder,
    /JOURNEY_TRIGGER_LABELS\[type\]/,
    "…and take its wording from the shared label map, which the journeys list reads too",
  );

  // The label map is typed Record<JourneyTrigger, string>, so a MISSING label is
  // a compile error. A stale EXTRA one is not, and would sit there naming a
  // trigger that no longer exists.
  assert.deepEqual(
    Object.keys(JOURNEY_TRIGGER_LABELS).sort(),
    [...JOURNEY_TRIGGERS].sort(),
    "the trigger label map and the declared trigger list disagree",
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
  const code = shipped("src/lib/journeyTriggers.ts");
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

/* ── the three review blockers on that migration ────────────────────────── */

const MIGRATION = "prisma/migrations/20260802120000_retire_automation_rules/migration.sql";

/**
 * The migration's own prose names "AutomationRule" and "AutomationLog" dozens of
 * times to explain what it retires. Every guard below asks whether a STATEMENT
 * touches those tables, so the comments have to go first or each check passes on
 * the explanation instead of the SQL — the same trap `stripComments` exists for
 * on the TypeScript side. No `--` appears inside a string literal in this file
 * (the prose uses em dashes), so line-comment stripping is safe here.
 */
const stripSqlComments = (sql: string) => sql.replace(/--[^\n]*/g, "");

const MIGRATION_SQL = stripSqlComments(src(MIGRATION));

/** The one guarded, atomic DO block. Null means the guard is gone. */
const GUARDED_BLOCK = (() => {
  const match = MIGRATION_SQL.match(/DO \$retire_automation_rules\$[\s\S]*?\$retire_automation_rules\$;/);
  return match ? match[0] : null;
})();

test("the migration is genuinely re-runnable: nothing reads a dropped table unguarded", () => {
  // BLOCKER 1. The migration ends by DROPping "AutomationRule" and
  // "AutomationLog", so a rerun — or a recovery run after Postgres died
  // part-way — reaches statements whose source tables are gone and fails with
  // 42P01. "Idempotent" was claimed in the header and was not true.
  //
  // The fix is a PL/pgSQL guard: PL/pgSQL does not parse or plan a statement
  // until it executes it, so with `to_regclass` NULL the block returns and the
  // statements below it are never analysed. That only holds if EVERY read of a
  // retired table is inside the block — one left outside is parsed on the way
  // past and errors regardless of the guard.
  assert.ok(
    GUARDED_BLOCK,
    "the DO $retire_automation_rules$ block is gone — a second run hits the retired tables and fails",
  );

  assert.match(
    GUARDED_BLOCK!,
    /IF to_regclass\('"AutomationRule"'\) IS NULL OR to_regclass\('"AutomationLog"'\) IS NULL THEN[\s\S]*?RETURN;/,
    "the block must return early when the tables are already gone",
  );
  // The guard has to be the FIRST thing in the block, or the statement above it
  // is the one that errors.
  assert.ok(
    GUARDED_BLOCK!.indexOf("to_regclass") < GUARDED_BLOCK!.indexOf('"AutomationRule" r'),
    "the guard must precede the first read of the retired tables",
  );

  const outsideTheGuard = MIGRATION_SQL.replace(GUARDED_BLOCK!, "");
  const stillOutside = ['"AutomationRule"', '"AutomationLog"', '"_rule_convert"'].filter((ref) =>
    outsideTheGuard.includes(ref),
  );
  assert.deepEqual(
    stillOutside,
    [],
    "these are read or dropped outside the existence guard, so a rerun still fails on them",
  );
});

test("AutomationLog history is archived, and archived BEFORE the drop", () => {
  // BLOCKER 2. AutomationLog was the ONLY execution record the retired engine
  // ever produced and there is no second copy of it anywhere; dropping it
  // destroys the audit trail of what fired and when. It is copied into a
  // retained table first.
  assert.match(
    MIGRATION_SQL,
    /CREATE TABLE IF NOT EXISTS "RetiredAutomationLog"/,
    "the archive table must be created by this migration, and survive it",
  );
  const archive = MIGRATION_SQL.indexOf('INSERT INTO "RetiredAutomationLog"');
  const dropLog = MIGRATION_SQL.indexOf('DROP TABLE IF EXISTS "AutomationLog"');
  assert.ok(archive >= 0, "AutomationLog is dropped without being copied anywhere");
  assert.ok(dropLog >= 0, "the retired table must still be dropped");
  assert.ok(archive < dropLog, "the archive copy must come BEFORE the drop, not after");

  // Copy and drop in the SAME guarded block, so no crash, ordering or rerun can
  // separate them into "dropped but never archived".
  assert.ok(
    GUARDED_BLOCK?.includes('INSERT INTO "RetiredAutomationLog"') &&
      GUARDED_BLOCK.includes('DROP TABLE IF EXISTS "AutomationLog"'),
    "archive and drop must be atomic — both inside the guarded block",
  );

  // The rule table goes in the same breath, so a bare copy of `ruleId` would be
  // a pile of orphans. What the rule WAS has to ride along, plus the id of the
  // journey it became, or the archive is unreadable in practice.
  for (const column of ['"ruleName"', '"ruleTrigger"', '"ruleAction"', '"journeyId"']) {
    assert.ok(
      MIGRATION_SQL.includes(column),
      `the archive drops ${column}, leaving rows that cannot be traced back to a rule or forward to a journey`,
    );
  }
  // It holds one tenant's lead ids; it must not become the one table where
  // tenants can read each other's history.
  assert.match(MIGRATION_SQL, /ALTER TABLE "RetiredAutomationLog" FORCE ROW LEVEL SECURITY/);
});

test("the archive is readable afterwards — it is a modelled, retained table", () => {
  // "Archived" is worth nothing if the rows land somewhere no one can query.
  // Asserted against the generated client rather than the schema text, so this
  // fails if the model is declared but never actually reaches Prisma.
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === "RetiredAutomationLog");
  assert.ok(model, "RetiredAutomationLog is not a Prisma model — the archived history has no reader");
  const fields = new Set(model!.fields.map((f) => f.name));
  for (const required of ["id", "tenantId", "ruleId", "ruleName", "ruleTrigger", "ruleAction", "journeyId", "leadId", "note", "createdAt"]) {
    assert.ok(fields.has(required), `RetiredAutomationLog.${required} is missing — archived rows lose ${required}`);
  }
  // A backup that omits the archive un-archives it the first time it is used.
  assert.match(shipped("scripts/export-data.ts"), /retiredAutomationLog\.findMany/);
});

test("a converted rule that SENDS EMAIL is subject to the consent gate", () => {
  // BLOCKER 3. Every converted rule was categorised 'automation' — deliberately,
  // because the step executor only applies the consent check to the 'marketing'
  // category, and the comment said as much: categorising them marketing "would
  // silently stop emails that fire today".
  //
  // That is the reasoning, not the rule. AutomationRule.send_email had NO
  // consent check of any kind, which is precisely the unsubscribe/POPIA hole the
  // sibling consent-gate change closes; carrying it forward under a category
  // that dodges the gate re-opens it by migration. A rule that mails a lead is
  // direct marketing whatever table it used to live in.
  assert.match(
    MIGRATION_SQL,
    /CASE WHEN c\."action" = 'send_email' THEN 'marketing' ELSE 'automation' END/,
    "converted email rules must be categorised 'marketing' so the consent gate applies to them",
  );

  // NARROWER than a blanket recategorisation, on purpose: the category is a
  // property of the whole journey and each converted rule is exactly one step.
  // create_activity / move_stage / assign_user contact nobody, and send_push
  // goes to STAFF devices (sendPushToAll) — gating an internal task on a
  // customer's mailing preference would be a different bug.
  assert.doesNotMatch(
    MIGRATION_SQL,
    /FROM "_rule_convert" c\s*\n\s*ON CONFLICT[\s\S]*?'marketing',\s*\n\s*CASE WHEN c\.convertible AND c\."active"/,
    "the category must depend on the action, not be a blanket 'marketing'",
  );

  // Say it out loud where an operator will actually read it. Some sends that
  // fire today WILL stop, and a migration that changes who gets email without
  // saying so is the problem, not the fix.
  assert.ok(
    MIGRATION_SQL.includes("CONSENT: this journey is categorised"),
    "the migrated journey must carry the warning that its sends are now consent-checked",
  );

  // And the category has to still MEAN something: if the executor stops gating
  // marketing sends, the line above becomes decoration.
  const executor = shipped("src/lib/journeyStepExecutor.ts");
  assert.match(
    executor,
    /case "send_email": \{\s*\n\s*if \(category === "marketing"/,
    "send_email no longer applies any check keyed on the marketing category",
  );
});
