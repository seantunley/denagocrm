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
  const gate = moveLead.indexOf("gateStageMove(");
  const update = moveLead.indexOf("prisma.lead.update(");
  assert.ok(update > gate, "the stage write must not happen before the gate decides");
});

test("a refused move writes nothing", () => {
  // The refusal returns before the update. Asserted as a shape rather than a
  // string: every `return { ok: false` in the gate section has to come before
  // the first write.
  const update = moveLead.indexOf("prisma.lead.update(");
  const refusals = [...moveLead.matchAll(/return \{ ok: false/g)].map((m) => m.index ?? -1);
  assert.ok(refusals.length > 0);
  const gate = moveLead.indexOf("gateStageMove(");
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
  const overrideBlock = moveLead.slice(moveLead.indexOf("lead.stage_gate_overridden") - 400);
  assert.ok(
    overrideBlock.indexOf("logAuditStrict") < overrideBlock.indexOf("lead.stage_gate_overridden"),
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
