import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { quoteDiscountPct } from "../src/lib/pricing";
import { applyChosen, compileWorkflow, evalCondition, workflowAsks, type WorkflowContext } from "../src/lib/signflow/compile";
import { CONDITION_LABEL, parseGraph, type WorkflowGraph } from "../src/lib/signflow/model";
import { askList, parseChosen } from "../src/lib/signflow/chosen";

/**
 * Signing workflows — the five things that made one unsafe to rely on.
 *
 * A rule on "Discount %" never fired; a step left for the sender to fill was
 * never asked for; the approver heard about it up to half an hour later, once,
 * with no way to send it again or hand it on; and none of it applied unless
 * somebody remembered to pick the workflow.
 *
 * The parts that are arithmetic or a graph walk are run here. What the queue and
 * the database do is in scripts/test-signing-workflows.ts.
 */
const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
/** Code only — a rule that survives solely in a comment is not a rule. */
const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ── Discount % ──────────────────────────────────────────────────────────────

const line = (unitPriceCents: number, discountPct = 0, extra: Record<string, unknown> = {}) => ({ qty: 1, unitPriceCents, discountPct, ...extra });

test("the discount on a quote is what was taken off its listed price, as a percentage", () => {
  assert.equal(quoteDiscountPct([]), 0);
  assert.equal(quoteDiscountPct([line(100_000)]), 0);
  assert.equal(quoteDiscountPct([line(100_000, 10)]), 10);
  assert.equal(quoteDiscountPct([{ qty: 2, unitPriceCents: 50_000, discountPct: 15 }]), 15);
  // Two lines: 12% off R200 000 and nothing off R40 000 is R24 000 off R240 000.
  assert.equal(quoteDiscountPct([line(20_000_000, 12), line(4_000_000)]), 10);
  assert.equal(quoteDiscountPct([line(23_400_000, 3.5), line(800_000)]), 3.4, "one decimal place");
});

test("it is the discount on the WHOLE quote, not the steepest line", () => {
  // 30% off a R500 accessory on a R240 000 vehicle is not a discounted deal.
  assert.equal(quoteDiscountPct([line(24_000_000), line(50_000, 30)]), 0.1);
});

test("only what the customer is charged for counts", () => {
  const vehicle = line(20_000_000, 10);
  assert.equal(quoteDiscountPct([vehicle, line(5_000_000, 50, { optional: true, selected: false })]), 10, "an add-on they did not take");
  assert.equal(quoteDiscountPct([vehicle, line(-3_000_000)]), 10, "a trade-in takes money off; it is not something a discount is measured against");
  assert.equal(quoteDiscountPct([vehicle, { qty: 0, unitPriceCents: 9_000_000, discountPct: 90 }]), 10, "a line of nothing");
  assert.equal(quoteDiscountPct([line(-1_000)]), 0, "nothing charged at all");
});

test("a rule on Discount % can fire, because the send path now measures it", () => {
  const rule = { id: "c", type: "condition" as const, field: "discount" as const, op: "gt" as const, value: "10", whenTrue: "a", whenFalse: "b" };
  const at = (discount: number): WorkflowContext => ({ total: 240_000, discount, segment: "retail", product: "Nomad" });
  assert.equal(evalCondition(rule, at(12.5)), true);
  assert.equal(evalCondition(rule, at(10)), false);
  assert.equal(evalCondition(rule, at(0)), false);

  const envelope = code("src/lib/signing/autoEnvelope.ts");
  assert.match(envelope, /const discount = quote \? quoteDiscountPct\(quote\.items\) : 0;/);
  assert.doesNotMatch(envelope, /discount: 0\b/, "the literal that made every discount rule read zero");
  assert.match(CONDITION_LABEL.discount, /whole quote/i, "the builder says which discount the rule is about");
});

// ── Choose at send ──────────────────────────────────────────────────────────

const STAFF = { u_sam: { name: "Sam Sales", email: "sam@example.test" } };
const PEOPLE = { customer: { name: "Jane Doe", email: "jane@example.test" }, staff: STAFF };
const VARS: WorkflowContext = { total: 600_000, discount: 12, segment: "retail", product: "Nomad" };

/** Our rep → (discount > 10 ? a manager approves, chosen at send) → the customer. A rejection goes to finance, a role. */
function graph(): WorkflowGraph {
  const parsed = parseGraph({
    start: "start",
    nodes: {
      start: { id: "start", type: "start", next: "rep" },
      rep: { id: "rep", type: "signer", label: "Our team", who: { mode: "staff", userId: "u_sam" }, role: "approver", next: "rule" },
      rule: { id: "rule", type: "condition", field: "discount", op: "gt", value: "10", whenTrue: "manager", whenFalse: "customer" },
      manager: { id: "manager", type: "approval", label: "Manager approval", mode: "decision", who: { mode: "ask" }, whenApproved: "customer", whenRejected: "finance" },
      finance: { id: "finance", type: "approval", label: "Finance review", mode: "decision", who: { mode: "role", role: "finance" }, whenApproved: "customer", whenRejected: "end" },
      customer: { id: "customer", type: "signer", label: "Customer", who: { mode: "customer" }, role: "signer", next: "end" },
      end: { id: "end", type: "end" },
    },
    positions: {},
  });
  assert.ok(parsed, "the test graph is a valid workflow");
  return parsed;
}

test("the sender is asked for every step on this record's path that has nobody in it", () => {
  const asks = workflowAsks(graph(), { ...PEOPLE, vars: VARS });
  assert.deepEqual(asks.map((ask) => ask.nodeId), ["manager", "finance"]);
  assert.deepEqual(asks[0], { nodeId: "manager", label: "Manager approval", kind: "approver", hint: null });
  assert.equal(asks[1].hint, "finance", "the role the designer named is shown beside the question");
  // Finance is only reached if the manager REJECTS. It is asked for anyway:
  // finding out after a rejection that nobody can be told is finding out too late.
});

test("a step the record never reaches is not asked about", () => {
  const smallDiscount = workflowAsks(graph(), { ...PEOPLE, vars: { ...VARS, discount: 5 } });
  assert.deepEqual(smallDiscount, [], "under the threshold the quote goes straight to the customer");
});

test("a member of staff who has left, a role and a blank address are all asked for; the owner and the customer are not", () => {
  const g = graph();
  g.nodes.rep = { id: "rep", type: "signer", label: "Our team", who: { mode: "staff", userId: "u_gone" }, role: "approver", next: "customer" };
  assert.deepEqual(workflowAsks(g, { ...PEOPLE, vars: VARS }).map((a) => a.nodeId), ["rep"], "someone no longer on the team");
  g.nodes.rep = { id: "rep", type: "signer", label: "Our team", who: { mode: "staff" }, role: "approver", next: "customer" };
  assert.deepEqual(workflowAsks(g, { ...PEOPLE, vars: VARS }).map((a) => a.nodeId), ["rep"], "a staff step nobody was put in");
  g.nodes.rep = { id: "rep", type: "approval", label: "Owner sign-off", mode: "decision", who: { mode: "owner" }, whenApproved: "customer", whenRejected: "end" };
  assert.deepEqual(workflowAsks(g, { ...PEOPLE, vars: VARS }), [], "the owner is found when the approval is raised");
  g.nodes.rep = { id: "rep", type: "signer", label: "Witness", who: { mode: "email", name: "W", email: "w@example.test" }, role: "signer", next: "customer" };
  assert.deepEqual(workflowAsks(g, { ...PEOPLE, vars: VARS }), [], "an address the designer filled in");
});

test("the people chosen go into this send's copy of the graph, never the saved design", () => {
  const saved = graph();
  const sent = applyChosen(saved, {
    manager: { userId: "u_sam" },
    finance: { name: "Fay Finance", email: "fay@example.test" },
    nowhere: { userId: "u_sam" },
    customer: { name: "Not Jane", email: "x@example.test" },
  });
  assert.deepEqual(saved.nodes.manager.type === "approval" && saved.nodes.manager.who, { mode: "ask" }, "the design still says: choose at send");
  assert.deepEqual(sent.nodes.manager.type === "approval" && sent.nodes.manager.who, { mode: "staff", userId: "u_sam" });
  assert.deepEqual(sent.nodes.finance.type === "approval" && sent.nodes.finance.who, { mode: "email", name: "Fay Finance", email: "fay@example.test" });
  assert.deepEqual(workflowAsks(sent, { ...PEOPLE, vars: VARS }), [], "nothing left to ask");

  // A signer chosen at send becomes a recipient with a name and an address.
  const g = graph();
  g.nodes.rep = { id: "rep", type: "signer", label: "Second signer", who: { mode: "ask" }, role: "signer", next: "customer" };
  const compiled = compileWorkflow(applyChosen(g, { rep: { name: "Ben Buyer", email: "ben@example.test" } }), { ...PEOPLE, vars: { ...VARS, discount: 0 } });
  assert.deepEqual(compiled.signers.map((s) => [s.name, s.email, s.needsInput]), [["Ben Buyer", "ben@example.test", false], ["Jane Doe", "jane@example.test", false]]);
});

test("what arrives from the browser is a set of people, or it is refused", () => {
  assert.deepEqual(parseChosen(undefined), {});
  assert.deepEqual(parseChosen({ a: { userId: "u_1" }, b: { name: " Fay Finance ", email: " Fay@Example.test " } }), { a: { userId: "u_1" }, b: { name: "Fay Finance", email: "fay@example.test" } });
  for (const bad of [
    "people",
    { a: { name: "F", email: "fay@example.test" } },
    { a: { name: "Fay Finance", email: "not-an-address" } },
    { a: { name: "Fay Finance", email: "fay@example.test", userId: "u_1" } },
    { a: { userId: "" } },
    { a: null },
    Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`n${i}`, { userId: "u_1" }])),
  ]) {
    assert.equal(parseChosen(bad), null, `refuses ${JSON.stringify(bad).slice(0, 70)}`);
  }
  assert.equal(askList([]), "");
  const three = [{ label: "Manager approval" }, { label: "Finance review" }, { label: "Witness" }].map((a, i) => ({ nodeId: String(i), kind: "approver" as const, hint: null, ...a }));
  assert.equal(askList(three.slice(0, 1)), "Manager approval");
  assert.equal(askList(three), "Manager approval, Finance review and Witness");
});

test("the send is refused on the server while a step is empty, not only on the card", () => {
  const envelope = code("src/lib/signing/autoEnvelope.ts");
  assert.match(envelope, /const graph = applyChosen\(saved, opts\.chosen \?\? \{\}\);/);
  const refuse = envelope.indexOf("if (missing.length > 0) return { missing };");
  assert.ok(refuse > 0);
  assert.ok(refuse < envelope.indexOf("const compiled = compileWorkflow(graph,"), "nothing is compiled, laid out or frozen for an incomplete workflow");

  const action = code("src/app/actions/recordSigning.ts");
  assert.match(action, /const people = parseChosen\(chosen\);\s*if \(!people\) return \{ ok: false,/);
  assert.match(action, /if \("missing" in envelope\) \{\s*return \{ ok: false, error: `Choose who will act as \$\{askList\(envelope\.missing\)\} before sending\.` \};/);
  assert.ok(action.indexOf('if ("missing" in envelope)') < action.indexOf("renderEnvelopePdf(envelope.doc"), "before a PDF is rendered or a request created");
});

// ── The approver hears now, and can be chased or replaced ───────────────────

test("an approval is delivered when it is raised, by the one thing that delivers approvals", () => {
  const runtime = code("src/lib/signflow/runtime.ts");
  assert.match(runtime, /if \(step\.tenantId\) await deliverQueuedNow\(requestId, step\.tenantId\);/);
  const now = runtime.slice(runtime.indexOf("async function deliverQueuedNow"));
  assert.match(now, /recoveryLeaseUntil: \{ gt: new Date\(\) \}/, "not when a worker already holds the request — that run looks again itself");
  assert.match(now, /if \(held\) return;/);
  assert.match(now, /await runAfterResponse\(async \(\) => \{\s*const \{ runSigningTransitionJobs \} = await import\("@\/lib\/signing\/transitionWorker"\);\s*await runSigningTransitionJobs\(tenantId, \d+, \{ requestId \}\);/);
  assert.doesNotMatch(runtime, /notifyApprover\(/, "the runtime still never sends the email itself: one owner, with retries");

  const worker = code("src/lib/signing/transitionWorker.ts");
  assert.match(worker, /AND \(\$\{requestId\}::text IS NULL OR "requestId" = \$\{requestId\}\)/, "a web request takes on one request's jobs, not the workspace's backlog");
  assert.match(worker, /for \(let pass = 0; pass < MAX_PASSES; pass\+\+\) \{\s*const jobs = await claimJobs\(/, "a job queued by this run is delivered by this run");
  assert.match(worker, /if \(jobs\.length === 0\) break;/);
});

test("sending the link again is a person's request, and reassigning replaces the link", () => {
  const approvals = code("src/lib/signing/approvals.ts");
  assert.match(approvals, /if \(!opts\.again && \(await approvalAlreadySent\(/, "the duplicate check is for the worker, not for someone asking");
  assert.match(approvals, /Date\.now\(\) - last\.getTime\(\) < RESEND_COOLDOWN_MS/, "…but they cannot hold the button down");

  const reassign = approvals.slice(approvals.indexOf("export async function reassignApproval"));
  assert.match(reassign, /where: \{ id: step\.id, tenantId: step\.tenantId, status: "pending" \}/, "never over a decision made a moment earlier");
  assert.match(reassign, /token: capability\.digest,\s*tokenCiphertext: capability\.ciphertext,/, "the first approver's link stops working");
  assert.match(reassign, /if \(moved\.count !== 1\) return \{ ok: false,/);
  assert.ok(reassign.indexOf("type: \"approval_reassigned\"") < reassign.indexOf("await notifyApprover(step.id, { again:"), "recorded, then sent to the new approver");
});

test("only someone who may manage that request can chase or reassign its approvals", () => {
  const actions = code("src/app/actions/signhub.ts");
  const guard = actions.slice(actions.indexOf("async function manageableApproval"), actions.indexOf("export async function resendApprovalLink"));
  assert.match(guard, /resolveSignatureRequestAccess\(\(\) =>\s*prisma\.signatureRequest\.findUnique\(\{ where: \{ id: step\.requestId \}/, "addressed by step id, so the request is checked one hop away");
  for (const name of ["resendApprovalLink", "reassignApprovalTo"]) {
    const body = actions.slice(actions.indexOf(`export async function ${name}`));
    assert.match(body.slice(0, 400), /const found = await manageableApproval\(stepId\);\s*if \(!found\) refuse\(/, `${name} goes through the guard first`);
  }
  assert.match(actions, /const to = userId \? await resolveTenantMemberUser\(userId\) : null;\s*if \(!to\) refuse\(/, "the new approver is looked up in this workspace, not taken from the form");

  const page = code("src/app/(app)/signatures/[id]/page.tsx");
  assert.match(page, /const canReassign = hasWaitingApproval && \(await hasPermission\(user, "signing\.manage"\)\);/);
  assert.match(page, /\{step\.status === "pending" && canReassign && \(/, "offered on a waiting approval only, to someone who can act on it");
});

// ── A default workflow ──────────────────────────────────────────────────────

test("a quote starts on the workspace's default workflow, and only the owner chooses it", () => {
  const card = code("src/components/SigningBlock.tsx");
  assert.match(card, /useState\(defaultWorkflowId \?\? ""\)/, "it was \"\" on every send");

  const view = code("src/app/actions/recordSigning.ts");
  assert.match(view, /defaultWorkflowId: workflows\.some\(\(workflow\) => workflow\.id === defaultWorkflow\) \? defaultWorkflow : null,/, "never a workflow that has since been deleted or archived");

  const action = code("src/app/actions/signflowDefault.ts");
  assert.match(action, /const user = await requireTenantOwner\(\);/);
  assert.match(action, /where: \{ id: workflowId, isArchived: false, deletedAt: null \}/);
  assert.equal((action.match(/await logAudit\(/g) ?? []).length, 2, "setting it and clearing it are both on the record");
});
