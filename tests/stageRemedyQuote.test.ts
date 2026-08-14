import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  CLEAR_VERDICT,
  evaluateStageMove,
  type StageCriteriaGroup,
  type StageGateFacts,
  type StageMoveInput,
} from "../src/lib/stageGate";
import { STAGE_REMEDIES, derivedCriteria, factsAfterRemedy, remedyFor } from "../src/lib/stageRemedies";
import { PIPELINE_STAGE_ACTIONS, PIPELINE_STAGE_ACTION_META } from "../src/lib/pipelineStageActions";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
const shipped = (rel: string) =>
  src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * `attach_quote` — the third remedy, and the first added AFTER the registry
 * existed.
 *
 * So it is also the test of the claim the registry was built on: that adding a
 * remedy is four coordinated changes and no new plumbing. Everything asserted
 * here is either the remedy's own behaviour or one of those four seams.
 */

const QUOTE = STAGE_REMEDIES.attach_quote;

function facts(overrides: Partial<{ quotes: number; latestStatus: string | null }> = {}): StageGateFacts {
  return {
    lead: { valueCents: 0, assignedToId: null, productId: null, email: null, phone: null, source: "manual" },
    quote: {
      count: overrides.quotes ?? 0,
      sentCount: 0,
      acceptedCount: 0,
      latestStatus: overrides.latestStatus ?? null,
    },
    contact: { linked: false, email: null, phone: null },
    activity: { plannedCount: 0, overdueCount: 0, testDriveCount: 0 },
    signature: { completedCount: 0, pendingCount: 0 },
    stage: { ageDays: 0 },
  };
}

function moveInput(criteria: StageCriteriaGroup, snapshot: StageGateFacts): StageMoveInput {
  return {
    from: { stageId: "qualification", order: 1, exit: { mode: "off", criteria: null } },
    to: { stageId: "proposal", order: 2, entry: { mode: "block", criteria } },
    samePipeline: true,
    facts: snapshot,
    canOverride: false,
  };
}

/* ── the rule and its remedy ────────────────────────────────────────────── */

test("a stage requiring a quote refuses a lead without one, and admits it after", () => {
  const input = moveInput(derivedCriteria(QUOTE), facts({ quotes: 0 }));
  assert.equal(evaluateStageMove(input).allowed, false);
  assert.deepEqual(
    evaluateStageMove({ ...input, facts: factsAfterRemedy(input.facts, QUOTE) }),
    CLEAR_VERDICT,
  );
});

test("a lead that already has a quote is not asked to raise another", () => {
  // The behaviour that distinguishes a remedy from the old `entryAction`: the
  // criterion is EVALUATED, so the dialog does not open for work already done.
  assert.deepEqual(evaluateStageMove(moveInput(derivedCriteria(QUOTE), facts({ quotes: 1 }))), CLEAR_VERDICT);
});

test("the effect moves latestStatus too, so a rule it breaks is reported", () => {
  // The quote created is by definition the most recent one, and it is a DRAFT. A
  // stage requiring "the latest quote is accepted" is therefore NOT satisfied
  // afterwards, and the gate has to say so — declaring only `count` would let this
  // remedy quietly break that rule while reporting the move as clear. Same class
  // as the `not(...)` case: an effect can tighten a verdict, not only loosen it.
  const rule: StageCriteriaGroup = {
    logic: "and",
    conditions: [{ field: "quote.latestStatus", operator: "equals", value: "accepted" }],
  };
  const input = moveInput(rule, facts({ quotes: 1, latestStatus: "accepted" }));
  assert.deepEqual(evaluateStageMove(input), CLEAR_VERDICT, "an accepted latest quote satisfies it");

  const after = evaluateStageMove({ ...input, facts: factsAfterRemedy(input.facts, QUOTE) });
  assert.equal(after.allowed, false, "raising a draft makes the latest quote a draft, and that fails");
});

test("the effect does not mutate the snapshot it is given", () => {
  const before = facts({ quotes: 0, latestStatus: null });
  factsAfterRemedy(before, QUOTE);
  assert.equal(before.quote.count, 0);
  assert.equal(before.quote.latestStatus, null);
});

/* ── the four coordinated seams ─────────────────────────────────────────── */

test("the vocabulary agrees across the tuple, the metadata and the registry", () => {
  assert.ok(PIPELINE_STAGE_ACTIONS.includes("attach_quote"));
  assert.ok(PIPELINE_STAGE_ACTION_META.attach_quote, "the settings picker reads its label from here");
  assert.equal(remedyFor("attach_quote"), QUOTE);
  // Every action in the tuple must have a remedy, or the settings screen offers a
  // required action the board cannot help anybody satisfy.
  for (const action of PIPELINE_STAGE_ACTIONS) {
    assert.ok(remedyFor(action), `${action} is offered in settings with no remedy behind it`);
  }
});

test("the migration widens the CHECK reentrantly, and guards on the new value", () => {
  const sql = src("prisma/migrations/20260814120000_stage_remedy_attach_quote/migration.sql");
  // The runner opens NO transaction, so a half-applied migration is a real
  // failure mode. This one WIDENS an existing constraint, so it must drop before
  // adding — and the guard has to be keyed on the NEW value, or a full re-run
  // would drop and rebuild a constraint that was already correct.
  assert.match(sql, /pg_get_constraintdef\(oid\) LIKE '%attach_quote%'/);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS "PipelineStage_entryAction_check"/);
  assert.match(sql, /NOT VALID/, "the two-step takes a weaker lock than a validating ADD");
  assert.match(sql, /VALIDATE CONSTRAINT "PipelineStage_entryAction_check"/);
  // Additive and inert: it must not touch a single row.
  //
  // Asserted against the SQL with its `--` comments stripped. This suite has been
  // caught four times now by prose matching a pattern meant for code — here the
  // migration's own header explains that a missing migration "fails at the INSERT",
  // which is exactly the word being forbidden.
  const statements = sql.replace(/^\s*--.*$/gm, "");
  assert.doesNotMatch(statements, /\bUPDATE\b|\bINSERT\b|\bDELETE\b/i);
});

/* ── the action ─────────────────────────────────────────────────────────── */

test("the quote remedy needs quotes.create on top of leads.change_stage", () => {
  // A stage rule must not become a way to perform a write the caller is not
  // entitled to make — the same reason the customer-link remedy demands
  // leads.link_contact.
  const body = actionBody("moveLeadWithNewQuoteInScope");
  assert.match(body, /requireLeadAccess\(leadId, "leads\.change_stage"\)/);
  assert.match(body, /hasPermission\(user, "quotes\.create"\)/);
  const perm = body.indexOf('hasPermission(user, "quotes.create")');
  const write = body.indexOf("basePrisma.$transaction");
  assert.ok(perm > 0 && perm < write, "the permission must be checked before the write");
});

test("it refuses a stage that does not ask for a quote", () => {
  // So the action cannot be used as a way into an unrelated stage, matching the
  // guard on both sibling remedies.
  assert.match(
    actionBody("moveLeadWithNewQuoteInScope"),
    /targetStage\.entryAction !== "attach_quote"[\s\S]*?does not ask for a quote/,
  );
});

test("it binds the acting workspace, like the other standalone actions", () => {
  const code = shipped("src/app/actions/leads.ts");
  const start = code.indexOf("export async function moveLeadWithNewQuote(");
  assert.ok(start >= 0);
  const body = code.slice(start, code.indexOf("\nasync function moveLeadWithNewQuoteInScope", start));
  assert.match(body, /withActingStaffScope\(/);
});

test("the quote, the move and both audits share one transaction", () => {
  // The atomicity rule the sibling remedies were reviewed into: a quote created
  // without the move, or a move without its audit, is three outcomes where there
  // should be one.
  const body = actionBody("moveLeadWithNewQuoteInScope");
  const tx = body.indexOf("basePrisma.$transaction");
  assert.ok(tx > 0);
  for (const inside of [
    "insertQuoteFromLead(tx",
    "tx.lead.updateMany",
    'action: "quote.created"',
    'action: "lead.stage_changed"',
    'action: "lead.stage_gate_overridden"',
  ]) {
    assert.ok(body.indexOf(inside) > tx, `${inside} must be inside the transaction`);
  }
  // Audits written with the transaction client, or they commit independently.
  assert.equal((body.match(/\}, tx\);/g) ?? []).length, 3, "all three audits take tx");
});

test("the bypass client is compensated for, not merely used", () => {
  // basePrisma is required here because Quote.number is GLOBALLY unique and
  // nextQuoteNumber computes MAX(number)+1 — on the scoped client that maximum is
  // per workspace, so it would hand back a number another workspace holds. The
  // cost is that no tenant filter is applied, so every write must name the owner.
  const body = actionBody("moveLeadWithNewQuoteInScope");
  assert.match(body, /where: \{ id: leadId, tenantId \}/, "the lead update must name the workspace itself");
  assert.match(body, /if \(moved\.count !== 1\) throw/, "and check it matched, rather than updating nothing");
  assert.match(body, /if \(!before\.tenantId\)/, "a lead with no workspace has no owner to stamp");
  // Ownership is established through the GUARDED client before the bypass runs.
  const guardedRead = body.indexOf("prisma.lead.findUnique");
  assert.ok(guardedRead > 0 && guardedRead < body.indexOf("basePrisma.$transaction"));
});

test("it re-runs the rule against the facts it creates", () => {
  assert.match(
    actionBody("moveLeadWithNewQuoteInScope"),
    /factsAfterRemedy\(gated\.move\.facts, STAGE_REMEDIES\.attach_quote\)/,
  );
});

test("the seeded-quote definition is shared with the plain create path", () => {
  // Otherwise the remedy grows a second copy of "what a quote from a lead
  // contains" and it drifts the first time somebody changes what is pre-filled.
  for (const rel of ["src/app/actions/leads.ts", "src/app/actions/quotes.ts"]) {
    assert.match(shipped(rel), /insertQuoteFromLead\(/, `${rel} must use the shared insert`);
  }
  // …and the settings read stays OUTSIDE the transaction, so the quote-number
  // advisory lock is not held across two AppSetting lookups.
  const lib = shipped("src/lib/quoteFromLead.ts");
  assert.match(lib, /export async function quoteFromLeadDefaults/);
  assert.doesNotMatch(lib.slice(lib.indexOf("export async function insertQuoteFromLead")), /getSetting\(/);
});

/* ── the board ──────────────────────────────────────────────────────────── */

test("the board dispatches on the registry's dialog, exhaustively", () => {
  // The old `if (test_drive) … else contact_link` would have sent this remedy to
  // the customer picker — the final branch silently becomes the default for
  // anything new. A switch over the union makes an unwired dialog a type error.
  const board = shipped("src/components/KanbanBoard.tsx");
  assert.match(board, /switch \(STAGE_REMEDIES\[result\.remedy\]\.dialog\)/);
  for (const dialog of ["test_drive", "contact_link", "quote_create"]) {
    assert.match(board, new RegExp(`case "${dialog}":`), `${dialog} must have its own branch`);
  }
  assert.doesNotMatch(board, /remedy\.dialog === "test_drive"/, "the if/else form is what this replaced");
});

test("the reason retry comes back through the quote path", () => {
  // A stage can want the quote AND something else. Falling through to a plain
  // requestMove would be refused for the quote that does not exist yet, so the
  // retry has to know which remedy it is retrying.
  const board = shipped("src/components/KanbanBoard.tsx");
  const start = board.indexOf("function confirmGateOverride");
  const body = board.slice(start, board.indexOf("\n  function onDragEnd", start));
  assert.match(body, /if \(newQuote\) \{\s*\n\s*submitNewQuote\(lead, stageId, reason\);/);
  // …and it must be decided BEFORE the plain move at the end.
  assert.ok(body.indexOf("newQuote") < body.indexOf("requestMove(lead, stageId, reason)"));
});

test("the board opens the real editor once the draft exists", () => {
  // The confirmation is not the quote editor — that dialog is 77KB and needs
  // products, settings and fee definitions, which would land in the leads page's
  // payload for a stage most boards do not have. So the work happens in the real
  // editor afterwards.
  const board = shipped("src/components/KanbanBoard.tsx");
  assert.match(board, /router\.push\(`\/quotes\?edit=\$\{result\.quoteId\}`\)/);
  assert.doesNotMatch(board, /QuoteEditorDialog/, "the editor must not be mounted on the board");
});

/** One exported-or-private action's body, bounded by the next declaration. */
function actionBody(name: string): string {
  const code = shipped("src/app/actions/leads.ts");
  const start = code.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const end = code.indexOf("\nexport async function", start + 1);
  assert.ok(end > start, `${name} must be followed by another export for this slice to be bounded`);
  return code.slice(start, end);
}
