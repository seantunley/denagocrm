import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { dryRunJourney, type DryRunScenario } from "../src/lib/journeyDryRun";

const context = { event: {}, lead: { source: "facebook", name: "Thandi M" }, contact: { firstName: "Thandi" } };
const templateVars = (ctx: Record<string, unknown>) => ({ first_name: String((ctx.contact as { firstName?: string } | null)?.firstName ?? "there") });
const run = (definition: unknown, scenario?: DryRunScenario, ctx: Record<string, unknown> = context) =>
  dryRunJourney({ definition, context: ctx, scenario: { start: "2026-11-04T08:00:00.000Z", ...scenario }, templateVars });

const fromFacebook = { logic: "and", conditions: [{ field: "lead.source", operator: "equals", value: "facebook" }] };
const welcome = {
  startStepId: "email",
  steps: [
    { id: "email", type: "send_email", config: { subject: "Hi {{first_name}}", body: "Welcome" }, nextStepId: "pause" },
    { id: "pause", type: "wait", config: { amount: 2, unit: "days" }, nextStepId: "fb" },
    { id: "fb", type: "condition", config: { condition: fromFacebook, trueStepId: "sms", falseStepId: "end" } },
    { id: "sms", type: "send_sms", config: { message: "Still keen, {{first_name}}?" }, nextStepId: "end" },
    { id: "end", type: "stop", config: {} },
  ],
};

test("a dry run walks the Journey on a pretend clock and says what each step would do", () => {
  const out = run(welcome);
  assert.deepEqual(out.steps.map((s) => [s.stepId, s.outcome]), [["email", "would_do"], ["pause", "waited"], ["fb", "decided"], ["sms", "would_do"], ["end", "stopped"]]);
  assert.match(out.steps[0].note, /Would send an email: “Hi Thandi”/);
  assert.equal(out.steps[3].at, "2026-11-06T08:00:00.000Z", "the SMS goes two days later");
  assert.match(out.steps[3].note, /Still keen, Thandi\?/);
  assert.equal(out.ended, "stopped");
});

test("the scenario can force a decision the lead's data would not take", () => {
  const out = run(welcome, { conditions: { fb: false } });
  assert.deepEqual(out.steps.map((s) => s.stepId), ["email", "pause", "fb", "end"]);
  assert.match(out.steps[2].note, /did not match \(your scenario\)/);
});

test("branches and loops run as the engine runs them; a wait that times out can end the run", () => {
  const out = run({
    startStepId: "pick",
    steps: [
      { id: "pick", type: "choose", config: { options: [{ conditions: fromFacebook, sequence: [{ id: "fbtask", type: "create_activity", config: { activityType: "call", summary: "Call {{first_name}}", dueDays: 0 } }] }], default: [{ id: "other", type: "send_push", config: { message: "x" } }] }, nextStepId: "loop" },
      { id: "loop", type: "repeat", config: { mode: "count", count: 2, sequence: [{ id: "nudge", type: "send_push", config: { message: "Nudge" } }] }, nextStepId: "signed" },
      { id: "signed", type: "wait_for_trigger", config: { triggers: ["quote_signed"], timeoutMinutes: 1440, continueOnTimeout: false }, nextStepId: "after" },
      { id: "after", type: "send_email", config: { subject: "Thanks" } },
    ],
  }, { triggers: { signed: "times_out" } });
  assert.deepEqual(out.steps.map((s) => s.stepId), ["pick", "fbtask", "loop", "nudge", "nudge", "signed"]);
  assert.match(out.steps[1].note, /Call Thandi/);
  assert.equal(out.ended, "stopped", "continueOnTimeout:false ends the run");
  assert.equal(out.endedAt, "2026-11-05T08:00:00.000Z");
});

test("variables set by a step are shown and reach later steps; with no lead it still walks", () => {
  const out = run({
    startStepId: "v",
    steps: [
      { id: "v", type: "variables", config: { set: { offer: "10% off" } }, nextStepId: "e" },
      { id: "e", type: "send_email", config: { subject: "{{var_offer}} for you" } },
    ],
  }, {}, { event: {}, lead: null, contact: null });
  assert.deepEqual(out.steps[0].vars, { offer: "10% off" });
  assert.equal(out.ended, "finished");
});

/** Every module the dry run can reach, following relative imports. */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of readFileSync(file, "utf8").matchAll(/^import[^;]*?from "(\.[^"]+)"/gm)) {
      const next = [".ts", ".tsx", "/index.ts"].map((ext) => path.resolve(path.dirname(file), m[1]) + ext).find(existsSync);
      if (next) visit(next);
    }
  };
  visit(path.resolve(entry));
  return seen;
}

test("the dry run cannot reach anything that sends or writes", () => {
  for (const file of reachable("src/lib/journeyDryRun.ts")) {
    const code = readFileSync(file, "utf8");
    const name = path.basename(file);
    assert.doesNotMatch(code, /^import\s+"server-only"/m, `${name} is server-only`);
    assert.doesNotMatch(code, /from "\.\/(db|journeyStepExecutor|email|sms|push|whatsapp|tenantActor)"/, `${name} reaches a sender or the database`);
    assert.doesNotMatch(code, /from "@prisma\/client"/, `${name} reaches the database`);
  }
  const action = readFileSync("src/app/actions/journeyDryRun.ts", "utf8");
  assert.doesNotMatch(action, /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|emitJourneyEvent|processJourney|executeJourneyStep|logAudit/, "the dry-run action must not write");
  assert.match(action, /const user = await requirePermission\("journeys\.manage"\)/);
  // Review of #998: a crafted request skips the page's lead picker, so the lead is authorised here too.
  assert.match(action, /lead\.tenantId !== journey\.tenantId \|\| !\(await canAccessLead\(user, lead\.id\)\)\) return \{ ok: false as const, error: "Lead not found\." \}/);
  assert.ok(action.indexOf("canAccessLead(") < action.indexOf("loadJourneyContext("), "authorised before its data is loaded");
});
