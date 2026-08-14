import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  DERIVED_GATE_MODE,
  STAGE_REMEDIES,
  derivedCriteria,
  remedyAddresses,
  remedyFor,
} from "../src/lib/stageRemedies";
import { PIPELINE_STAGE_ACTIONS, PIPELINE_STAGE_ACTION_META } from "../src/lib/pipelineStageActions";
import {
  STAGE_CRITERION_FIELDS,
  evaluateStageMove,
  type StageGateFacts,
  type UnmetCriterion,
} from "../src/lib/stageGate";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
const shipped = (rel: string) =>
  src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * A required action and a stage rule were two unrelated mechanisms describing the
 * same moment. A remedy is the seam: a rule, plus a form that satisfies it.
 *
 * The rules half is executed in stageGate.test.ts. This file executes the JOIN —
 * that every remedy declares a criterion the fact snapshot can actually answer,
 * that a stage with no rule of its own derives one, and that today's behaviour
 * survives becoming the derived case.
 */

function facts(overrides: Partial<{ testDrives: number; linked: boolean }> = {}): StageGateFacts {
  return {
    lead: { valueCents: 0, assignedToId: null, productId: null, email: null, phone: null, source: "manual" },
    quote: { count: 0, sentCount: 0, acceptedCount: 0, latestStatus: null },
    contact: { linked: overrides.linked ?? false, email: null, phone: null },
    activity: { plannedCount: 0, overdueCount: 0, testDriveCount: overrides.testDrives ?? 0 },
    signature: { completedCount: 0, pendingCount: 0 },
    stage: { ageDays: 0 },
  };
}

/* ── the registry is complete and answerable ────────────────────────────── */

test("every stage action has a remedy, and every remedy an action", () => {
  // Three lists name this vocabulary — the tuple, the metadata and the registry —
  // and a value missing from any one of them is a stage that can be configured
  // and then cannot be satisfied.
  for (const action of PIPELINE_STAGE_ACTIONS) {
    assert.ok(STAGE_REMEDIES[action], `${action} has no remedy`);
    assert.ok(PIPELINE_STAGE_ACTION_META[action], `${action} has no metadata`);
  }
  assert.deepEqual(Object.keys(STAGE_REMEDIES).sort(), [...PIPELINE_STAGE_ACTIONS].sort());
});

test("every remedy satisfies a criterion the facts can actually answer", () => {
  // THE failure this design is arranged to prevent: a remedy that claims to
  // satisfy a field the evaluator resolves to `undefined`, so completing the
  // dialog leaves the rule unmet and the move refuses again. An infinite loop
  // with a form in it.
  const snapshot = facts() as unknown as Record<string, Record<string, unknown>>;
  for (const remedy of Object.values(STAGE_REMEDIES)) {
    assert.ok(
      (STAGE_CRITERION_FIELDS as readonly string[]).includes(remedy.satisfies.field),
      `${remedy.id} satisfies ${remedy.satisfies.field}, which is not an offered field`,
    );
    const [namespace, key] = remedy.satisfies.field.split(".");
    assert.ok(namespace in snapshot && key in snapshot[namespace], `${remedy.id}'s field has no fact behind it`);
  }
});

test("a booked test drive is counted specifically, not as any planned activity", () => {
  // `activity.plannedCount` would have been satisfied by a booked service visit,
  // so a rule saying "a test drive is booked" would pass for a lead with none.
  assert.equal(STAGE_REMEDIES.book_test_drive.satisfies.field, "activity.testDriveCount");
});

/* ── the derivation ─────────────────────────────────────────────────────── */

test("a stage with a remedy and no rule is judged by what the remedy provides", () => {
  const derived = derivedCriteria(STAGE_REMEDIES.book_test_drive);
  assert.deepEqual(derived, {
    logic: "and",
    conditions: [{ field: "activity.testDriveCount", operator: "greater_or_equal", value: 1 }],
  });
  // A required action has always been mandatory, and stays so.
  assert.equal(DERIVED_GATE_MODE, "block");
});

test("today's test-drive stage still blocks a lead with no booking", () => {
  // The compatibility claim, executed rather than asserted in prose.
  const verdict = evaluateStageMove({
    from: { stageId: "qual", order: 1, exit: { mode: "off", criteria: null } },
    to: {
      stageId: "td",
      order: 2,
      entry: { mode: DERIVED_GATE_MODE, criteria: derivedCriteria(STAGE_REMEDIES.book_test_drive) },
    },
    samePipeline: true,
    facts: facts({ testDrives: 0 }),
    canOverride: false,
  });
  assert.equal(verdict.allowed, false);
  assert.deepEqual(verdict.unmet.map((u) => u.field), ["activity.testDriveCount"]);
});

test("a lead that ALREADY has a booking moves straight in", () => {
  // The improvement that falls out of evaluating the criterion instead of
  // trusting the presence of an entryAction: the booking dialog used to open
  // regardless, asking somebody to re-book what was already booked.
  const verdict = evaluateStageMove({
    from: { stageId: "qual", order: 1, exit: { mode: "off", criteria: null } },
    to: {
      stageId: "td",
      order: 2,
      entry: { mode: DERIVED_GATE_MODE, criteria: derivedCriteria(STAGE_REMEDIES.book_test_drive) },
    },
    samePipeline: true,
    facts: facts({ testDrives: 1 }),
    canOverride: false,
  });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.unmet.length, 0);
});

test("the customer-link remedy compares the way the editor stores a boolean", () => {
  const entry = { mode: DERIVED_GATE_MODE, criteria: derivedCriteria(STAGE_REMEDIES.link_contact) };
  const move = (linked: boolean) =>
    evaluateStageMove({
      from: { stageId: "qual", order: 1, exit: { mode: "off" as const, criteria: null } },
      to: { stageId: "prop", order: 2, entry },
      samePipeline: true,
      facts: facts({ linked }),
      canOverride: false,
    });
  assert.equal(move(true).allowed, true);
  assert.equal(move(false).allowed, false);
});

/* ── which remedy is offered ────────────────────────────────────────────── */

test("a remedy is offered only for the clause it addresses", () => {
  // A stage wanting both a quote and a customer link, missing only the quote,
  // must not offer the customer picker — it would not help.
  const quoteMissing: UnmetCriterion[] = [
    { field: "quote.count", operator: "greater_or_equal", expected: 1, actual: 0 },
  ];
  const linkMissing: UnmetCriterion[] = [
    { field: "contact.linked", operator: "equals", expected: "true", actual: false },
  ];
  assert.equal(remedyAddresses(STAGE_REMEDIES.link_contact, quoteMissing), false);
  assert.equal(remedyAddresses(STAGE_REMEDIES.link_contact, linkMissing), true);
  // And it IS offered when its clause is one of several.
  assert.equal(remedyAddresses(STAGE_REMEDIES.link_contact, [...quoteMissing, ...linkMissing]), true);
});

test("an unknown or absent action resolves to no remedy", () => {
  assert.equal(remedyFor(null), null);
  assert.equal(remedyFor(""), null);
  // A value written by a newer release, or by hand past the CHECK constraint.
  assert.equal(remedyFor("collect_deposit"), null);
});

/* ── the vocabulary agrees with the database ────────────────────────────── */

test("the CHECK constraint permits exactly the actions this build offers", () => {
  // The constraint is the database's half of the vocabulary and is enforced only
  // there — Prisma's DSL has no equivalent — so an action added to the tuple
  // without a migration fails at the INSERT rather than at the type check.
  // Sorted the way the runner applies them: numeric-prefixed migrations first,
  // then the timestamped ones. A plain string sort puts "20260813…" before
  // "79_…", so the OLD constraint would look like the last word.
  const dirs = readdirSync(path.join(root, "prisma", "migrations")).sort((a, b) => {
    const num = (d: string) => (/^\d+_/.test(d) ? parseInt(d, 10) : Number.MAX_SAFE_INTEGER);
    return num(a) - num(b) || a.localeCompare(b);
  });
  let allowed: string[] | null = null;
  for (const dir of dirs) {
    let sql: string;
    try {
      sql = readFileSync(path.join(root, "prisma", "migrations", dir, "migration.sql"), "utf8");
    } catch {
      continue;
    }
    // The LAST migration to define it wins, which is what the database sees.
    //
    // Whitespace-tolerant on purpose. The pattern used to require the clause on a
    // single line with single spaces, so wrapping a longer vocabulary across lines
    // — which the third action forced — made it match nothing, and the loop then
    // silently read the PREVIOUS migration's list. That is a false reading rather
    // than a failure: it happens to fail loudly here, but only because the lists
    // differ. Formatting must not decide which constraint this test believes in.
    for (const match of sql.matchAll(/"entryAction"\s+IS\s+NULL\s+OR\s+"entryAction"\s+IN\s*\(([^)]*)\)/g)) {
      allowed = match[1].split(",").map((value) => value.trim().replace(/^'|'$/g, ""));
    }
  }
  assert.ok(allowed, "no migration defines the entryAction CHECK");
  assert.deepEqual(allowed!.sort(), [...PIPELINE_STAGE_ACTIONS].sort());
});

/* ── the board asks, it does not decide ─────────────────────────────────── */

test("the board no longer inspects entryAction to choose a dialog", () => {
  // It used to open the booking dialog before calling the server at all, so it
  // could not know whether the work was already done, and every new remedy meant
  // another branch in the client.
  const board = shipped("src/components/KanbanBoard.tsx");
  // Scoped to the MOVE path. One reference survives elsewhere on purpose: the
  // context menu's "Book a test drive" shortcut jumps to whichever stage asks for
  // one, which is a menu item about test drives rather than a decision about
  // which dialog a rule needs.
  const requestMove = board.slice(board.indexOf("function requestMove("), board.indexOf("function onDragEnd("));
  assert.ok(!/entryAction/.test(requestMove), "the move path must not inspect entryAction");
  assert.match(board, /if \(!result\.ok && result\.remedy\)/, "the server names the remedy");
  assert.match(board, /STAGE_REMEDIES\[result\.remedy\]/, "and the registry maps it to a dialog");
  // The column's own label comes from the registry too, or a second remedy
  // silently labels nothing.
  assert.match(board, /remedyFor\(stage\.entryAction\)/);
});

test("the settings picker offers whatever the registry holds", () => {
  // Three hardcoded copies of one option is how a second action gets added
  // everywhere except the screen that configures it.
  const page = shipped("src/app/(app)/settings/pipelines/page.tsx");
  assert.equal(
    (page.match(/PIPELINE_STAGE_ACTIONS\.map/g) ?? []).length,
    2,
    "both stage forms must render the list, not literals",
  );
  assert.ok(!/<option value="book_test_drive">/.test(page), "no hardcoded option may remain");
});

test("the second remedy's action exists and is gated on the write it performs", () => {
  const leads = shipped("src/app/actions/leads.ts");
  assert.ok(leads.includes("export async function moveLeadWithContact("), "the remedy needs an action");
  const action = leads.slice(leads.indexOf("export async function moveLeadWithContact("));
  // A stage rule must not become a way to perform a write the caller may not make.
  assert.match(action, /hasPermission\(user, "leads\.link_contact"\)/);
  assert.ok(action.includes("gateStageMove("), "and it runs the gate like every other door");
  assert.match(action, /\}, GOVERNANCE_TX\);/, "the link, the move and the audits commit together");
});
