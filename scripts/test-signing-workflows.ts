/**
 * SIGNING WORKFLOWS — what the send path, the queue and the database actually do.
 *
 * The unit tests run the arithmetic and the graph walk. These are the parts that
 * only exist against a real database:
 *
 *   - the discount on a real quote reaches the rule that tests it, and the path
 *     the document takes changes because of it;
 *   - a workflow with an empty step is refused by the send path itself, and the
 *     people chosen are frozen into THAT request's graph;
 *   - an approval is delivered when it is raised — by the queue, immediately —
 *     including the one a queued job raises for the next approver;
 *   - an approval can be handed to someone else, and the first link dies.
 *
 * "Delivered" here is the queue ATTEMPTING the email at once. The test database
 * has no mail server on purpose, so every attempt fails with "SMTP is not
 * configured" — and that failure, recorded on the job the moment the approval
 * is raised rather than at the next cron run, is exactly the evidence wanted.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database. Signing
 * evidence is append-only, so the rows stay behind in a workspace of their own.
 */
import { basePrisma } from "../src/lib/db";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { putSetting } from "../src/lib/settings";
import { resolveEnvelope } from "../src/lib/signing/autoEnvelope";
import { advanceWorkflow } from "../src/lib/signflow/runtime";
import { runSigningTransitionJobs } from "../src/lib/signing/transitionWorker";
import { reassignApproval, resendApproval } from "../src/lib/signing/approvals";
import { revealSignCapability } from "../src/lib/signing/tokenVault";
import { resolveApprovalStepTenant } from "../src/lib/tokenTenant";
import { hashSignToken, newSignToken } from "../src/lib/signing/tokens";
import { SIGNING_DEFAULT_WORKFLOW_KEY, defaultSignWorkflowId } from "../src/lib/signflow/defaultWorkflow";
import type { WorkflowGraph } from "../src/lib/signflow/model";

const SFX = Math.random().toString(16).slice(2, 10);
let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function guardEnvironment() {
  if (process.env.NODE_ENV !== "test") throw new Error("Refusing to run outside NODE_ENV=test");
  const name = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
  if (!/_test$/.test(name)) {
    throw new Error(`Refusing to run against database "${name}" — the name must end in _test`);
  }
}

type Job = { jobType: string; status: string; attempts: number; lastError: string | null; stepId: string | null };
const jobs = (requestId: string) =>
  basePrisma.$queryRaw<Job[]>`
    SELECT "jobType", "status", "attempts", "lastError", "payload"->>'approvalStepId' AS "stepId"
    FROM "SigningJob" WHERE "requestId" = ${requestId} ORDER BY "createdAt"
  `;

async function main() {
  guardEnvironment();
  const tenantId = `wf_${SFX}`;
  await basePrisma.tenant.create({ data: { id: tenantId, name: `Workflow Co ${SFX}`, slug: tenantId, active: true } });
  const person = async (label: string) => {
    const user = await basePrisma.user.create({
      data: { id: `wf_${label}_${SFX}`, name: `${label} ${SFX}`, email: `wf-${label}-${SFX}@example.test`, passwordHash: "x", role: "sales", tenantId },
    });
    await basePrisma.tenantMember.create({ data: { tenantId, userId: user.id } });
    return { id: user.id, name: user.name, email: user.email };
  };
  const [rep, manager, director] = [await person("rep"), await person("manager"), await person("director")];
  const inScope = <T>(work: () => Promise<T>) => runInTenantScope({ tenantId, system: false }, work);

  // ── 1. The discount reaches the rule, and an empty step stops the send ────
  console.log("\nA rule on Discount %, and a step chosen at send");
  const contact = await basePrisma.contact.create({ data: { firstName: "Jane", lastName: "Doe", email: `jane-${SFX}@example.test`, createdById: rep.id, tenantId } });
  let number = 810_000_000 + Math.floor(Math.random() * 80_000_000);
  const quoteWith = async (discountPct: number) => {
    const quote = await basePrisma.quote.create({ data: { number: number++, status: "draft", tenantId, createdById: rep.id, contactId: contact.id } });
    await basePrisma.quoteItem.createMany({
      data: [
        { quoteId: quote.id, tenantId, description: "Vehicle", qty: 1, unitPriceCents: 20_000_000, discountPct },
        { quoteId: quote.id, tenantId, description: "Accessory", qty: 1, unitPriceCents: 4_000_000, discountPct: 0 },
      ],
    });
    return quote.id;
  };
  // Our rep → (discount > 10 ? a manager approves, CHOSEN AT SEND) → the customer.
  const design: WorkflowGraph = {
    start: "start",
    positions: {},
    nodes: {
      start: { id: "start", type: "start", next: "rep" },
      rep: { id: "rep", type: "signer", label: "Our team", who: { mode: "staff", userId: rep.id }, role: "approver", next: "rule" },
      rule: { id: "rule", type: "condition", field: "discount", op: "gt", value: "10", whenTrue: "manager", whenFalse: "customer" },
      manager: { id: "manager", type: "approval", label: "Manager approval", mode: "decision", who: { mode: "ask" }, whenApproved: "customer", whenRejected: "end" },
      customer: { id: "customer", type: "signer", label: "Customer", who: { mode: "customer" }, role: "signer", next: "end" },
      end: { id: "end", type: "end" },
    },
  };
  const workflow = await basePrisma.signWorkflow.create({ data: { tenantId, name: `Discount approval ${SFX}`, graphJson: design as object, createdById: rep.id } });
  const envelope = (quoteId: string, chosen?: Record<string, { userId: string }>) =>
    inScope(() => resolveEnvelope({ quoteId, workflowId: workflow.id, chosen, signer: { name: rep.name, email: rep.email } }));

  // 15% off the R200 000 vehicle is R30 000 off a listed R240 000: 12.5% on the quote.
  const discounted = await quoteWith(15);
  const refused = await envelope(discounted);
  check(
    "a 12.5% discount sends the quote down the approval branch, and the send is refused until someone is chosen",
    Boolean(refused && "missing" in refused && refused.missing.length === 1 && refused.missing[0].nodeId === "manager"),
    JSON.stringify(refused && "missing" in refused ? refused.missing : refused && Object.keys(refused)),
  );
  const prepared = await envelope(discounted, { manager: { userId: manager.id } });
  const frozen = prepared && "doc" in prepared ? prepared.frozen : undefined;
  check("with the manager chosen it is prepared, and the discount is frozen on the request", frozen?.vars.discount === 12.5, JSON.stringify(frozen?.vars));
  const frozenManager = frozen?.graph.nodes.manager;
  check(
    "the chosen person is in THIS request's graph",
    frozenManager?.type === "approval" && frozenManager.who.mode === "staff" && frozenManager.who.userId === manager.id,
    JSON.stringify(frozenManager),
  );
  const saved = await basePrisma.signWorkflow.findUniqueOrThrow({ where: { id: workflow.id }, select: { graphJson: true } });
  check("…and the saved design still says: choose at send", JSON.stringify(saved.graphJson).includes('"mode":"ask"'));
  const stranger = await envelope(discounted, { manager: { userId: `nobody_${SFX}` } });
  check("someone who is not on the team does not fill the step", Boolean(stranger && "missing" in stranger));

  const small = await envelope(await quoteWith(6));
  check(
    "a 5% discount is under the threshold: nobody is asked for, and the path skips the approval",
    Boolean(small && "doc" in small && small.frozen?.vars.discount === 5 && small.signers?.length === 2),
    JSON.stringify(small && "doc" in small ? { vars: small.frozen?.vars, signers: small.signers?.map((s) => s.label) } : small),
  );

  // ── 2. An approval is delivered when it is raised ─────────────────────────
  console.log("\nThe approver is told at once");
  // Manager approves, then the director approves, then the customer signs.
  const chain: WorkflowGraph = {
    start: "start",
    positions: {},
    nodes: {
      start: { id: "start", type: "start", next: "manager" },
      manager: { id: "manager", type: "approval", label: "Manager approval", mode: "decision", who: { mode: "staff", userId: manager.id }, whenApproved: "director", whenRejected: "end" },
      director: { id: "director", type: "approval", label: "Director approval", mode: "decision", who: { mode: "staff", userId: director.id }, whenApproved: "customer", whenRejected: "end" },
      customer: { id: "customer", type: "signer", label: "Customer", who: { mode: "customer" }, role: "signer", next: "end" },
      end: { id: "end", type: "end" },
    },
  };
  const request = await basePrisma.signatureRequest.create({
    data: {
      tenantId, title: `Workflow probe ${SFX}`, status: "sent", sentAt: new Date(), ordering: "sequential", identityMode: "link", contactId: contact.id, createdById: rep.id,
      workflowGraphJson: { graph: chain, vars: { total: 240_000, discount: 12, segment: "retail", product: "" } } as object,
    },
  });
  await basePrisma.signatureRecipient.create({
    data: { tenantId, requestId: request.id, name: "Jane Doe", email: contact.email, nodeId: "customer", order: 0, token: hashSignToken(newSignToken()) },
  });

  await inScope(() => advanceWorkflow(request.id));
  const first = await basePrisma.approvalStep.findFirst({ where: { requestId: request.id, nodeId: "manager" } });
  let queue = await jobs(request.id);
  const firstNotify = queue.find((job) => job.jobType === "approval_notify" && job.stepId === first?.id);
  check("raising the approval creates it for the manager", first?.status === "pending" && first.assigneeUserId === manager.id);
  check("…under their name, though the graph holds only their id", first?.assigneeName === manager.name, String(first?.assigneeName));
  check(
    "its email was attempted there and then — not left for the next scheduled run",
    Boolean(firstNotify && firstNotify.attempts === 1 && /SMTP/i.test(firstNotify.lastError ?? "")),
    JSON.stringify(firstNotify ?? queue),
  );

  // The manager approves, as the queue would see it: the decision is committed
  // and an "advance" job is waiting. One run of the worker must both raise the
  // director's approval AND attempt the director's email.
  await basePrisma.approvalStep.update({ where: { id: first!.id }, data: { status: "approved", decidedAt: new Date(), decidedByName: manager.name } });
  await inScope(() => runSigningTransitionJobs(tenantId));
  const second = await basePrisma.approvalStep.findFirst({ where: { requestId: request.id, nodeId: "director" } });
  queue = await jobs(request.id);
  const secondNotify = queue.find((job) => job.jobType === "approval_notify" && job.stepId === second?.id);
  check("one run of the queue raises the next approval", second?.status === "pending" && second.assigneeUserId === director.id, JSON.stringify(queue));
  check(
    "…and attempts that approver's email in the same run, not half an hour later",
    Boolean(secondNotify && secondNotify.attempts === 1 && /SMTP/i.test(secondNotify.lastError ?? "")),
    JSON.stringify(secondNotify ?? queue),
  );

  // ── 3. Sending again, and handing the approval to someone else ────────────
  console.log("\nChasing and reassigning an approval");
  const again = await inScope(() => resendApproval(second!.id, "Tester"));
  check("Send again tries the email (and says plainly when it could not go)", !again.ok && /SMTP/i.test(again.error ?? ""), JSON.stringify(again));

  const oldLink = revealSignCapability(second!.tokenCiphertext);
  check("the director's link works before the hand-over", Boolean(oldLink && (await resolveApprovalStepTenant(oldLink!))?.tenantId === tenantId));
  const same = await inScope(() => reassignApproval(second!.id, director, "Tester"));
  check("reassigning to the person who already has it is refused", !same.ok && /already has/.test(same.error ?? ""), JSON.stringify(same));

  const moved = await inScope(() => reassignApproval(second!.id, manager, "Tester"));
  const after = await basePrisma.approvalStep.findUniqueOrThrow({ where: { id: second!.id } });
  check("the approval now belongs to the new person, still waiting", after.assigneeUserId === manager.id && after.assigneeName === manager.name && after.status === "pending", JSON.stringify({ ...after, token: "…" }));
  check("the hand-over is reported as done, with the email that could not go said plainly", !moved.ok && /Reassigned to/.test(moved.error ?? "") && /Send again/.test(moved.error ?? ""), JSON.stringify(moved));
  check("the first approver's link is dead", Boolean(oldLink) && (await resolveApprovalStepTenant(oldLink!)) === null);
  const newLink = revealSignCapability(after.tokenCiphertext);
  check("…and the new one resolves", Boolean(newLink && newLink !== oldLink && (await resolveApprovalStepTenant(newLink!))?.tenantId === tenantId));
  const trail = await basePrisma.signatureEvent.findMany({ where: { requestId: request.id, type: "approval_reassigned" }, select: { actor: true, metadata: true } });
  check(
    "the audit trail says who it went from and to",
    trail.length === 1 && (trail[0].metadata as { from?: string; to?: string }).from === director.name && (trail[0].metadata as { to?: string }).to === manager.name,
    JSON.stringify(trail),
  );
  const decided = await inScope(() => reassignApproval(first!.id, director, "Tester"));
  check("an approval that has been decided cannot be reassigned", !decided.ok && /already been decided/.test(decided.error ?? ""), JSON.stringify(decided));

  // ── 4. The default workflow belongs to one workspace ──────────────────────
  console.log("\nThe default workflow");
  const otherTenant = `wf_other_${SFX}`;
  await basePrisma.tenant.create({ data: { id: otherTenant, name: `Other Co ${SFX}`, slug: otherTenant, active: true } });
  __setTenantEnforcingForTests(true);
  try {
    await inScope(() => putSetting(SIGNING_DEFAULT_WORKFLOW_KEY, workflow.id));
    check("the workspace that set it reads it back", (await inScope(() => defaultSignWorkflowId())) === workflow.id);
    check(
      "another workspace does not",
      (await runInTenantScope({ tenantId: otherTenant, system: false }, () => defaultSignWorkflowId())) === null,
    );
    await inScope(() => putSetting(SIGNING_DEFAULT_WORKFLOW_KEY, ""));
    check("clearing it leaves no default", (await inScope(() => defaultSignWorkflowId())) === null);
  } finally {
    __setTenantEnforcingForTests(null);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
}

main()
  .catch((err) => {
    console.error(err);
    failed++;
  })
  .finally(async () => {
    await basePrisma.$disconnect();
    process.exit(failed > 0 ? 1 : 0);
  });
