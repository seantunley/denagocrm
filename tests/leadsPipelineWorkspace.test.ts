import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const pageSource = readFileSync(join(process.cwd(), "src", "app", "(app)", "leads", "page.tsx"), "utf8");
const boardSource = readFileSync(join(process.cwd(), "src", "components", "KanbanBoard.tsx"), "utf8");
const leadActionsSource = readFileSync(join(process.cwd(), "src", "app", "actions", "leads.ts"), "utf8");

test("lead pipeline activity summaries stay bounded", () => {
  assert.equal(
    pageSource.match(/SELECT DISTINCT ON \("leadId"\)/g)?.length,
    2,
    "expected one bounded query for the next activity and one for the next test drive",
  );
  assert.doesNotMatch(
    pageSource,
    /activities:\s*\{\s*where:\s*\{\s*status:\s*"planned"\s*\},\s*orderBy/,
    "do not restore an unbounded nested planned-activity row load",
  );
});

test("lead pipeline preserves production card signals", () => {
  assert.match(pageSource, /signing:\s*signingByLead\.get\(lead\.id\)/);
  assert.match(pageSource, /stage\.order < testDriveStage\.order/);
  assert.match(pageSource, /stage\.entryAction === "book_test_drive"/);
  assert.match(boardSource, /target\.entryAction === "book_test_drive"/);
  assert.doesNotMatch(boardSource, /\/test\/i\.test\(target\.name\)/);
  assert.match(boardSource, /follow-up automation/);
  assert.match(boardSource, /lead\.signing\.label/);
});

test("lead board staff pickers and mutations stay inside the active tenant", () => {
  assert.match(pageSource, /listActingTenantStaff\(\)/);
  assert.doesNotMatch(pageSource, /prisma\.user\.findMany/);
  // Same intent as before — the board's assign action must check membership —
  // but asserted against the SHARED contract rather than this file's own former
  // copy of it. `resolveTenantMemberUser` is the raw lookup underneath;
  // `resolveAssignableUser` is the lookup plus the refusal rule, and going
  // through it is what stops the four copies drifting apart again.
  assert.match(leadActionsSource, /resolveAssignableUser\(assignedToId, ASSIGNEE_LABEL\)/);
  assert.doesNotMatch(leadActionsSource, /\bresolveTenantMemberUser\s*\(/);
});

test("lead card actions share the required-action stage gate", () => {
  assert.match(boardSource, /function LeadMenuItems/);
  assert.match(boardSource, /Right-click or press Shift\+F10 for actions/);
  assert.match(boardSource, /move: \(stageId\) => requestMove\(lead, stageId\)/);
  assert.match(boardSource, /Reschedule test drive/);
  assert.match(boardSource, /Schedule activity/);
  assert.match(boardSource, /Assign owner/);
  assert.match(boardSource, /Mark won/);
  assert.match(boardSource, /Mark lost/);
  assert.match(boardSource, /Copy lead link/);
});

test("rescheduling a test drive updates the planned activity without replaying stage automations", () => {
  assert.match(leadActionsSource, /findFirst\(\{[\s\S]+type: "test_drive", status: "planned"/);
  // runLeadAutomations is retired; the Journey engine is the one automation
  // engine now and emitLeadJourneyEvent is how a write path reaches it.
  assert.match(leadActionsSource, /if \(changingStage\) await emitLeadJourneyEvent\("stage_entered", leadId\)/);
});

test("needs-attention filtering includes overdue work", () => {
  assert.match(
    boardSource,
    /lead\.noNextStep\s*\|\|\s*lead\.nextStep\?\.overdue\s*\|\|/,
    "overdue activities must remain visible when Needs attention is enabled",
  );
});

test("required stage actions cannot be bypassed through the generic move action", () => {
  // THE PROPERTY IS UNCHANGED; THE MECHANISM MOVED.
  //
  // `moveLead` used to refuse any stage carrying an entryAction outright, with
  // "This stage requires test-drive booking details". A required action is now a
  // REMEDY — a rule plus a form that satisfies it — so the refusal comes from the
  // rule being unmet, and instead of a dead end the caller is told which dialog
  // to open. Either way the lead does not move.
  //
  // What changed on purpose: a lead that ALREADY has a booked test drive now
  // satisfies the rule and moves straight in, where before the dialog opened
  // regardless. That is why the old literal cannot simply be re-asserted.
  const moveLead = leadActionsSource.slice(
    leadActionsSource.indexOf("export async function moveLead("),
    leadActionsSource.indexOf("export async function moveLeadToTestDrive("),
  );
  const write = moveLead.indexOf("prisma.$transaction(");
  const offer = moveLead.indexOf("if (gateOutcome.remedy)");
  assert.ok(offer >= 0, "the generic move must hand back the remedy rather than moving");
  assert.ok(offer < write, "and it must do so BEFORE the write");
  assert.match(moveLead, /return \{ ok: false, gate: verdict, remedy: gateOutcome\.remedy\.id \}/);

  // The bespoke booking action still refuses a stage that does not ask for one,
  // so it cannot be used as a way into an unrelated stage.
  assert.match(
    leadActionsSource,
    /targetStage\.entryAction !== "book_test_drive"[\s\S]+not configured for test-drive booking/,
  );
  assert.doesNotMatch(leadActionsSource, /\/test\/i\.test\(s\.name\)/);
});
