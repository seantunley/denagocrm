import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

/**
 * Where the gate sits in `moveLead`, and what it is allowed to read.
 *
 * SOURCE-PATTERNED, AND SAID SO. `stageGate.test.ts` executes the rules; nothing
 * here can, because the properties below are about ORDER and about which client
 * a query goes through, and asserting those for real needs a live two-tenant
 * database — the harness behind `npm run test:tenant-isolation`, which needs
 * Postgres. These are the cheap guards that survive without it, and they are
 * exactly as strong as a regex, which is to say: they catch a deletion or a
 * reordering, and they do not prove behaviour.
 *
 * The one thing they genuinely protect is the property that made the whole
 * feature safe to ship — that a gate cannot be reached before the permission
 * checks that precede it, and cannot read a stage from another workspace.
 */

const leads = src("src/app/actions/leads.ts");
const moveLead = leads.slice(
  leads.indexOf("export async function moveLead("),
  leads.indexOf("export async function moveLeadToTestDrive("),
);

/**
 * `moveLead` with comments stripped.
 *
 * Every POSITIONAL assertion below uses this rather than the raw text. This file
 * documents the defects it guards against, in prose, inside the very function it
 * is measuring — so a naive indexOf("lead.stage_changed") finds the sentence
 * explaining the fix before it finds the call. Twice now.
 */
const moveLeadCode = moveLead.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** The gate helper lives above `moveLead`, so it is sliced separately. */
const gateHelper = leads.slice(
  leads.indexOf("async function gateStageMove("),
  leads.indexOf("const BROKEN_RULE_MESSAGE"),
);

test("the gate runs after access control, not instead of it", () => {
  // A gate is a business rule, not a boundary. If it ran first it would be
  // deciding moves for leads the caller was never allowed to touch, and its
  // refusal sentence would confirm the lead exists.
  const access = moveLead.indexOf("requireLeadAccess(");
  const pipelinePermission = moveLead.indexOf("leads.change_pipeline");
  const gate = moveLead.indexOf("gateStageMove(");
  assert.ok(access >= 0 && pipelinePermission >= 0 && gate >= 0, "moveLead lost one of its checks");
  assert.ok(access < gate, "requireLeadAccess must precede the gate");
  assert.ok(pipelinePermission < gate, "the cross-pipeline permission must precede the gate");
});

test("the gate runs before the write, not after it", () => {
  const gate = moveLeadCode.indexOf("gateStageMove(");
  const update = moveLeadCode.indexOf("tx.lead.update(");
  assert.ok(gate >= 0 && update >= 0, "moveLead lost the gate or the write");
  assert.ok(update > gate, "the stage write must not happen before the gate decides");
});

test("the move and its mandatory audits commit together", () => {
  // These were three separate awaits — update, stage_changed, stage_gate_overridden
  // — and a strict audit THROWS on failure. So either audit failing left the lead
  // already moved while the action reported an error, and the override could be
  // lost while the move it excuses stood. The override event is the entire point
  // of allowing an override at all.
  const tx = moveLeadCode.indexOf("prisma.$transaction(");
  const update = moveLeadCode.indexOf("tx.lead.update(");
  const changed = moveLeadCode.indexOf("lead.stage_changed");
  const overridden = moveLeadCode.indexOf("lead.stage_gate_overridden");
  assert.ok(tx >= 0, "the move must open a transaction");
  for (const [name, at] of [["the update", update], ["stage_changed", changed], ["the override event", overridden]] as const) {
    assert.ok(at > tx, `${name} must be inside the transaction`);
  }
  // Both audits must be written ON the transaction, not beside it.
  const body = moveLeadCode.slice(tx, moveLeadCode.indexOf("}, GOVERNANCE_TX);"));
  assert.equal(
    [...body.matchAll(/\}, tx\);/g)].length,
    2,
    "both strict audits must be handed the transaction",
  );
});

test("a refused move writes nothing", () => {
  // The refusal returns before the update. Asserted as a shape rather than a
  // string: every `return { ok: false` in the gate section has to come before
  // the first write.
  const update = moveLeadCode.indexOf("tx.lead.update(");
  const refusals = [...moveLeadCode.matchAll(/return \{ ok: false/g)].map((m) => m.index ?? -1);
  assert.ok(refusals.length > 0);
  const gate = moveLeadCode.indexOf("gateStageMove(");
  const gateRefusals = refusals.filter((index) => index > gate);
  assert.ok(gateRefusals.length >= 2, "expected the broken-rule and blocked refusals");
  for (const index of gateRefusals) assert.ok(index < update, "a gate refusal must return before the write");
});

test("the source stage is resolved through the tenant-filtered helper", () => {
  // `getPipelineStage` carries `tenantFilter`, so a stage id from another
  // workspace resolves to null and contributes no rule. Reading PipelineStage
  // directly here — on basePrisma, as everything else in pipelines.ts does —
  // would let another tenant's rule decide this tenant's move.
  assert.ok(gateHelper.includes("getPipelineStage("), "the source stage must come from getPipelineStage");
  assert.ok(!/basePrisma/.test(gateHelper), "the gate must not reach for the RLS bypass");
  assert.ok(
    !/\$queryRaw|prisma\.pipelineStage/.test(gateHelper),
    "the gate must not query PipelineStage directly — only the tenant-filtered helper",
  );
});

test("facts are re-derived server-side and never read from the request", () => {
  // The client's snapshot greys a column; it is not an argument. `moveLead`
  // takes only `overrideReason` from the caller — a fact parameter would make
  // the board's stale copy authoritative and the gate trivially forgeable.
  assert.ok(gateHelper.includes("stageGateFactsForLead("), "the gate must build its own facts");
  const signature = moveLead.slice(0, moveLead.indexOf("): Promise<"));
  assert.ok(!/facts/i.test(signature), "moveLead must not accept facts from the caller");
  // The only thing the caller contributes to a gate decision.
  assert.ok(/options\?: \{ overrideReason\?: string \}/.test(signature), "unexpected gate input from the caller");
});

test("an override is only reachable with a reason the server measured", () => {
  // The dialog is a courtesy; the length check is the control. A POST that skips
  // the dialog has to meet the same bar.
  assert.ok(moveLead.includes("MIN_OVERRIDE_REASON"), "the reason length must be enforced here");
  assert.ok(
    /verdict\.requiresReason && overrideReason\.length < MIN_OVERRIDE_REASON/.test(moveLead),
    "the reason gate must test the server-side value",
  );
});

test("an override is audited as its own event, not a footnote on the move", () => {
  assert.ok(moveLead.includes("lead.stage_gate_overridden"), "overrides need their own action name");
  assert.ok(moveLead.includes("logAuditStrict"), "an override must go to the append-only trail");
  // `logAudit` (best-effort) is right for a refusal and wrong for an override:
  // AuditEvent's triggers refuse UPDATE and DELETE, and an override you can edit
  // afterwards is not a record of anything.
  const at = moveLeadCode.indexOf("lead.stage_gate_overridden");
  const preceding = moveLeadCode.slice(0, at);
  assert.ok(
    preceding.lastIndexOf("logAuditStrict(") > preceding.lastIndexOf("logAudit({"),
    "the override event must be written with logAuditStrict",
  );
});

test("a blocked move is recorded, because a refusal log is how a bad rule is found", () => {
  assert.ok(moveLead.includes("lead.stage_gate_blocked"), "refusals must leave a trace");
  // Best-effort on purpose: a failed audit write must not turn a refusal into an
  // error the person cannot act on.
  const blockedAt = moveLead.indexOf("lead.stage_gate_blocked");
  const before = moveLead.slice(Math.max(0, blockedAt - 200), blockedAt);
  assert.ok(/logAudit\(\{/.test(before), "a refusal should use the best-effort logger");
});

/* ── the board can actually USE the modes the settings screen offers ─────── */

const board = src("src/components/KanbanBoard.tsx");
const boardCode = board.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("a verdict asking for a reason opens a dialog rather than a failure toast", () => {
  // The server answers `{ ok: false, gate: { requiresReason: true } }` with NO
  // error, because it is asking rather than refusing. The board read the falsy
  // `ok`, rolled back and said "Couldn't move the lead" — so a stage set to "ask
  // for a reason" could not be entered at all, and an OWNER could never move a
  // lead past their own blocking rule, owners holding every permission and so
  // always resolving to the override path.
  assert.match(
    boardCode,
    /if \(!result\.ok && result\.gate\?\.requiresReason\) \{/,
    "the board must recognise a reason request",
  );
  const branch = boardCode.slice(boardCode.indexOf("if (!result.ok && result.gate?.requiresReason)"));
  assert.ok(branch.indexOf("setPendingGate(") < branch.indexOf("}"), "it must open the dialog");
  // And it must NOT go through rollbackTo, which toasts an error.
  const upToClose = branch.slice(0, branch.indexOf("return;"));
  assert.ok(!upToClose.includes("rollbackTo("), "asking for a reason is not an error");
});

test("the retry carries the reason back to the same action", () => {
  assert.match(
    boardCode,
    /moveLead\(lead\.id, targetStageId, overrideReason \? \{ overrideReason \} : undefined\)/,
    "the retry must pass the reason through",
  );
  assert.match(boardCode, /function confirmGateOverride\(reason: string\)/);
  assert.match(boardCode, /requestMove\(lead, stageId, reason\)/, "confirming must re-run the move");
});

test("a warning names what was missing, on screen and not only in the audit", () => {
  // `moveLead` returns its verdict on SUCCESS too. Without that a `warn` gate's
  // whole purpose — saying what is missing — reached the audit trail and nowhere
  // the person who moved the card would look.
  assert.match(src("src/app/actions/leads.ts"), /return \{ ok: true, gate: verdict \};/);
  assert.match(boardCode, /result\.gate\?\.mode === "warn" && result\.gate\.unmet\.length > 0/);
  assert.match(boardCode, /toast\.warning\(/, "a warning is a warning, not an error");
});

test("the board and the server describe an unmet criterion with one function", () => {
  // A second copy of this wording is how the refusal and the warning start
  // disagreeing about the same rule.
  // No `s` flag: `[^}]` already matches newlines, and dotAll needs an es2018
  // target this project does not set — CI caught it, because I added this test
  // after the last typecheck and only re-ran the test runner.
  assert.match(board, /import \{[^}]*describeUnmet[^}]*\} from "@\/lib\/stageGate"/);
  assert.ok(!/function describeUnmet/.test(board), "the board must not restate it");
  // The reason length lives in the pure module for the same reason: the dialog's
  // disabled button and the server's refusal must use one number.
  assert.match(board, /MIN_OVERRIDE_REASON/);
  assert.match(src("src/lib/stageGate.ts"), /export const MIN_OVERRIDE_REASON = 10;/);
  assert.ok(
    !/const MIN_OVERRIDE_REASON = \d+/.test(src("src/app/actions/leads.ts")),
    "the action must import the shared value, not declare its own",
  );
});

test("the test-drive path is gated too, and can carry a reason", () => {
  // A stage may carry BOTH a required action and entry criteria, and the board
  // routes a required-action stage straight to the booking dialog — so `moveLead`,
  // where the gate lived, was never called for those stages. The rules were
  // skipped on exactly the stages most likely to have them.
  const leads = src("src/app/actions/leads.ts");
  const testDrive = leads.slice(leads.indexOf("export async function moveLeadToTestDrive("));
  const code = testDrive.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(code.includes("gateStageMove("), "the booking path must run the gate");
  assert.ok(code.includes("MIN_OVERRIDE_REASON"), "and enforce the reason length itself");
  assert.ok(code.includes("lead.stage_gate_overridden"), "an override here is audited like any other");
  // INSIDE the transaction that moves the lead and books the drive. Written
  // after it, a failing strict audit left the lead moved AND the booking created
  // while the action reported an error — the same partial success fixed for
  // ordinary moves, reintroduced here when the gate was added to this path.
  const tx = code.indexOf("prisma.$transaction(");
  const override = code.indexOf("lead.stage_gate_overridden");
  const txEnd = code.indexOf("}, GOVERNANCE_TX);");
  assert.ok(tx >= 0 && txEnd > tx, "the booking must run in a transaction with audit-sized limits");
  assert.ok(override > tx && override < txEnd, "the override record must commit with the move and the booking");
  assert.match(code.slice(tx, txEnd), /\}, tx\);/, "and be written ON that transaction");
  // Only when the stage actually changes: rescheduling a booking on the stage the
  // lead already sits in is not a transition, and gates never judge residency.
  assert.match(code, /if \(changingStage\) \{\s+const gated = await gateStageMove/);

  // The board keeps the booking details across the reason prompt rather than
  // making somebody fill the form in twice.
  assert.match(boardCode, /testDrive\?: \{ productId: string \| null/);
  assert.match(boardCode, /submitTestDrive\(lead, stageId, testDrive, reason\)/);
  // Taking the target as an argument, not re-reading state a frame later.
  assert.match(boardCode, /function submitTestDrive\(\s*lead: KanbanLead,\s*stageId: string,/);
  assert.ok(!/setTimeout\(\(\) => confirmTestDrive/.test(boardCode), "no timing hack");
});

test("the edit form's stage picker is gated too", () => {
  // LeadForm carries a stageId select, so a rule enforced only in `moveLead`
  // would be walked around by opening the lead and choosing the stage from a
  // dropdown. A gate the product offers a way past is not a gate.
  const leads = src("src/app/actions/leads.ts");
  const updateLead = leads.slice(
    leads.indexOf("export async function updateLead("),
    leads.indexOf("async function gateStageMove("),
  );
  assert.ok(updateLead.includes("gateStageMove("), "updateLead must run the same gate");
  const code = updateLead.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(code.includes("refusalSentence("), "and refuse with the same sentence");
  // No override path on this screen: an override must be RECORDED with a reason,
  // and this form has nowhere to type one.
  assert.ok(!code.includes("overrideReason"), "the edit form must not offer a quiet override");
  assert.ok(
    code.includes("requiresReason"),
    "a move needing a reason must be refused here, not silently allowed",
  );
});

/* ── authoring: the settings path cannot silently destroy a rule ─────────── */

const pipelineActions = src("src/app/actions/pipelines.ts");

test("criteria are parsed in the action, where a refusal can be shown", () => {
  // `parseStageCriteria` throws a human sentence; only this layer is wrapped in
  // `asActionResult`, which turns one into a toast. Parsing inside the raw
  // UPDATE would surface it as a generic failure on the one error the author can
  // actually fix.
  assert.ok(pipelineActions.includes("parseStageCriteria("), "the action must parse the criteria");
  assert.ok(!src("src/lib/pipelines.ts").includes("parseStageCriteria("), "pipelines.ts must only store them");
});

test("a rule the editor cannot show is kept, not overwritten", () => {
  // The read-only path posts no criteria field at all, and `{ keep: true }` is
  // what stops the next unrelated save from deleting the rule. This is the same
  // silent-write-loss shape the trash sweep was fixed for.
  assert.ok(pipelineActions.includes("keep: true"), "an absent field must mean keep");
  assert.ok(
    /if \(!formData\.has\(key\)\) return \{ keep: true \}/.test(pipelineActions),
    "the keep decision must hang off the field being absent",
  );
  const editor = src("src/components/StageRulesEditor.tsx");
  assert.ok(
    /\{!unsupported && <input type="hidden"/.test(editor),
    "the editor must not post a criteria value it cannot round-trip",
  );
});

test("the stage update writes every gate column it names", () => {
  // The input type is required rather than optional so that forgetting one is a
  // compile error instead of a silently cleared rule.
  const pipelines = src("src/lib/pipelines.ts");
  const input = pipelines.slice(
    pipelines.indexOf("export async function updatePipelineStage("),
    pipelines.indexOf("export async function reorderPipelineStages("),
  );
  for (const field of ["entryCriteria", "exitCriteria", "entryGateMode", "exitGateMode"]) {
    assert.ok(new RegExp(`${field}:`).test(input), `${field} must be part of the update input`);
    assert.ok(new RegExp(`"${field}" =`).test(input), `${field} must be written by the statement`);
    assert.ok(!new RegExp(`${field}\\?:`).test(input), `${field} must not be optional`);
  }
});

/* ── the migration ships inert ──────────────────────────────────────────── */

test("every gate column arrives with a default that cannot enforce anything", () => {
  const migration = src("prisma/migrations/20260813120000_stage_gates/migration.sql");
  // NULL criteria and 'off' modes are what make this deployable on a live board
  // with no behaviour change and no backfill.
  assert.ok(/"entryCriteria" JSONB;/.test(migration), "criteria must be nullable with no default");
  assert.ok(/"exitCriteria"\s+JSONB;/.test(migration), "criteria must be nullable with no default");
  assert.ok(/"entryGateMode" TEXT NOT NULL DEFAULT 'off'/.test(migration));
  assert.ok(/"exitGateMode"\s+TEXT NOT NULL DEFAULT 'off'/.test(migration));
  // The runner opens no transaction, so a half-applied migration is a real
  // failure mode and every statement has to be reentrant.
  const alters = [...migration.matchAll(/ALTER TABLE "PipelineStage" ADD COLUMN/g)];
  assert.equal(alters.length, 4);
  assert.equal([...migration.matchAll(/ADD COLUMN IF NOT EXISTS/g)].length, 4, "every ADD COLUMN must be reentrant");
});
